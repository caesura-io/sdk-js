import {
  CaesuraClient,
  type AnalyzeRequestBody,
  type AnalyzeMessage,
  type CreateConversationOptions,
} from './client.js';
import {
  MemoryCaesuraStore,
  type CaesuraStore,
  type StoredRecommendation,
} from './store.js';
import type { CaesuraConfig, ResolvedConfig, CaesuraEvent } from './types.js';
import {
  buildAnalyzeMessages,
  dialogueAnchors,
  hashMessage,
  hasAnalysis,
} from './helpers.js';
import { DEFAULT_SKILL_PROMPT, DEFAULT_TEMPLATE } from './defaults.js';

let _idSeq = 0;
const nextId = (): string => `caesura-${Date.now()}-${_idSeq++}`;

export function resolveConfig(user: CaesuraConfig): ResolvedConfig {
  if (!user || typeof user !== 'object' || Array.isArray(user)) {
    throw new TypeError('CaesuraO: expected a configuration object.');
  }
  const apiKey = user.apiKey ?? process.env.CAESURA_API_KEY;
  if (!apiKey) {
    throw new Error(
      'CaesuraO: no API key. Pass config.apiKey or set CAESURA_API_KEY.',
    );
  }
  for (const [name, value] of Object.entries({
    'send.maxMessages': user.send?.maxMessages,
    'send.maxInputChars': user.send?.maxInputChars,
    'inject.keepLast': user.inject?.keepLast,
  })) {
    if (
      value !== undefined &&
      value !== 'all' &&
      (!Number.isInteger(value) || value < 0)
    ) {
      throw new Error(`CaesuraO: ${name} must be a nonnegative integer.`);
    }
  }
  const onError = (error: unknown) => {
    try {
      const result = (user.onError ?? ((e) => console.error('[caesura]', e)))(
        error,
      );
      void Promise.resolve(result).catch(() => {});
    } catch {
      /* Observability must never interrupt model requests. */
    }
  };

  return {
    apiKey,
    baseUrl: user.baseUrl ?? 'https://api.caesurao.com',
    callType: user.callType,
    mode: user.mode ?? 'async',
    conversationId: user.conversationId,
    persist: user.persist ?? true,
    autoCreateConversation: user.autoCreateConversation ?? false,
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
    onError,
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

  /** Create once and reuse the backend ID; explicit failures propagate. */
  createConversation(options?: CreateConversationOptions): Promise<string>;

  /** Emit safely: callback errors are routed to onError, never thrown. */
  emitEvent(event: CaesuraEvent): void;

  /**
   * Run the observe phase: check cadence, fire analyze, buffer recommendation,
   * trigger credit callback. Advances the turn once, including skipped observations.
   * Respects mode (sync vs async); wrappers must not increment the turn.
   *
   * @param convId      The conversation id for this turn.
   * @param collected   Dialogue only. An assistant role here may select the agent
   *                    default name; both participants are sent as user to CaesuraO.
   *                    Pass empty array if no messages available.
   * @returns Promise that resolves when sync mode observe completes;
   *          in async mode, observe is fire-and-forget and this resolves immediately.
   */
  observe(convId: string, collected: AnalyzeMessage[]): Promise<void>;
}

/**
 * Create a framework-agnostic CaesuraO engine.
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
        void Promise.resolve(cfg.onEvent(event)).catch(cfg.onError);
      } catch (e) {
        cfg.onError(e);
      }
    }
  };

  const observe = async (
    convId: string,
    collected: AnalyzeMessage[],
  ): Promise<void> => {
    const state = store.get(convId);
    state.turn += 1;
    const queryTurn = state.turn;
    // Snapshot primitive message fields before any background work or awaits.
    collected = collected
      .filter(
        (m) =>
          (m.speakerRole === 'user' || m.speakerRole === 'assistant') &&
          m.text.trim(),
      )
      .map((m) => ({
        ...m,
        speakerIndex: m.speakerIndex ?? (m.speakerRole === 'assistant' ? 0 : 1),
        speakerName:
          m.speakerName ??
          (m.speakerRole === 'assistant'
            ? cfg.speakerNames.agent
            : cfg.speakerNames.customer),
      }));
    const afterMessageAnchor = dialogueAnchors(collected).at(-1);
    const now = Date.now();

    const turnsDue = state.turn - state.lastQueryTurn >= cfg.cadence.everyTurns;
    const secondsDue =
      cfg.cadence.everySeconds <= 0 ||
      now - state.lastQueryMs >= cfg.cadence.everySeconds * 1000;
    const shouldQuery =
      collected.length > 0 &&
      cfg.send.maxMessages !== 0 &&
      cfg.send.maxInputChars !== 0 &&
      turnsDue &&
      secondsDue &&
      !state.inFlight;

    if (!shouldQuery) {
      let reason:
        | 'cadence-turns'
        | 'cadence-seconds'
        | 'in-flight'
        | 'no-messages';
      if (
        collected.length === 0 ||
        cfg.send.maxMessages === 0 ||
        cfg.send.maxInputChars === 0
      ) {
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

    state.inFlight = true;
    state.lastQueryTurn = queryTurn;
    state.lastQueryMs = now;
    const doObserve = async (): Promise<void> => {
      try {
        const messages = buildAnalyzeMessages(collected, state, cfg.send);
        let backendId = convId;
        if (cfg.persist && cfg.autoCreateConversation) {
          state.backendConversationId ??= await client.createConversation();
          backendId = state.backendConversationId;
        }
        const body: AnalyzeRequestBody = {
          ...(cfg.persist
            ? { conversationId: backendId, sessionId: backendId }
            : {}),
          callType: cfg.callType,
          currentUser: cfg.speakerNames.agent,
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
        const { analysis, creditUsage, isSame } = await client.analyze(body, {
          includeCreditUsage: cfg.includeCreditUsage,
        });
        const durationMs = Date.now() - startTime;

        emitEvent({
          type: 'response',
          conversationId: convId,
          queryTurn,
          analysis,
          creditUsage,
          isSame,
          durationMs,
        });

        let rec: StoredRecommendation | undefined;

        // Explicit duplicates and empty payloads leave prior guidance in context.
        if (isSame !== true && hasAnalysis(analysis)) {
          const lastCollected = collected[collected.length - 1]!;
          rec = {
            id: nextId(),
            analysis,
            afterMessageHash: hashMessage(
              lastCollected.speakerName ?? '',
              lastCollected.text,
            ),
            afterMessageAnchor,
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
            const callbackResult = cfg.onCreditUsage({
              credits: creditUsage,
              conversationId: convId,
              queryTurn,
              recommendationId: rec?.id,
              isSame,
              timestampMs: Date.now(),
            });
            void Promise.resolve(callbackResult).catch(cfg.onError);
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
    async createConversation(options) {
      const id = await client.createConversation(options);
      store.get(id).backendConversationId = id;
      return id;
    },
  };
}
