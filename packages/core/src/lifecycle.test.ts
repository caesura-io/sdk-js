import { describe, expect, it, vi } from 'vitest';
import { createCaesuraEngine } from './engine.js';
import {
  MemoryCaesuraStore,
  type CaesuraStore,
  type ConversationState,
} from './store.js';
import { CaesuraError, type AnalysisTransport } from './contracts.js';

const customer = [{ speakerRole: 'user' as const, text: 'yes' }];
const turn = (id: string) => ({ turn: { id, origin: 'customer' as const } });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function detached(): CaesuraStore {
  const data = new Map<string, string>();
  return {
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
}

describe('application orchestration contract', () => {
  it('uses a local service without credentials/network and retains complete metadata', async () => {
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network forbidden'));
    const analyze = vi.fn(async () => ({
      analysis: { recommendation: 'ask', research: { raw: 'full' } },
      usage: { tokens: 9 },
      requestId: 'paid-1',
      creditUsage: 3,
      metadata: { private: 42 },
    }));
    const persistAnalysis = vi.fn();
    const engine = createCaesuraEngine({
      transport: { analyze },
      mode: 'sync',
      persistAnalysis,
    });
    await engine.observe('one', customer, {
      ...turn('a'),
      metadata: { trace: 'x' },
    });
    expect(network).not.toHaveBeenCalled();
    expect(analyze.mock.calls[0][0]).toMatchObject({
      currentUser: 'Agent',
      persist: true,
      messages: [{ speakerRole: 'user', speakerIndex: 1 }],
    });
    expect(analyze.mock.calls[0][0]).not.toHaveProperty('metadata');
    expect(analyze.mock.calls[0][1]).toMatchObject({
      customerTurnId: 'a',
      metadata: { trace: 'x' },
      signal: expect.any(AbortSignal),
      deadline: expect.any(Number),
    });
    expect(persistAnalysis.mock.calls[0][0].result).toEqual(
      await analyze.mock.results[0].value,
    );
    await expect(engine.createConversation()).rejects.toMatchObject({
      kind: 'unsupported',
    });
    network.mockRestore();
  });

  it('deduplicates turn IDs, not text; persists cadence across detached store reloads', async () => {
    const store = detached();
    const analyze = vi.fn(async () => ({ analysis: 'advice' }));
    const config = {
      store,
      transport: { analyze },
      mode: 'sync' as const,
      cadence: { everyTurns: 2 },
    };
    const engine = createCaesuraEngine(config);
    await engine.observe('one', customer, turn('a'));
    await engine.observe('one', customer, turn('a'));
    await engine.observe('one', customer, turn('b'));
    const reloaded = createCaesuraEngine(config);
    await reloaded.observe('one', customer, turn('b'));
    await reloaded.observe('one', customer, turn('c'));
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(await store.get('one')).toMatchObject({
      turn: 3,
      processedTurnIds: ['a', 'b', 'c'],
      inFlight: false,
    });
  });

  it('uses occurrence fallback, skips agent/internal turns, and selects explicit evidence', async () => {
    const analyze = vi.fn(async () => ({ analysis: 'advice' }));
    const engine = createCaesuraEngine({
      transport: { analyze },
      mode: 'sync',
    });
    await engine.observe('one', customer);
    await engine.observe('one', customer);
    await engine.observe('one', [...customer, ...customer]);
    await engine.observe('one', [{ speakerRole: 'assistant', text: 'hello' }]);
    await engine.observe('one', customer, {
      turn: { id: 'rag', origin: 'internal' },
    });
    await engine.observe('one', [], {
      ...turn('explicit'),
      dialogue: [
        {
          speakerRole: 'user',
          origin: 'agent',
          speakerName: 'A',
          speakerIndex: 8,
          text: 'background',
        },
        { speakerRole: 'user', origin: 'internal', text: 'RAG' },
        { speakerRole: 'user', origin: 'customer', text: 'actual' },
      ],
    });
    expect(analyze).toHaveBeenCalledTimes(3);
    const messages = analyze.mock.calls[2][0].messages;
    expect(messages.some((m: { text: string }) => m.text === 'RAG')).toBe(
      false,
    );
    expect(messages).toContainEqual({
      speakerRole: 'user',
      speakerName: 'A',
      speakerIndex: 8,
      text: 'background',
    });
    expect(messages.at(-1).text).toBe('actual');
  });

  it.each(['sync', 'async'] as const)(
    'cancels %s without stale state, including ignored signals and required persistence',
    async (mode) => {
      const gate = deferred<{ analysis: string; creditUsage: number }>();
      const analyze = vi.fn(() => gate.promise);
      const persistAnalysis = vi.fn();
      const engine = createCaesuraEngine({
        transport: { analyze },
        mode,
        persistAnalysis,
      });
      const ctrl = new AbortController();
      const observing = engine.observe('one', customer, {
        ...turn('a'),
        signal: ctrl.signal,
      });
      const rejected = observing.catch((error) => error);
      await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());
      ctrl.abort('stop');
      if (mode === 'sync')
        expect(await rejected).toMatchObject({ kind: 'cancelled' });
      else await observing;
      expect((await engine.flush())[0]).toMatchObject({ status: 'cancelled' });
      await engine.clear('one');
      gate.resolve({ analysis: 'late', creditUsage: 4 });
      await vi.waitFor(() => expect(persistAnalysis).toHaveBeenCalledOnce());
      expect((await engine.getState('one')).recommendations).toEqual([]);
    },
  );

  it('queues newer turns, snapshots input, preserves correct anchors, and exposes completion', async () => {
    const gate = deferred<{ analysis: string }>();
    const analyze = vi
      .fn()
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValue({ analysis: 'second' });
    const engine = createCaesuraEngine({ transport: { analyze } });
    const first = structuredClone(customer);
    await engine.observe('one', first, turn('a'));
    first[0].text = 'mutated';
    await engine.observe('one', [...customer, ...customer], turn('b'));
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());
    expect(analyze.mock.calls[0][0].messages.at(-1).text).toBe('yes');
    gate.resolve({ analysis: 'first' });
    const completed = await engine.flush('one');
    expect(completed.map((c) => c.correlation.customerTurnId)).toEqual([
      'a',
      'b',
    ]);
    expect(
      analyze.mock.calls[1][0].messages.map((m: { text: string }) => m.text),
    ).toEqual(['yes', 'first', 'yes']);
    expect(
      (await engine.getState('one')).recommendations.map(
        (r) => r.createdAtTurn,
      ),
    ).toEqual([1, 2]);
  });

  it('clear and shutdown abort active and queued work without repopulation', async () => {
    const gate = deferred<{ analysis: string }>();
    const analyze = vi.fn(() => gate.promise);
    const engine = createCaesuraEngine({ transport: { analyze } });
    await engine.observe('one', customer, turn('a'));
    await engine.observe('one', customer, turn('b'));
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());
    const oldSignal = engine.getSignal('one');
    await engine.clear('one');
    expect(oldSignal.aborted).toBe(true);
    await engine.flush();
    gate.resolve({ analysis: 'stale' });
    await Promise.resolve();
    expect((await engine.getState('one')).recommendations).toEqual([]);
    expect(analyze).toHaveBeenCalledOnce();
    await engine.shutdown();
    await expect(
      engine.observe('one', customer, turn('c')),
    ).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it.each(['transport', 'store', 'timeout'] as const)(
    'distinguishes %s failure and strict versus continue',
    async (kind) => {
      for (const failurePolicy of ['continue', 'throw'] as const) {
        const cause = new Error('original');
        const transport: AnalysisTransport = {
          analyze: async () => {
            if (kind === 'transport') throw cause;
            if (kind === 'timeout') return new Promise(() => {});
            return { analysis: 'ok' };
          },
        };
        const engine = createCaesuraEngine({
          transport,
          mode: 'sync',
          failurePolicy,
          timeoutMs: 15,
          onError: () => {},
          ...(kind === 'store'
            ? {
                persistAnalysis: async () => {
                  throw cause;
                },
              }
            : {}),
        });
        const result = engine.observe('one', customer, turn('a'));
        if (failurePolicy === 'throw')
          await expect(result).rejects.toMatchObject({ kind });
        else await result;
        const [completion] = await engine.flush();
        expect(completion?.error).toBeInstanceOf(CaesuraError);
        expect(completion?.error?.kind).toBe(kind);
        if (kind !== 'timeout') expect(completion?.error?.cause).toBe(cause);
        expect((await engine.getState('one')).recommendations).toEqual([]);
      }
    },
  );

  it('records store write failure explicitly, and never retries a paid analysis automatically', async () => {
    const backing = detached();
    let fail = true;
    const store = {
      ...backing,
      async set(id: string, state: ConversationState) {
        if (fail) throw new Error('offline');
        return backing.set(id, state);
      },
    };
    const analyze = vi.fn(async () => ({ analysis: 'SAME' }));
    const engine = createCaesuraEngine({
      store,
      transport: { analyze },
      mode: 'sync',
      failurePolicy: 'throw',
      onError: () => {},
    });
    await expect(
      engine.observe('one', customer, turn('a')),
    ).rejects.toMatchObject({ kind: 'store' });
    expect(analyze).not.toHaveBeenCalled();
    fail = false;
    await engine.observe('one', customer, turn('a'));
    await engine.observe('one', customer, turn('a'));
    expect(analyze).toHaveBeenCalledOnce();
    expect((await engine.getState('one')).recommendations).toEqual([]);
  });
});

it('strict retries cannot bypass a failed or unresolved required analysis', async () => {
  const store = detached();
  const analyze = vi.fn(async () => {
    throw new Error('paid request failed');
  });
  const options = {
    store,
    transport: { analyze },
    mode: 'sync' as const,
    failurePolicy: 'throw' as const,
    onError: () => {},
  };
  const engine = createCaesuraEngine(options);
  await expect(
    engine.observe('one', customer, turn('a')),
  ).rejects.toMatchObject({ kind: 'transport' });
  const reloaded = createCaesuraEngine(options);
  await expect(
    reloaded.observe('one', customer, turn('a')),
  ).rejects.toMatchObject({ kind: 'transport' });
  expect(analyze).toHaveBeenCalledOnce();
  const unresolved = await store.get('one');
  unresolved.turnOutcomes!.a = { status: 'pending' };
  await store.set('one', unresolved);
  await expect(
    reloaded.observe('one', customer, turn('a')),
  ).rejects.toMatchObject({ kind: 'store' });
  expect(analyze).toHaveBeenCalledOnce();
});

it('clearAll serializes detached writes while a new conversation arrives', async () => {
  const base = detached();
  const clearGate = deferred<void>();
  const store = {
    ...base,
    async clearAll() {
      await clearGate.promise;
      await base.clearAll();
    },
  };
  const engine = createCaesuraEngine({
    store,
    transport: { analyze: async () => ({ analysis: 'fresh' }) },
    mode: 'sync',
  });
  const clearing = engine.clearAll();
  const observing = engine.observe('new', customer, turn('new-event'));
  clearGate.resolve();
  await clearing;
  await observing;
  expect((await engine.getState('new')).recommendations).toHaveLength(1);
});

it('does not share an in-memory lock between different engines using the same store', async () => {
  // Deliberate limitation: distributed/application ownership is required.
  const store = detached();
  const gate = deferred<{ analysis: string }>();
  const analyze = vi.fn(() => gate.promise);
  const a = createCaesuraEngine({ store, transport: { analyze } });
  const b = createCaesuraEngine({ store, transport: { analyze } });
  await Promise.all([
    a.observe('same', customer, turn('a')),
    b.observe('same', customer, turn('b')),
  ]);
  await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(2));
  gate.resolve({ analysis: 'ok' });
  await Promise.all([a.flush(), b.flush()]);
});
