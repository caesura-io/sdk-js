import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCaesuraStore, type AnalyzeRequestBody } from '@caesura-io/core';
import { caesuraMiddleware } from './middleware.js';
import type { PromptMessageLike } from './internal/ai-types.js';

afterEach(() => vi.unstubAllGlobals());
describe.each(['sync', 'async'] as const)(
  'AI SDK occurrence ordering in %s',
  (mode) => {
    it.each(['generate', 'stream'] as const)(
      '%s preserves exact transcript and injection order',
      async (type) => {
        const requests: AnalyzeRequestBody[] = [];
        const store = new MemoryCaesuraStore();
        let release!: () => void;
        vi.stubGlobal(
          'fetch',
          vi.fn(async (_url, init) => {
            requests.push(JSON.parse(init.body));
            if (mode === 'async')
              await new Promise<void>((resolve) => {
                release = resolve;
              });
            return Response.json(requests.length);
          }),
        );
        const middleware = caesuraMiddleware({
          apiKey: 'test',
          mode,
          store,
          conversationId: 'one',
          inject: {
            skillPrompt: '',
            template: 'A{analysis}',
            placement: 'after-last-analyzed',
          },
        });
        for (let turn = 1; turn <= 4; turn++) {
          const prompt: PromptMessageLike[] = Array.from(
            { length: turn },
            (_, i) => ({
              role: i % 2 ? 'assistant' : 'user',
              content: [{ type: 'text', text: 'same' }],
            }),
          );
          const original = structuredClone(prompt);
          const result = await middleware.transformParams!({
            type,
            params: { prompt },
            model: {},
          });
          expect(result.prompt).toEqual(
            original.flatMap((m, i) => [
              m,
              ...(i + 1 < turn || mode === 'sync'
                ? [
                    {
                      role: 'user',
                      content: [{ type: 'text', text: `A${i + 1}` }],
                    },
                  ]
                : []),
            ]),
          );
          expect(prompt).toEqual(original);
          if (mode === 'async') {
            prompt[0]!.content = 'MUTATED';
            release();
            await vi.waitFor(() =>
              expect(store.get('one').inFlight).toBe(false),
            );
          }
          expect(requests.at(-1)!.messages).toEqual(
            original.flatMap((m, i) => [
              {
                speakerRole: 'user',
                speakerName: i % 2 ? 'Agent' : 'Customer',
                speakerIndex: 1 - (i % 2),
                text: 'same',
              },
              ...(i + 1 < turn
                ? [
                    {
                      speakerRole: 'assistant',
                      speakerIndex: -1,
                      text: String(i + 1),
                    },
                  ]
                : []),
            ]),
          );
        }
      },
    );
  },
);
