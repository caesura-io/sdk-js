import { afterEach, expect, it, vi } from 'vitest';
import { MemoryCaesuraStore } from '@caesura-io/core';
import { caesuraMiddleware } from './middleware.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it.each(['generate', 'stream'] as const)(
  'expires guidance during foreground %s analysis',
  async (type) => {
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
    stubAnalysisFetch(
      vi.fn(async () => {
        now = 3000;
        return Response.json({ isSame: true });
      }),
    );
    const middleware = caesuraMiddleware({
      apiKey: 'test',
      conversationId: 'one',
      mode: 'sync',
      store,
      inject: { skillPrompt: '', ttl: { type: 'seconds', seconds: 1 } },
    });
    const prompt = [
      { role: 'user', content: [{ type: 'text', text: 'new turn' }] },
    ];
    const result = await middleware.transformParams!({
      type,
      params: { prompt },
      model: {},
    });
    expect(result.prompt).toEqual(prompt);
    expect(store.get('one').recommendations).toHaveLength(1);
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
