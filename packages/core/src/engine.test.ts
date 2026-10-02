import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCaesuraEngine, resolveConfig } from './engine.js';
import { MemoryCaesuraStore } from './store.js';
import { hashMessage, renderBlock, selectActive } from './helpers.js';
import type { AnalyzeMessage } from './client.js';
import type { CaesuraAnalysis, CaesuraEvent } from './types.js';

const dialogue: AnalyzeMessage[] = [
  { speakerRole: 'user', text: 'oldest dialogue' },
  { speakerRole: 'assistant', text: 'newest dialogue' },
];
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', 'x-credit-usage': '2' },
  });
afterEach(() => vi.unstubAllGlobals());

describe('engine regressions', () => {
  it('uses product defaults without forcing a call type', () => {
    const cfg = resolveConfig({ apiKey: 'key' });
    expect(cfg).toMatchObject({
      baseUrl: 'https://api.caesurao.com',
      persist: true,
      autoCreateConversation: false,
    });
    expect(cfg.callType).toBeUndefined();
  });

  it.each([
    { send: { maxMessages: -1 } },
    { send: { maxInputChars: -1 } },
    { inject: { keepLast: -1 } },
  ])('rejects negative limits %j', (options) => {
    expect(() => resolveConfig({ apiKey: 'key', ...options })).toThrow(
      'nonnegative',
    );
  });

  it.each(['sync', 'async'] as const)(
    'enforces actual outbound limits and preserves anchors in %s mode',
    async (mode) => {
      const fetcher = vi
        .fn()
        .mockImplementation(() => Promise.resolve(json(false)));
      vi.stubGlobal('fetch', fetcher);
      const engine = createCaesuraEngine({
        apiKey: 'key',
        mode,
        send: { maxMessages: 1, maxInputChars: 5 },
        speakerNames: { agent: 'Support', customer: 'Visitor' },
      });
      engine.store.add('id', [
        {
          id: 'old',
          analysis: { long: 'history' },
          afterMessageHash: hashMessage('Support', 'newest dialogue'),
          createdAtMs: 0,
          createdAtTurn: 0,
        },
      ]);
      await engine.observe('id', dialogue);
      await vi.waitFor(() =>
        expect(engine.store.get('id').inFlight).toBe(false),
      );
      const body = JSON.parse(fetcher.mock.calls[0]![1].body);
      expect(body.messages).toEqual([
        {
          speakerRole: 'user',
          speakerName: 'Support',
          speakerIndex: 0,
          text: 'logue',
        },
      ]);
      expect(body).toMatchObject({
        persist: true,
        conversationId: 'id',
        sessionId: 'id',
      });
      expect(body).not.toHaveProperty('notifyIntegrations');
      expect(body).not.toHaveProperty('callType');
      const state = engine.store.get('id');
      expect(state.recommendations.at(-1)?.afterMessageHash).toBe(
        hashMessage('Support', 'newest dialogue'),
      );
      expect(dialogue[1]).toEqual({
        speakerRole: 'assistant',
        text: 'newest dialogue',
      });
    },
  );

  it('preserves explicit speaker names and uses remaining budget for history', async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(json(0)));
    vi.stubGlobal('fetch', fetcher);
    const engine = createCaesuraEngine({
      apiKey: 'key',
      mode: 'sync',
      send: { maxMessages: 3, maxInputChars: 50 },
    });
    const input: AnalyzeMessage[] = [
      {
        speakerRole: 'user',
        speakerName: 'Named',
        speakerIndex: 1,
        text: 'hello',
      },
    ];
    await engine.observe('id', input);
    await engine.observe('id', [
      ...input,
      { speakerRole: 'assistant', text: 'answer' },
    ]);
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).messages).toEqual([
      input[0],
      { speakerRole: 'assistant', speakerIndex: -1, text: '0' },
      {
        speakerRole: 'user',
        speakerName: 'Agent',
        speakerIndex: 0,
        text: 'answer',
      },
    ]);
  });

  it.each([{ maxMessages: 0 }, { maxInputChars: 0 }])(
    'zero limits skip analysis and creation %j',
    async (send) => {
      const fetcher = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      const engine = createCaesuraEngine({
        apiKey: 'key',
        mode: 'sync',
        autoCreateConversation: true,
        send,
      });
      await engine.observe('local', dialogue);
      expect(fetcher).not.toHaveBeenCalled();
      expect(engine.store.get('local').turn).toBe(1);
    },
  );

  it('owns cadence and TTL turns, including skipped observations', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(() => Promise.resolve(json('advice')));
    vi.stubGlobal('fetch', fetcher);
    const engine = createCaesuraEngine({
      apiKey: 'key',
      mode: 'sync',
      cadence: { everyTurns: 2 },
      inject: { ttl: { type: 'turns', turns: 0 } },
    });
    await engine.observe('id', dialogue);
    expect(
      selectActive(engine.store.get('id'), engine.config.inject, Date.now()),
    ).toHaveLength(1);
    await engine.observe('id', dialogue);
    expect(
      selectActive(engine.store.get('id'), engine.config.inject, Date.now()),
    ).toHaveLength(0);
    await engine.observe('id', dialogue);
    await engine.observe('id', []);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(engine.store.get('id').turn).toBe(4);
  });

  it.each<CaesuraAnalysis>([
    0,
    false,
    'שלום 😊',
    ['שלום', false],
    { latest_speaker: 'Visitor', emoji: '😊', 'exact.key': 0 },
    { isSame: 'false' },
  ])('buffers arbitrary payload %j', async (analysis) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(json(analysis))),
    );
    const events: CaesuraEvent[] = [];
    const engine = createCaesuraEngine({
      apiKey: 'key',
      mode: 'sync',
      onEvent: (e) => events.push(e),
    });
    await engine.observe('id', dialogue);
    const recs = engine.store.get('id').recommendations;
    expect(recs[0]?.analysis).toEqual(analysis);
    expect(renderBlock(recs, engine.config.inject)).toHaveLength(1);
    expect(events.find((e) => e.type === 'response')).toMatchObject({
      analysis,
    });
  });

  it.each([null, '', '  ', [], {}, { isSame: true }, { is_same: true }])(
    'skips empty or explicitly duplicate payload %j',
    async (analysis) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(() => Promise.resolve(json(analysis))),
      );
      const engine = createCaesuraEngine({ apiKey: 'key', mode: 'sync' });
      await engine.observe('id', dialogue);
      expect(engine.store.get('id').recommendations).toHaveLength(0);
    },
  );

  it('isolates failures from every callback, including the error callback', async () => {
    const fail = vi.fn(() => {
      throw new Error('hook failed');
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(json('advice'))),
    );
    const engine = createCaesuraEngine({
      apiKey: 'key',
      mode: 'sync',
      onError: fail,
      onEvent: fail,
      onCreditUsage: fail,
    });
    await expect(engine.observe('id', dialogue)).resolves.toBeUndefined();
    expect(engine.store.get('id').recommendations).toHaveLength(1);
    expect(engine.store.get('id').inFlight).toBe(false);
  });
});

describe('conversation lifecycle', () => {
  it('creates explicitly and reuses that ID even when automatic creation is enabled', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ id: 'backend' }))
      .mockResolvedValueOnce(json('advice'));
    vi.stubGlobal('fetch', fetcher);
    const engine = createCaesuraEngine({
      apiKey: 'key',
      mode: 'sync',
      autoCreateConversation: true,
    });
    const id = await engine.createConversation({
      name: 'Support',
      calendarId: 'calendar',
      eventId: 'event',
    });
    await engine.observe(id, dialogue);
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual([
      'https://api.caesurao.com/api/conversation',
      'https://api.caesurao.com/api/analyze',
    ]);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({
      name: 'Support',
      calendarId: 'calendar',
      eventId: 'event',
    });
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).conversationId).toBe(
      'backend',
    );
  });

  it.each(['sync', 'async'] as const)(
    'reserves overlapping %s observations and retains mapping after analysis failure',
    async (mode) => {
      let finish!: (r: Response) => void;
      const fetcher = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              finish = resolve;
            }),
        )
        .mockRejectedValueOnce(new Error('analysis failed'))
        .mockResolvedValueOnce(json('advice'));
      vi.stubGlobal('fetch', fetcher);
      const onError = vi.fn();
      const store = new MemoryCaesuraStore({
        maxConversations: 1,
        maxIdleMs: 1000,
      });
      const engine = createCaesuraEngine({
        apiKey: 'key',
        mode,
        autoCreateConversation: true,
        onError,
        store,
      });
      const pending = engine.observe('local', dialogue);
      const original = store.get('local');
      original.lastAccessMs = 0;
      store.get('other');
      await engine.observe('local', dialogue);
      expect(store.get('local')).toBe(original);
      expect(fetcher).toHaveBeenCalledTimes(1);
      finish(json({ id: 'backend' }));
      await pending;
      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
      await engine.observe('local', dialogue);
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
      expect(
        fetcher.mock.calls.filter((c) => c[0].endsWith('/conversation')),
      ).toHaveLength(1);
      expect(JSON.parse(fetcher.mock.calls[2]![1].body).conversationId).toBe(
        'backend',
      );
    },
  );

  it('reports automatic creation failures and allows a later retry', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('creation failed'))
      .mockResolvedValueOnce(json({ id: 'backend' }))
      .mockResolvedValueOnce(json('ok'));
    vi.stubGlobal('fetch', fetcher);
    const onError = vi.fn();
    const engine = createCaesuraEngine({
      apiKey: 'key',
      mode: 'sync',
      autoCreateConversation: true,
      onError,
    });
    await engine.observe('local', dialogue);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(engine.store.get('local').inFlight).toBe(false);
    await engine.observe('local', dialogue);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('skips automatic creation for empty dialogue or disabled persistence', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json('advice'));
    vi.stubGlobal('fetch', fetcher);
    const engine = createCaesuraEngine({
      apiKey: 'key',
      mode: 'sync',
      persist: false,
      autoCreateConversation: true,
    });
    await engine.observe('local', []);
    await engine.observe('local', dialogue);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(body.persist).toBe(false);
    expect(body).not.toHaveProperty('conversationId');
    expect(body).not.toHaveProperty('sessionId');
  });

  it('keeps the originating turn for a delayed analysis', async () => {
    let finish!: (r: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const engine = createCaesuraEngine({ apiKey: 'key' });
    await engine.observe('id', dialogue);
    await engine.observe('id', dialogue);
    finish(json('late'));
    await vi.waitFor(() => expect(engine.store.get('id').inFlight).toBe(false));
    expect(engine.store.get('id').recommendations[0]?.createdAtTurn).toBe(1);
  });
});

it('contains rejected asynchronous observability callbacks', async () => {
  const fail = vi.fn(async () => {
    throw new Error('async hook failed');
  });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => Promise.resolve(json(false))),
  );
  const engine = createCaesuraEngine({
    apiKey: 'key',
    mode: 'sync',
    onEvent: fail,
    onCreditUsage: fail,
    onError: fail,
  });
  await engine.observe('id', dialogue);
  expect(engine.store.get('id').recommendations[0]?.analysis).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(engine.store.get('id').inFlight).toBe(false);
});

describe.each(['sync', 'async'] as const)(
  'backend persistence contract in %s mode',
  (mode) => {
    it.each([
      'plain agent reply',
      '{"recommendation":"this is agent dialogue"}',
    ])('keeps repeated agent dialogue last: %s', async (text) => {
      const requests: import('./client.js').AnalyzeRequestBody[] = [];
      const analysis = { recommendation: 'Prior analysis' };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url, init) => {
          requests.push(JSON.parse(init.body));
          return json(analysis);
        }),
      );
      const engine = createCaesuraEngine({
        apiKey: 'test',
        mode,
        speakerNames: { agent: 'Support', customer: 'Visitor' },
      });
      const input: AnalyzeMessage[] = [{ speakerRole: 'assistant', text }];
      for (let turn = 0; turn < 2; turn++) {
        await engine.observe('existing-backend-id', input);
        await vi.waitFor(() =>
          expect(engine.store.get('existing-backend-id').inFlight).toBe(false),
        );
      }
      const utterance = {
        speakerRole: 'user',
        speakerName: 'Support',
        speakerIndex: 0,
        text,
      };
      expect(requests[0]!.messages).toEqual([utterance]);
      expect(requests[1]!.messages).toEqual([
        {
          speakerRole: 'assistant',
          speakerIndex: -1,
          text: JSON.stringify(analysis),
        },
        utterance,
      ]);
      expect(requests[1]!.messages.at(-1)).toEqual(utterance);
      expect(input).toEqual([{ speakerRole: 'assistant', text }]);
    });
  },
);

it.each([
  { calculateSimilarities: true },
  { calculateSimilarities: false },
  { calculateSimilarities: true, similarityThreshold: 0.8 },
  { calculateSimilarities: false, similarityThreshold: 0.8 },
  { calculateSimilarities: true, similarityThreshold: 0 },
])(
  'forwards similarity configuration without inventing suppression: %j',
  async (options) => {
    const requests: import('./client.js').AnalyzeRequestBody[] = [];
    const analysis = { recommendation: 'Repeated guidance', similarities: [1] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return json(analysis);
      }),
    );
    const engine = createCaesuraEngine({
      apiKey: 'test',
      mode: 'sync',
      ...options,
    });
    await engine.observe('id', dialogue);
    await engine.observe('id', dialogue);
    for (const request of requests) {
      expect(request.calculateSimilarities).toBe(options.calculateSimilarities);
      if ('similarityThreshold' in options)
        expect(request.similarityThreshold).toBe(options.similarityThreshold);
      else expect(request).not.toHaveProperty('similarityThreshold');
    }
    // Similarity values alone are not a duplicate flag; only the backend decides isSame.
    expect(
      engine.store.get('id').recommendations.map((r) => r.analysis),
    ).toEqual([analysis, analysis]);
  },
);
