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
      expect(
        getMessageText([
          { type: 'text', text: 'hello' },
          { type: 'text', text: ' world' },
        ]),
      ).toBe('hello world');
    });

    it('ignores non-text parts', () => {
      expect(
        getMessageText([
          { type: 'image_url', image_url: { url: '...' } },
          { type: 'text', text: 'hello' },
        ]),
      ).toBe('hello');
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

      const collected = collectOpenAIMessages(
        messages,
        { maxMessages: 10 },
        speakers,
        new Set(),
      );
      expect(collected).toHaveLength(2);
      expect(collected[0]).toEqual({
        speakerRole: 'user',
        speakerName: 'Customer',
        speakerIndex: 1,
        text: 'user message',
      });
      expect(collected[1]).toEqual({
        speakerRole: 'user',
        speakerName: 'Agent',
        speakerIndex: 0,
        text: 'assistant reply',
      });
    });

    it('normalizes string input for Responses API', () => {
      const collected = collectOpenAIMessages(
        'hello prompt',
        { maxMessages: 10 },
        speakers,
        new Set(),
      );
      expect(collected).toEqual([
        {
          speakerRole: 'user',
          speakerName: 'Customer',
          speakerIndex: 1,
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

      const collected = collectOpenAIMessages(
        messages,
        { maxMessages: 2 },
        speakers,
        new Set(),
      );
      expect(collected).toHaveLength(2);
      expect(collected[0]!.text).toBe('second');
      expect(collected[1]!.text).toBe('third');

      const collectedChars = collectOpenAIMessages(
        messages,
        { maxMessages: 10, maxInputChars: 10 },
        speakers,
        new Set(),
      );
      expect(collectedChars.map((m) => m.text)).toEqual(['econd', 'third']);
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
      const { instructions } = applySkillPromptOpenAI(
        [],
        'Skill prompt',
        'Base instructions',
      );
      expect(instructions).toBe('Base instructions\n\nSkill prompt');

      const { instructions: emptyBase } = applySkillPromptOpenAI(
        [],
        'Skill prompt',
        null,
      );
      expect(emptyBase).toBe('Skill prompt');
    });
  });

  describe('injectBlocksOpenAI', () => {
    const speakerNames = { customer: 'Customer', agent: 'Agent' };

    it('appends blocks to end in placement end mode', () => {
      const messages = [{ role: 'user', content: 'hello' }];
      const blocks = [
        {
          recommendationId: '1',
          text: 'rec 1',
          afterMessageHash: 'h1',
          createdAtTurn: 1,
        },
      ];

      const { result, indices } = injectBlocksOpenAI(
        messages,
        blocks,
        {
          placement: 'end',
          as: 'user',
          keepLast: 'all',
          ttl: { type: 'none' },
          template: '',
        },
        speakerNames,
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
        {
          recommendationId: '1',
          text: 'rec 1',
          afterMessageHash: msgHash,
          createdAtTurn: 1,
        },
      ];

      const { result, indices } = injectBlocksOpenAI(
        messages,
        blocks,
        {
          placement: 'after-last-analyzed',
          as: 'user',
          keepLast: 'all',
          ttl: { type: 'none' },
          template: '',
        },
        speakerNames,
      );

      expect(result).toHaveLength(3);
      expect(result[0].content).toBe('hello');
      expect(result[1]).toEqual({ role: 'user', content: 'rec 1' });
      expect(result[2].content).toBe('world');
      expect(indices).toEqual([1]);
    });
  });
});

describe('dialogue and tool-order regressions', () => {
  const speakers = { agent: 'Support', customer: 'Visitor' };
  it('collects Responses text and ignores reasoning, instructions, and tools', () => {
    const input = [
      { role: 'system', content: 'private' },
      { role: 'developer', content: 'private' },
      { role: 'user', content: [{ type: 'input_text', text: 'שלום' }] },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '😊' }],
      },
      {
        role: 'assistant',
        name: 'Named',
        content: 'Let me check',
        tool_calls: [{ id: 'one' }],
      },
      { role: 'assistant', content: null, tool_calls: [{ id: 'two' }] },
      {
        type: 'reasoning',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'private' }],
      },
      { type: 'function_call', arguments: '{"secret":true}' },
      { type: 'function_call_output', output: 'private' },
      { role: 'tool', content: 'private' },
    ];
    expect(collectOpenAIMessages(input, {}, speakers, new Set())).toEqual([
      {
        speakerRole: 'user',
        speakerName: 'Visitor',
        speakerIndex: 1,
        text: 'שלום',
      },
      {
        speakerRole: 'user',
        speakerName: 'Support',
        speakerIndex: 0,
        text: '😊',
      },
      {
        speakerRole: 'user',
        speakerName: 'Named',
        speakerIndex: 0,
        text: 'Let me check',
      },
    ]);
  });

  it.each([{ maxMessages: 0 }, { maxInputChars: 0 }])(
    'zero collection limit %j',
    (send) => {
      expect(collectOpenAIMessages('hello', send, speakers, new Set())).toEqual(
        [],
      );
    },
  );

  it('keeps parallel tool results adjacent and reports final injection indices', () => {
    const input = [
      { role: 'user', content: 'question' },
      {
        role: 'assistant',
        name: 'Named',
        content: 'checking',
        tool_calls: [{ id: 'a' }, { id: 'b' }],
      },
      { role: 'tool', tool_call_id: 'a', content: 'first' },
      { role: 'tool', tool_call_id: 'b', content: 'second' },
    ];
    const blocks = [
      {
        recommendationId: 'one',
        text: 'first advice',
        afterMessageHash: hashMessage('Visitor', 'question'),
        createdAtTurn: 1,
      },
      {
        recommendationId: 'two',
        text: 'second advice',
        afterMessageHash: hashMessage('Named', 'checking'),
        createdAtTurn: 2,
      },
    ];
    const inject = {
      placement: 'after-last-analyzed' as const,
      as: 'user' as const,
      keepLast: 'all' as const,
      ttl: { type: 'none' as const },
      template: '{analysis}',
    };
    const { result, indices } = injectBlocksOpenAI(
      input,
      blocks,
      inject,
      speakers,
    );
    expect(result).toEqual([
      input[0],
      { role: 'user', content: 'first advice' },
      ...input.slice(1),
      { role: 'user', content: 'second advice' },
    ]);
    expect(indices).toEqual([1, 5]);
    expect(input).toHaveLength(4);
  });
});

it.each([0, 1, 8])(
  'preserves explicit speakerIndex %s in Chat and Responses collection',
  (speakerIndex) => {
    for (const content of [
      'prefix-current',
      [{ type: 'output_text', text: 'prefix-current' }],
    ]) {
      const messages = [{ role: 'assistant', speakerIndex, content }];
      const original = structuredClone(messages);
      expect(
        collectOpenAIMessages(
          messages,
          { maxMessages: 1, maxInputChars: 7 },
          { agent: 'Agent', customer: 'Customer' },
          new Set(),
        ),
      ).toEqual([
        {
          speakerRole: 'user',
          speakerName: 'Agent',
          speakerIndex,
          text: 'current',
        },
      ]);
      expect(messages).toEqual(original);
    }
  },
);
