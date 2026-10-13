import { copyProviderValue } from './copy.js';
import { sdkIdentity } from './provenance.js';
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
  normalizeDialogue,
  dialogueAnchors,
  hashMessage,
  hasAnalysis,
} from './helpers.js';
import { HttpAnalysisTransport } from './client.js';
import type { ConversationState } from './store.js';
import {
  CaesuraError,
  checkOperation,
  type OperationContext,
  auditSnapshot,
  snapshotObservation,
  requireConversationId,
  type CreationContext,
  type SdkIdentity,
  type TranscriptMessage,
  type AnalysisTransport,
  type AnalysisContext,
  type ObservationOptions,
  type AnalysisCompletion,
  type ProviderAuditEvent,
  type Correlation,
} from './contracts.js';
import { DEFAULT_SKILL_PROMPT, DEFAULT_TEMPLATE } from './defaults.js';

let _idSeq = 0;
const nextId = (): string => `caesura-${Date.now()}-${_idSeq++}`;

export function resolveConfig(user: CaesuraConfig): ResolvedConfig {
  if (!user || typeof user !== 'object' || Array.isArray(user)) {
    throw new TypeError('CaesuraO: expected a configuration object.');
  }
  if (user.transport && typeof user.transport.analyze !== 'function')
    throw new TypeError(
      'CaesuraO: transport must implement analyze(input, context).',
    );
  if (
    user.failurePolicy !== undefined &&
    !['continue', 'throw'].includes(user.failurePolicy)
  )
    throw new TypeError('CaesuraO: failurePolicy must be continue or throw.');
  if (
    user.timeoutMs !== undefined &&
    (!Number.isFinite(user.timeoutMs) || user.timeoutMs < 0)
  )
    throw new TypeError(
      'CaesuraO: timeoutMs must be a nonnegative finite number.',
    );
  if ('autoCreateConversation' in user)
    throw new CaesuraError(
      'configuration',
      'CaesuraO: autoCreateConversation was removed. Call createConversation() explicitly and reuse the returned conversationId.',
    );
  const apiKey =
    user.apiKey ??
    (typeof process !== 'undefined' ? process.env.CAESURA_API_KEY : undefined);
  if (!apiKey && !user.transport) {
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
    includeCreditUsage:
      !!user.onCreditUsage ||
      !!user.onEvent ||
      !!user.persistAnalysis ||
      !!user.onCompletion,
    onCreditUsage: user.onCreditUsage,
    onEvent: user.onEvent,
  };
}

export interface CaesuraEngine {
  readonly config: ResolvedConfig;
  readonly sdk: SdkIdentity;
  /** Await application transcript upserts; never triggers analysis. */
  recordMessages(
    conversationId: string,
    messages: readonly TranscriptMessage[],
    context?: ObservationOptions,
  ): Promise<void>;
  readonly client?: CaesuraClient;
  readonly transport: AnalysisTransport;
  readonly store: CaesuraStore;
  /** Aborted by clear/reset/shutdown; obtain a fresh signal for each invocation. */
  getSignal(convId: string): AbortSignal;
  createConversation(
    options?: CreateConversationOptions,
    observation?: ObservationOptions,
  ): Promise<string>;
  emitEvent(event: CaesuraEvent): void;
  observe(
    convId: string,
    collected: AnalyzeMessage[],
    options?: ObservationOptions,
  ): Promise<void>;
  getState(convId: string): Promise<ConversationState>;
  /** Serializes awaited read/modify/write, including detached stores. */
  updateState<T>(
    convId: string,
    update: (state: ConversationState) => T | Promise<T>,
  ): Promise<T>;
  /** Wait for work accepted before this call; returns errors even under continue policy. */
  flush(convId?: string): Promise<AnalysisCompletion[]>;
  clear(convId: string): Promise<void>;
  clearAll(): Promise<void>;
  shutdown(options?: { cancel?: boolean }): Promise<AnalysisCompletion[]>;
  audit(event: ProviderAuditEvent): void;
  prepareProvider(
    event: Extract<ProviderAuditEvent, { type: 'request' }>,
    context?: OperationContext,
  ): Promise<void>;
}

function failure(error: unknown, kind: 'store' | 'transport'): CaesuraError {
  if (error instanceof CaesuraError) return error;
  if (error instanceof Error && error.name === 'TimeoutError')
    return new CaesuraError('timeout', 'CaesuraO: deadline exceeded.', {
      cause: error,
    });
  if (error instanceof Error && error.name === 'AbortError')
    return new CaesuraError('cancelled', 'CaesuraO: cancelled.', {
      cause: error,
    });
  return new CaesuraError(kind, `CaesuraO ${kind} failure.`, { cause: error });
}
function check(signal?: AbortSignal): void {
  checkOperation({ signal });
}
/** Abort promptly even when an application transport ignores its signal. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createCaesuraEngine(
  config: CaesuraConfig,
  integration?: SdkIdentity['integration'],
): CaesuraEngine {
  const cfg = resolveConfig(config);
  const store = config.store ?? new MemoryCaesuraStore();
  if (typeof store.set !== 'function')
    throw new TypeError(
      'CaesuraO stores must implement set(conversationId, state).',
    );
  const client = config.transport
    ? undefined
    : new CaesuraClient(cfg.baseUrl, cfg.apiKey!, cfg.timeoutMs);
  const transport = config.transport ?? new HttpAnalysisTransport(client!);
  const sdk = sdkIdentity(
    transport instanceof HttpAnalysisTransport ? 'http' : 'in-process',
    integration,
  );
  const safe = <T>(callback: ((value: T) => unknown) | undefined, value: T) => {
    try {
      void Promise.resolve(callback?.(value)).catch(cfg.onError);
    } catch (error) {
      cfg.onError(error);
    }
  };
  const emitEvent = (event: CaesuraEvent) =>
    safe(cfg.onEvent, event.type === 'error' ? event : structuredClone(event));
  let resetBarrier: Promise<void> = Promise.resolve();
  const locks = new Map<string, Promise<unknown>>();
  const queues = new Map<string, Promise<void>>();
  const pending = new Map<string, Set<AbortController>>();
  const completions: AnalysisCompletion[] = [];
  const creations = new Set<Promise<string>>();
  let closed = false;
  const shutdownController = new AbortController();
  const sessions = new Map<string, AbortController>();
  const getSignal = (id: string) => {
    requireConversationId(id);
    let session = sessions.get(id);
    if (!session) {
      session = new AbortController();
      sessions.set(id, session);
    }
    if (closed)
      session.abort(
        new CaesuraError('cancelled', 'CaesuraO: engine is shut down.'),
      );
    return session.signal;
  };
  // Only short state transactions hold this lock, never network work.
  const locked = <T>(id: string, action: () => Promise<T>): Promise<T> => {
    requireConversationId(id);
    const prior = locks.get(id) ?? Promise.resolve();
    const barrier = resetBarrier;
    const task = prior
      .catch(() => {})
      .then(() => barrier)
      .then(action);
    locks.set(id, task);
    void task
      .finally(() => {
        if (locks.get(id) === task) locks.delete(id);
      })
      .catch(() => {});
    return task;
  };
  const read = async (id: string) => {
    try {
      return structuredClone(await store.get(id));
    } catch (error) {
      throw failure(error, 'store');
    }
  };
  const write = async (id: string, state: ConversationState) => {
    state.inFlight = false;
    try {
      await store.set(id, structuredClone(state));
    } catch (error) {
      throw failure(error, 'store');
    }
  };
  const updateState = <T>(
    id: string,
    update: (state: ConversationState) => T | Promise<T>,
  ): Promise<T> =>
    locked(id, async () => {
      try {
        const state = await read(id);
        const result = await update(state);
        await write(id, state);
        return result;
      } catch (error) {
        const e = failure(error, 'store');
        cfg.onError(e);
        if (config.failurePolicy === 'throw' || e.kind === 'cancelled') throw e;
        // Continue with a transient state when storage is unavailable.
        return update(new MemoryCaesuraStore().get(id));
      }
    });
  const getState = (id: string) =>
    locked(id, async () => {
      try {
        return await read(id);
      } catch (error) {
        cfg.onError(error);
        if (config.failurePolicy === 'throw') throw error;
        return new MemoryCaesuraStore().get(id);
      }
    });
  const report = (completion: AnalysisCompletion) => {
    completions.push(completion);
    safe(config.onCompletion, {
      ...copyProviderValue(completion),
      error: completion.error,
    });
    if (completion.error) {
      emitEvent({
        type: 'error',
        conversationId: completion.correlation.conversationId,
        error: completion.error,
      });
      cfg.onError(completion.error);
    }
  };
  const create = async (
    options: CreateConversationOptions,
    context: CreationContext,
  ) => {
    check(context.signal);
    if (context.deadline <= Date.now())
      throw new CaesuraError(
        'timeout',
        'CaesuraO: creation deadline exceeded.',
      );
    if (!transport.createConversation)
      throw new CaesuraError(
        'unsupported',
        'CaesuraO: this transport does not support conversation creation.',
      );
    const id = await abortable(
      transport.createConversation(options, context),
      context.signal,
    );
    if (typeof id !== 'string' || !id.trim())
      throw new CaesuraError(
        'transport',
        'CaesuraO: conversation creation must return a nonempty string ID.',
      );
    return id;
  };
  const recordMessages = async (
    id: string,
    messages: readonly TranscriptMessage[],
    options: ObservationOptions = {},
  ) => {
    requireConversationId(id);
    options = snapshotObservation(options);
    const snapshot = structuredClone(messages);
    for (const message of snapshot) {
      if (
        typeof message.id !== 'string' ||
        !message.id.trim() ||
        !['customer', 'agent'].includes(message.role) ||
        typeof message.text !== 'string'
      )
        throw new CaesuraError(
          'configuration',
          'CaesuraO: transcript entries require an ID, customer/agent role and text.',
        );
    }
    const signal = AbortSignal.any([
      getSignal(id),
      ...(options.signal ? [options.signal] : []),
      ...(options.deadline !== undefined
        ? [
            AbortSignal.timeout(
              Math.ceil(Math.max(0, options.deadline - Date.now())),
            ),
          ]
        : []),
    ]);
    check(signal);
    if (options.deadline !== undefined && options.deadline <= Date.now())
      throw new CaesuraError(
        'timeout',
        'CaesuraO: transcript deadline exceeded.',
      );
    try {
      await abortable(
        Promise.resolve().then(() =>
          config.persistMessages?.({
            correlation: {
              conversationId: id,
              sdk,
              customerTurnId:
                options.turn?.origin === 'customer'
                  ? options.turn.id
                  : undefined,
              invocationId: options.invocationId,
              metadata: options.metadata,
            },
            messages: snapshot,
          }),
        ),
        signal,
      );
      check(signal);
    } catch (error) {
      const e = failure(error, 'store');
      cfg.onError(e);
      emitEvent({ type: 'error', conversationId: id, error: e });
      if (
        config.failurePolicy === 'throw' ||
        e.kind === 'cancelled' ||
        e.kind === 'timeout'
      )
        throw e;
    }
  };
  const observe = async (
    convId: string,
    input: AnalyzeMessage[],
    options: ObservationOptions = {},
  ) => {
    requireConversationId(convId);
    options = snapshotObservation(options);
    options.signal = AbortSignal.any([
      getSignal(convId),
      ...(options.signal ? [options.signal] : []),
    ]);
    check(options.signal);
    if (closed)
      throw new CaesuraError('cancelled', 'CaesuraO: engine is shut down.');
    // Snapshot before scheduling/awaiting. Selection metadata never enters HTTP bodies.
    const collected = normalizeDialogue(
      options.dialogue ?? input,
      cfg.speakerNames,
    );
    const anchor = dialogueAnchors(collected).at(-1);
    const turn = options.turn
      ? { ...options.turn }
      : collected.at(-1)?.speakerRole === 'user' && anchor
        ? { id: anchor, origin: 'customer' as const }
        : undefined;
    // Explicit internal calls can still inject existing guidance in adapters.
    if (!turn || turn.origin !== 'customer' || !collected.length) {
      emitEvent({
        type: 'skipped',
        conversationId: convId,
        turn: 0,
        reason: 'no-messages',
      });
      return;
    }
    if (!turn.id.trim())
      throw new TypeError('CaesuraO: customer turn ID must not be empty.');
    const correlation: Correlation = {
      sdk,
      conversationId: convId,
      customerTurnId: turn.id,
      invocationId: options.invocationId,
      analysisId: nextId(),
      metadata: options.metadata
        ? copyProviderValue(options.metadata)
        : undefined,
    };
    const ctrl = new AbortController();
    const onAbort = () =>
      ctrl.abort(
        new CaesuraError('cancelled', 'CaesuraO: cancelled.', {
          cause: options.signal?.reason,
        }),
      );
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const controllers = pending.get(convId) ?? new Set<AbortController>();
    pending.set(convId, controllers);
    controllers.add(ctrl);
    if (store instanceof MemoryCaesuraStore) store.pin(convId);
    const deadline = Math.min(
      options.deadline ?? Infinity,
      Date.now() + cfg.timeoutMs,
    );
    if (deadline <= Date.now())
      ctrl.abort(
        new CaesuraError('timeout', 'CaesuraO: analysis deadline exceeded.'),
      );
    const timer = setTimeout(
      () =>
        ctrl.abort(
          new CaesuraError('timeout', 'CaesuraO: analysis deadline exceeded.'),
        ),
      Math.max(0, deadline - Date.now()),
    );
    const context: AnalysisContext = {
      ...correlation,
      sdk,
      signal: ctrl.signal,
      deadline,
      includeCreditUsage:
        cfg.includeCreditUsage ||
        !!config.persistAnalysis ||
        !!config.onCompletion,
    };
    const current = collected.at(-1)!;
    // Reserve the FIFO position and pin state before awaiting transcript storage.
    const transcript =
      config.persistMessages && current.speakerRole === 'user'
        ? recordMessages(
            convId,
            [
              {
                id: turn.id,
                role: 'customer',
                text: current.text,
                speakerName: current.speakerName,
                speakerIndex: current.speakerIndex,
              },
            ],
            { ...options, turn, signal: ctrl.signal, deadline },
          )
        : Promise.resolve();
    void transcript.catch(() => {});
    const run = async () => {
      let result: import('./client.js').AnalyzeResult | undefined;
      let queryTurn = 0;
      try {
        await abortable(transcript, ctrl.signal);
        if (ctrl.signal.aborted) throw ctrl.signal.reason;
        const state = await locked(convId, async () => {
          const current = await read(convId);
          if (ctrl.signal.aborted) throw ctrl.signal.reason;
          if (current.processedTurnIds?.includes(turn.id)) {
            const outcome =
              current.turnOutcomes &&
              Object.hasOwn(current.turnOutcomes, turn.id)
                ? current.turnOutcomes[turn.id]
                : undefined;
            if (
              config.failurePolicy === 'throw' &&
              outcome &&
              (outcome.status === 'pending' || outcome.status === 'failed')
            ) {
              throw new CaesuraError(
                outcome.error?.kind ?? 'store',
                outcome.error?.message ??
                  'CaesuraO: prior analysis outcome is unknown; reconcile before retrying.',
              );
            }
            return undefined;
          }
          (current.processedTurnIds ??= []).push(turn.id);
          current.turn++;
          current.turnNumbers = {
            ...current.turnNumbers,
            [turn.id]: current.turn,
          };
          queryTurn = current.turn;
          const turnsDue =
            !current.lastQueryTurn ||
            current.turn - current.lastQueryTurn >= cfg.cadence.everyTurns;
          const secondsDue =
            !current.lastQueryMs ||
            Date.now() - current.lastQueryMs >= cfg.cadence.everySeconds * 1000;
          const due =
            cfg.send.maxMessages !== 0 &&
            cfg.send.maxInputChars !== 0 &&
            turnsDue &&
            secondsDue;
          if (due) {
            current.lastQueryTurn = current.turn;
            current.lastQueryMs = Date.now();
          }
          current.turnOutcomes = {
            ...current.turnOutcomes,
            [turn.id]: { status: due ? 'pending' : 'skipped' },
          };
          await write(convId, current);
          if (!due)
            emitEvent({
              type: 'skipped',
              conversationId: convId,
              turn: current.turn,
              reason: !turnsDue
                ? 'cadence-turns'
                : !secondsDue
                  ? 'cadence-seconds'
                  : 'no-messages',
            });
          return due ? current : undefined;
        });
        if (!state) {
          report({ correlation, status: 'skipped' });
          return;
        }
        const body: AnalyzeRequestBody = {
          conversationId: convId,
          sessionId: convId,
          callType: cfg.callType,
          currentUser: cfg.speakerNames.agent,
          messages: buildAnalyzeMessages(collected, state, cfg.send),
          persist: cfg.persist,
          calculateSimilarities: cfg.calculateSimilarities,
          similarityThreshold: cfg.similarityThreshold,
        };
        emitEvent({
          type: 'request',
          conversationId: convId,
          queryTurn,
          body: structuredClone(body),
          includeCreditUsage: context.includeCreditUsage,
        });
        const start = Date.now();
        const work = Promise.resolve()
          .then(() => {
            if (ctrl.signal.aborted) throw ctrl.signal.reason;
            return transport.analyze(body, context);
          })
          .then(async (value) => {
            // Completed paid work is reported/persisted even if the transport ignored cancellation.
            result = copyProviderValue(value);
            if (config.persistAnalysis) {
              try {
                await config.persistAnalysis({
                  correlation: copyProviderValue(correlation),
                  status: 'completed',
                  result: copyProviderValue(result),
                });
              } catch (error) {
                throw failure(error, 'store');
              }
            }
            if (result.creditUsage != null)
              safe(cfg.onCreditUsage, {
                credits: result.creditUsage,
                conversationId: convId,
                queryTurn,
                recommendationId:
                  result.isSame === true ? undefined : correlation.analysisId,
                isSame: result.isSame,
                timestampMs: Date.now(),
              });
            emitEvent({
              type: 'response',
              conversationId: convId,
              queryTurn,
              analysis: result.analysis,
              creditUsage: result.creditUsage,
              isSame: result.isSame,
              durationMs: Date.now() - start,
            });
            if (ctrl.signal.aborted)
              report({ correlation, status: 'completed', result });
            return result;
          })
          .catch((error) => {
            if (ctrl.signal.aborted && error !== ctrl.signal.reason)
              report({
                correlation,
                status: 'failed',
                result,
                error: failure(error, 'transport'),
              });
            throw error;
          });
        result = await abortable(work, ctrl.signal);
        await locked(convId, async () => {
          if (ctrl.signal.aborted) throw ctrl.signal.reason;
          const latest = await read(convId);
          if (ctrl.signal.aborted) throw ctrl.signal.reason;
          const value = result!;
          const same =
            value.isSame === true ||
            value.analysis === 'SAME' ||
            (value.analysis &&
              typeof value.analysis === 'object' &&
              !Array.isArray(value.analysis) &&
              (value.analysis.isSame === true ||
                value.analysis.is_same === true ||
                value.analysis.recommendation === 'SAME' ||
                value.analysis.raw === 'SAME'));
          if (!same && hasAnalysis(value.analysis)) {
            const last = collected.at(-1)!;
            const rec: StoredRecommendation = {
              id: correlation.analysisId!,
              analysis: value.analysis,
              afterMessageHash: hashMessage(last.speakerName ?? '', last.text),
              afterMessageAnchor: anchor,
              createdAtMs: Date.now(),
              createdAtTurn: queryTurn,
            };
            latest.recommendations.push(rec);
            emitEvent({
              type: 'buffered',
              conversationId: convId,
              queryTurn,
              recommendationId: rec.id,
            });
          } else
            emitEvent({ type: 'deduped', conversationId: convId, queryTurn });
          latest.turnOutcomes = {
            ...latest.turnOutcomes,
            [turn.id]: { status: 'completed' },
          };
          await write(convId, latest);
        });
        report({ correlation, status: 'completed', result });
      } catch (error) {
        const e = failure(error, 'transport');
        if (!ctrl.signal.aborted) {
          try {
            await locked(convId, async () => {
              if (ctrl.signal.aborted) return;
              const state = await read(convId);
              if (
                ctrl.signal.aborted ||
                !state.processedTurnIds?.includes(turn.id)
              )
                return;
              state.turnOutcomes = {
                ...state.turnOutcomes,
                [turn.id]: {
                  status: 'failed',
                  error: { kind: e.kind, message: e.message },
                },
              };
              await write(convId, state);
            });
          } catch (storeError) {
            cfg.onError(storeError);
          }
        }
        report({
          correlation,
          status: e.kind === 'cancelled' ? 'cancelled' : 'failed',
          error: e,
          result,
        });
        throw e;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        controllers.delete(ctrl);
        if (store instanceof MemoryCaesuraStore) store.unpin(convId);
        if (!controllers.size) pending.delete(convId);
      }
    };
    const previous = queues.get(convId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(run);
    queues.set(convId, task);
    void task
      .finally(() => {
        if (queues.get(convId) === task) queues.delete(convId);
      })
      .catch(() => {});
    // Required customer transcript writes finish before even background-mode calls return.
    if (cfg.mode === 'async') await transcript;
    if (cfg.mode === 'sync') {
      try {
        await abortable(task, ctrl.signal);
      } catch (error) {
        if (
          config.failurePolicy === 'throw' ||
          (error instanceof CaesuraError && error.kind === 'cancelled')
        )
          throw error;
      }
      check(options.signal);
    }
  };
  const flush = async (id?: string) => {
    const work =
      id === undefined
        ? [...queues.values()]
        : [queues.get(id)].filter((p): p is Promise<void> => !!p);
    await Promise.allSettled(work);
    const selected = completions.filter(
      (c) => id === undefined || c.correlation.conversationId === id,
    );
    for (const completion of selected)
      completions.splice(completions.indexOf(completion), 1);
    return selected;
  };
  const cancel = (id: string) => {
    sessions
      .get(id)
      ?.abort(
        new CaesuraError(
          'cancelled',
          'CaesuraO: conversation cleared or engine shut down.',
        ),
      );
    sessions.delete(id);
    for (const ctrl of pending.get(id) ?? [])
      ctrl.abort(
        new CaesuraError(
          'cancelled',
          'CaesuraO: conversation cleared or engine shut down.',
        ),
      );
  };
  const clear = async (id: string) => {
    cancel(id);
    await locked(id, async () => {
      try {
        await store.clear(id);
      } catch (error) {
        throw failure(error, 'store');
      }
    });
  };
  return {
    config: cfg,
    sdk,
    recordMessages,
    client,
    transport,
    store,
    getSignal,
    emitEvent,
    observe,
    getState,
    updateState,
    flush,
    clear,
    async prepareProvider(event, operation = {}) {
      const { deadline } = operation;
      const controller = new AbortController();
      const signal = AbortSignal.any([
        getSignal(event.correlation.conversationId),
        controller.signal,
        ...(operation.signal ? [operation.signal] : []),
      ]);
      const context = { signal, deadline };
      checkOperation(context);
      // Own the snapshot before awaiting; neither caller nor callback mutations affect capture.
      const snapshot = auditSnapshot(event) as Extract<
        ProviderAuditEvent,
        { type: 'request' }
      >;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const scheduleDeadline = () => {
        if (deadline === undefined) return;
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          controller.abort(
            new CaesuraError('timeout', 'CaesuraO: audit deadline exceeded.'),
          );
        else
          timer = setTimeout(
            scheduleDeadline,
            Math.min(remaining, 2_147_483_647),
          );
      };
      scheduleDeadline();
      try {
        // Attach a rejection handler immediately; ignored cancellation may still finish/reject later.
        await abortable(
          Promise.resolve().then(() => {
            checkOperation(context);
            return config.persistProviderRequest?.(
              auditSnapshot(snapshot) as typeof snapshot,
              Object.freeze({ signal, deadline }),
            );
          }),
          signal,
        );
        checkOperation(context);
      } catch (error) {
        // Operation cancellation takes precedence over a racing ordinary storage failure.
        checkOperation(context);
        const e = failure(error, 'store');
        cfg.onError(e);
        if (
          config.failurePolicy === 'throw' ||
          e.kind === 'cancelled' ||
          e.kind === 'timeout'
        )
          throw e;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      checkOperation(context);
      safe(
        config.onProviderEvent,
        auditSnapshot(snapshot) as ProviderAuditEvent,
      );
      // A synchronous observer can cancel or consume the remaining deadline too.
      checkOperation(context);
    },
    audit: (event) => {
      try {
        safe(
          config.onProviderEvent,
          event.type === 'error'
            ? event
            : (auditSnapshot(event) as ProviderAuditEvent),
        );
      } catch (error) {
        cfg.onError(error);
      }
    },
    async clearAll() {
      for (const id of new Set([...pending.keys(), ...sessions.keys()]))
        cancel(id);
      const existing = [...locks.values()];
      const reset = Promise.allSettled(existing).then(async () => {
        try {
          await store.clearAll();
        } catch (error) {
          throw failure(error, 'store');
        }
      });
      resetBarrier = reset.catch(() => {});
      await reset;
    },
    async shutdown(options = {}) {
      closed = true;
      if (options.cancel !== false)
        shutdownController.abort(
          new CaesuraError('cancelled', 'CaesuraO: engine shut down.'),
        );
      if (options.cancel !== false)
        for (const id of new Set([...pending.keys(), ...sessions.keys()]))
          cancel(id);
      await Promise.allSettled([...creations]);
      return flush();
    },
    async createConversation(options = {}, observation = {}) {
      observation = snapshotObservation(observation);
      options = copyProviderValue(options);
      check(observation.signal);
      if (closed)
        throw new CaesuraError('cancelled', 'CaesuraO: engine is shut down.');
      const deadline = Math.min(
        observation.deadline ?? Infinity,
        Date.now() + cfg.timeoutMs,
      );
      const signal = AbortSignal.any([
        shutdownController.signal,
        ...(observation.signal ? [observation.signal] : []),
        AbortSignal.timeout(Math.ceil(Math.max(0, deadline - Date.now()))),
      ]);
      const creation = (async () => {
        try {
          const id = await create(options, {
            sdk,
            invocationId: observation.invocationId,
            signal,
            deadline,
            metadata: observation.metadata,
          });
          emitEvent({ type: 'conversation-created', conversationId: id, sdk });
          return id;
        } catch (error) {
          throw failure(error, 'transport');
        }
      })();
      creations.add(creation);
      try {
        return await creation;
      } finally {
        creations.delete(creation);
      }
    },
  };
}
