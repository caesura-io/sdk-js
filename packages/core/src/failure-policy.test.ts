import { expect, it, vi } from 'vitest';
import { createCaesuraEngine } from './engine.js';
import { MemoryCaesuraStore } from './store.js';
import {
  CaesuraError,
  type AnalyzeRequestBody,
  type AnalysisCompletion,
} from './index.js';
const turn = (id: string) => ({ turn: { id, origin: 'customer' as const } });
const input = [
  { speakerRole: 'user' as const, speakerIndex: 0, text: 'hello' },
];
for (const mode of ['sync', 'async'] as const) {
  it(`falls back per invocation and resumes persistence without losing mappings (${mode})`, async () => {
    const requests: AnalyzeRequestBody[] = [],
      completions: AnalysisCompletion[] = [];
    const onError = vi.fn(),
      onEvent = vi.fn();
    const store = new MemoryCaesuraStore();
    let fail = true;
    const engine = createCaesuraEngine({
      mode,
      store,
      callType: 'custom',
      speakerNames: { customer: 'Visitor', agent: 'Support' },
      similarityThreshold: 0.8,
      onError,
      onEvent,
      onCompletion: (e) => {
        completions.push(e);
      },
      transport: {
        getNextMessageId: async () => 10,
        appendMessages: async () => {
          if (fail) throw new Error('hosted unavailable');
        },
        analyze: async (body) => {
          requests.push(body);
          return { analysis: 'guidance' };
        },
      },
    });
    await engine.observe('id', input, turn('first'));
    await engine.flush();
    expect(requests[0]).toMatchObject({
      persist: false,
      currentUser: 'Support',
      callType: 'custom',
      similarityThreshold: 0.8,
      messages: [
        {
          speakerRole: 'user',
          speakerIndex: 0,
          speakerName: 'Visitor',
          text: 'hello',
        },
      ],
    });
    for (const key of ['conversationId', 'sessionId', 'transcriptMessageId'])
      expect(requests[0]).not.toHaveProperty(key);
    expect(completions[0].correlation).toMatchObject({
      conversationId: 'id',
      persistence: 'disabled',
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls.filter(([e]) => e.type === 'error')).toHaveLength(
      1,
    );
    expect(store.get('id').transcriptMessageIds).toEqual({ first: 10 });
    fail = false;
    await engine.observe('id', input, turn('second'));
    await engine.flush();
    expect(requests[1]).toMatchObject({
      persist: true,
      conversationId: 'id',
      sessionId: 'id',
      transcriptMessageId: 11,
    });
    expect(completions[1].correlation.persistence).toBe('requested');
    expect(engine.config.persist).toBe(true);
    await engine.shutdown();
  });
  it(`required hooks do not trigger hosted fallback and report once (${mode})`, async () => {
    const analyze = vi.fn(),
      appendMessages = vi.fn(),
      onError = vi.fn();
    const engine = createCaesuraEngine({
      mode,
      onError,
      persistMessages: async () => {
        throw new Error('required hook failed');
      },
      transport: { analyze, appendMessages, getNextMessageId: async () => 1 },
    });
    await engine.observe('id', input, turn('first'));
    const results = await engine.flush();
    expect(results[0]).toMatchObject({
      status: 'failed',
      error: { kind: 'store' },
    });
    expect(analyze).not.toHaveBeenCalled();
    expect(appendMessages).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    await engine.shutdown();
  });
}
it('creation failure stays explicit, reports once, and a stateless scope has no fabricated identity', async () => {
  const onError = vi.fn(),
    onEvent = vi.fn(),
    bodies: AnalyzeRequestBody[] = [];
  const engine = createCaesuraEngine({
    mode: 'sync',
    onError,
    onEvent,
    transport: {
      createConversation: async () => {
        throw new Error('creation failed');
      },
      analyze: async (body) => {
        bodies.push(body);
        return { analysis: 'guidance' };
      },
    },
  });
  await expect(engine.createConversation()).resolves.toBeUndefined();
  const scope = engine.createStatelessScope();
  await scope.observe(undefined, input, turn('one'));
  const results = await engine.flush();
  expect(
    onEvent.mock.calls.some(([e]) => e.type === 'conversation-created'),
  ).toBe(false);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(results[0].correlation.conversationId).toBeUndefined();
  expect(results[0].correlation.persistence).toBe('disabled');
  expect(bodies[0]).not.toHaveProperty('conversationId');
  await expect(engine.observe(undefined, input)).rejects.toMatchObject({
    kind: 'configuration',
  });
  await engine.shutdown();
  await expect(
    scope.observe(undefined, input, turn('two')),
  ).rejects.toBeInstanceOf(CaesuraError);
});

it('isolates stateless invocations from conversation state and still awaits application hooks', async () => {
  const store = new MemoryCaesuraStore();
  const get = vi.spyOn(store, 'get'),
    set = vi.spyOn(store, 'set');
  const persistMessages = vi.fn(async () => {});
  const engine = createCaesuraEngine({
    mode: 'sync',
    store,
    persistMessages,
    transport: {
      analyze: async (body) => ({ analysis: body.messages.at(-1)?.text }),
    },
  });
  const first = engine.createStatelessScope(),
    second = engine.createStatelessScope();
  await Promise.all([
    first.observe(undefined, input, turn('same-turn')),
    second.observe(
      undefined,
      [{ speakerRole: 'user', text: 'other' }],
      turn('same-turn'),
    ),
  ]);
  expect((await first.getState(undefined)).recommendations[0].analysis).toBe(
    'hello',
  );
  expect((await second.getState(undefined)).recommendations[0].analysis).toBe(
    'other',
  );
  expect(get).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
  expect(persistMessages).toHaveBeenCalledTimes(2);
  expect(persistMessages).toHaveBeenCalledWith(
    expect.objectContaining({
      correlation: expect.objectContaining({ conversationId: undefined }),
    }),
  );
  await expect(first.observe('invented', input)).rejects.toMatchObject({
    kind: 'configuration',
  });
  expect(await engine.flush()).toHaveLength(2);
  await engine.shutdown();
});

for (const action of ['clearAll', 'shutdown'] as const) {
  it(`parent ${action} cancels blocked stateless analysis without stale guidance`, async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine = createCaesuraEngine({
      mode: 'async',
      transport: {
        analyze: async () => {
          enter();
          await gate;
          return { analysis: 'late' };
        },
      },
    });
    const scope = engine.createStatelessScope();
    let guard!: ReturnType<typeof setTimeout>;
    const bounded = <T>(work: Promise<T>) =>
      Promise.race([
        work,
        new Promise<never>((_, reject) => {
          guard = setTimeout(
            () => reject(new Error('scope cancellation stalled')),
            1000,
          );
        }),
      ]).finally(() => clearTimeout(guard));
    try {
      await scope.observe(undefined, input, turn('one'));
      await bounded(entered);
      const results = await bounded(
        action === 'shutdown'
          ? engine.shutdown()
          : engine.clearAll().then(() => engine.flush()),
      );
      expect(results[0].status).toBe('cancelled');
      release();
      await Promise.resolve();
      expect((await scope.getState(undefined)).recommendations).toEqual([]);
    } finally {
      release();
      await engine.shutdown();
    }
  });
}

it('retains guidance and retry mappings after fallback analysis fails; retry saves without repeating analysis', async () => {
  let fail = false;
  const analyze = vi.fn(async () => {
    if (fail) throw new Error('analysis failed');
    return { analysis: 'previous guidance' };
  });
  const appendMessages = vi.fn(async () => {
    if (fail) throw new Error('save failed');
  });
  const engine = createCaesuraEngine({
    mode: 'sync',
    transport: { analyze, appendMessages, getNextMessageId: async () => 1 },
  });
  await engine.observe('id', input, turn('one'));
  fail = true;
  await engine.observe('id', input, turn('two'));
  expect(
    (await engine.getState('id')).recommendations.map((r) => r.analysis),
  ).toEqual(['previous guidance']);
  expect((await engine.getState('id')).transcriptMessageIds).toEqual({
    one: 1,
    two: 2,
  });
  fail = false;
  await engine.observe('id', input, turn('two'));
  expect(appendMessages).toHaveBeenCalledTimes(3);
  expect(appendMessages).toHaveBeenLastCalledWith(
    [expect.objectContaining({ id: 2 })],
    expect.anything(),
  );
  expect(analyze).toHaveBeenCalledTimes(2);
  await engine.shutdown();
});

it('does not swallow an explicit caller deadline during stateless foreground analysis', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const engine = createCaesuraEngine({
    mode: 'sync',
    transport: {
      analyze: async () => {
        await blocked;
        return { analysis: 'late' };
      },
    },
  });
  const scope = engine.createStatelessScope();
  let guard!: ReturnType<typeof setTimeout>;
  try {
    await expect(
      Promise.race([
        scope.observe(undefined, input, {
          ...turn('one'),
          deadline: Date.now() + 25,
        }),
        new Promise<never>((_, reject) => {
          guard = setTimeout(() => reject(new Error('deadline stalled')), 1000);
        }),
      ]),
    ).rejects.toMatchObject({ kind: 'timeout' });
    expect((await scope.getState(undefined)).recommendations).toEqual([]);
  } finally {
    clearTimeout(guard);
    release();
    await engine.shutdown();
  }
});
