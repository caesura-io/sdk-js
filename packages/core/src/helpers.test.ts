import { describe, it, expect, vi } from 'vitest';
import {
  buildAnalyzeMessages,
  hashMessage,
  renderAnalysis,
  selectActive,
  renderBlock,
} from './helpers.js';
import type { ConversationState } from './store.js';
import { createDebugLogger } from './logger.js';

describe('core helpers', () => {
  describe('buildAnalyzeMessages', () => {
    it('interleaves analyses at the correct chronological position', () => {
      const collected = [
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'msg 1' },
        { speakerRole: 'user' as const, speakerName: 'Agent', text: 'response 1' },
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'msg 2' },
        { speakerRole: 'user' as const, speakerName: 'Agent', text: 'response 2' },
      ];
      const state: ConversationState = {
        recommendations: [
          { id: '1', analysis: { recommendation: 'A' }, afterMessageHash: hashMessage('Agent', 'response 1'), createdAtMs: 1000, createdAtTurn: 1 },
          { id: '2', analysis: { recommendation: 'B' }, afterMessageHash: hashMessage('Agent', 'response 2'), createdAtMs: 2000, createdAtTurn: 2 },
        ],
        turn: 3,
        lastQueryTurn: 2,
        lastQueryMs: 2000,
        inFlight: false,
        lastAccessMs: 0,
      };

      const messages = buildAnalyzeMessages(collected, state);
      expect(messages).toEqual([
        { speakerRole: 'user', speakerName: 'Customer', text: 'msg 1' },
        { speakerRole: 'user', speakerName: 'Agent', text: 'response 1' },
        { speakerRole: 'assistant', text: JSON.stringify({ recommendation: 'A' }) },
        { speakerRole: 'user', speakerName: 'Customer', text: 'msg 2' },
        { speakerRole: 'user', speakerName: 'Agent', text: 'response 2' },
        { speakerRole: 'assistant', text: JSON.stringify({ recommendation: 'B' }) },
      ]);
    });

    it('all dialogue messages use speakerRole user', () => {
      const collected = [
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'hello' },
        { speakerRole: 'user' as const, speakerName: 'Agent', text: 'hi there' },
      ];
      const state: ConversationState = {
        recommendations: [],
        turn: 1,
        lastQueryTurn: 0,
        lastQueryMs: 0,
        inFlight: false,
        lastAccessMs: 0,
      };

      const messages = buildAnalyzeMessages(collected, state);
      expect(messages.every((m) => m.speakerRole === 'user' || m.speakerRole === 'assistant')).toBe(true);
      expect(messages[0]!.speakerRole).toBe('user');
      expect(messages[1]!.speakerRole).toBe('user');
    });

    it('analyses have no speakerName', () => {
      const collected = [
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'msg' },
      ];
      const state: ConversationState = {
        recommendations: [
          { id: '1', analysis: { recommendation: 'R' }, afterMessageHash: hashMessage('Customer', 'msg'), createdAtMs: 1000, createdAtTurn: 1 },
        ],
        turn: 2,
        lastQueryTurn: 1,
        lastQueryMs: 1000,
        inFlight: false,
        lastAccessMs: 0,
      };

      const messages = buildAnalyzeMessages(collected, state);
      const analysis = messages.find((m) => m.speakerRole === 'assistant');
      expect(analysis).toBeDefined();
      expect(analysis!.speakerName).toBeUndefined();
    });

    it('analysis with trimmed anchor message is prepended', () => {
      // The anchor message "msg 1" was trimmed out of the window
      const collected = [
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'msg 3' },
        { speakerRole: 'user' as const, speakerName: 'Agent', text: 'response 3' },
      ];
      const state: ConversationState = {
        recommendations: [
          { id: '1', analysis: { recommendation: 'old' }, afterMessageHash: hashMessage('Customer', 'msg 1'), createdAtMs: 500, createdAtTurn: 1 },
        ],
        turn: 3,
        lastQueryTurn: 1,
        lastQueryMs: 500,
        inFlight: false,
        lastAccessMs: 0,
      };

      const messages = buildAnalyzeMessages(collected, state);
      expect(messages[0]!.speakerRole).toBe('assistant');
      expect(messages[1]!.text).toBe('msg 3');
      expect(messages[2]!.text).toBe('response 3');
    });

    it('async mode: analysis from turn 1 placed correctly in turn 3 window', () => {
      const collected = [
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'msg 1' },
        { speakerRole: 'user' as const, speakerName: 'Agent', text: 'resp 1' },
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'msg 2' },
        { speakerRole: 'user' as const, speakerName: 'Agent', text: 'resp 2' },
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'msg 3' },
      ];
      const state: ConversationState = {
        recommendations: [
          { id: '1', analysis: { recommendation: 'A' }, afterMessageHash: hashMessage('Customer', 'msg 1'), createdAtMs: 500, createdAtTurn: 1 },
        ],
        turn: 3,
        lastQueryTurn: 1,
        lastQueryMs: 500,
        inFlight: false,
        lastAccessMs: 0,
      };

      const messages = buildAnalyzeMessages(collected, state);
      expect(messages[0]).toEqual({ speakerRole: 'user', speakerName: 'Customer', text: 'msg 1' });
      expect(messages[1]).toEqual({ speakerRole: 'assistant', text: JSON.stringify({ recommendation: 'A' }) });
      expect(messages[2]).toEqual({ speakerRole: 'user', speakerName: 'Agent', text: 'resp 1' });
      expect(messages).toHaveLength(6); // 5 dialogue + 1 analysis
    });

    it('maxMessages trimming: analysis from before window is prepended', () => {
      const collected = [
        { speakerRole: 'user' as const, speakerName: 'Agent', text: 'resp 2' },
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'msg 3' },
      ];
      const state: ConversationState = {
        recommendations: [
          { id: '1', analysis: { recommendation: 'old' }, afterMessageHash: hashMessage('Customer', 'msg 1'), createdAtMs: 500, createdAtTurn: 1 },
          { id: '2', analysis: { recommendation: 'recent' }, afterMessageHash: hashMessage('Agent', 'resp 2'), createdAtMs: 1500, createdAtTurn: 2 },
        ],
        turn: 3,
        lastQueryTurn: 2,
        lastQueryMs: 1500,
        inFlight: false,
        lastAccessMs: 0,
      };

      const messages = buildAnalyzeMessages(collected, state);
      expect(messages).toEqual([
        { speakerRole: 'assistant', text: JSON.stringify({ recommendation: 'old' }) },
        { speakerRole: 'user', speakerName: 'Agent', text: 'resp 2' },
        { speakerRole: 'assistant', text: JSON.stringify({ recommendation: 'recent' }) },
        { speakerRole: 'user', speakerName: 'Customer', text: 'msg 3' },
      ]);
    });

    it('afterMessageHash on last collected message appends analysis at end', () => {
      const collected = [
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'msg' },
        { speakerRole: 'user' as const, speakerName: 'Agent', text: 'resp' },
      ];
      const state: ConversationState = {
        recommendations: [
          { id: '1', analysis: { recommendation: 'R' }, afterMessageHash: hashMessage('Agent', 'resp'), createdAtMs: 1000, createdAtTurn: 1 },
        ],
        turn: 2,
        lastQueryTurn: 1,
        lastQueryMs: 1000,
        inFlight: false,
        lastAccessMs: 0,
      };

      const messages = buildAnalyzeMessages(collected, state);
      expect(messages).toEqual([
        { speakerRole: 'user', speakerName: 'Customer', text: 'msg' },
        { speakerRole: 'user', speakerName: 'Agent', text: 'resp' },
        { speakerRole: 'assistant', text: JSON.stringify({ recommendation: 'R' }) },
      ]);
    });

    it('handles multiple identical messages gracefully', () => {
      const collected = [
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'yes' },
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'yes' },
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'yes' },
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'yes' },
      ];

      const hash = hashMessage('Customer', 'yes');
      const state: ConversationState = {
        recommendations: [
          { id: '1', analysis: { recommendation: 'A1' }, afterMessageHash: hash, createdAtMs: 100, createdAtTurn: 1 },
          { id: '2', analysis: { recommendation: 'A2' }, afterMessageHash: hash, createdAtMs: 200, createdAtTurn: 2 },
          { id: '3', analysis: { recommendation: 'A3' }, afterMessageHash: hash, createdAtMs: 300, createdAtTurn: 3 },
          { id: '4', analysis: { recommendation: 'A4' }, afterMessageHash: hash, createdAtMs: 400, createdAtTurn: 4 },
          { id: '5', analysis: { recommendation: 'A5' }, afterMessageHash: hash, createdAtMs: 500, createdAtTurn: 5 },
        ],
        turn: 5,
        lastQueryTurn: 5,
        lastQueryMs: 500,
        inFlight: false,
        lastAccessMs: 0,
      };

      const messages = buildAnalyzeMessages(collected, state);
      expect(messages).toEqual([
        { speakerRole: 'assistant', text: JSON.stringify({ recommendation: 'A1' }) },
        { speakerRole: 'user', speakerName: 'Customer', text: 'yes' },
        { speakerRole: 'assistant', text: JSON.stringify({ recommendation: 'A2' }) },
        { speakerRole: 'user', speakerName: 'Customer', text: 'yes' },
        { speakerRole: 'assistant', text: JSON.stringify({ recommendation: 'A3' }) },
        { speakerRole: 'user', speakerName: 'Customer', text: 'yes' },
        { speakerRole: 'assistant', text: JSON.stringify({ recommendation: 'A4' }) },
        { speakerRole: 'user', speakerName: 'Customer', text: 'yes' },
        { speakerRole: 'assistant', text: JSON.stringify({ recommendation: 'A5' }) },
      ]);
    });
  });

  describe('renderAnalysis', () => {
    const analysis = {
      observation: 'User is confused',
      recommendation: 'Explain caching',
      sentiment: 'Neutral',
      customField: 42,
    };

    it('resolves basic dot-path tokens', () => {
      const template = 'Obs: {analysis.observation}\nRec: {analysis.recommendation}';
      expect(renderAnalysis(analysis, template)).toBe('Obs: User is confused\nRec: Explain caching');
    });

    it('resolves full analysis JSON', () => {
      const template = '{analysis}';
      expect(JSON.parse(renderAnalysis(analysis, template))).toEqual(analysis);
    });

    it('drops lines with only empty tokens', () => {
      const template = 'Obs: {analysis.observation}\nEmpty: {analysis.nonexistent}\nRec: {analysis.recommendation}';
      expect(renderAnalysis(analysis, template)).toBe('Obs: User is confused\nRec: Explain caching');
    });
  });

  describe('selectActive', () => {
    const state: ConversationState = {
      recommendations: [
        { id: '1', analysis: { recommendation: 'A' }, afterMessageHash: hashMessage('Customer', 'x'), createdAtMs: 1000, createdAtTurn: 1 },
        { id: '2', analysis: { recommendation: 'B' }, afterMessageHash: hashMessage('Customer', 'y'), createdAtMs: 2000, createdAtTurn: 2 },
      ],
      turn: 3,
      lastQueryTurn: 0,
      lastQueryMs: 0,
      inFlight: false,
      lastAccessMs: 0,
    };

    it('retains all under none TTL', () => {
      const active = selectActive(state, { keepLast: 'all', ttl: { type: 'none' }, placement: 'end', as: 'user', template: '' }, 3000);
      expect(active).toHaveLength(2);
    });

    it('respects turns TTL', () => {
      const active = selectActive(state, { keepLast: 'all', ttl: { type: 'turns', turns: 1 }, placement: 'end', as: 'user', template: '' }, 3000);
      expect(active).toHaveLength(1);
      expect(active[0]!.id).toBe('2');
    });

    it('respects seconds TTL', () => {
      const active = selectActive(state, { keepLast: 'all', ttl: { type: 'seconds', seconds: 1.5 }, placement: 'end', as: 'user', template: '' }, 3000);
      expect(active).toHaveLength(1);
      expect(active[0]!.id).toBe('2');
    });

    it('respects keepLast limit', () => {
      const active = selectActive(state, { keepLast: 1, ttl: { type: 'none' }, placement: 'end', as: 'user', template: '' }, 3000);
      expect(active).toHaveLength(1);
      expect(active[0]!.id).toBe('2');
    });
  });

  describe('renderBlock', () => {
    it('concatenates recommendations without prepending skillPrompt', () => {
      const recs = [
        { id: '1', analysis: { recommendation: 'Rec A' }, afterMessageHash: hashMessage('Customer', 'x'), createdAtMs: 1000, createdAtTurn: 1 },
        { id: '2', analysis: { recommendation: 'Rec B' }, afterMessageHash: hashMessage('Customer', 'y'), createdAtMs: 2000, createdAtTurn: 2 },
      ];
      const blocks = renderBlock(recs, {
        template: 'Rec: {analysis.recommendation}',
        skillPrompt: 'Should be ignored in renderBlock',
        placement: 'end',
        as: 'user',
        keepLast: 'all',
        ttl: { type: 'none' },
      });
      expect(blocks).toEqual([
        { recommendationId: '1', text: 'Rec: Rec A', afterMessageHash: hashMessage('Customer', 'x'), createdAtTurn: 1 },
        { recommendationId: '2', text: 'Rec: Rec B', afterMessageHash: hashMessage('Customer', 'y'), createdAtTurn: 2 },
      ]);
    });
  });
});

describe('createDebugLogger', () => {
  it('formats and outputs all events to the custom log function', () => {
    const logFn = vi.fn();
    const logger = createDebugLogger({ logger: logFn });

    const reqEvent = {
      type: 'request' as const,
      conversationId: 'c1',
      queryTurn: 1,
      body: { messages: [{ speakerRole: 'user' as const, text: 'hello' }] },
      includeCreditUsage: true,
    };

    logger(reqEvent);

    expect(logFn).toHaveBeenCalledTimes(1);
    expect(logFn.mock.calls[0][0]).toContain('[caesura:request]');
    expect(logFn.mock.calls[0][0]).toContain('Conversation: c1');
    expect(logFn.mock.calls[0][0]).toContain('Turn: 1');
    expect(logFn.mock.calls[0][1].body.messages[0].text).toBe('hello');
  });

  it('filters events by type if specified in options', () => {
    const logFn = vi.fn();
    const logger = createDebugLogger({
      types: ['response', 'error'],
      logger: logFn,
    });

    logger({
      type: 'skipped' as const,
      conversationId: 'c1',
      turn: 1,
      reason: 'no-messages',
    });

    logger({
      type: 'error' as const,
      conversationId: 'c1',
      error: new Error('oops'),
    });

    expect(logFn).toHaveBeenCalledTimes(1);
    expect(logFn.mock.calls[0][0]).toContain('[caesura:error]');
  });

  it('truncates long texts if truncateText is specified', () => {
    const logFn = vi.fn();
    const logger = createDebugLogger({
      logger: logFn,
      truncateText: 5,
    });

    logger({
      type: 'injected',
      conversationId: 'c1',
      turn: 2,
      blocks: [{ recommendationId: 'rec-1', text: 'This is a very long text', index: 2 }],
      placement: 'end',
    });

    expect(logFn).toHaveBeenCalledTimes(1);
    expect(logFn.mock.calls[0][1].blocks[0].text).toBe('This ... [truncated]');
  });

  it('handles custom object loggers with .log or .info methods', () => {
    const customLog = { log: vi.fn(), info: vi.fn() };
    const logger = createDebugLogger({ logger: customLog });

    logger({
      type: 'skipped' as const,
      conversationId: 'c1',
      turn: 1,
      reason: 'no-messages',
    });

    expect(customLog.log).toHaveBeenCalledTimes(1);
    expect(customLog.info).not.toHaveBeenCalled();
  });
});
