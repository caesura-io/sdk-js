import type { CaesuraAnalysis } from './types.js';

/** A single buffered recommendation, keyed within a conversation. */
export interface StoredRecommendation {
  /** SDK-generated id (the backend `id` may be absent in non-persist mode). */
  id: string;
  /** The full, raw analysis object as returned by the backend. */
  analysis: CaesuraAnalysis;
  /** The exact rendered block text as injected, for self-exclusion on collect. */
  injectedText?: string;
  createdAtMs: number;
  createdAtTurn: number;
}

/** Mutable per-conversation state held by the store. */
export interface ConversationState {
  recommendations: StoredRecommendation[];
  /** Increments on every middleware invocation for this conversation. */
  turn: number;
  /** Turn index of the last backend query (for cadence.everyTurns). */
  lastQueryTurn: number;
  /** Wall-clock ms of the last backend query (for cadence.everySeconds). */
  lastQueryMs: number;
  /** Guards against overlapping async observe calls. */
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
  /** Returns (creating if needed) the mutable state for a conversation. */
  get(conversationId: string): ConversationState;
  /** Appends recommendations to a conversation's buffer. */
  add(conversationId: string, recs: StoredRecommendation[]): void;
  /** Drops a single conversation's state. */
  clear(conversationId: string): void;
  /** Drops all state. */
  clearAll(): void;
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
        lastQueryTurn: Number.NEGATIVE_INFINITY,
        lastQueryMs: Number.NEGATIVE_INFINITY,
        inFlight: false,
        lastAccessMs: Date.now(),
      };
      this.map.set(conversationId, s);
      this.evictOverflow();
    } else {
      // Refresh recency: re-insert to move to the end (Map preserves order).
      s.lastAccessMs = Date.now();
      this.map.delete(conversationId);
      this.map.set(conversationId, s);
    }
    return s;
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
      if (s.lastAccessMs < cutoff) this.map.delete(id);
    }
  }

  private evictOverflow(): void {
    while (this.map.size > this.maxConversations) {
      // Map iteration order is insertion order; first key is the LRU.
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}
