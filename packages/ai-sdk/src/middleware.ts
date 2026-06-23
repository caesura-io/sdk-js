import type { CaesuraMiddleware, PromptMessageLike } from './internal/ai-types.js';
import { CaesuraClient, type AnalyzeRequestBody } from './client.js';
import { MemoryCaesuraStore, type CaesuraStore, type StoredRecommendation } from './store.js';
import type { CaesuraAnalysis, CaesuraConfig, ResolvedConfig, CaesuraEvent } from './types.js';
import {
  buildAnalyzeMessages,
  collectMessages,
  hashMessage,
  injectBlocks,
  renderBlock,
  selectActive,
  applySkillPrompt,
} from './helpers.js';
import { DEFAULT_SKILL_PROMPT, DEFAULT_TEMPLATE } from './defaults.js';

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
      placement: user.inject?.placement ?? 'after-last-analyzed',
      as: user.inject?.as ?? 'user',
      keepLast: user.inject?.keepLast ?? 'all',
      ttl: user.inject?.ttl ?? { type: 'none' },
      template: user.inject?.template ?? DEFAULT_TEMPLATE,
      skillPrompt: user.inject?.skillPrompt ?? DEFAULT_SKILL_PROMPT,
    },
    timeoutMs: user.timeoutMs ?? 8000,
    onError: user.onError ?? ((e) => console.error('[caesura]', e)),
    includeCreditUsage: !!user.onCreditUsage || !!user.onEvent,
    onCreditUsage: user.onCreditUsage,
    onEvent: user.onEvent,
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
      let modifiedPrompt = applySkillPrompt(prompt, cfg.inject.skillPrompt);

      const convId =
        ((params.providerOptions as Record<string, Record<string, unknown>> | undefined)
          ?.caesura?.conversationId as string | undefined) ??
        cfg.conversationId ??
        'default';

      const emitEvent = (event: CaesuraEvent) => {
        if (cfg.onEvent) {
          try {
            cfg.onEvent(event);
          } catch (e) {
            cfg.onError(e);
          }
        }
      };

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

      if (!shouldQuery) {
        let reason: 'cadence-turns' | 'cadence-seconds' | 'in-flight' | 'no-messages';
        if (collected.length === 0) {
          reason = 'no-messages';
        } else if (state.inFlight) {
          reason = 'in-flight';
        } else if (!turnsDue) {
          reason = 'cadence-turns';
        } else {
          reason = 'cadence-seconds';
        }
        emitEvent({
          type: 'skipped',
          conversationId: convId,
          turn: state.turn,
          reason,
        });
      }

      const observe = async (): Promise<void> => {
        state.inFlight = true;
        state.lastQueryTurn = state.turn;
        state.lastQueryMs = now;
        const queryTurn = state.turn;
        try {
          const messages = buildAnalyzeMessages(collected, state);
          const body: AnalyzeRequestBody = {
            ...(cfg.persist ? { conversationId: convId, sessionId: convId } : {}),
            callType: cfg.callType,
            messages,
            persist: cfg.persist,
            calculateSimilarities: cfg.calculateSimilarities,
            similarityThreshold: cfg.similarityThreshold,
          };

          emitEvent({
            type: 'request',
            conversationId: convId,
            queryTurn,
            body,
            includeCreditUsage: cfg.includeCreditUsage,
          });

          const startTime = Date.now();
          const { analysis, creditUsage } = await client.analyze(
            body,
            { includeCreditUsage: cfg.includeCreditUsage },
          );
          const durationMs = Date.now() - startTime;

          emitEvent({
            type: 'response',
            conversationId: convId,
            queryTurn,
            analysis,
            creditUsage,
            durationMs,
          });

          let rec: StoredRecommendation | undefined;

          // isSame (or no recommendation) -> add nothing; prior stays in context.
          if (!analysis.isSame && analysis.recommendation) {
            const lastCollected = collected[collected.length - 1]!;
            rec = {
              id: nextId(),
              analysis,
              afterMessageHash: hashMessage(lastCollected.speakerName ?? '', lastCollected.text),
              createdAtMs: Date.now(),
              createdAtTurn: queryTurn,
            };
            store.add(convId, [rec]);
            emitEvent({
              type: 'buffered',
              conversationId: convId,
              queryTurn,
              recommendationId: rec.id,
            });
          } else {
            emitEvent({
              type: 'deduped',
              conversationId: convId,
              queryTurn,
            });
          }

          if (creditUsage != null && cfg.onCreditUsage) {
            try {
              cfg.onCreditUsage({
                credits: creditUsage,
                conversationId: convId,
                queryTurn,
                recommendationId: rec?.id,
                isSame: analysis.isSame,
                timestampMs: Date.now(),
              });
            } catch (e) {
              cfg.onError(e);
            }
          }
        } catch (e) {
          emitEvent({
            type: 'error',
            conversationId: convId,
            error: e,
          });
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
      if (active.length > 0) {
        const blocks = renderBlock(active, cfg.inject);
        if (blocks.length > 0) {
          const injectedResult = injectBlocks(modifiedPrompt, blocks, cfg.inject, cfg.speakerNames);
          modifiedPrompt = injectedResult.prompt;
          
          for (let i = 0; i < active.length; i++) {
            active[i]!.injectedText = blocks[i]!.text;
          }

          emitEvent({
            type: 'injected',
            conversationId: convId,
            turn: state.turn,
            blocks: blocks.map((b, i) => ({
              recommendationId: b.recommendationId,
              text: b.text,
              index: injectedResult.indices[i]!,
            })),
            placement: cfg.inject.placement,
          });
        }
      }

      return { ...params, prompt: modifiedPrompt as typeof params.prompt };
    },
  };
}
