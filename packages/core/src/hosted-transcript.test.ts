/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryCaesuraStore } from './store.js';
import { createCaesuraEngine } from './engine.js';

afterEach(() => vi.unstubAllGlobals());
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const turn = (id: string) => ({ turn: { id, origin: 'customer' as const } });
const input = [{ speakerRole: 'user' as const, text: 'Hello' }];

it.each(['sync', 'async'] as const)(
  'persists greeting, retries and cadence-skipped customer turns in %s mode',
  async (mode) => {
    const rows = new Map();
    const analyses: any[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('/conversation/messages?'))
        return Response.json({
          success: true,
          conversationId: new URL(url).searchParams.get('conversationId'),
          nextMessageId: 1,
        });
      const body = JSON.parse(init.body as string);
      expect(new Headers(init.headers).get('x-caesura-sdk-language')).toBe(
        'javascript',
      );
      if (url.endsWith('/conversation/messages')) {
        for (const message of body.messages) rows.set(message.id, message);
        return json({ success: true, ...body });
      }
      expect(rows.has(body.transcriptMessageId)).toBe(true);
      analyses.push(body);
      return json('Guidance');
    });
    vi.stubGlobal('fetch', fetcher);
    const engine = createCaesuraEngine({
      apiKey: 'key',
      mode,
      cadence: { everyTurns: 10 },
      failurePolicy: 'throw',
    });
    await engine.recordMessages('conversation', [
      { id: 'greeting', role: 'agent', text: 'Welcome' },
    ]);
    await engine.observe('conversation', input, turn('first'));
    await engine.flush();
    await engine.observe('conversation', input, turn('first'));
    await engine.observe('conversation', input, turn('second'));
    await engine.flush();
    expect([...rows.values()]).toEqual([
      { id: 1, role: 'assistant', text: 'Welcome' },
      {
        id: 2,
        role: 'user',
        speakerName: 'Customer',
        speakerIndex: 1,
        text: 'Hello',
      },
      {
        id: 3,
        role: 'user',
        speakerName: 'Customer',
        speakerIndex: 1,
        text: 'Hello',
      },
    ]);
    expect(analyses).toHaveLength(1);
    expect(analyses[0].transcriptMessageId).toBe(2);
  },
);

it('persist false keeps application hooks but never uploads messages or references transcript rows', async () => {
  const fetcher = vi.fn(async () => json('Guidance'));
  vi.stubGlobal('fetch', fetcher);
  const hook = vi.fn();
  const engine = createCaesuraEngine({
    apiKey: 'key',
    mode: 'sync',
    persist: false,
    persistMessages: hook,
  });
  await engine.recordMessages('conversation', [
    { id: 'greeting', role: 'agent', text: 'Welcome' },
  ]);
  await engine.observe('conversation', input, turn('first'));
  expect(hook).toHaveBeenCalledTimes(2);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toContain('/analyze');
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).not.toHaveProperty(
    'transcriptMessageId',
  );
});

it.each(['throw', 'continue'] as const)(
  'surfaces unsupported-backend persistence under %s policy without legacy duplicates',
  async (failurePolicy) => {
    const fetcher = vi.fn(async () => json({ message: 'Not found' }, 404));
    vi.stubGlobal('fetch', fetcher);
    const onError = vi.fn();
    const engine = createCaesuraEngine({
      apiKey: 'key',
      mode: 'sync',
      failurePolicy,
      onError,
    });
    const work = engine.observe('conversation', input, turn('first'));
    if (failurePolicy === 'throw')
      await expect(work).rejects.toMatchObject({ kind: 'store' });
    else await work;
    expect(onError).toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(failurePolicy === 'continue' ? 2 : 1);
    expect(fetcher.mock.calls[0][0]).toContain('/conversation/messages');
    if (failurePolicy === 'continue') {
      const fallback = JSON.parse(fetcher.mock.calls[1][1].body as string);
      expect(fallback.persist).toBe(false);
      expect(fallback).not.toHaveProperty('conversationId');
    }
  },
);

it('rejects customer metadata over agent dialogue before uploads or analysis', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const engine = createCaesuraEngine({ apiKey: 'key', mode: 'sync' });
  await expect(
    engine.observe(
      'conversation',
      [{ speakerRole: 'assistant', text: 'Agent-only response' }],
      turn('customer'),
    ),
  ).rejects.toMatchObject({ kind: 'configuration' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('runs required application storage first with an isolated snapshot', async () => {
  const hook = vi.fn(async (batch) => {
    batch.messages[0].text = 'mutated';
  });
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes('/conversation/messages?'))
      return json({
        success: true,
        conversationId: 'conversation',
        nextMessageId: 1,
      });
    expect(hook).toHaveBeenCalledTimes(1);
    const body = JSON.parse(init.body as string);
    expect(body.messages[0].text).toBe('original');
    return json({ message: 'unsupported' }, 404);
  });
  vi.stubGlobal('fetch', fetcher);
  const engine = createCaesuraEngine({
    apiKey: 'key',
    failurePolicy: 'throw',
    persistMessages: hook,
    onError: () => {},
  });
  await expect(
    engine.recordMessages('conversation', [
      { id: 'greeting', role: 'agent', text: 'original' },
    ]),
  ).rejects.toMatchObject({ kind: 'store' });
  expect(hook).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('a failed required application transcript hook prevents hosted upload', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const engine = createCaesuraEngine({
    apiKey: 'key',
    failurePolicy: 'throw',
    persistMessages: () => {
      throw new Error('store offline');
    },
    onError: () => {},
  });
  await expect(
    engine.recordMessages('conversation', [
      { id: 'greeting', role: 'agent', text: 'original' },
    ]),
  ).rejects.toMatchObject({ kind: 'store' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('serializes numeric allocation, persists retry mappings and resumes from the server counter', async () => {
  let reads = 0;
  const uploaded: number[] = [];
  const store = new MemoryCaesuraStore();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('?')) {
        reads++;
        return json({
          success: true,
          conversationId: 'conversation',
          nextMessageId: 20,
        });
      }
      const body = JSON.parse(init.body as string);
      expect(
        Object.values(store.get('conversation').transcriptMessageIds ?? {}),
      ).toContain(body.messages[0].id);
      uploaded.push(...body.messages.map((m: any) => m.id));
      return json({ success: true, ...body });
    }),
  );
  const engine = createCaesuraEngine({
    apiKey: 'key',
    store,
    failurePolicy: 'throw',
  });
  await Promise.all(
    ['a', 'b', '__proto__'].map((id) =>
      engine.recordMessages('conversation', [{ id, role: 'agent', text: id }]),
    ),
  );
  expect(uploaded.sort((a, b) => a - b)).toEqual([20, 21, 22]);
  expect(reads).toBe(1);
  const restored = createCaesuraEngine({
    apiKey: 'key',
    store,
    failurePolicy: 'throw',
  });
  await restored.recordMessages('conversation', [
    { id: 'b', role: 'agent', text: 'b' },
  ]);
  expect(uploaded.at(-1)).toBe(21);
  expect(reads).toBe(1);
  expect(store.get('conversation').nextMessageId).toBe(23);
});

it('retains the assigned numeric ID after uncertain upload failure instead of advancing on retry', async () => {
  const ids: number[] = [];
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('?')) {
        reads++;
        return json({
          success: true,
          conversationId: 'conversation',
          nextMessageId: 7,
        });
      }
      const body = JSON.parse(init.body as string);
      ids.push(body.messages[0].id);
      if (ids.length === 1) return json({ message: 'conflict' }, 409);
      return json({ success: true, ...body });
    }),
  );
  const engine = createCaesuraEngine({
    apiKey: 'key',
    failurePolicy: 'throw',
    onError: () => {},
  });
  const messages = [{ id: 'reply', role: 'agent' as const, text: 'Hi' }];
  await expect(
    engine.recordMessages('conversation', messages),
  ).rejects.toMatchObject({ kind: 'store' });
  await engine.recordMessages('conversation', messages);
  expect(ids).toEqual([7, 7]);
  expect(reads).toBe(1);
});

it('does not upload when the numeric ID mapping cannot be saved', async () => {
  const base = new MemoryCaesuraStore();
  const fetcher = vi.fn(async () =>
    json({ success: true, conversationId: 'conversation', nextMessageId: 7 }),
  );
  vi.stubGlobal('fetch', fetcher);
  const engine = createCaesuraEngine({
    apiKey: 'key',
    failurePolicy: 'throw',
    onError: () => {},
    store: {
      get: base.get.bind(base),
      set: () => {
        throw new Error('store offline');
      },
      clear: base.clear.bind(base),
      clearAll: base.clearAll.bind(base),
    },
  });
  await expect(
    engine.recordMessages('conversation', [
      { id: 'reply', role: 'agent', text: 'Hi' },
    ]),
  ).rejects.toMatchObject({ kind: 'store' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toContain('?conversationId=');
});

it.each(['sync', 'async'] as const)(
  'preserves explicit participant indexes on upload and analysis in %s mode',
  async (mode) => {
    const saved = new Map<number, any>();
    const analyzed: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/conversation/messages?'))
          return json({
            success: true,
            conversationId: 'conversation',
            nextMessageId: 1,
          });
        const body = JSON.parse(init!.body as string);
        if (url.endsWith('/messages')) {
          for (const message of body.messages) saved.set(message.id, message);
          return json({ success: true, ...body });
        }
        const current = body.messages.at(-1);
        const stored = saved.get(body.transcriptMessageId);
        expect(stored.speakerIndex).toBe(current.speakerIndex);
        expect(stored.role).toBe('user');
        analyzed.push(current.speakerIndex);
        return json('Guidance');
      }),
    );
    const engine = createCaesuraEngine({
      apiKey: 'key',
      mode,
      failurePolicy: 'throw',
    });
    await engine.recordMessages('conversation', [
      { id: 'agent', role: 'agent', text: 'Welcome', speakerIndex: 9 },
    ]);
    for (const index of [42, 7]) {
      await engine.observe(
        'conversation',
        [
          {
            speakerRole: 'user',
            speakerIndex: index,
            text: `Customer ${index}`,
          },
        ],
        turn(`customer-${index}`),
      );
      await engine.flush();
    }
    expect([...saved.values()].map((message) => message.speakerIndex)).toEqual([
      9, 42, 7,
    ]);
    expect(analyzed).toEqual([42, 7]);
    await engine.shutdown();
  },
);
