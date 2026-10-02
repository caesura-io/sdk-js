/* eslint-disable @typescript-eslint/no-explicit-any */
import type OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalyzeRequestBody, SendConfig } from '@caesura-io/core';
import { createCaesura } from './wrapper.js';

const previous = { recommendation: 'Prior guidance', emoji: '😊' };
const history = {
  speakerRole: 'assistant',
  speakerIndex: -1,
  text: JSON.stringify(previous),
};
const scenarios: {
  label: string;
  role: 'user' | 'assistant';
  text: string;
  name?: string;
  send?: SendConfig;
  oldText?: string;
  persisted?: string;
  retainHistory: boolean;
}[] = [
  {
    label: 'identical customer prompts',
    role: 'user',
    text: 'same',
    retainHistory: true,
  },
  {
    label: 'identical agent dialogue',
    role: 'assistant',
    text: 'Let me check',
    retainHistory: true,
  },
  {
    label: 'JSON agent dialogue is transcript, not an analysis',
    role: 'assistant',
    text: '{"recommendation":"actual agent dialogue"}',
    retainHistory: true,
  },
  {
    label: 'explicit agent name',
    role: 'assistant',
    name: 'Specialist',
    text: 'same',
    retainHistory: true,
  },
  {
    label: 'history fits the message limit',
    role: 'user',
    text: 'same',
    send: { maxMessages: 2 },
    retainHistory: true,
  },
  {
    label: 'only current dialogue fits the message limit',
    role: 'assistant',
    text: 'same',
    send: { maxMessages: 1 },
    retainHistory: false,
  },
  {
    label: 'partial old dialogue takes priority over analysis context',
    role: 'assistant',
    text: 'same',
    oldText: 'old '.repeat(100),
    send: { maxMessages: 3, maxInputChars: 100 },
    retainHistory: false,
  },
  {
    label: 'current dialogue character trimmed',
    role: 'assistant',
    text: 'prefix-current',
    send: { maxInputChars: 7 },
    persisted: 'current',
    retainHistory: false,
  },
];

afterEach(() => vi.unstubAllGlobals());

describe.each([
  ['chat', 'chat'],
  ['responses', 'responses'],
  ['responses', 'chat'],
] as const)(
  'backend contract: %s then %s on the same instance and ID',
  (first, second) => {
    it.each(scenarios)('$label', async (scenario) => {
      const requests: AnalyzeRequestBody[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url, init) => {
          requests.push(JSON.parse(init.body));
          return Response.json(previous);
        }),
      );
      const chat = vi.fn().mockResolvedValue({ choices: [] });
      const responses = vi.fn().mockResolvedValue({ output: [] });
      const client = createCaesura(
        {
          chat: { completions: { create: chat } },
          responses: { create: responses },
        } as unknown as OpenAI,
        {
          apiKey: 'test',
          mode: 'sync',
          speakerNames: { agent: 'Support', customer: 'Visitor' },
          send: scenario.send,
          // Isolate backend adaptation and verify provider input is forwarded unchanged.
          inject: { skillPrompt: '', keepLast: 0 },
        },
      );
      const current = {
        role: scenario.role,
        content: scenario.text,
        ...(scenario.name ? { name: scenario.name } : {}),
      };
      const call = async (api: 'chat' | 'responses', includeOld: boolean) => {
        const messages = [
          ...(includeOld && scenario.oldText
            ? [{ role: 'user', content: scenario.oldText }]
            : []),
          current,
        ];
        const input = messages.map(({ content, ...message }) => ({
          ...message,
          type: 'message',
          content: [
            {
              type: message.role === 'assistant' ? 'output_text' : 'input_text',
              text: content,
            },
          ],
        }));
        // Exercise string input as well as Responses message and reusable output shapes.
        const body: any =
          api === 'chat'
            ? { model: 'test', messages }
            : {
                model: 'test',
                input:
                  scenario.role === 'user' && !includeOld
                    ? scenario.text
                    : input,
              };
        const original = structuredClone(body);
        const opts = { caesura: { conversationId: 'backend-conversation' } };
        if (api === 'chat') await client.chat.completions.create(body, opts);
        else await client.responses.create(body, opts);
        expect(body).toEqual(original);
        const forwarded = (api === 'chat' ? chat : responses).mock.calls.at(
          -1,
        )![0];
        expect(forwarded[api === 'chat' ? 'messages' : 'input']).toEqual(
          original[api === 'chat' ? 'messages' : 'input'],
        );
      };
      await call(first, false);
      await call(second, true);
      const utterance = {
        speakerRole: 'user',
        speakerIndex: scenario.role === 'assistant' ? 0 : 1,
        speakerName:
          scenario.name ??
          (scenario.role === 'assistant' ? 'Support' : 'Visitor'),
        text: scenario.persisted ?? scenario.text,
      };
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request).toMatchObject({
          persist: true,
          conversationId: 'backend-conversation',
          sessionId: 'backend-conversation',
        });
        // The unchanged backend persists this exact array entry.
        expect(request.messages.at(-1)).toEqual(utterance);
        expect(request.messages.every((message) => !('kind' in message))).toBe(
          true,
        );
      }
      expect(requests[0]!.messages).toEqual([utterance]);
      expect(requests[1]!.messages).toEqual(
        scenario.oldText
          ? [
              {
                speakerRole: 'user',
                speakerName: 'Visitor',
                speakerIndex: 1,
                text: 'old '.repeat(24),
              },
              utterance,
            ]
          : scenario.retainHistory
            ? [history, utterance]
            : [utterance],
      );
      expect(
        requests[1]!.messages.filter((m) => m.speakerRole === 'assistant'),
      ).toEqual(scenario.retainHistory ? [history] : []);
    });
  },
);
