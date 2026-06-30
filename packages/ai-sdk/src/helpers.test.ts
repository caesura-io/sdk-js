import { describe, it, expect } from 'vitest';
import {
  collectMessages,
  injectBlocks,
  messageText,
  applySkillPrompt,
} from './helpers.js';
import { hashMessage } from '@caesura-io/core';
import type { PromptMessageLike } from './internal/ai-types.js';

describe('AI SDK helpers', () => {
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
      });
      expect(collected[1]).toEqual({
        speakerRole: 'user',
        speakerName: 'Agent',
        text: 'assistant response',
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

  describe('injectBlocks', () => {
    it('appends them all individually to end if placement is end', () => {
      const prompt: PromptMessageLike[] = [
        { role: 'user', content: 'hello' },
      ];
      const blocks = [
        { recommendationId: '1', text: 'rec 1', afterMessageHash: 'h1', createdAtTurn: 1 },
        { recommendationId: '2', text: 'rec 2', afterMessageHash: 'h2', createdAtTurn: 2 },
      ];
      const injected = injectBlocks(prompt, blocks, { placement: 'end', as: 'user', keepLast: 'all', ttl: { type: 'none' }, template: '' }, { customer: 'Customer', agent: 'Agent' });
      
      expect(injected.prompt).toHaveLength(3);
      expect(injected.prompt[1]!.content[0]!.text).toBe('rec 1');
      expect(injected.prompt[2]!.content[0]!.text).toBe('rec 2');
      expect(injected.indices).toEqual([1, 2]);
    });

    it('interleaves blocks chronologically after their anchor message', () => {
      const speakerNames = { customer: 'Customer', agent: 'Agent' };
      const msg1Hash = hashMessage('Customer', 'first message');
      const msg2Hash = hashMessage('Customer', 'second message');

      const prompt: PromptMessageLike[] = [
        { role: 'user', content: 'first message' },
        { role: 'user', content: 'second message' },
        { role: 'user', content: 'third message' },
      ];
      
      const blocks = [
        { recommendationId: '1', text: 'rec 1', afterMessageHash: msg1Hash, createdAtTurn: 1 },
        { recommendationId: '2', text: 'rec 2', afterMessageHash: msg2Hash, createdAtTurn: 2 },
      ];

      const injected = injectBlocks(
        prompt,
        blocks,
        { placement: 'after-last-analyzed', as: 'user', keepLast: 'all', ttl: { type: 'none' }, template: '' },
        speakerNames
      );

      expect(injected.prompt).toHaveLength(5);
      expect(messageText(injected.prompt[0]!.content)).toBe('first message');
      expect(injected.prompt[1]!.content[0]!.text).toBe('rec 1');
      expect(messageText(injected.prompt[2]!.content)).toBe('second message');
      expect(injected.prompt[3]!.content[0]!.text).toBe('rec 2');
      expect(messageText(injected.prompt[4]!.content)).toBe('third message');
      expect(injected.indices).toEqual([1, 3]);
    });

    it('prepends the latest unanchored block and skips older unanchored ones', () => {
      const speakerNames = { customer: 'Customer', agent: 'Agent' };
      const prompt: PromptMessageLike[] = [
        { role: 'user', content: 'only message' },
      ];
      
      const blocks = [
        { recommendationId: '1', text: 'old unanchored', afterMessageHash: 'missing', createdAtTurn: 1 },
        { recommendationId: '2', text: 'new unanchored', afterMessageHash: 'also missing', createdAtTurn: 2 },
      ];

      const injected = injectBlocks(
        prompt,
        blocks,
        { placement: 'after-last-analyzed', as: 'user', keepLast: 'all', ttl: { type: 'none' }, template: '' },
        speakerNames
      );

      expect(injected.prompt).toHaveLength(2);
      expect(injected.prompt[0]!.content[0]!.text).toBe('new unanchored');
      expect(messageText(injected.prompt[1]!.content)).toBe('only message');
      // Indices array maps back to original blocks array
      expect(injected.indices).toEqual([-1, 0]); // block 1 skipped, block 2 prepended
    });

    it('merges blocks that land at the exact same index', () => {
      const speakerNames = { customer: 'Customer', agent: 'Agent' };
      const msgHash = hashMessage('Customer', 'only message');

      const prompt: PromptMessageLike[] = [
        { role: 'user', content: 'only message' },
      ];
      
      const blocks = [
        { recommendationId: '1', text: 'rec A', afterMessageHash: msgHash, createdAtTurn: 1 },
        { recommendationId: '2', text: 'rec B', afterMessageHash: msgHash, createdAtTurn: 1 },
      ];

      const injected = injectBlocks(
        prompt,
        blocks,
        { placement: 'after-last-analyzed', as: 'user', keepLast: 'all', ttl: { type: 'none' }, template: '' },
        speakerNames
      );

      expect(injected.prompt).toHaveLength(2);
      expect(messageText(injected.prompt[0]!.content)).toBe('only message');
      expect(injected.prompt[1]!.content[0]!.text).toBe('rec A\n\nrec B');
      expect(injected.indices).toEqual([1, 1]);
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
