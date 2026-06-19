import { describe, it, expect } from 'vitest';
import {
  collectMessages,
  renderAnalysis,
  selectActive,
  injectBlock,
  messageText,
  renderBlock,
  applySkillPrompt,
} from './helpers.js';
import type { ConversationState } from './store.js';
import type { PromptMessageLike } from './internal/ai-types.js';

describe('helpers', () => {
  describe('messageText', () => {
    it('handles string content', () => {
      expect(messageText('hello')).toBe('hello');
    });

    it('handles text parts array', () => {
      expect(messageText([{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }])).toBe('hello world');
    });

    it('skips non-text parts', () => {
      expect(messageText([{ type: 'image', text: 'ignored' }, { type: 'text', text: 'hello' }])).toBe('hello');
    });
  });

  describe('collectMessages', () => {
    const speakers = { agent: 'Agent', customer: 'Customer' };

    it('collects assistant and user messages', () => {
      const prompt: PromptMessageLike[] = [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'user message' },
        { role: 'assistant', content: 'assistant response' },
      ];

      const collected = collectMessages(prompt, { maxMessages: 10 }, speakers, new Set());
      expect(collected).toHaveLength(2);
      expect(collected[0]).toEqual({
        speakerRole: 'user',
        speakerName: 'Customer',
        text: 'user message',
        sourceIndex: 1,
      });
      expect(collected[1]).toEqual({
        speakerRole: 'assistant',
        speakerName: 'Agent',
        text: 'assistant response',
        sourceIndex: 2,
      });
    });

    it('skips injected blocks based on text match', () => {
      const prompt: PromptMessageLike[] = [
        { role: 'user', content: 'hello' },
        { role: 'user', content: 'injected rec' },
      ];

      const collected = collectMessages(prompt, { maxMessages: 10 }, speakers, new Set(['injected rec']));
      expect(collected).toHaveLength(1);
      expect(collected[0]!.text).toBe('hello');
    });

    it('respects maxMessages and trims oldest first', () => {
      const prompt: PromptMessageLike[] = [
        { role: 'user', content: '1' },
        { role: 'user', content: '2' },
        { role: 'user', content: '3' },
      ];

      const collected = collectMessages(prompt, { maxMessages: 2 }, speakers, new Set());
      expect(collected).toHaveLength(2);
      expect(collected[0]!.text).toBe('2');
      expect(collected[1]!.text).toBe('3');
    });

    it('respects maxInputChars and trims oldest first', () => {
      const prompt: PromptMessageLike[] = [
        { role: 'user', content: 'hello' },
        { role: 'user', content: 'world' },
      ];

      const collected = collectMessages(prompt, { maxMessages: 10, maxInputChars: 7 }, speakers, new Set());
      expect(collected).toHaveLength(1);
      expect(collected[0]!.text).toBe('world');
    });

    it('trims head of a single message if it exceeds maxInputChars', () => {
      const prompt: PromptMessageLike[] = [
        { role: 'user', content: 'hello world' },
      ];

      const collected = collectMessages(prompt, { maxMessages: 10, maxInputChars: 5 }, speakers, new Set());
      expect(collected).toHaveLength(1);
      expect(collected[0]!.text).toBe('world');
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
        { id: '1', analysis: { recommendation: 'A' }, createdAtMs: 1000, createdAtTurn: 1 },
        { id: '2', analysis: { recommendation: 'B' }, createdAtMs: 2000, createdAtTurn: 2 },
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

  describe('injectBlock', () => {
    it('appends to end by default', () => {
      const prompt: PromptMessageLike[] = [
        { role: 'user', content: 'hello' },
      ];

      const injected = injectBlock(prompt, 'rec', { placement: 'end', as: 'user', keepLast: 'all', ttl: { type: 'none' }, template: '' }, undefined);
      expect(injected).toHaveLength(2);
      expect(injected[1]!.content[0]!.text).toBe('rec');
    });

    it('spliced right after last analyzed message', () => {
      const prompt: PromptMessageLike[] = [
        { role: 'user', content: 'first message' },
        { role: 'user', content: 'second message' },
        { role: 'user', content: 'third message' },
      ];

      const injected = injectBlock(
        prompt,
        'rec',
        { placement: 'after-last-analyzed', as: 'user', keepLast: 'all', ttl: { type: 'none' }, template: '' },
        'second message'
      );

      expect(injected).toHaveLength(4);
      expect(messageText(injected[0]!.content)).toBe('first message');
      expect(messageText(injected[1]!.content)).toBe('second message');
      expect(injected[2]!.content[0]!.text).toBe('rec');
      expect(messageText(injected[3]!.content)).toBe('third message');
    });
  });

  describe('renderBlock', () => {
    it('concatenates recommendations without prepending skillPrompt', () => {
      const recs = [
        { id: '1', analysis: { recommendation: 'Rec A' }, createdAtMs: 1000, createdAtTurn: 1 },
        { id: '2', analysis: { recommendation: 'Rec B' }, createdAtMs: 2000, createdAtTurn: 2 },
      ];
      const block = renderBlock(recs, {
        template: 'Rec: {analysis.recommendation}',
        skillPrompt: 'Should be ignored in renderBlock',
        placement: 'end',
        as: 'user',
        keepLast: 'all',
        ttl: { type: 'none' },
      });
      expect(block).toBe('Rec: Rec A\n\nRec: Rec B');
    });
  });

  describe('applySkillPrompt', () => {
    it('returns unmodified prompt if skillPrompt is empty', () => {
      const prompt: PromptMessageLike[] = [{ role: 'user', content: 'hello' }];
      expect(applySkillPrompt(prompt, undefined)).toBe(prompt);
      expect(applySkillPrompt(prompt, '')).toBe(prompt);
      expect(applySkillPrompt(prompt, '   ')).toBe(prompt);
    });

    it('appends skillPrompt to existing system prompt string content', () => {
      const prompt: PromptMessageLike[] = [
        { role: 'system', content: 'System instruction' },
        { role: 'user', content: 'hello' },
      ];
      const res = applySkillPrompt(prompt, 'Skill prompt');
      expect(res).toHaveLength(2);
      expect(res[0]!.content).toBe('System instruction\n\nSkill prompt');
    });

    it('appends skillPrompt to existing system prompt array content', () => {
      const prompt: PromptMessageLike[] = [
        { role: 'system', content: [{ type: 'text', text: 'System instruction' }] },
        { role: 'user', content: 'hello' },
      ];
      const res = applySkillPrompt(prompt, 'Skill prompt');
      expect(res).toHaveLength(2);
      expect(Array.isArray(res[0]!.content)).toBe(true);
      expect(res[0]!.content).toEqual([
        { type: 'text', text: 'System instruction' },
        { type: 'text', text: '\n\nSkill prompt' },
      ]);
    });

    it('skips appending if skillPrompt is already present', () => {
      const prompt: PromptMessageLike[] = [
        { role: 'system', content: 'System instruction\n\nSkill prompt' },
        { role: 'user', content: 'hello' },
      ];
      const res = applySkillPrompt(prompt, 'Skill prompt');
      expect(res).toBe(prompt);
    });

    it('prepends a new system prompt if absent', () => {
      const prompt: PromptMessageLike[] = [
        { role: 'user', content: 'hello' },
      ];
      const res = applySkillPrompt(prompt, 'Skill prompt');
      expect(res).toHaveLength(2);
      expect(res[0]).toEqual({
        role: 'system',
        content: [{ type: 'text', text: 'Skill prompt' }],
      });
      expect(res[1]).toEqual({ role: 'user', content: 'hello' });
    });
  });
});
