import { describe, it, expect } from 'vitest';
import {
  collectOpenAIMessages,
  applySkillPromptOpenAI,
  injectBlocksOpenAI,
  getMessageText,
} from './adapters.js';
import { hashMessage } from '@caesura-io/core';

describe('OpenAI adapters', () => {
  describe('getMessageText', () => {
    it('handles string content', () => {
      expect(getMessageText('hello')).toBe('hello');
    });

    it('handles content part array', () => {
      expect(getMessageText([{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }])).toBe('hello world');
    });

    it('ignores non-text parts', () => {
      expect(getMessageText([{ type: 'image_url', image_url: { url: '...' } }, { type: 'text', text: 'hello' }])).toBe('hello');
    });
  });

  describe('collectOpenAIMessages', () => {
    const speakers = { agent: 'Agent', customer: 'Customer' };

    it('collects messages with role user or assistant', () => {
      const messages = [
        { role: 'developer', content: 'developer instruction' },
        { role: 'user', content: 'user message' },
        { role: 'assistant', content: 'assistant reply' },
        { role: 'system', content: 'system message' },
      ];

      const collected = collectOpenAIMessages(messages, { maxMessages: 10 }, speakers, new Set());
      expect(collected).toHaveLength(2);
      expect(collected[0]).toEqual({
        speakerRole: 'user',
        speakerName: 'Customer',
        text: 'user message',
      });
      expect(collected[1]).toEqual({
        speakerRole: 'user',
        speakerName: 'Agent',
        text: 'assistant reply',
      });
    });

    it('normalizes string input for Responses API', () => {
      const collected = collectOpenAIMessages('hello prompt', { maxMessages: 10 }, speakers, new Set());
      expect(collected).toEqual([
        {
          speakerRole: 'user',
          speakerName: 'Customer',
          text: 'hello prompt',
        },
      ]);
    });

    it('respects maxMessages and maxInputChars limits', () => {
      const messages = [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
        { role: 'user', content: 'third' },
      ];

      const collected = collectOpenAIMessages(messages, { maxMessages: 2 }, speakers, new Set());
      expect(collected).toHaveLength(2);
      expect(collected[0]!.text).toBe('second');
      expect(collected[1]!.text).toBe('third');

      const collectedChars = collectOpenAIMessages(messages, { maxMessages: 10, maxInputChars: 10 }, speakers, new Set());
      expect(collectedChars).toHaveLength(1);
      expect(collectedChars[0]!.text).toBe('third');
    });
  });

  describe('applySkillPromptOpenAI', () => {
    it('does nothing if skillPrompt is empty', () => {
      const messages = [{ role: 'user', content: 'hello' }];
      expect(applySkillPromptOpenAI(messages, undefined).result).toBe(messages);
      expect(applySkillPromptOpenAI(messages, '').result).toBe(messages);
    });

    it('appends skillPrompt to existing system/developer messages in array', () => {
      const messages = [
        { role: 'system', content: 'System instruction' },
        { role: 'user', content: 'hello' },
      ];
      const { result } = applySkillPromptOpenAI(messages, 'Skill prompt');
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('System instruction\n\nSkill prompt');
    });

    it('prepends a new system message if system message is absent in array', () => {
      const messages = [{ role: 'user', content: 'hello' }];
      const { result } = applySkillPromptOpenAI(messages, 'Skill prompt');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ role: 'system', content: 'Skill prompt' });
      expect(result[1]).toEqual({ role: 'user', content: 'hello' });
    });

    it('modifies responsesInstructions if provided', () => {
      const { instructions } = applySkillPromptOpenAI([], 'Skill prompt', 'Base instructions');
      expect(instructions).toBe('Base instructions\n\nSkill prompt');

      const { instructions: emptyBase } = applySkillPromptOpenAI([], 'Skill prompt', null);
      expect(emptyBase).toBe('Skill prompt');
    });
  });

  describe('injectBlocksOpenAI', () => {
    const speakerNames = { customer: 'Customer', agent: 'Agent' };

    it('appends blocks to end in placement end mode', () => {
      const messages = [{ role: 'user', content: 'hello' }];
      const blocks = [
        { recommendationId: '1', text: 'rec 1', afterMessageHash: 'h1', createdAtTurn: 1 },
      ];

      const { result, indices } = injectBlocksOpenAI(
        messages,
        blocks,
        { placement: 'end', as: 'user', keepLast: 'all', ttl: { type: 'none' }, template: '' },
        speakerNames
      );

      expect(result).toHaveLength(2);
      expect(result[1]).toEqual({ role: 'user', content: 'rec 1' });
      expect(indices).toEqual([1]);
    });

    it('interleaves blocks after their anchor message', () => {
      const msgHash = hashMessage('Customer', 'hello');
      const messages = [
        { role: 'user', content: 'hello' },
        { role: 'user', content: 'world' },
      ];
      const blocks = [
        { recommendationId: '1', text: 'rec 1', afterMessageHash: msgHash, createdAtTurn: 1 },
      ];

      const { result, indices } = injectBlocksOpenAI(
        messages,
        blocks,
        { placement: 'after-last-analyzed', as: 'user', keepLast: 'all', ttl: { type: 'none' }, template: '' },
        speakerNames
      );

      expect(result).toHaveLength(3);
      expect(result[0].content).toBe('hello');
      expect(result[1]).toEqual({ role: 'user', content: 'rec 1' });
      expect(result[2].content).toBe('world');
      expect(indices).toEqual([1]);
    });
  });
});
