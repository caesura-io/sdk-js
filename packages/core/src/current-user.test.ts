import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCaesuraEngine } from './engine.js';
import type { AnalyzeRequestBody } from './client.js';

afterEach(() => vi.unstubAllGlobals());

describe.each(['sync', 'async'] as const)(
  'guidance recipient in %s mode',
  (mode) => {
    it.each([
      { speakerNames: undefined, agent: 'Agent', customer: 'Customer' },
      {
        speakerNames: { agent: 'Support', customer: 'Visitor' },
        agent: 'Support',
        customer: 'Visitor',
      },
      {
        speakerNames: { customer: 'Visitor' },
        agent: 'Agent',
        customer: 'Visitor',
      },
    ])(
      'uses configured agent $agent independently of the latest speaker',
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
        const engine = createCaesuraEngine({
          apiKey: 'test',
          mode,
          speakerNames,
        });
        for (const speakerRole of ['user', 'assistant'] as const) {
          for (const speakerName of [undefined, 'Per-message override']) {
            const input = [{ speakerRole, speakerName, text: 'same text' }];
            const original = structuredClone(input);
            await engine.observe('existing-conversation', input);
            await vi.waitFor(() =>
              expect(engine.store.get('existing-conversation').inFlight).toBe(
                false,
              ),
            );
            expect(requests.at(-1)).toMatchObject({
              currentUser: agent,
              persist: true,
              sessionId: 'existing-conversation',
            });
            expect(requests.at(-1)!.messages).toEqual([
              {
                speakerRole: 'user',
                speakerName:
                  speakerName ??
                  (speakerRole === 'assistant' ? agent : customer),
                speakerIndex: speakerRole === 'assistant' ? 0 : 1,
                text: 'same text',
              },
            ]);
            expect(input).toEqual(original);
          }
        }
        expect(requests).toHaveLength(4);
      },
    );
  },
);
