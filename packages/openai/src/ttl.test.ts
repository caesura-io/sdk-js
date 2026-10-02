import type OpenAI from 'openai';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryCaesuraStore } from '@caesura-io/core';
import { createCaesura } from './wrapper.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it.each(['chat', 'responses'] as const)(
  'expires guidance during foreground %s analysis',
  async (api) => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const store = new MemoryCaesuraStore();
    store.add('one', [
      {
        id: 'old',
        analysis: 'EXPIRED',
        afterMessageHash: '',
        createdAtMs: 500,
        createdAtTurn: 0,
      },
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        now = 3000;
        return Response.json({ isSame: true });
      }),
    );
    const create = vi.fn().mockResolvedValue({});
    const client = createCaesura(
      {
        chat: { completions: { create } },
        responses: { create },
      } as unknown as OpenAI,
      {
        apiKey: 'test',
        conversationId: 'one',
        mode: 'sync',
        store,
        inject: { skillPrompt: '', ttl: { type: 'seconds', seconds: 1 } },
      },
    );
    const input = [{ role: 'user' as const, content: 'new turn' }];
    if (api === 'chat')
      await client.chat.completions.create({ model: 'test', messages: input });
    else await client.responses.create({ model: 'test', input });
    expect(
      create.mock.calls[0]![0][api === 'chat' ? 'messages' : 'input'],
    ).toEqual(input);
    expect(store.get('one').recommendations).toHaveLength(1);
  },
);
