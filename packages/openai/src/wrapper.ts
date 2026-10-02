/* eslint-disable @typescript-eslint/no-explicit-any */
import type OpenAI from 'openai';
import {
  createCaesuraEngine,
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
  const engine = createCaesuraEngine(options);
  const cfg = engine.config;

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  const wrapMethod = (originalFn: Function, isResponses: boolean) => {
    return function (this: any, body: any, requestOptions?: any) {
      if (!body) {
        return originalFn.call(this, body, requestOptions);
      }

      const pending = (async () => {
        // 1. Resolve conversationId
        const perCallConvId = requestOptions?.caesura?.conversationId;
        const convId = perCallConvId ?? cfg.conversationId ?? 'default';

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

        // 3. Observe dialogue messages
        const state = engine.store.get(convId);

        const injectedMessages = knownInjectedMessages(state, cfg.inject.as);
        const messagesOrInput = stripInjectedOpenAIMessages(
          isResponses ? body.input : body.messages,
          injectedMessages,
        );
        const collected = collectOpenAIMessages(
          messagesOrInput,
          { maxMessages: 'all' },
          cfg.speakerNames,
          injectedMessages,
        );

        await engine.observe(convId, collected);

        // 4. Inject recommendations and skill prompt
        const active = selectActive(state, cfg.inject, Date.now());
        const modifiedBody = { ...body };

        const targetKey = isResponses ? 'input' : 'messages';
        const skill = applySkillPromptOpenAI(
          messagesOrInput,
          cfg.inject.skillPrompt,
          isResponses ? (body.instructions ?? null) : undefined,
        );
        modifiedBody[targetKey] = skill.result;
        if (isResponses && skill.instructions !== undefined)
          modifiedBody.instructions = skill.instructions;

        const blocks = renderBlock(active, cfg.inject);
        if (blocks.length > 0) {
          const { result, indices } = injectBlocksOpenAI(
            modifiedBody[targetKey],
            blocks,
            cfg.inject,
            cfg.speakerNames,
            injectedMessages,
          );
          modifiedBody[targetKey] = result;
          const injected = blocks.flatMap((block, i) => {
            const index = indices[i]!;
            if (index < 0) return [];
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

        // 5. Call original method
        return {
          request: originalFn.call(this, modifiedBody, cleanRequestOptions),
        };
      })();
      return deferRequest(pending);
    };
  };

  const makeProxy = (target: any, path: string[]): any => {
    return new Proxy(target, {
      get(obj, prop) {
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
