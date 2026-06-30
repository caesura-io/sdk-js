/* eslint-disable @typescript-eslint/no-explicit-any */
import type OpenAI from 'openai';
import {
  createCaesuraEngine,
  selectActive,
  renderBlock,
  type CaesuraEvent,
} from '@caesura-io/core';
import type { CaesuraOpenAIOptions } from './types.js';
import {
  collectOpenAIMessages,
  applySkillPromptOpenAI,
  injectBlocksOpenAI,
} from './adapters.js';

export function createCaesura(openai: OpenAI, options: CaesuraOpenAIOptions): OpenAI {
  const engine = createCaesuraEngine(options);
  const cfg = engine.config;

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  const wrapMethod = (originalFn: Function, isResponses: boolean) => {
    return async function (this: any, body: any, requestOptions?: any) {
      if (!body) {
        return originalFn.call(this, body, requestOptions);
      }

      // 1. Resolve conversationId
      const perCallConvId = requestOptions?.caesura?.conversationId;
      const convId = perCallConvId ?? cfg.conversationId ?? 'default';

      // 2. Strip 'caesura' option from RequestOptions to avoid breaking other wrappers or the SDK itself
      let cleanRequestOptions = requestOptions;
      if (requestOptions && typeof requestOptions === 'object' && 'caesura' in requestOptions) {
        const rest = { ...requestOptions };
        delete rest.caesura;
        cleanRequestOptions = rest;
      }

      // 3. Observe dialogue messages
      const state = engine.store.get(convId);
      state.turn += 1;
      const now = Date.now();

      const injectedTexts = new Set<string>();
      for (const r of state.recommendations) {
        if (r.injectedText) {
          injectedTexts.add(r.injectedText);
        }
      }

      const messagesOrInput = isResponses ? body.input : body.messages;
      const collected = collectOpenAIMessages(messagesOrInput, cfg.send, cfg.speakerNames, injectedTexts);

      await engine.observe(convId, collected);

      // 4. Inject recommendations and skill prompt
      const active = selectActive(state, cfg.inject, now);
      const modifiedBody = { ...body };

      if (active.length > 0) {
        const blocks = renderBlock(active, cfg.inject);
        if (blocks.length > 0) {
          // A. Apply skill prompt
          if (isResponses) {
            const { result: newInput, instructions: newInstructions } = applySkillPromptOpenAI(
              body.input,
              cfg.inject.skillPrompt,
              body.instructions,
            );
            modifiedBody.input = newInput;
            if (newInstructions !== undefined) {
              modifiedBody.instructions = newInstructions;
            }
          } else {
            const { result: newMessages } = applySkillPromptOpenAI(
              body.messages,
              cfg.inject.skillPrompt,
            );
            modifiedBody.messages = newMessages;
          }

          // B. Inject blocks
          const targetInputOrMessages = isResponses ? modifiedBody.input : modifiedBody.messages;
          const { result: finalInputOrMessages, indices } = injectBlocksOpenAI(
            targetInputOrMessages,
            blocks,
            cfg.inject,
            cfg.speakerNames,
          );

          if (isResponses) {
            modifiedBody.input = finalInputOrMessages;
          } else {
            modifiedBody.messages = finalInputOrMessages;
          }

          for (let i = 0; i < active.length; i++) {
            active[i]!.injectedText = blocks[i]!.text;
          }

          engine.emitEvent({
            type: 'injected',
            conversationId: convId,
            turn: state.turn,
            blocks: blocks.map((b, i) => ({
              recommendationId: b.recommendationId,
              text: b.text,
              index: indices[i]!,
            })),
            placement: cfg.inject.placement,
          } as CaesuraEvent);
        }
      } else {
        // Even if no recommendations are active, apply skill prompt if present
        if (isResponses) {
          const { result: newInput, instructions: newInstructions } = applySkillPromptOpenAI(
            body.input,
            cfg.inject.skillPrompt,
            body.instructions,
          );
          modifiedBody.input = newInput;
          if (newInstructions !== undefined) {
            modifiedBody.instructions = newInstructions;
          }
        } else {
          const { result: newMessages } = applySkillPromptOpenAI(
            body.messages,
            cfg.inject.skillPrompt,
          );
          modifiedBody.messages = newMessages;
        }
      }

      // 5. Call original method
      return originalFn.call(this, modifiedBody, cleanRequestOptions);
    };
  };

  const makeProxy = (target: any, path: string[]): any => {
    return new Proxy(target, {
      get(obj, prop) {
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
          return wrapMethod(value, false);
        }

        // Intercept client.responses.create
        if (
          currentPath.length === 2 &&
          currentPath[0] === 'responses' &&
          currentPath[1] === 'create' &&
          typeof value === 'function'
        ) {
          return wrapMethod(value, true);
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
