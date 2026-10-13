import { afterEach, expect, it, vi } from 'vitest';
import { createCaesuraEngine } from './engine.js';
import { MemoryCaesuraStore, type CaesuraStore } from './store.js';
import type {
  AnalysisTransport,
  HostedTranscriptMessage,
} from './contracts.js';

const gate = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Test gate stalled')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const message = (id: string) => [{ id, role: 'agent' as const, text: id }];
const turn = (id: string) => ({ turn: { id, origin: 'customer' as const } });
function backend() {
  const saved = new Map<string, HostedTranscriptMessage[]>();
  const transport: AnalysisTransport = {
    analyze: vi.fn(async () => ({ analysis: 'SAME' })),
    getNextMessageId: vi.fn(
      async ({ conversationId }) =>
        1 + Math.max(0, ...(saved.get(conversationId) ?? []).map((m) => m.id)),
    ),
    appendMessages: vi.fn(async (messages, { conversationId }) => {
      const rows = saved.get(conversationId) ?? [];
      for (const m of messages) {
        const previous = rows.find((row) => row.id === m.id);
        if (previous) expect(previous).toEqual(m);
        else rows.push({ ...m });
      }
      saved.set(conversationId, rows);
    }),
  };
  return { saved, transport };
}
afterEach(() => vi.restoreAllMocks());

it('pins active and queued uploads against eviction and releases every pin afterward', async () => {
  const { saved, transport } = backend();
  const started = gate(),
    release = gate();
  const append = transport.appendMessages!;
  transport.appendMessages = async (messages, context) => {
    if (messages[0].text === 'first') {
      started.resolve();
      await release.promise;
    }
    return append(messages, context);
  };
  const store = new MemoryCaesuraStore({ maxConversations: 1 });
  const engine = createCaesuraEngine({
    store,
    transport,
    failurePolicy: 'throw',
  });
  const first = engine.recordMessages('A', message('first'));
  await bounded(started.promise);
  const second = engine.recordMessages('A', message('second'));
  await bounded(engine.recordMessages('B', message('other')));
  expect(saved.has('A')).toBe(false);
  release.resolve();
  await bounded(Promise.all([first, second]));
  expect(saved.get('A')?.map((m) => [m.id, m.text])).toEqual([
    [1, 'first'],
    [2, 'second'],
  ]);
  expect(
    vi
      .mocked(transport.getNextMessageId!)
      .mock.calls.filter(([c]) => c.conversationId === 'A'),
  ).toHaveLength(1);
  store.get('B');
  expect(store.get('A').nextMessageId).toBeUndefined();
  await engine.shutdown();
});

it.each(['sync', 'async'] as const)(
  'keeps customer transcript order with a blocked application hook and detached store (%s)',
  async (mode) => {
    const { transport, saved } = backend();
    const started = gate(),
      release = gate();
    const data = new Map<string, string>();
    const store: CaesuraStore = {
      async get(id) {
        return data.has(id)
          ? JSON.parse(data.get(id)!)
          : new MemoryCaesuraStore().get(id);
      },
      async set(id, state) {
        data.set(id, JSON.stringify(state));
      },
      async clear(id) {
        data.delete(id);
      },
      async clearAll() {
        data.clear();
      },
    };
    const hooks: string[] = [];
    const engine = createCaesuraEngine({
      transport,
      store,
      mode,
      failurePolicy: 'throw',
      persistMessages: async ({ messages }) => {
        hooks.push(messages[0].id);
        if (messages[0].id === 'first') {
          started.resolve();
          await release.promise;
        }
      },
    });
    const first = engine.observe(
      'A',
      [{ speakerRole: 'user', text: 'first' }],
      turn('first'),
    );
    await bounded(started.promise);
    const second = engine.observe(
      'A',
      [{ speakerRole: 'user', text: 'second' }],
      turn('second'),
    );
    await bounded(engine.recordMessages('B', message('other')));
    expect(hooks).toEqual(['first', 'other']);
    // The transcript FIFO does not hold the short state mutex during user I/O.
    await bounded(engine.getState('A'));
    release.resolve();
    await bounded(Promise.all([first, second]));
    await bounded(engine.flush());
    expect(saved.get('A')?.map((m) => [m.id, m.text])).toEqual([
      [1, 'first'],
      [2, 'second'],
    ]);
    expect(
      vi
        .mocked(transport.analyze)
        .mock.calls.map(([body]) => body.transcriptMessageId),
    ).toEqual([1, 2]);
    await engine.shutdown();
  },
);

it.each(['throw', 'continue'] as const)(
  'advances after an application hook failure under %s policy',
  async (failurePolicy) => {
    const { transport, saved } = backend();
    const started = gate(),
      release = gate();
    const engine = createCaesuraEngine({
      transport,
      failurePolicy,
      onError: () => {},
      persistMessages: async ({ messages }) => {
        if (messages[0].id === 'first') {
          started.resolve();
          await release.promise;
          throw new Error('write failed');
        }
      },
    });
    const first = engine.recordMessages('A', message('first')).catch((e) => e);
    await bounded(started.promise);
    const second = engine.recordMessages('A', message('second'));
    release.resolve();
    const result = await bounded(first);
    if (failurePolicy === 'throw')
      expect(result).toMatchObject({ kind: 'store' });
    else expect(result).toBeUndefined();
    await bounded(second);
    expect(saved.get('A')?.map((m) => m.text)).toEqual(['second']);
    await engine.shutdown();
  },
);

it.each(['cancel', 'deadline'] as const)(
  'rejects a queued %s promptly without allowing a later write to overtake',
  async (reason) => {
    const { transport, saved } = backend();
    const started = gate(),
      release = gate();
    const hooks: string[] = [];
    const engine = createCaesuraEngine({
      transport,
      onError: () => {},
      persistMessages: async ({ messages }) => {
        hooks.push(messages[0].id);
        if (messages[0].id === 'first') {
          started.resolve();
          await release.promise;
        }
      },
    });
    const first = engine.recordMessages('A', message('first'));
    await bounded(started.promise);
    const controller = new AbortController();
    const second = engine
      .recordMessages('A', message('second'), {
        signal: controller.signal,
        ...(reason === 'deadline' ? { deadline: Date.now() + 20 } : {}),
      })
      .catch((e) => e);
    if (reason === 'cancel') controller.abort();
    expect(await bounded(second)).toMatchObject({
      kind: reason === 'cancel' ? 'cancelled' : 'timeout',
    });
    const third = engine.recordMessages('A', message('third'));
    await bounded(engine.recordMessages('B', message('other')));
    expect(hooks).toEqual(['first', 'other']);
    release.resolve();
    await bounded(Promise.all([first, third]));
    expect(saved.get('A')?.map((m) => [m.id, m.text])).toEqual([
      [1, 'first'],
      [2, 'third'],
    ]);
    expect(hooks).not.toContain('second');
    await engine.shutdown();
  },
);

it.each(['clear', 'clearAll', 'shutdown'] as const)(
  'cancels active/queued transcript hooks on %s without late uploads',
  async (operation) => {
    const { transport, saved } = backend();
    const started = gate(),
      release = gate();
    const engine = createCaesuraEngine({
      transport,
      onError: () => {},
      persistMessages: async ({ messages }) => {
        if (messages[0].id === 'first') {
          started.resolve();
          await release.promise;
        }
      },
    });
    const first = engine.recordMessages('A', message('first')).catch((e) => e);
    await bounded(started.promise);
    const second = engine
      .recordMessages('A', message('second'))
      .catch((e) => e);
    await bounded(
      operation === 'clear'
        ? engine.clear('A')
        : operation === 'clearAll'
          ? engine.clearAll()
          : engine.shutdown(),
    );
    expect(await bounded(first)).toMatchObject({ kind: 'cancelled' });
    expect(await bounded(second)).toMatchObject({ kind: 'cancelled' });
    // Late rejection is observed, and cannot resume the cancelled upload.
    release.reject(new Error('late hook failure'));
    await bounded(engine.flush());
    expect(saved.has('A')).toBe(false);
    if (operation !== 'shutdown') {
      await bounded(engine.recordMessages('A', message('new')));
      expect(saved.get('A')?.map((m) => [m.id, m.text])).toEqual([[1, 'new']]);
    }
    await engine.shutdown();
  },
);

it('drains active and queued standalone transcript writes on graceful shutdown', async () => {
  const { transport, saved } = backend();
  const started = gate(),
    release = gate();
  const engine = createCaesuraEngine({
    transport,
    persistMessages: async ({ messages }) => {
      if (messages[0].id === 'first') {
        started.resolve();
        await release.promise;
      }
    },
  });
  const first = engine.recordMessages('A', message('first'));
  await bounded(started.promise);
  const second = engine.recordMessages('A', message('second'));
  let drained = false;
  const shutdown = engine.shutdown({ cancel: false }).then(() => {
    drained = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(drained).toBe(false);
  release.resolve();
  await bounded(Promise.all([first, second, shutdown]));
  expect(saved.get('A')?.map((m) => m.text)).toEqual(['first', 'second']);
});
