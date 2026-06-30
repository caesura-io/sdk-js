import { describe, it, expect } from 'vitest';
import { createCreditMeter } from './meter.js';
import type { CreditUsageInfo } from './types.js';

describe('createCreditMeter', () => {
  it('should record credits and track totals, count and breakdown', () => {
    const meter = createCreditMeter();

    const info1: CreditUsageInfo = {
      credits: 5,
      conversationId: 'conv-1',
      queryTurn: 1,
      recommendationId: 'rec-1',
      isSame: false,
      timestampMs: 1000,
    };

    const info2: CreditUsageInfo = {
      credits: 10,
      conversationId: 'conv-1',
      queryTurn: 2,
      recommendationId: 'rec-2',
      isSame: true,
      timestampMs: 2000,
    };

    const info3: CreditUsageInfo = {
      credits: 7,
      conversationId: 'conv-2',
      queryTurn: 1,
      recommendationId: 'rec-3',
      isSame: false,
      timestampMs: 3000,
    };

    meter.record(info1);
    meter.record(info2);
    meter.record(info3);

    expect(meter.total()).toBe(22);
    expect(meter.totalByConversation('conv-1')).toBe(15);
    expect(meter.totalByConversation('conv-2')).toBe(7);
    expect(meter.totalByConversation('conv-nonexistent')).toBe(0);

    expect(meter.breakdown()).toEqual({
      'conv-1': 15,
      'conv-2': 7,
    });

    expect(meter.count()).toBe(3);
    expect(meter.count({ conversationId: 'conv-1' })).toBe(2);
    expect(meter.count({ isSame: true })).toBe(1);
    expect(meter.count({ conversationId: 'conv-1', isSame: true })).toBe(1);
    expect(meter.count({ conversationId: 'conv-1', isSame: false })).toBe(1);
  });

  it('should bucket undefined conversationId under (none)', () => {
    const meter = createCreditMeter();
    const info: CreditUsageInfo = {
      credits: 8,
      queryTurn: 1,
      timestampMs: 1000,
    };

    meter.record(info);

    expect(meter.total()).toBe(8);
    expect(meter.totalByConversation(undefined)).toBe(8);
    expect(meter.totalByConversation('(none)')).toBe(8);
    expect(meter.breakdown()).toEqual({
      '(none)': 8,
    });
  });

  it('should respect keepEvents: false option', () => {
    const meter = createCreditMeter({ keepEvents: false });
    const info: CreditUsageInfo = {
      credits: 5,
      conversationId: 'conv-1',
      queryTurn: 1,
      recommendationId: 'rec-1',
      isSame: false,
      timestampMs: 1000,
    };

    meter.record(info);

    expect(meter.total()).toBe(5);
    expect(meter.totalByConversation('conv-1')).toBe(5);
    expect(meter.events()).toEqual([]);
    expect(meter.byRecommendationId('rec-1')).toBeUndefined();
    expect(meter.count()).toBe(1);
    expect(meter.count({ conversationId: 'conv-1' })).toBe(1);
  });

  it('should respect maxEvents for FIFO eviction', () => {
    const meter = createCreditMeter({ maxEvents: 2 });
    const info1: CreditUsageInfo = {
      credits: 1,
      conversationId: 'conv-1',
      queryTurn: 1,
      recommendationId: 'rec-1',
      timestampMs: 1000,
    };
    const info2: CreditUsageInfo = {
      credits: 2,
      conversationId: 'conv-1',
      queryTurn: 2,
      recommendationId: 'rec-2',
      timestampMs: 2000,
    };
    const info3: CreditUsageInfo = {
      credits: 3,
      conversationId: 'conv-1',
      queryTurn: 3,
      recommendationId: 'rec-3',
      timestampMs: 3000,
    };

    meter.record(info1);
    meter.record(info2);
    meter.record(info3);

    // Totals are still correct and cumulative
    expect(meter.total()).toBe(6);

    // But eventList has only 2 elements, and first one (rec-1) is evicted
    expect(meter.events()).toHaveLength(2);
    expect(meter.events().map(e => e.recommendationId)).toEqual(['rec-2', 'rec-3']);
    expect(meter.byRecommendationId('rec-1')).toBeUndefined();
    expect(meter.byRecommendationId('rec-2')).toEqual(info2);
    expect(meter.byRecommendationId('rec-3')).toEqual(info3);
  });

  it('should reset all state or per-conversation', () => {
    const meter = createCreditMeter();
    meter.record({
      credits: 10,
      conversationId: 'conv-1',
      queryTurn: 1,
      recommendationId: 'rec-1',
      timestampMs: 1000,
    });
    meter.record({
      credits: 20,
      conversationId: 'conv-2',
      queryTurn: 1,
      recommendationId: 'rec-2',
      timestampMs: 2000,
    });

    expect(meter.total()).toBe(30);

    // Reset single conversation
    meter.reset('conv-1');
    expect(meter.total()).toBe(20);
    expect(meter.totalByConversation('conv-1')).toBe(0);
    expect(meter.totalByConversation('conv-2')).toBe(20);
    expect(meter.events().map(e => e.recommendationId)).toEqual(['rec-2']);
    expect(meter.byRecommendationId('rec-1')).toBeUndefined();
    expect(meter.byRecommendationId('rec-2')).toBeDefined();

    // Reset everything
    meter.reset();
    expect(meter.total()).toBe(0);
    expect(meter.totalByConversation('conv-2')).toBe(0);
    expect(meter.events()).toHaveLength(0);
    expect(meter.byRecommendationId('rec-2')).toBeUndefined();
  });

  it('should generate accurate snapshots', () => {
    const meter = createCreditMeter();
    meter.record({
      credits: 10,
      conversationId: 'conv-1',
      queryTurn: 1,
      timestampMs: 1000,
    });
    meter.record({
      credits: 5,
      conversationId: 'conv-2',
      queryTurn: 1,
      timestampMs: 2000,
    });

    expect(meter.snapshot()).toEqual({
      total: 15,
      byConversation: {
        'conv-1': 10,
        'conv-2': 5,
      },
    });
  });
});
