import type { CaesuraStore } from './store.js';
import type { AnalyzeRequestBody } from './client.js';

/** Whether recommendation generation blocks the model call. */
export type CaesuraMode = 'async' | 'sync';

/** Where to splice the rendered recommendation into the prompt. */
export type Placement = 'after-last-analyzed' | 'end';

/** Which role the injected recommendation message uses. */
export type InjectAs = 'user' | 'system' | 'assistant' | 'developer';

/** The unmodified JSON value or plain text returned by CaesuraO. */
export type CaesuraAnalysis =
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null;

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
  /** Maximum outbound messages including analysis history. Dialogue has priority. Default: 10. */
  maxMessages?: number | 'all';
  /**
   * Cap Unicode code points across dialogue and serialized analysis history.
   * Keep newest dialogue and a suffix of the oldest retained message; then
   * fit whole analyses newest-first, stopping at the first that cannot fit.
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
  /** Where to splice the recommendation. Default: 'after-last-analyzed'. */
  placement?: Placement;
  /** Which role to inject as. Default: 'user' (avoids a second system prompt). */
  as?: InjectAs;
  /** Keep only the last N recommendations in context. 'all' = keep everything. Default: 'all'. */
  keepLast?: number | 'all';
  /** Expiration policy. Default: { type: 'none' } (best for prompt caching). */
  ttl?: TtlPolicy;
  /**
   * Template for rendering an analysis. Supports:
   *   {analysis}            -> full value (objects/arrays as JSON)
   *   {analysis.recommendation}, {analysis.observation}, {analysis.anyField}
   * Missing fields resolve to '' and their line is trimmed.
   * Default: 'CONVERSATION ANALYSIS:\n{analysis}'.
   */
  template?: string;
  /**
   * Optional system-prompt-style "skill" describing how the agent should
   * react to recommendations. Added once to system/developer instructions.
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

  /** API URL override. Defaults to https://api.caesurao.com; environment follows the account. */
  baseUrl?: string;

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
   * Default: true. Requires an existing backend conversation ID or automatic creation.
   */
  persist?: boolean;

  /** Map local session labels to backend conversations automatically. Default: false. */
  autoCreateConversation?: boolean;

  /** Calculate server-side cosine similarities. Default: true; does not set a suppression threshold. */
  calculateSimilarities?: boolean;
  /** Opt-in cosine similarity threshold for SAME suppression; omitted by default. */
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

  /** Structured lifecycle events for debugging/observability. */
  onEvent?: (event: CaesuraEvent) => void;
}

export type CaesuraEvent =
  | {
      type: 'request';
      conversationId: string;
      queryTurn: number;
      /** Exactly what was sent to the backend. */
      body: AnalyzeRequestBody;
      includeCreditUsage: boolean;
    }
  | {
      type: 'response';
      conversationId: string;
      queryTurn: number;
      /** The full, unmodified analysis value. */
      analysis: CaesuraAnalysis;
      creditUsage?: number;
      /** Boolean deduplication metadata, separate from the unmodified payload. */
      isSame?: boolean;
      /** Wall-clock duration of the analyze call. */
      durationMs: number;
    }
  | {
      type: 'skipped';
      conversationId: string;
      turn: number;
      /** Why no backend call happened this turn. */
      reason: 'cadence-turns' | 'cadence-seconds' | 'in-flight' | 'no-messages';
    }
  | {
      type: 'buffered';
      conversationId: string;
      queryTurn: number;
      recommendationId: string;
    }
  | {
      type: 'deduped';
      conversationId: string;
      queryTurn: number;
      /** Explicit duplicate or empty payload -> nothing buffered. */
    }
  | {
      type: 'injected';
      conversationId: string;
      turn: number;
      /** The individual rendered recommendations that made up this block. */
      blocks: {
        recommendationId: string;
        text: string;
        /** The index in the modified prompt array where the block was injected. */
        index: number;
      }[];
      placement: Placement;
    }
  | {
      type: 'error';
      conversationId: string;
      error: unknown;
    };

/** Internal: fully-resolved config with defaults applied. */
export interface ResolvedConfig {
  apiKey: string;
  baseUrl: string;
  callType?: string;
  mode: CaesuraMode;
  conversationId?: string;
  persist: boolean;
  autoCreateConversation: boolean;
  calculateSimilarities: boolean;
  similarityThreshold?: number;
  speakerNames: Required<SpeakerNames>;
  cadence: Required<CadenceConfig>;
  send: Required<Pick<SendConfig, 'maxMessages'>> & SendConfig;
  inject: Required<Omit<InjectConfig, 'skillPrompt'>> &
    Pick<InjectConfig, 'skillPrompt'>;
  timeoutMs: number;
  onError: (err: unknown) => void;
  includeCreditUsage: boolean;
  onCreditUsage?: (info: CreditUsageInfo) => void;
  onEvent?: (event: CaesuraEvent) => void;
}
