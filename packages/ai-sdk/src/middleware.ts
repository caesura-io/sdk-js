import type {
  CaesuraMiddleware,
  PromptMessageLike,
} from './internal/ai-types.js';
import {
  createCaesuraEngine,
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
  createConversation: import('@caesura-io/core').CaesuraEngine['createConversation'];
};

export function caesuraMiddleware(
  config: CaesuraConfig,
): CaesuraMiddlewareWithConversations {
  const engine = createCaesuraEngine(config);
  const cfg = engine.config;

  return {
    createConversation: engine.createConversation,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    specificationVersion: 'v3' as any,
    transformParams: async ({ params }) => {
      let prompt = (params.prompt ?? []) as unknown as PromptMessageLike[];

      const convId =
        ((
          params.providerOptions as
            | Record<string, Record<string, unknown>>
            | undefined
        )?.caesura?.conversationId as string | undefined) ??
        cfg.conversationId ??
        'default';

      const state = engine.store.get(convId);

      const injectedMessages = knownInjectedMessages(
        state,
        cfg.inject.as === 'developer' ? 'system' : cfg.inject.as,
      );
      prompt = stripInjectedMessages(prompt, injectedMessages);
      let modifiedPrompt = applySkillPrompt(prompt, cfg.inject.skillPrompt);

      // ── 1. OBSERVE ─────────────────────────────────────────────
      const collected = collectMessages(
        prompt,
        { maxMessages: 'all' },
        cfg.speakerNames,
        injectedMessages,
      );
      await engine.observe(convId, collected);

      // ── 2. INJECT ──────────────────────────────────────────────
      const active = selectActive(state, cfg.inject, Date.now());
      if (active.length > 0) {
        const blocks = renderBlock(active, cfg.inject);
        if (blocks.length > 0) {
          const injectedResult = injectBlocks(
            modifiedPrompt,
            blocks,
            cfg.inject,
            cfg.speakerNames,
            injectedMessages,
          );
          modifiedPrompt = injectedResult.prompt;

          for (let i = 0; i < blocks.length; i++) {
            const index = injectedResult.indices[i]!;
            if (index < 0) continue;
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

      return { ...params, prompt: modifiedPrompt as typeof params.prompt };
    },
  } as CaesuraMiddlewareWithConversations;
}
