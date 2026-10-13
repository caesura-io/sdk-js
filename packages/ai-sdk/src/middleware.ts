import { packageIdentity } from './package-identity.js';
import type {
  CaesuraMiddleware,
  PromptMessageLike,
} from './internal/ai-types.js';
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
  type Correlation,
  knownInjectedMessages,
  rememberInjectedMessage,
  selectActive,
  renderBlock,
  type CaesuraConfig,
  type CaesuraEvent,
} from '@caesura-io/core';
import {
  collectMessages,
  stripInjectedMessages,
  injectBlocks,
  applySkillPrompt,
  messageText,
} from './helpers.js';

/**
 * CaesuraO language model middleware for the Vercel AI SDK.
 *
 * Observes the dialogue and asynchronously fetches recommendations, then
 * injects buffered recommendations into the prompt before each model call —
 * without blocking the conversation (in 'async' mode).
 */
export type CaesuraMiddlewareWithConversations = CaesuraMiddleware & {
  readonly caesura: import('@caesura-io/core').CaesuraEngine;
  createConversation: import('@caesura-io/core').CaesuraEngine['createConversation'];
};

export function caesuraMiddleware(
  config: CaesuraConfig,
): CaesuraMiddlewareWithConversations {
  const engine = createCaesuraEngine(config, packageIdentity);
  const cfg = engine.config;

  const persistAgent = async (
    correlation: Correlation,
    text: string,
    signal?: AbortSignal,
    id?: string,
  ) => {
    if (!text) return;
    await engine.recordMessages(
      correlation.conversationId,
      [
        {
          id: id ?? `${correlation.invocationId}:agent`,
          role: 'agent',
          text,
          speakerName: cfg.speakerNames.agent,
          speakerIndex: 0,
        },
      ],
      {
        invocationId: correlation.invocationId,
        metadata: correlation.metadata,
        signal,
        turn: correlation.customerTurnId
          ? { id: correlation.customerTurnId, origin: 'customer' }
          : undefined,
      },
    );
  };
  const captures = new WeakMap<
    object,
    { correlation: Correlation; analysisIds: string[]; deadline?: number }
  >();
  return {
    caesura: engine,
    createConversation: engine.createConversation,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    specificationVersion: 'v3' as any,
    transformParams: async ({ params }) => {
      const { abortSignal, ...nativeParameters } = params;
      params = { ...copyProviderValue(nativeParameters), abortSignal };
      let prompt = copyProviderValue(
        params.prompt ?? [],
      ) as unknown as PromptMessageLike[];
      const call: CaesuraCallOptions = snapshotObservation({
        ...params.providerOptions?.caesura,
        signal: params.abortSignal,
      });
      call.invocationId ??= crypto.randomUUID();
      checkOperation(call);

      const convId = requireConversationId(
        call.conversationId ?? cfg.conversationId,
      );

      call.signal = AbortSignal.any([
        engine.getSignal(convId),
        ...(call.signal ? [call.signal] : []),
      ]);
      const state = await engine.getState(convId);
      const available = new Set(state.recommendations.map((r) => r.id));

      const injectedMessages = knownInjectedMessages(
        state,
        cfg.inject.as === 'developer' ? 'system' : cfg.inject.as,
      );
      const source = prompt;
      const protectedMessages = new Set(
        call.dialoguePositions
          ? selectPositions(source, call.dialoguePositions)
          : [],
      );
      if (
        call.turn?.origin === 'customer' &&
        !state.processedTurnIds?.includes(call.turn.id) &&
        source.at(-1)?.role === 'user'
      )
        protectedMessages.add(source.at(-1)!);
      prompt = stripInjectedMessages(
        prompt,
        injectedMessages,
        protectedMessages,
      );
      const positions = call.dialoguePositions?.map((i) =>
        prompt.indexOf(source[i]!),
      );
      let modifiedPrompt = applySkillPrompt(prompt, cfg.inject.skillPrompt);

      // ── 1. OBSERVE ─────────────────────────────────────────────
      const collected = normalizeDialogue(
        call.dialogue ??
          collectMessages(
            selectPositions(prompt, positions),
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
      await engine.observe(convId, collected, {
        ...call,
        turn:
          call.turn ??
          (prompt.at(-1)?.role !== 'user'
            ? { id: call.invocationId!, origin: 'internal' }
            : undefined),
      });
      checkOperation(call);
      return engine.updateState(convId, (state) => {
        // ── 2. INJECT ──────────────────────────────────────────────
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
        const analysisIds: string[] = [];
        if (active.length > 0) {
          const blocks = renderBlock(active, cfg.inject);
          if (blocks.length > 0) {
            const injectedResult = injectBlocks(
              modifiedPrompt,
              blocks,
              cfg.inject,
              cfg.speakerNames,
              new Set(),
              positions
                ? {
                    positions: positions.map(
                      (i) => i + modifiedPrompt.length - prompt.length,
                    ),
                    messages: collected,
                  }
                : undefined,
            );
            modifiedPrompt = injectedResult.prompt;

            for (let i = 0; i < blocks.length; i++) {
              const index = injectedResult.indices[i]!;
              if (index < 0) continue;
              analysisIds.push(blocks[i]!.recommendationId);
              const rec = active.find(
                (r) => r.id === blocks[i]!.recommendationId,
              )!;
              rec.injectedText = messageText(modifiedPrompt[index]!.content);
              rememberInjectedMessage(
                state,
                modifiedPrompt[index]!.role,
                rec.injectedText,
              );
            }

            engine.emitEvent({
              type: 'injected',
              conversationId: convId,
              turn: state.turn,
              blocks: blocks
                .map((b, i) => ({
                  recommendationId: b.recommendationId,
                  text: b.text,
                  index: injectedResult.indices[i]!,
                }))
                .filter((b) => b.index >= 0),
              placement: cfg.inject.placement,
            } as CaesuraEvent);
          }
        }

        const providerOptions = { ...params.providerOptions };
        delete providerOptions.caesura;
        const result = {
          ...params,
          abortSignal: call.signal,
          providerOptions,
          prompt: modifiedPrompt as typeof params.prompt,
        };
        captures.set(result.prompt, {
          correlation: {
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
          },
          analysisIds,
          deadline: call.deadline,
        });
        return result;
      });
    },
    wrapGenerate: async ({ params, model, doGenerate }) => {
      const capture = captures.get(params.prompt)!;
      const operation = {
        signal: params.abortSignal,
        deadline: capture.deadline,
      };
      checkOperation(operation);
      await engine.prepareProvider(
        {
          type: 'request',
          api: 'ai-sdk',
          correlation: capture.correlation,
          analysisIds: capture.analysisIds,
          parameters: {
            ...params,
            model: model.modelId,
            provider: model.provider,
          },
        },
        operation,
      );
      checkOperation(operation);
      try {
        const result = await doGenerate();
        const text = (result.content ?? [])
          .filter((part: { type: string }) => part.type === 'text')
          .map((part: { text: string }) => part.text)
          .join('');
        engine.audit({
          type: 'response',
          api: 'ai-sdk',
          correlation: capture.correlation,
          value: result,
        });
        await persistAgent(
          capture.correlation,
          text,
          params.abortSignal,
          result.response?.id,
        );
        return result;
      } catch (error) {
        engine.audit({
          type: 'error',
          api: 'ai-sdk',
          correlation: capture.correlation,
          error:
            error instanceof CaesuraError
              ? error
              : new CaesuraError(
                  params.abortSignal?.aborted ||
                    (error instanceof Error && error.name === 'AbortError')
                    ? 'cancelled'
                    : 'provider',
                  'Provider request failed.',
                  { cause: error },
                ),
        });
        throw error;
      }
    },
    wrapStream: async ({ params, model, doStream }) => {
      const capture = captures.get(params.prompt)!;
      const operation = {
        signal: params.abortSignal,
        deadline: capture.deadline,
      };
      checkOperation(operation);
      await engine.prepareProvider(
        {
          type: 'request',
          api: 'ai-sdk',
          correlation: capture.correlation,
          analysisIds: capture.analysisIds,
          parameters: {
            ...params,
            model: model.modelId,
            provider: model.provider,
          },
        },
        operation,
      );
      checkOperation(operation);
      try {
        const result = await doStream();
        const { stream, ...metadata } = result;
        engine.audit({
          type: 'stream-start',
          api: 'ai-sdk',
          correlation: capture.correlation,
          value: metadata,
        });
        const reader = stream.getReader();
        let text = '';
        let terminal: unknown;
        let failed = false;
        let finished = false;
        let ended = false;
        let cancelled = false;
        const end = async (status: ProviderStreamStatus) => {
          if (ended) return;
          ended = true;
          engine.audit({
            type: 'stream-end',
            api: 'ai-sdk',
            correlation: capture.correlation,
            status,
            value: { text, terminal },
          });
          if (status === 'completed')
            await persistAgent(
              capture.correlation,
              text,
              params.abortSignal,
              metadata.response?.id,
            );
        };
        return {
          ...result,
          stream: new ReadableStream(
            {
              async pull(controller) {
                try {
                  const next = await reader.read();
                  if (cancelled) return;
                  if (next.done) {
                    await end(
                      params.abortSignal?.aborted
                        ? 'cancelled'
                        : failed
                          ? 'failed'
                          : finished
                            ? 'completed'
                            : 'incomplete',
                    );
                    reader.releaseLock();
                    controller.close();
                    return;
                  }
                  const part = next.value;
                  if (part.type === 'text-delta')
                    text += part.delta ?? part.textDelta ?? '';
                  if (part.type === 'finish') {
                    finished = true;
                    terminal = part;
                  }
                  if (part.type === 'error') {
                    failed = true;
                    terminal = part;
                    engine.audit({
                      type: 'error',
                      api: 'ai-sdk',
                      correlation: capture.correlation,
                      error: new CaesuraError(
                        'provider',
                        'Provider emitted an error part.',
                        { cause: part.error },
                      ),
                    });
                  }
                  engine.audit({
                    type: 'chunk',
                    api: 'ai-sdk',
                    correlation: capture.correlation,
                    value: next.value,
                  });
                  controller.enqueue(next.value);
                } catch (error) {
                  await end(
                    params.abortSignal?.aborted ||
                      (error instanceof Error && error.name === 'AbortError')
                      ? 'cancelled'
                      : 'failed',
                  );
                  engine.audit({
                    type: 'error',
                    api: 'ai-sdk',
                    correlation: capture.correlation,
                    error:
                      error instanceof CaesuraError
                        ? error
                        : new CaesuraError(
                            params.abortSignal?.aborted
                              ? 'cancelled'
                              : 'provider',
                            'Provider stream failed.',
                            { cause: error },
                          ),
                  });
                  reader.releaseLock();
                  controller.error(error);
                }
              },
              async cancel(reason) {
                cancelled = true;
                await end('cancelled');
                try {
                  await reader.cancel(reason);
                } finally {
                  reader.releaseLock();
                  await end('cancelled');
                }
              },
            },
            { highWaterMark: 0 },
          ),
        };
      } catch (error) {
        engine.audit({
          type: 'error',
          api: 'ai-sdk',
          correlation: capture.correlation,
          error:
            error instanceof CaesuraError
              ? error
              : new CaesuraError(
                  params.abortSignal?.aborted ||
                    (error instanceof Error && error.name === 'AbortError')
                    ? 'cancelled'
                    : 'provider',
                  'Provider request failed.',
                  { cause: error },
                ),
        });
        throw error;
      }
    },
  } as CaesuraMiddlewareWithConversations;
}
