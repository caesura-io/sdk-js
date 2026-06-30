import type { CaesuraMiddleware, PromptMessageLike } from './internal/ai-types.js';
import {
  createCaesuraEngine,
  selectActive,
  renderBlock,
  type CaesuraConfig,
  type CaesuraEvent,
} from '@caesura-io/core';
import {
  collectMessages,
  injectBlocks,
  applySkillPrompt,
} from './helpers.js';

/**
 * Caesura language model middleware for the Vercel AI SDK.
 *
 * Observes the dialogue and asynchronously fetches recommendations, then
 * injects buffered recommendations into the prompt before each model call —
 * without blocking the conversation (in 'async' mode).
 */
export function caesuraMiddleware(config: CaesuraConfig): CaesuraMiddleware {
  const engine = createCaesuraEngine(config);
  const cfg = engine.config;

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    specificationVersion: 'v3' as any,
    transformParams: async ({ params }) => {
      const prompt = (params.prompt ?? []) as unknown as PromptMessageLike[];
      let modifiedPrompt = applySkillPrompt(prompt, cfg.inject.skillPrompt);

      const convId =
        ((params.providerOptions as Record<string, Record<string, unknown>> | undefined)
          ?.caesura?.conversationId as string | undefined) ??
        cfg.conversationId ??
        'default';

      const state = engine.store.get(convId);
      state.turn += 1;
      const now = Date.now();

      // build self-exclusion set from prior injections
      const injectedTexts = new Set<string>();
      for (const r of state.recommendations) {
        if (r.injectedText) injectedTexts.add(r.injectedText);
      }

      // ── 1. OBSERVE ─────────────────────────────────────────────
      const collected = collectMessages(prompt, cfg.send, cfg.speakerNames, injectedTexts);
      await engine.observe(convId, collected);

      // ── 2. INJECT ──────────────────────────────────────────────
      const active = selectActive(state, cfg.inject, now);
      if (active.length > 0) {
        const blocks = renderBlock(active, cfg.inject);
        if (blocks.length > 0) {
          const injectedResult = injectBlocks(modifiedPrompt, blocks, cfg.inject, cfg.speakerNames);
          modifiedPrompt = injectedResult.prompt;
          
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
              index: injectedResult.indices[i]!,
            })),
            placement: cfg.inject.placement,
          } as CaesuraEvent);
        }
      }

      return { ...params, prompt: modifiedPrompt as typeof params.prompt };
    },
  } as CaesuraMiddleware;
}
