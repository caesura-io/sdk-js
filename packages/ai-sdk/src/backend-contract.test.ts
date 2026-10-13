// Explicit event IDs isolate backend serialization; lifecycle tests cover genuine-turn fallback and continuations.
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
    label: 'actual customer dialogue',
    role: 'user',
    text: 'Let me check',
    retainHistory: true,
  },
  {
    label: 'JSON customer dialogue is not prior analysis',
    role: 'user',
    text: '{"recommendation":"actual customer dialogue"}',
    retainHistory: true,
  },
  {
    label: 'explicit customer name',
    role: 'user',
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
    role: 'user',
    text: 'same',
    send: { maxMessages: 1 },
    retainHistory: false,
  },
  {
    label: 'partial old dialogue takes priority over analysis context',
    role: 'user',
    text: 'same',
    oldText: 'old '.repeat(100),
    send: { maxMessages: 3, maxInputChars: 100 },
    retainHistory: false,
  },
  {
    label: 'character-trimmed current utterance',
    role: 'user',
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
      stubAnalysisFetch(
        vi.fn(async (_url, init) => {
          requests.push(JSON.parse(init.body));
          return Response.json(previous);
        }),
      );
      const middleware = caesuraMiddleware({
        conversationId: 'fixture-conversation',
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
            caesura: {
              conversationId: 'backend-conversation',
              turn: { id: String(includeOld), origin: 'customer' as const },
            },
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

// Analysis-only fixtures exclude the separately tested transcript endpoint.
function stubAnalysisFetch(fetcher: typeof fetch) {
  vi.stubGlobal('fetch', (url: string, init: RequestInit) =>
    url.includes('/conversation/messages?')
      ? Promise.resolve(
          Response.json({
            success: true,
            conversationId: new URL(url).searchParams.get('conversationId'),
            nextMessageId: 1,
          }),
        )
      : url.endsWith('/conversation/messages')
        ? Promise.resolve(
            Response.json({
              success: true,
              ...JSON.parse(init.body as string),
            }),
          )
        : fetcher(url, init),
  );
}
