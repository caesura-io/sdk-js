import type { Awaitable } from './contracts.js';
import type { CaesuraAnalysis } from './types.js';

/** A single buffered recommendation, keyed within a conversation. */
export interface StoredRecommendation {
  /** SDK-generated id (the backend `id` may be absent in non-persist mode). */
  id: string;
  /** The full, raw analysis value as returned by the backend. */
  analysis: CaesuraAnalysis;
  /** The exact rendered block text as injected, for self-exclusion on collect. */
  injectedText?: string;
  /** Legacy content hash, retained for custom stores and older recommendations. */
  afterMessageHash: string;
  /** Fingerprint of the full dialogue prefix through the analyzed occurrence. */
  afterMessageAnchor?: string;
  createdAtMs: number;
  createdAtTurn: number;
}

/** Serializable per-conversation state; the engine always writes mutations explicitly. */
export interface ConversationState {
  recommendations: StoredRecommendation[];
  /** Accepted customer IDs, including skipped/failed work. No automatic paid retries. */
  processedTurnIds?: string[];
  /** Stable cadence number for each accepted event, including retries after reload. */
  turnNumbers?: Record<string, number>;
  /** Pending means outcome unknown after restart, never a persisted execution lock. */
  turnOutcomes?: Record<
    string,
    {
      status: 'pending' | 'completed' | 'skipped' | 'failed';
      error?: { kind: import('./contracts.js').ErrorKind; message: string };
    }
  >;
  /** Previously emitted guidance, including older merged renderings. Cleared with the session. */
  injectedMessages?: { role: string; text: string }[];
  /** Increments on each distinct accepted customer event. */
  turn: number;
  /** Turn index of the last backend query (for cadence.everyTurns). */
  lastQueryTurn: number;
  /** Wall-clock ms of the last backend query (for cadence.everySeconds). */
  lastQueryMs: number;
  /** Guards against overlapping async observe calls. */
  /** @deprecated Runtime work belongs to the engine, never persisted as a lock. */
  inFlight: boolean;
  /** Wall-clock ms of last access, for eviction. */
  lastAccessMs: number;
}

/**
 * Store contract. The default is in-memory; developers may supply their own
 * (e.g. Redis) implementation. Implementations must be safe to call with an
 * unknown conversationId (create-on-read).
 */
export interface CaesuraStore {
  /** Returns (creating if needed) state; detached values are supported. */
  get(conversationId: string): Awaitable<ConversationState>;
  set(conversationId: string, state: ConversationState): Awaitable<void>;
  /** Appends recommendations to a conversation's buffer. */
  add?(conversationId: string, recs: StoredRecommendation[]): Awaitable<void>;
  /** Drops a single conversation's state. */
  clear(conversationId: string): Awaitable<void>;
  /** Drops all state. */
  clearAll(): Awaitable<void>;
}

export interface MemoryStoreOptions {
  /** Max conversations kept before LRU eviction. Default: 1000. */
  maxConversations?: number;
  /** Evict conversations idle longer than this (ms). Default: 1h. 0 = disabled. */
  maxIdleMs?: number;
}

/**
 * Default in-memory store with idle + LRU eviction so it doesn't leak memory
 * across long-lived processes. NOT shared across processes — supply a custom
 * store for multi-instance/serverless deployments.
 */
export class MemoryCaesuraStore implements CaesuraStore {
  private readonly pins = new Map<string, number>();
  pin(id: string): void {
    this.pins.set(id, (this.pins.get(id) ?? 0) + 1);
  }
  unpin(id: string): void {
    const count = (this.pins.get(id) ?? 1) - 1;
    if (count) this.pins.set(id, count);
    else this.pins.delete(id);
  }
  private readonly map = new Map<string, ConversationState>();
  private readonly maxConversations: number;
  private readonly maxIdleMs: number;

  constructor(opts: MemoryStoreOptions = {}) {
    this.maxConversations = opts.maxConversations ?? 1000;
    this.maxIdleMs = opts.maxIdleMs ?? 60 * 60 * 1000;
  }

  get(conversationId: string): ConversationState {
    this.evictIdle();
    let s = this.map.get(conversationId);
    if (!s) {
      s = {
        recommendations: [],
        turn: 0,
        lastQueryTurn: 0,
        lastQueryMs: 0,
        inFlight: false,
        lastAccessMs: Date.now(),
      };
      this.map.set(conversationId, s);
    } else {
      // Refresh recency: re-insert to move to the end (Map preserves order).
      s.lastAccessMs = Date.now();
      this.map.delete(conversationId);
      this.map.set(conversationId, s);
    }
    this.evictOverflow(conversationId);
    return s;
  }

  set(conversationId: string, state: ConversationState): void {
    this.map.set(conversationId, state);
  }

  add(conversationId: string, recs: StoredRecommendation[]): void {
    const s = this.get(conversationId);
    s.recommendations.push(...recs);
  }

  clear(conversationId: string): void {
    this.map.delete(conversationId);
  }

  clearAll(): void {
    this.map.clear();
  }

  private evictIdle(): void {
    if (this.maxIdleMs <= 0) return;
    const cutoff = Date.now() - this.maxIdleMs;
    for (const [id, s] of this.map) {
      if (!this.pins.has(id) && s.lastAccessMs < cutoff) this.map.delete(id);
    }
  }

  private evictOverflow(protectedId: string): void {
    while (this.map.size > this.maxConversations) {
      // Map iteration order is insertion order; first eligible key is the LRU.
      const oldest = [...this.map].find(
        ([id]) => id !== protectedId && !this.pins.has(id),
      )?.[0];
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}
