import type { CaesuraStore } from './store.js';

/** Whether recommendation generation blocks the model call. */
export type CaesuraMode = 'async' | 'sync';

/** Where to splice the rendered recommendation into the prompt. */
export type Placement = 'after-last-analyzed' | 'end';

/** Which role the injected recommendation message uses. */
export type InjectAs = 'user' | 'system' | 'assistant' | 'developer';

/**
 * The analysis object returned by the Caesura backend.
 *
 * Intentionally open-ended: different call types may return different fields
 * now or in the future (the backend spreads `...parsedResponse`). Only the
 * stable, cross-call-type fields are typed explicitly.
 *
 * Note: the deprecated `actionItem` field is intentionally NOT included.
 * `recommendation` is the canonical field.
 */
export interface CaesuraAnalysis {
  observation?: string;
  recommendation?: string;
  sentiment?: string;
  isSame?: boolean;
  id?: number;
  [key: string]: unknown;
}

/** Speaker labels sent to the backend for each dialogue role. */
export interface SpeakerNames {
  /** Label for assistant-role turns. Default: "Agent". */
  agent?: string;
  /** Label for user-role turns. Default: "Customer". */
  customer?: string;
}

/** Cadence: how often the SDK queries the backend for recommendations. */
export interface CadenceConfig {
  /** Query at most once every N turns. Default: 1 (every turn). */
  everyTurns?: number;
  /** Additionally, query at most once every N seconds. Default: 0 (no limit). */
  everySeconds?: number;
}

/** Controls what dialogue window the SDK sends to the backend. */
export interface SendConfig {
  /** Last N messages, or 'all' for the whole conversation. Default: 10. */
  maxMessages?: number | 'all';
  /**
   * Cap total characters of the collected window. Trims from the START
   * (oldest first), because the latest messages matter most.
   * Default: undefined (no cap).
   */
  maxInputChars?: number;
}

/** TTL policy for buffered recommendations. */
export type TtlPolicy =
  | { type: 'none' }
  | { type: 'turns'; turns: number }
  | { type: 'seconds'; seconds: number };

/** Controls how/where recommendations are injected into the model context. */
export interface InjectConfig {
  /** Where to splice the recommendation. Default: 'end'. */
  placement?: Placement;
  /** Which role to inject as. Default: 'user' (avoids a second system prompt). */
  as?: InjectAs;
  /** Keep only the last N recommendations in context. 'all' = keep everything. Default: 'all'. */
  keepLast?: number | 'all';
  /** Expiration policy. Default: { type: 'none' } (best for prompt caching). */
  ttl?: TtlPolicy;
  /**
   * Template for rendering an analysis. Supports:
   *   {analysis}            -> JSON.stringify(analysis)
   *   {analysis.recommendation}, {analysis.observation}, {analysis.anyField}
   * Missing fields resolve to '' and their line is trimmed.
   * Default: 'New recommendation:\n{analysis.recommendation}'.
   */
  template?: string;
  /**
   * Optional system-prompt-style "skill" describing how the agent should
   * react to recommendations. Prepended once to the rendered block.
   */
  skillPrompt?: string;
}

export interface CreditUsageInfo {
  /** Credits consumed by this analyze call. */
  credits: number;
  /** Conversation this call belonged to (store key), if any. */
  conversationId?: string;
  /** The turn index at which the observe call was fired. */
  queryTurn: number;
  /** The SDK recommendation id produced by this call, if any. */
  recommendationId?: string;
  /** Whether the backend deduped (isSame). */
  isSame?: boolean;
  /** When the analyze call resolved. */
  timestampMs: number;
}

/** Top-level SDK configuration. Almost everything is optional. */
export interface CaesuraConfig {
  /** API key. Falls back to process.env.CAESURA_API_KEY if omitted. */
  apiKey?: string;

  /** Base URL incl. subdomain (environment), e.g. https://dev.caesura.io */
  baseUrl: string;

  /** Call type / preset discriminator sent to the backend. */
  callType?: string;

  /** 'async' (default) never blocks the model; 'sync' awaits inline. */
  mode?: CaesuraMode;

  /**
   * Stable conversation id. Usually supplied per-call via
   * providerOptions.caesura.conversationId, which overrides this.
   */
  conversationId?: string;

  /**
   * Whether the backend should persist this conversation/analysis.
   * Default: false (SDK mode). Set true only if you want server-side storage.
   */
  persist?: boolean;

  /** Run server-side cosine-similarity dedup. Default: true. */
  calculateSimilarities?: boolean;
  /** Cosine similarity threshold for SAME detection. */
  similarityThreshold?: number;

  /** Speaker labels. Defaults: { agent: 'Agent', customer: 'Customer' }. */
  speakerNames?: SpeakerNames;

  cadence?: CadenceConfig;
  send?: SendConfig;
  inject?: InjectConfig;

  /** Request timeout in ms. Default: 8000. */
  timeoutMs?: number;

  /**
   * Store implementation. Defaults to an in-memory store with eviction.
   * Provide your own (e.g. Redis-backed) for multi-process/serverless.
   */
  store?: CaesuraStore;

  /** Error hook for observability. Default: console.error. */
  onError?: (err: unknown) => void;

  /**
   * If provided, the SDK requests credit-usage metadata on every analyze
   * call and invokes this with the reported value. Presence of this callback
   * is what opts you in; omit it and no credit header is requested.
   */
  onCreditUsage?: (info: CreditUsageInfo) => void;
}

/** Internal: fully-resolved config with defaults applied. */
export interface ResolvedConfig {
  apiKey: string;
  baseUrl: string;
  callType?: string;
  mode: CaesuraMode;
  conversationId?: string;
  persist: boolean;
  calculateSimilarities: boolean;
  similarityThreshold?: number;
  speakerNames: Required<SpeakerNames>;
  cadence: Required<CadenceConfig>;
  send: Required<Pick<SendConfig, 'maxMessages'>> & SendConfig;
  inject: Required<Omit<InjectConfig, 'skillPrompt'>> & Pick<InjectConfig, 'skillPrompt'>;
  timeoutMs: number;
  onError: (err: unknown) => void;
  includeCreditUsage: boolean;
  onCreditUsage?: (info: CreditUsageInfo) => void;
}
