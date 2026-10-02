import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalyzeRequestBody, SendConfig } from '@caesura-io/core';
import { caesuraMiddleware } from './middleware.js';

const previous = { recommendation: 'Prior guidance', emoji: '😊' };
const history = {
  speakerRole: 'assistant',
  speakerIndex: -1,
  text: JSON.stringify(previous),
};
const scenarios: {
  label: string;
  role: string;
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
    label: 'actual agent dialogue',
    role: 'assistant',
    text: 'Let me check',
    retainHistory: true,
  },
  {
    label: 'JSON agent dialogue is not prior analysis',
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
    label: 'history fits message budget',
    role: 'user',
    text: 'same',
    send: { maxMessages: 2 },
    retainHistory: true,
  },
  {
    label: 'only current utterance fits',
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
    label: 'character-trimmed current utterance',
    role: 'assistant',
    text: 'prefix-current',
    send: { maxInputChars: 7 },
    persisted: 'current',
    retainHistory: false,
  },
];

afterEach(() => vi.unstubAllGlobals());
describe.each(['generate', 'stream'] as const)(
  'backend contract for AI SDK %s',
  (type) => {
    it.each(scenarios)('$label', async (scenario) => {
      const requests: AnalyzeRequestBody[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url, init) => {
          requests.push(JSON.parse(init.body));
          return Response.json(previous);
        }),
      );
      const middleware = caesuraMiddleware({
        apiKey: 'test',
        mode: 'sync',
        speakerNames: { agent: 'Support', customer: 'Visitor' },
        send: scenario.send,
        inject: { skillPrompt: '', keepLast: 0 },
      });
      const current = {
        role: scenario.role,
        content: [{ type: 'text', text: scenario.text }],
        ...(scenario.name ? { name: scenario.name } : {}),
      };
      for (const includeOld of [false, true]) {
        const prompt = [
          ...(includeOld && scenario.oldText
            ? [
                {
                  role: 'user',
                  content: [{ type: 'text', text: scenario.oldText }],
                },
              ]
            : []),
          current,
        ];
        const params = {
          prompt,
          providerOptions: {
            caesura: { conversationId: 'backend-conversation' },
          },
        };
        const original = structuredClone(params);
        const result = await middleware.transformParams!({
          type,
          params,
          model: {},
        });
        expect(params).toEqual(original);
        expect(result.prompt).toEqual(original.prompt);
      }
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
