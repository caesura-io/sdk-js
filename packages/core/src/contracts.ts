import { copyProviderValue } from './copy.js';
import type {
  AnalyzeMessage,
  AnalyzeRequestBody,
  AnalyzeResult,
  CreateConversationOptions,
} from './client.js';

export type Awaitable<T> = T | Promise<T>;
export type FailurePolicy = 'continue' | 'throw';
export type ErrorKind =
  | 'transport'
  | 'timeout'
  | 'cancelled'
  | 'store'
  | 'provider'
  | 'unsupported'
  | 'configuration';
export class CaesuraError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = kind === 'cancelled' ? 'AbortError' : 'CaesuraError';
  }
}

/** Out-of-band correlation. Never serialized into an HTTP analysis/provider body. */
export interface SdkIdentity {
  language: 'javascript';
  core: { name: string; version: string };
  integration?: { name: string; version: string };
  transport: 'http' | 'in-process';
  runtime?: { name: string; version: string };
}

export interface Correlation {
  sdk?: SdkIdentity;
  conversationId: string;
  customerTurnId?: string;
  invocationId?: string;
  analysisId?: string;
  metadata?: Readonly<Record<string, unknown>>;
}
export interface CreationContext {
  sdk: SdkIdentity;
  invocationId?: string;
  metadata?: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
  deadline: number;
}
export interface AnalysisContext extends Correlation {
  sdk: SdkIdentity;
  signal: AbortSignal;
  deadline: number;
  includeCreditUsage: boolean;
}
export interface AnalysisTransport {
  analyze(
    input: AnalyzeRequestBody,
    context: AnalysisContext,
  ): Promise<AnalyzeResult>;
  createConversation?(
    options: CreateConversationOptions,
    context: CreationContext,
  ): Promise<string>;
}
/** Application-selected evidence; internal text is excluded, agent text remains background. */
export interface DialogueMessage extends AnalyzeMessage {
  origin?: 'customer' | 'agent' | 'internal';
}
export interface CustomerTurn {
  /** Stable across retries/tool continuations; distinct even when text is identical. */
  id: string;
  origin: 'customer' | 'internal';
}
/** Live operation controls; never part of a persisted audit snapshot. */
export interface OperationContext {
  readonly signal?: AbortSignal;
  /** Optional absolute Unix-millisecond deadline, including required audit persistence. */
  readonly deadline?: number;
}
export interface ProviderAuditContext extends OperationContext {
  readonly signal: AbortSignal;
}
/** Check at stage boundaries, including immediately before provider invocation. */
export function checkOperation({ signal, deadline }: OperationContext): void {
  if (signal?.aborted) {
    const reason: unknown = signal.reason;
    if (
      reason instanceof CaesuraError &&
      (reason.kind === 'cancelled' || reason.kind === 'timeout')
    )
      throw reason;
    throw new CaesuraError(
      reason instanceof Error && reason.name === 'TimeoutError'
        ? 'timeout'
        : 'cancelled',
      'CaesuraO: operation aborted.',
      { cause: reason },
    );
  }
  if (deadline !== undefined) {
    if (!Number.isFinite(deadline))
      throw new CaesuraError(
        'configuration',
        'CaesuraO: deadline must be finite Unix milliseconds.',
      );
    if (Date.now() >= deadline)
      throw new CaesuraError(
        'timeout',
        'CaesuraO: operation deadline exceeded.',
      );
  }
}
export interface ObservationOptions {
  turn?: CustomerTurn;
  /** Explicit trusted dialogue selection, replacing automatic extraction. */
  dialogue?: readonly DialogueMessage[];
  /** Trusted dialogue indices in the original provider input, before any SDK transformations. */
  dialoguePositions?: readonly number[];
  signal?: AbortSignal;
  /** Absolute Unix milliseconds, including required audit persistence. timeoutMs caps analysis/creation. */
  deadline?: number;
  metadata?: Readonly<Record<string, unknown>>;
  invocationId?: string;
}
export interface CaesuraCallOptions extends ObservationOptions {
  conversationId?: string;
}
export interface AnalysisCompletion {
  correlation: Correlation;
  status: 'completed' | 'skipped' | 'failed' | 'cancelled';
  result?: AnalyzeResult;
  error?: CaesuraError;
}
/** Protocol completion is not a guarantee of semantic completeness; inspect finish reasons. */
export type ProviderStreamStatus =
  | 'completed'
  | 'incomplete'
  | 'cancelled'
  | 'failed';
export type ProviderAuditEvent = {
  correlation: Correlation;
  api: 'chat' | 'responses' | 'ai-sdk';
} & (
  | { type: 'request'; parameters: unknown; analysisIds: string[] }
  | { type: 'response' | 'stream-start' | 'chunk'; value: unknown }
  | {
      type: 'stream-end';
      status: ProviderStreamStatus;
      value?: unknown;
    }
  | { type: 'error'; error: CaesuraError }
);

/** Isolated snapshot of provider parameters/data, excluding transport credentials. */
export function auditSnapshot(value: unknown): unknown {
  const copy = (item: unknown, data = false): unknown => {
    if (item === null || typeof item !== 'object')
      return typeof item === 'function' ? undefined : item;
    if (
      item instanceof URL ||
      item instanceof URLSearchParams ||
      item instanceof ArrayBuffer ||
      ArrayBuffer.isView(item)
    )
      return copyProviderValue(item);
    if (typeof Blob !== 'undefined' && item instanceof Blob) return item;
    if (item instanceof Date) return item.toISOString();
    if (item instanceof AbortSignal) return undefined;
    if (item instanceof Error)
      return copy({
        ...item,
        name: item.name,
        message: item.message,
        stack: item.stack,
        cause: item.cause,
      });
    if (Array.isArray(item)) return item.map((entry) => copy(entry, data));
    return Object.fromEntries(
      Object.entries(item)
        .filter(
          ([key]) =>
            data ||
            !/^(headers|authorization|apiKey|api_key|accessToken)$/i.test(key),
        )
        .map(([key, entry]) => [
          key,
          copy(
            entry,
            data ||
              [
                'messages',
                'input',
                'instructions',
                'prompt',
                'tools',
                'content',
              ].includes(key),
          ),
        ]),
    );
  };
  return copy(value);
}

/** Copy out-of-band options before adapter state I/O; keep the live AbortSignal. */
export function snapshotObservation<T extends ObservationOptions>(
  options: T,
): T {
  const { signal, ...data } = options;
  return { ...copyProviderValue(data), signal } as T;
}

/** Validate explicit provider positions; no text matching or guessing. */
export function selectPositions<T>(
  items: readonly T[],
  positions?: readonly number[],
): T[] {
  if (!positions) return [...items];
  let previous = -1;
  return positions.map((index) => {
    if (!Number.isInteger(index) || index <= previous || index >= items.length)
      throw new TypeError(
        'CaesuraO: dialoguePositions must be increasing valid message indices.',
      );
    previous = index;
    return items[index]!;
  });
}

/** Complete application transcript entries; never implicitly treated as analysis evidence. */
export interface TranscriptMessage {
  id: string;
  role: 'customer' | 'agent';
  text: string;
  speakerName?: string;
  speakerIndex?: number;
}
export interface TranscriptBatch {
  correlation: Correlation;
  messages: readonly TranscriptMessage[];
}
/** No fallback: IDs are opaque, authoritative application/backend identities. */
export function requireConversationId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new CaesuraError(
      'configuration',
      'CaesuraO: conversationId is required. Call createConversation() once and reuse its returned ID, or supply an existing authoritative ID.',
    );
  return value;
}
