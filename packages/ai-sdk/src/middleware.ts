import type { CaesuraMiddleware, PromptMessageLike } from './internal/ai-types.js';
import { CaesuraClient } from './client.js';
import { MemoryCaesuraStore, type CaesuraStore, type StoredRecommendation } from './store.js';
import type { CaesuraAnalysis, CaesuraConfig, ResolvedConfig } from './types.js';
import {
  buildAnalyzeMessages,
  collectMessages,
  injectBlock,
  renderBlock,
  selectActive,
} from './helpers.js';

let _idSeq = 0;
const nextId = (): string => `caesura-${Date.now()}-${_idSeq++}`;

function resolveConfig(user: CaesuraConfig): ResolvedConfig {
  const apiKey = user.apiKey ?? process.env.CAESURA_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Caesura: no API key. Pass config.apiKey or set CAESURA_API_KEY.',
    );
  }
  if (!user.baseUrl) {
    throw new Error('Caesura: config.baseUrl is required.');
  }

  return {
    apiKey,
    baseUrl: user.baseUrl,
    callType: user.callType,
    mode: user.mode ?? 'async',
    conversationId: user.conversationId,
    persist: user.persist ?? false,
    calculateSimilarities: user.calculateSimilarities ?? true,
    similarityThreshold: user.similarityThreshold,
    speakerNames: {
      agent: user.speakerNames?.agent ?? 'Agent',
      customer: user.speakerNames?.customer ?? 'Customer',
    },
    cadence: {
      everyTurns: user.cadence?.everyTurns ?? 1,
      everySeconds: user.cadence?.everySeconds ?? 0,
    },
    send: {
      maxMessages: user.send?.maxMessages ?? 10,
      maxInputChars: user.send?.maxInputChars,
    },
    inject: {
      placement: user.inject?.placement ?? 'end',
      as: user.inject?.as ?? 'user',
      keepLast: user.inject?.keepLast ?? 'all',
      ttl: user.inject?.ttl ?? { type: 'none' },
      template: user.inject?.template ?? 'New recommendation:\n{analysis.recommendation}',
      skillPrompt: user.inject?.skillPrompt,
    },
    timeoutMs: user.timeoutMs ?? 8000,
    onError: user.onError ?? ((e) => console.error('[caesura]', e)),
  };
}

/**
 * Caesura language model middleware for the Vercel AI SDK.
 *
 * Observes the dialogue and asynchronously fetches recommendations, then
 * injects buffered recommendations into the prompt before each model call —
 * without blocking the conversation (in 'async' mode).
 */
export function caesuraMiddleware(config: CaesuraConfig): CaesuraMiddleware {
  const cfg = resolveConfig(config);
  const store: CaesuraStore = config.store ?? new MemoryCaesuraStore();
  const client = new CaesuraClient(cfg.baseUrl, cfg.apiKey, cfg.timeoutMs);

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    specificationVersion: 'v3' as any,
    transformParams: async ({ params }) => {
      const prompt = (params.prompt ?? []) as unknown as PromptMessageLike[];

      const convId =
        ((params.providerOptions as Record<string, Record<string, unknown>> | undefined)
          ?.caesura?.conversationId as string | undefined) ??
        cfg.conversationId ??
        'default';

      const state = store.get(convId);
      state.turn += 1;
      const now = Date.now();

      // build self-exclusion set from prior injections
      const injectedTexts = new Set<string>();
      for (const r of state.recommendations) {
        if (r.injectedText) injectedTexts.add(r.injectedText);
      }

      // ── 1. OBSERVE ─────────────────────────────────────────────
      const collected = collectMessages(prompt, cfg.send, cfg.speakerNames, injectedTexts);

      const turnsDue = state.turn - state.lastQueryTurn >= cfg.cadence.everyTurns;
      const secondsDue =
        cfg.cadence.everySeconds <= 0 ||
        now - state.lastQueryMs >= cfg.cadence.everySeconds * 1000;
      const shouldQuery =
        collected.length > 0 && turnsDue && secondsDue && !state.inFlight;

      const observe = async (): Promise<void> => {
        state.inFlight = true;
        state.lastQueryTurn = state.turn;
        state.lastQueryMs = now;
        const queryTurn = state.turn;
        try {
          const messages = buildAnalyzeMessages(collected, state);
          const analysis: CaesuraAnalysis = await client.analyze({
            ...(cfg.persist ? { conversationId: convId, sessionId: convId } : {}),
            callType: cfg.callType,
            messages,
            persist: cfg.persist,
            calculateSimilarities: cfg.calculateSimilarities,
            similarityThreshold: cfg.similarityThreshold,
          });

          // isSame (or no recommendation) -> add nothing; prior stays in context.
          if (analysis.isSame || !analysis.recommendation) return;

          const rec: StoredRecommendation = {
            id: nextId(),
            analysis,
            createdAtMs: Date.now(),
            createdAtTurn: queryTurn,
          };
          store.add(convId, [rec]);
        } catch (e) {
          cfg.onError(e);
        } finally {
          state.inFlight = false;
        }
      };

      if (shouldQuery) {
        if (cfg.mode === 'sync') {
          await observe(); // available THIS turn (adds latency)
        } else {
          void observe(); // fire-and-forget; lands for a future turn
        }
      }

      // ── 2. INJECT ──────────────────────────────────────────────
      const active = selectActive(state, cfg.inject, now);
      if (active.length === 0) return params;

      const block = renderBlock(active, cfg.inject);
      if (block.trim() === '') return params;

      // record the rendered block so the NEXT turn can exclude it on collect.
      for (const r of active) {
        r.injectedText = block;
      }

      const lastAnalyzedText =
        collected.length > 0 ? collected[collected.length - 1]!.text : undefined;

      const newPrompt = injectBlock(prompt, block, cfg.inject, lastAnalyzedText);
      return { ...params, prompt: newPrompt as typeof params.prompt };
    },
  };
}
