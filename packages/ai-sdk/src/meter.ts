import type { CreditUsageInfo } from './types.js';

export interface CreditMeterOptions {
  /**
   * Keep per-event records for detailed queries (byConversation, history).
   * If false, only running totals are kept (constant memory). Default: true.
   */
  keepEvents?: boolean;
  /**
   * Cap retained events (oldest evicted) when keepEvents is true.
   * 0 = unbounded. Default: 10_000.
   */
  maxEvents?: number;
}

export interface CreditMeter {
  /** Drop-in handler: pass as config.onCreditUsage. */
  record: (info: CreditUsageInfo) => void;

  /** Total credits across all recorded calls. */
  total(): number;
  /** Total credits for one conversation. */
  totalByConversation(conversationId: string | undefined): number;
  /** Number of analyze calls recorded (optionally filtered). */
  count(filter?: { conversationId?: string; isSame?: boolean }): number;

  /** Per-conversation breakdown: { [conversationId]: credits }. */
  breakdown(): Record<string, number>;

  /** Look up the cost of a specific recommendation. */
  byRecommendationId(id: string): CreditUsageInfo | undefined;

  /** Raw events (copy), newest last. Empty if keepEvents is false. */
  events(): readonly CreditUsageInfo[];

  /** Reset everything (or one conversation). */
  reset(conversationId?: string): void;

  /** Returns a lightweight totals snapshot for external persistence. */
  snapshot(): { total: number; byConversation: Record<string, number> };
}

export function createCreditMeter(options: CreditMeterOptions = {}): CreditMeter {
  const keepEvents = options.keepEvents ?? true;
  const maxEvents = options.maxEvents ?? 10000;

  let totalCredits = 0;
  const conversationTotals = new Map<string, number>();

  // Running counts for count() utility in constant memory
  let totalCalls = 0;
  const conversationCalls = new Map<string, number>();
  let totalSameCalls = 0;
  const conversationSameCalls = new Map<string, number>();

  // Rich event records
  let eventList: CreditUsageInfo[] = [];
  const recIndex = new Map<string, CreditUsageInfo>();

  const record = (info: CreditUsageInfo) => {
    totalCredits += info.credits;
    const convId = info.conversationId ?? '(none)';
    
    // Update credit totals
    conversationTotals.set(convId, (conversationTotals.get(convId) ?? 0) + info.credits);

    // Update counts
    totalCalls += 1;
    conversationCalls.set(convId, (conversationCalls.get(convId) ?? 0) + 1);
    if (info.isSame) {
      totalSameCalls += 1;
      conversationSameCalls.set(convId, (conversationSameCalls.get(convId) ?? 0) + 1);
    }

    if (keepEvents) {
      eventList.push(info);
      if (info.recommendationId) {
        recIndex.set(info.recommendationId, info);
      }

      if (maxEvents > 0 && eventList.length > maxEvents) {
        const evicted = eventList.shift();
        if (evicted?.recommendationId) {
          recIndex.delete(evicted.recommendationId);
        }
      }
    }
  };

  return {
    record,
    total() {
      return totalCredits;
    },
    totalByConversation(conversationId) {
      return conversationTotals.get(conversationId ?? '(none)') ?? 0;
    },
    count(filter) {
      if (keepEvents) {
        return eventList.filter((e) => {
          if (filter?.conversationId !== undefined) {
            const expected = filter.conversationId ?? '(none)';
            const actual = e.conversationId ?? '(none)';
            if (actual !== expected) return false;
          }
          if (filter?.isSame !== undefined) {
            if (!!e.isSame !== !!filter.isSame) return false;
          }
          return true;
        }).length;
      }

      const targetConv = filter?.conversationId !== undefined ? (filter.conversationId ?? '(none)') : undefined;
      const targetSame = filter?.isSame;

      if (targetConv !== undefined) {
        if (targetSame !== undefined) {
          const same = conversationSameCalls.get(targetConv) ?? 0;
          return targetSame ? same : (conversationCalls.get(targetConv) ?? 0) - same;
        }
        return conversationCalls.get(targetConv) ?? 0;
      }

      if (targetSame !== undefined) {
        return targetSame ? totalSameCalls : totalCalls - totalSameCalls;
      }

      return totalCalls;
    },
    breakdown() {
      const result: Record<string, number> = {};
      for (const [key, value] of conversationTotals) {
        result[key] = value;
      }
      return result;
    },
    byRecommendationId(id) {
      if (!keepEvents) return undefined;
      return recIndex.get(id);
    },
    events() {
      if (!keepEvents) return [];
      return [...eventList];
    },
    reset(conversationId) {
      if (conversationId !== undefined) {
        const convId = conversationId ?? '(none)';
        const credits = conversationTotals.get(convId) ?? 0;
        totalCredits = Math.max(0, totalCredits - credits);
        conversationTotals.delete(convId);

        const calls = conversationCalls.get(convId) ?? 0;
        totalCalls = Math.max(0, totalCalls - calls);
        conversationCalls.delete(convId);

        const sameCalls = conversationSameCalls.get(convId) ?? 0;
        totalSameCalls = Math.max(0, totalSameCalls - sameCalls);
        conversationSameCalls.delete(convId);

        if (keepEvents) {
          eventList = eventList.filter((e) => {
            const actual = e.conversationId ?? '(none)';
            if (actual === convId) {
              if (e.recommendationId) {
                recIndex.delete(e.recommendationId);
              }
              return false;
            }
            return true;
          });
        }
      } else {
        totalCredits = 0;
        conversationTotals.clear();
        totalCalls = 0;
        conversationCalls.clear();
        totalSameCalls = 0;
        conversationSameCalls.clear();
        eventList = [];
        recIndex.clear();
      }
    },
    snapshot() {
      return {
        total: totalCredits,
        byConversation: this.breakdown(),
      };
    },
  };
}
