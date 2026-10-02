import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCaesuraStore, type AnalyzeRequestBody } from '@caesura-io/core';
import { caesuraMiddleware } from './middleware.js';

afterEach(() => vi.unstubAllGlobals());

describe.each(['sync', 'async'] as const)(
  'AI SDK guidance recipient in %s mode',
  (mode) => {
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
        const store = new MemoryCaesuraStore();
        const middleware = caesuraMiddleware({
          apiKey: 'test',
          mode,
          store,
          speakerNames,
          inject: { skillPrompt: '' },
        });
        for (const role of ['user', 'assistant'] as const) {
          for (const name of [undefined, 'Per-message override']) {
            const prompt = [
              {
                role,
                content: [{ type: 'text', text: 'same text' }],
                ...(name ? { name } : {}),
              },
            ];
            const result = await middleware.transformParams!({
              type: 'generate',
              model: {},
              params: {
                prompt,
                providerOptions: {
                  caesura: { conversationId: 'existing-conversation' },
                },
              },
            });
            await vi.waitFor(() =>
              expect(store.get('existing-conversation').inFlight).toBe(false),
            );
            expect(requests.at(-1)?.currentUser).toBe(agent);
            expect(requests.at(-1)!.messages).toEqual([
              {
                speakerRole: 'user',
                speakerName: name ?? (role === 'assistant' ? agent : customer),
                speakerIndex: role === 'assistant' ? 0 : 1,
                text: 'same text',
              },
            ]);
            expect(result.prompt).toEqual(prompt);
          }
        }
        expect(requests).toHaveLength(4);
      },
    );
  },
);
