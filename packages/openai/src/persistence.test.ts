/* eslint-disable @typescript-eslint/no-explicit-any */
import type OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryCaesuraStore,
  type AnalyzeRequestBody,
  type CaesuraEvent,
} from '@caesura-io/core';
import { createCaesura } from './wrapper.js';
import { getMessageText } from './adapters.js';

const text = 'I feel unsure about the next step.';
const originalAnalysis = { recommendation: 'Ask what feels uncertain.', id: 1 };
const duplicate = {
  isSame: true,
  recommendation: 'DUPLICATE MUST NOT BE INJECTED',
};
const roles = ['user', 'assistant', 'user', 'assistant'] as const;
const names = ['Customer', 'Agent', 'Customer', 'Agent'];
afterEach(() => vi.unstubAllGlobals());

describe.each(['sync', 'async'] as const)(
  'persisted speaker identity and duplicate guidance in %s mode',
  (mode) => {
    it.each(['chat', 'responses', 'switch'] as const)(
      'four identical-text turns through %s',
      async (api) => {
        const store = new MemoryCaesuraStore();
        const events: CaesuraEvent[] = [];
        const requests: AnalyzeRequestBody[] = [];
        const saved: {
          text: string;
          speakerName?: string;
          speakerIndex: number;
        }[] = [];
        const releases: (() => void)[] = [];
        const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
          if (url.endsWith('/api/conversation'))
            return Response.json({ id: 'one-conversation' });
          if (url.includes('/api/conversation?'))
            return Response.json({
              success: true,
              conversation: { analyses: saved },
            });
          expect(url).toBe('https://api.caesurao.com/api/analyze');
          const request: AnalyzeRequestBody = JSON.parse(init!.body as string);
          requests.push(request);
          if (mode === 'async')
            await new Promise<void>((resolve) => releases.push(resolve));
          // Replay the unchanged backend selector, including its fallback index of 0.
          const current = request.messages.at(-1)!;
          saved.push({
            text: current.text,
            speakerName: current.speakerName,
            speakerIndex: current.speakerIndex ?? 0,
          });
          return Response.json(
            saved.length === 1 ? originalAnalysis : duplicate,
          );
        });
        vi.stubGlobal('fetch', fetcher);
        const chat = vi.fn().mockResolvedValue({ choices: [] });
        const responses = vi.fn().mockResolvedValue({ output: [] });
        const client = createCaesura(
          {
            chat: { completions: { create: chat } },
            responses: { create: responses },
          } as unknown as OpenAI,
          {
            apiKey: 'test',
            mode,
            persist: true,
            store,
            calculateSimilarities: true,
            similarityThreshold: 0.8,
            inject: { skillPrompt: '', placement: 'end' },
            onEvent: (event) => events.push(event),
          },
        );
        const id = await client.createConversation({
          name: 'Four-turn regression',
        });
        for (const [turn, role] of roles.entries()) {
          const useResponses =
            api === 'responses' || (api === 'switch' && turn % 2 === 0);
          const input: any[] = useResponses
            ? [
                {
                  type: 'message',
                  role,
                  content: [
                    {
                      type: role === 'user' ? 'input_text' : 'output_text',
                      text,
                    },
                  ],
                },
              ]
            : [{ role, content: text }];
          const before = structuredClone(input);
          const opts = { caesura: { conversationId: id } };
          if (useResponses)
            await client.responses.create({ model: 'test', input }, opts);
          else
            await client.chat.completions.create(
              { model: 'test', messages: input },
              opts,
            );
          expect(input).toEqual(before);
          const body = (useResponses ? responses : chat).mock.calls.at(-1)![0];
          const forwarded = useResponses ? body.input : body.messages;
          expect(forwarded[0]).toEqual(before[0]);
          const guidance = forwarded
            .slice(1)
            .map((m: any) => getMessageText(m.content));
          expect(guidance).toEqual(
            mode === 'async' && turn === 0
              ? []
              : ['CONVERSATION ANALYSIS:\n' + JSON.stringify(originalAnalysis)],
          );
          if (mode === 'async') {
            expect(store.get(id).inFlight).toBe(true);
            expect(releases).toHaveLength(turn + 1);
            releases[turn]!();
          }
          await vi.waitFor(() => expect(store.get(id).inFlight).toBe(false));
          expect(store.get(id).recommendations.map((r) => r.analysis)).toEqual([
            originalAnalysis,
          ]);
          const request = requests[turn]!;
          expect(request).toMatchObject({
            persist: true,
            sessionId: id,
            conversationId: id,
            calculateSimilarities: true,
            similarityThreshold: 0.8,
          });
          const utterance = {
            speakerRole: 'user',
            speakerName: names[turn],
            speakerIndex: 1 - (turn % 2),
            text,
          };
          const history = {
            speakerRole: 'assistant',
            speakerIndex: -1,
            text: JSON.stringify(originalAnalysis),
          };
          expect(request.messages).toEqual(
            turn === 0 ? [utterance] : [history, utterance],
          );
          expect(request.messages.at(-1)).toEqual(utterance);
        }
        const response = await fetch(
          `https://api.caesurao.com/api/conversation?conversationId=${id}`,
        );
        const conversation = (await response.json()).conversation;
        expect(conversation.analyses).toEqual(
          roles.map((_, i) => ({
            text,
            speakerName: names[i],
            speakerIndex: 1 - (i % 2),
          })),
        );
        expect(
          events.filter((event) => event.type === 'buffered'),
        ).toHaveLength(1);
        expect(events.filter((event) => event.type === 'deduped')).toHaveLength(
          3,
        );
        expect(events.filter((event) => event.type === 'error')).toEqual([]);
      },
    );
  },
);
