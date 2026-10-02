import type OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCaesuraStore, type AnalyzeRequestBody } from '@caesura-io/core';
import { createCaesura } from './wrapper.js';

afterEach(() => vi.unstubAllGlobals());

describe.each(['sync', 'async'] as const)(
  'OpenAI guidance recipient in %s mode',
  (mode) => {
    describe.each(['chat', 'responses'] as const)('%s', (api) => {
      it.each([
        { speakerNames: undefined, agent: 'Agent', customer: 'Customer' },
        {
          speakerNames: { agent: 'Support', customer: 'Visitor' },
          agent: 'Support',
          customer: 'Visitor',
        },
      ])(
        'always sends currentUser=$agent',
        async ({ speakerNames, agent, customer }) => {
          const requests: AnalyzeRequestBody[] = [];
          vi.stubGlobal(
            'fetch',
            vi.fn(async (url, init) => {
              expect(url).toBe('https://api.caesurao.com/api/analyze');
              requests.push(JSON.parse(init.body));
              return Response.json({ isSame: true });
            }),
          );
          const create = vi.fn().mockResolvedValue({});
          const store = new MemoryCaesuraStore();
          const client = createCaesura(
            {
              chat: { completions: { create } },
              responses: { create },
            } as unknown as OpenAI,
            {
              apiKey: 'test',
              mode,
              store,
              speakerNames,
              inject: { skillPrompt: '' },
            },
          );
          for (const role of ['user', 'assistant'] as const) {
            for (const name of [undefined, 'Per-message override']) {
              const messages = [
                { role, content: 'same text', ...(name ? { name } : {}) },
              ];
              const opts = {
                caesura: { conversationId: 'existing-conversation' },
              };
              if (api === 'chat')
                await client.chat.completions.create(
                  { model: 'test', messages },
                  opts,
                );
              else
                await client.responses.create(
                  {
                    model: 'test',
                    input: messages.map((m) => ({
                      ...m,
                      content: [
                        {
                          type:
                            role === 'user'
                              ? ('input_text' as const)
                              : ('output_text' as const),
                          text: m.content,
                        },
                      ],
                    })),
                  },
                  opts,
                );
              await vi.waitFor(() =>
                expect(store.get('existing-conversation').inFlight).toBe(false),
              );
              expect(requests.at(-1)?.currentUser).toBe(agent);
              expect(requests.at(-1)!.messages).toEqual([
                {
                  speakerRole: 'user',
                  speakerName:
                    name ?? (role === 'assistant' ? agent : customer),
                  speakerIndex: role === 'assistant' ? 0 : 1,
                  text: 'same text',
                },
              ]);
              const forwarded = create.mock.calls.at(-1)![0];
              expect(
                (api === 'chat' ? forwarded.messages : forwarded.input)[0].role,
              ).toBe(role);
            }
          }
          expect(requests).toHaveLength(4);
        },
      );
    });
  },
);
