import { CaesuraClient, type AnalyzeRequestBody, type AnalyzeMessage } from './client.js';
import { MemoryCaesuraStore, type CaesuraStore, type StoredRecommendation } from './store.js';
import type { CaesuraConfig, ResolvedConfig, CaesuraEvent } from './types.js';
import { buildAnalyzeMessages, hashMessage } from './helpers.js';
import { DEFAULT_SKILL_PROMPT, DEFAULT_TEMPLATE } from './defaults.js';

let _idSeq = 0;
const nextId = (): string => `caesura-${Date.now()}-${_idSeq++}`;

export function resolveConfig(user: CaesuraConfig): ResolvedConfig {
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

export interface CaesuraEngine {
  /** The resolved configuration. */
  readonly config: ResolvedConfig;
  /** The backend HTTP client. */
  readonly client: CaesuraClient;
  /** The conversation store. */
  readonly store: CaesuraStore;

  /**
   * Emit a CaesuraEvent safely (errors routed to onError, never thrown).
   */
  emitEvent(event: CaesuraEvent): void;

  /**
   * Run the observe phase: check cadence, fire analyze, buffer recommendation,
   * trigger credit callback. Respects mode (sync vs async).
   *
   * @param convId      The conversation id for this turn.
   * @param collected   Vendor-adapted messages (already in AnalyzeMessage format).
   *                    Pass empty array if no messages available.
   * @returns Promise that resolves when sync mode observe completes;
   *          in async mode, observe is fire-and-forget and this resolves immediately.
   */
  observe(convId: string, collected: AnalyzeMessage[]): Promise<void>;
}

/**
 * Create a framework-agnostic Caesura engine.
 * Integration packages (ai-sdk, openai) use this to delegate all
 * vendor-neutral orchestration.
 */
export function createCaesuraEngine(config: CaesuraConfig): CaesuraEngine {
  const cfg = resolveConfig(config);
  const store: CaesuraStore = config.store ?? new MemoryCaesuraStore();
  const client = new CaesuraClient(cfg.baseUrl, cfg.apiKey, cfg.timeoutMs);

  const emitEvent = (event: CaesuraEvent) => {
    if (cfg.onEvent) {
      try {
        cfg.onEvent(event);
      } catch (e) {
        cfg.onError(e);
      }
    }
  };

  const observe = async (convId: string, collected: AnalyzeMessage[]): Promise<void> => {
    const state = store.get(convId);
    const now = Date.now();

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
      return;
    }

    const doObserve = async (): Promise<void> => {
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

    if (cfg.mode === 'sync') {
      await doObserve(); // available THIS turn (adds latency)
    } else {
      void doObserve(); // fire-and-forget; lands for a future turn
    }
  };

  return {
    config: cfg,
    client,
    store,
    emitEvent,
    observe,
  };
}
