import { packageIdentity } from './package-identity.js';
/* eslint-disable @typescript-eslint/no-explicit-any */
import type OpenAI from 'openai';
import {
  createCaesuraEngine,
  checkOperation,
  copyProviderValue,
  type ProviderStreamStatus,
  requireConversationId,
  CaesuraError,
  snapshotObservation,
  selectPositions,
  normalizeDialogue,
  dialogueAnchors,
  type CaesuraCallOptions,
  knownInjectedMessages,
  rememberInjectedMessage,
  selectActive,
  renderBlock,
  type CaesuraEvent,
} from '@caesura-io/core';
import type { CaesuraOpenAI, CaesuraOpenAIOptions } from './types.js';
export type { CaesuraOpenAI } from './types.js';
import {
  collectOpenAIMessages,
  stripInjectedOpenAIMessages,
  applySkillPromptOpenAI,
  injectBlocksOpenAI,
  getMessageText,
} from './adapters.js';

/** Delay delegation without assimilating the SDK's APIPromise and losing its helpers. */
function deferRequest(pending: Promise<{ request: any }>): any {
  const parsed = () => pending.then(({ request }) => request);
  return {
    then: (...args: any[]) => parsed().then(...args),
    catch: (...args: any[]) => parsed().catch(...args),
    finally: (...args: any[]) => parsed().finally(...args),
    asResponse: () => pending.then(({ request }) => request.asResponse()),
    withResponse: () => pending.then(({ request }) => request.withResponse()),
    _thenUnwrap: (...args: any[]) =>
      deferRequest(
        pending.then(({ request }) => ({
          request: request._thenUnwrap(...args),
        })),
      ),
    [Symbol.toStringTag]: 'Promise',
  };
}

export function createCaesura(
  openai: OpenAI,
  options: CaesuraOpenAIOptions,
): CaesuraOpenAI {
  const engine = createCaesuraEngine(options, packageIdentity);
  const cfg = engine.config;

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  const wrapMethod = (originalFn: Function, isResponses: boolean) => {
    return function (this: any, body: any, requestOptions?: any) {
      if (!body) {
        requireConversationId(
          requestOptions?.caesura?.conversationId ?? cfg.conversationId,
        );
        return originalFn.call(this, body, requestOptions);
      }

      // Freeze dialogue before any state I/O or background scheduling.
      body = copyProviderValue(body);
      const pending = (async () => {
        // 1. Resolve conversationId
        const call: CaesuraCallOptions = snapshotObservation({
          ...requestOptions?.caesura,
          signal: requestOptions?.signal ?? requestOptions?.caesura?.signal,
        });
        call.invocationId ??= crypto.randomUUID();
        checkOperation(call);
        const perCallConvId = call.conversationId;
        const convId = requireConversationId(
          perCallConvId ?? cfg.conversationId,
        );
        call.signal = AbortSignal.any([
          engine.getSignal(convId),
          ...(call.signal ? [call.signal] : []),
        ]);

        // 2. Strip 'caesura' option from RequestOptions to avoid breaking other wrappers or the SDK itself
        let cleanRequestOptions = requestOptions;
        if (
          requestOptions &&
          typeof requestOptions === 'object' &&
          'caesura' in requestOptions
        ) {
          const rest = { ...requestOptions };
          delete rest.caesura;
          cleanRequestOptions = rest;
        }

        cleanRequestOptions = { ...cleanRequestOptions, signal: call.signal };

        // 3. Observe dialogue messages
        const state = await engine.getState(convId);
        const available = new Set(state.recommendations.map((r) => r.id));

        const injectedMessages = knownInjectedMessages(state, cfg.inject.as);
        const source = isResponses ? body.input : body.messages;
        const sourceItems =
          typeof source === 'string'
            ? [{ role: 'user', content: source }]
            : Array.isArray(source)
              ? source
              : [];
        const protectedMessages = new Set(
          call.dialoguePositions
            ? selectPositions(sourceItems, call.dialoguePositions)
            : [],
        );
        if (
          call.turn?.origin === 'customer' &&
          !state.processedTurnIds?.includes(call.turn.id) &&
          sourceItems.at(-1)?.role === 'user'
        )
          protectedMessages.add(sourceItems.at(-1));
        const messagesOrInput = stripInjectedOpenAIMessages(
          source,
          injectedMessages,
          protectedMessages,
        );
        const rawItems =
          typeof messagesOrInput === 'string'
            ? [{ role: 'user', content: messagesOrInput }]
            : Array.isArray(messagesOrInput)
              ? messagesOrInput
              : [];
        const positions = call.dialoguePositions?.map((i) =>
          typeof source === 'string' ? 0 : rawItems.indexOf(sourceItems[i]),
        );
        const selectedInput = positions
          ? selectPositions(rawItems, positions)
          : messagesOrInput;
        const collected = normalizeDialogue(
          call.dialogue ??
            collectOpenAIMessages(
              selectedInput,
              { maxMessages: 'all' },
              cfg.speakerNames,
              new Set(),
            ),
          cfg.speakerNames,
        );
        if (
          call.dialoguePositions &&
          call.dialoguePositions.length !== collected.length
        )
          throw new TypeError(
            'CaesuraO: each dialogue position must select one nonempty dialogue message.',
          );

        const rawLast =
          typeof messagesOrInput === 'string'
            ? { role: 'user' }
            : Array.isArray(messagesOrInput)
              ? messagesOrInput.at(-1)
              : undefined;
        const observation = {
          ...call,
          turn:
            call.turn ??
            (rawLast?.role !== 'user'
              ? { id: call.invocationId!, origin: 'internal' as const }
              : undefined),
        };
        await engine.observe(convId, collected, observation);
        checkOperation(call);
        const prepared = await engine.updateState(convId, (state) => {
          // 4. Inject recommendations and skill prompt
          const eventId = call.turn?.id ?? dialogueAnchors(collected).at(-1);
          const eventTurn =
            eventId &&
            state.turnNumbers &&
            Object.hasOwn(state.turnNumbers, eventId)
              ? state.turnNumbers[eventId]!
              : state.turn;
          const active = selectActive(
            { ...state, turn: eventTurn },
            cfg.inject,
            Date.now(),
          ).filter(
            (r) =>
              r.createdAtTurn <= eventTurn &&
              (cfg.mode === 'sync' || available.has(r.id)),
          );
          const modifiedBody = { ...body };
          const analysisIds: string[] = [];

          const targetKey = isResponses ? 'input' : 'messages';
          const skill = applySkillPromptOpenAI(
            messagesOrInput,
            cfg.inject.skillPrompt,
            isResponses ? (body.instructions ?? null) : undefined,
          );
          modifiedBody[targetKey] = skill.result;
          if (
            isResponses &&
            skill.instructions !== undefined &&
            // null signals Responses mode to the helper, not an absent caller field.
            (body.instructions !== undefined || skill.instructions !== null)
          )
            modifiedBody.instructions = skill.instructions;

          const blocks = renderBlock(active, cfg.inject);
          if (blocks.length > 0) {
            const { result, indices } = injectBlocksOpenAI(
              modifiedBody[targetKey],
              blocks,
              cfg.inject,
              cfg.speakerNames,
              new Set(),
              positions
                ? {
                    positions: positions.map(
                      (i) =>
                        i +
                        (Array.isArray(modifiedBody[targetKey])
                          ? modifiedBody[targetKey].length - rawItems.length
                          : 0),
                    ),
                    messages: collected,
                  }
                : undefined,
            );
            modifiedBody[targetKey] = result;
            const injected = blocks.flatMap((block, i) => {
              const index = indices[i]!;
              if (index < 0) return [];
              analysisIds.push(block.recommendationId);
              const rec = active.find((r) => r.id === block.recommendationId)!;
              rec.injectedText = getMessageText(
                (result as any[])[index]?.content,
              );
              rememberInjectedMessage(
                state,
                (result as any[])[index].role,
                rec.injectedText,
              );
              return [
                {
                  recommendationId: block.recommendationId,
                  text: block.text,
                  index,
                },
              ];
            });
            engine.emitEvent({
              type: 'injected',
              conversationId: convId,
              turn: state.turn,
              blocks: injected,
              placement: cfg.inject.placement,
            } as CaesuraEvent);
          }

          return { modifiedBody, analysisIds };
        });
        checkOperation(call);
        const correlation = {
          conversationId: convId,
          sdk: engine.sdk,
          customerTurnId:
            call.turn?.origin === 'customer'
              ? call.turn.id
              : call.turn
                ? undefined
                : dialogueAnchors(collected).at(-1),
          invocationId: call.invocationId,
          metadata: call.metadata,
        };
        const api = isResponses ? ('responses' as const) : ('chat' as const);
        await engine.prepareProvider(
          {
            type: 'request',
            api,
            correlation,
            parameters: prepared.modifiedBody,
            analysisIds: prepared.analysisIds,
          },
          { signal: call.signal, deadline: call.deadline },
        );
        checkOperation(call);
        // Keep native APIPromise helpers, native response values, and native request options.
        try {
          const request = originalFn.call(
            this,
            prepared.modifiedBody,
            cleanRequestOptions,
          );
          if (!options.onProviderEvent && !options.persistMessages)
            return { request };
          const persistAgent = async (text: string, id?: string) => {
            if (!text) return;
            await engine.recordMessages(
              convId,
              [
                {
                  id: id ?? `${call.invocationId}:agent`,
                  role: 'agent',
                  text,
                  speakerName: cfg.speakerNames.agent,
                  speakerIndex: 0,
                },
              ],
              call,
            );
          };
          return {
            request: auditRequest(
              request,
              async (value) => {
                engine.audit({ type: 'response', api, correlation, value });
                if (isResponses) {
                  if (
                    value.status === undefined ||
                    value.status === 'completed'
                  )
                    for (const message of responseMessages(value))
                      await persistAgent(message.text, message.id);
                } else {
                  const text = value.choices?.[0]?.message?.content;
                  await persistAgent(
                    typeof text === 'string' ? text : '',
                    value.id,
                  );
                }
              },
              (value) =>
                engine.audit({ type: 'chunk', api, correlation, value }),
              (error) =>
                engine.audit({
                  type: 'error',
                  api,
                  correlation,
                  error:
                    error instanceof CaesuraError
                      ? error
                      : new CaesuraError(
                          call.signal?.aborted ||
                            (error instanceof Error &&
                              error.name === 'AbortError')
                            ? 'cancelled'
                            : 'provider',
                          'Provider request failed.',
                          { cause: error },
                        ),
                }),
              () =>
                engine.audit({
                  type: 'stream-start',
                  api,
                  correlation,
                  value: {},
                }),
              async (status, value) => {
                engine.audit({
                  type: 'stream-end',
                  api,
                  correlation,
                  status,
                  value,
                });
                if (status === 'completed') {
                  if (value.messages.length)
                    for (const message of value.messages)
                      await persistAgent(message.text, message.id);
                  else await persistAgent(value.text, value.id);
                }
              },
              isResponses,
              call.signal,
            ),
          };
        } catch (error) {
          engine.audit({
            type: 'error',
            api,
            correlation,
            error: new CaesuraError(
              call.signal?.aborted ? 'cancelled' : 'provider',
              'Provider request failed.',
              { cause: error },
            ),
          });
          throw error;
        }
      })();
      return deferRequest(pending);
    };
  };

  const makeProxy = (target: any, path: string[]): any => {
    return new Proxy(target, {
      get(obj, prop) {
        if (path.length === 0 && prop === 'caesura') return engine;
        if (path.length === 0 && prop === 'createConversation')
          return engine.createConversation;
        if (typeof prop === 'symbol') {
          return Reflect.get(obj, prop);
        }

        const value = Reflect.get(obj, prop);
        const currentPath = [...path, prop];

        // Intercept client.chat.completions.create
        if (
          currentPath.length === 3 &&
          currentPath[0] === 'chat' &&
          currentPath[1] === 'completions' &&
          currentPath[2] === 'create' &&
          typeof value === 'function'
        ) {
          return wrapMethod(value.bind(obj), false);
        }

        // Intercept client.responses.create
        if (
          currentPath.length === 2 &&
          currentPath[0] === 'responses' &&
          currentPath[1] === 'create' &&
          typeof value === 'function'
        ) {
          return wrapMethod(value.bind(obj), true);
        }

        if (value !== null && typeof value === 'object') {
          return makeProxy(value, currentPath);
        }

        if (typeof value === 'function') {
          return value.bind(obj);
        }

        return value;
      },
    });
  };

  return makeProxy(openai, []);
}

// Alias for withCaesura
export const withCaesura = createCaesura;

function auditRequest(
  request: any,
  response: (value: any) => Promise<void>,
  chunk: (value: any) => void,
  error: (value: unknown) => void,
  start: () => void,
  end: (status: ProviderStreamStatus, value: any) => Promise<void>,
  isResponses: boolean,
  signal?: AbortSignal,
): any {
  let captured: Promise<any> | undefined;
  const capture = (value: any): Promise<any> =>
    (captured ??= (async () => {
      if (value?.[Symbol.asyncIterator]) {
        start();
        return new Proxy(value, {
          get(target, key) {
            if (key === Symbol.asyncIterator)
              return async function* () {
                let status: ProviderStreamStatus = 'cancelled';
                let finished = false;
                let finishReason: string | undefined;
                let text = '';
                let usage: unknown;
                let id: string | undefined;
                let terminal: unknown;
                const messages = new Map<
                  string,
                  { id?: string; text: string }
                >();
                try {
                  for await (const part of target) {
                    chunk(part);
                    id ??= part.id ?? part.response?.id;
                    usage = part.usage ?? part.response?.usage ?? usage;
                    const choice = part.choices?.find(
                      (choice: any) =>
                        choice.index === 0 || choice.index === undefined,
                    );
                    if (
                      !isResponses &&
                      typeof choice?.finish_reason === 'string' &&
                      choice.finish_reason
                    ) {
                      finished = true;
                      finishReason = choice.finish_reason;
                      terminal = part;
                    }
                    if (isResponses && part.type === 'response.completed') {
                      finished = true;
                      terminal = part;
                      for (const message of responseMessages(part.response))
                        messages.set(
                          message.id ?? String(messages.size),
                          message,
                        );
                    }
                    if (
                      part.type === 'response.output_item.done' &&
                      part.item?.type === 'message' &&
                      part.item.role === 'assistant'
                    ) {
                      for (const message of responseMessages({
                        output: [part.item],
                      }))
                        messages.set(
                          message.id ?? String(messages.size),
                          message,
                        );
                    }
                    if (part.type === 'response.output_text.delta')
                      text += part.delta ?? '';
                    else
                      text +=
                        part.choices?.find(
                          (choice: any) =>
                            choice.index === 0 || choice.index === undefined,
                        )?.delta?.content ?? '';
                    if (
                      part.type === 'error' ||
                      part.type === 'response.failed' ||
                      part.type === 'response.incomplete'
                    ) {
                      status =
                        part.type === 'response.incomplete'
                          ? 'incomplete'
                          : 'failed';
                      terminal = part;
                      error(
                        new CaesuraError(
                          'provider',
                          'Provider reported a failed or incomplete response.',
                          { cause: part },
                        ),
                      );
                    }
                    yield part;
                  }
                  if (status !== 'failed' && status !== 'incomplete')
                    status =
                      signal?.aborted || target.controller?.signal?.aborted
                        ? 'cancelled'
                        : finished
                          ? 'completed'
                          : 'incomplete';
                } catch (e) {
                  status =
                    signal?.aborted ||
                    target.controller?.signal?.aborted ||
                    (e instanceof Error && e.name === 'AbortError')
                      ? 'cancelled'
                      : 'failed';
                  error(e);
                  throw e;
                } finally {
                  await end(status, {
                    text,
                    usage,
                    id,
                    terminal,
                    finishReason,
                    messages: [...messages.values()],
                  }).catch((e) => {
                    error(e);
                    throw e;
                  });
                }
              };
            const field = Reflect.get(target, key);
            return typeof field === 'function' ? field.bind(target) : field;
          },
        });
      }
      await response(value);
      return value;
    })());
  let parsedResult: Promise<any> | undefined;
  const parsed = () =>
    (parsedResult ??= Promise.resolve(request)
      .then(capture)
      .catch((e) => {
        error(e);
        throw e;
      }));
  return {
    then: (...args: any[]) => parsed().then(...args),
    catch: (...args: any[]) => parsed().catch(...args),
    finally: (...args: any[]) => parsed().finally(...args),
    asResponse: () =>
      request.asResponse().catch((e: unknown) => {
        error(e);
        throw e;
      }),
    withResponse: () =>
      request
        .withResponse()
        .then(async (result: any) => ({
          ...result,
          data: await capture(result.data),
        }))
        .catch((e: unknown) => {
          error(e);
          throw e;
        }),
    _thenUnwrap: (...args: any[]) => request._thenUnwrap(...args),
    [Symbol.toStringTag]: 'Promise',
  };
}

/** Preserve actual Responses output-message IDs when the provider supplies them. */
function responseMessages(value: any): { id?: string; text: string }[] {
  return (value?.output ?? [])
    .filter((item: any) => item.type === 'message' && item.role === 'assistant')
    .map((item: any, index: number) => ({
      id: item.id ?? (value.id ? `${value.id}:${index}` : undefined),
      text: (item.content ?? [])
        .filter((part: any) => part.type === 'output_text')
        .map((part: any) => part.text)
        .join(''),
    }));
}
