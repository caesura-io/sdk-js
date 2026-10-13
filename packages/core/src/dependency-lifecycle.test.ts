import { expect, it, vi } from 'vitest';
import { createCaesuraEngine } from './engine.js';
import { CaesuraError, type AnalysisContext } from './contracts.js';
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('operation stalled')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const input = [
  { speakerRole: 'user' as const, speakerIndex: 0, text: 'hello' },
];
for (const mode of ['sync', 'async'] as const)
  for (const failurePolicy of ['continue', 'throw'] as const)
    for (const stage of ['counter', 'append'] as const) {
      it(`${stage} dependency timeout keeps a fresh analysis budget (${mode}/${failurePolicy})`, async () => {
        const blocked = gate(),
          errors: unknown[] = [];
        let storageSignal!: AbortSignal;
        let storageDeadline!: number;
        const analyze = vi.fn(async (body, context: AnalysisContext) => {
          expect(storageSignal.aborted).toBe(true);
          expect(context.signal.aborted).toBe(false);
          expect(context.deadline - storageDeadline).toBeGreaterThanOrEqual(20);
          expect(body).toMatchObject({
            persist: false,
            messages: [{ speakerIndex: 0 }],
          });
          for (const key of [
            'conversationId',
            'sessionId',
            'transcriptMessageId',
          ])
            expect(body).not.toHaveProperty(key);
          return { analysis: 'guidance' };
        });
        const engine = createCaesuraEngine({
          mode,
          failurePolicy,
          timeoutMs: 30,
          onError: (e) => {
            errors.push(e);
          },
          transport: {
            getNextMessageId: async (context) => {
              storageSignal = context.signal;
              storageDeadline = context.deadline;
              if (stage === 'counter') await blocked.promise;
              return 1;
            },
            appendMessages: async (_, context) => {
              storageSignal = context.signal;
              storageDeadline = context.deadline;
              if (stage === 'append') await blocked.promise;
            },
            analyze,
          },
        });
        try {
          const work = engine.observe('id', input, {
            deadline: Date.now() + 2000,
          });
          if (failurePolicy === 'throw')
            await expect(bounded(work)).rejects.toMatchObject({
              kind: 'timeout',
            });
          else await bounded(work);
          await bounded(engine.flush());
          expect(analyze).toHaveBeenCalledTimes(
            failurePolicy === 'throw' ? 0 : 1,
          );
          expect(errors).toEqual([
            expect.objectContaining({ kind: 'timeout' }),
          ]);
        } finally {
          blocked.resolve();
          await engine.shutdown();
        }
      });
    }
for (const mode of ['sync', 'async'] as const) {
  it(`required application timeout is not a hosted fallback (${mode})`, async () => {
    const blocked = gate(),
      analyze = vi.fn();
    const engine = createCaesuraEngine({
      mode,
      timeoutMs: 25,
      persistMessages: () => blocked.promise,
      transport: { analyze },
    });
    try {
      await expect(
        bounded(engine.observe('id', input, { deadline: Date.now() + 2000 })),
      ).rejects.toMatchObject({ kind: 'timeout' });
      expect(analyze).not.toHaveBeenCalled();
    } finally {
      blocked.resolve();
      await engine.shutdown();
    }
  });
}
for (const failurePolicy of ['continue', 'throw'] as const) {
  for (const kind of [
    'transport',
    'timeout',
    'cancelled',
    'deadline',
    'unsupported',
    'configuration',
  ] as const) {
    it(`creation ${kind} follows ${failurePolicy} without fabricated identity`, async () => {
      const entered = gate(),
        blocked = gate(),
        controller = new AbortController();
      const onError = vi.fn(),
        onEvent = vi.fn();
      const engine = createCaesuraEngine({
        failurePolicy,
        timeoutMs: kind === 'timeout' ? 25 : 2000,
        onError,
        onEvent,
        transport: {
          analyze: vi.fn(),
          ...(kind === 'unsupported'
            ? {}
            : {
                createConversation: async () => {
                  entered.resolve();
                  if (kind === 'transport' || kind === 'configuration')
                    throw new CaesuraError(kind, 'creation unavailable');
                  await blocked.promise;
                  return 'late-id';
                },
              }),
        },
      });
      try {
        const work = engine.createConversation(
          {},
          {
            signal: controller.signal,
            deadline: Date.now() + (kind === 'deadline' ? 25 : 2000),
          },
        );
        const outcome = work.then(
          (id) => ({ id }),
          (error) => ({ error }),
        );
        if (kind === 'cancelled') {
          await bounded(entered.promise);
          controller.abort();
        }
        const result = await bounded(outcome);
        if (
          failurePolicy === 'continue' &&
          ['transport', 'timeout'].includes(kind)
        )
          expect(result).toEqual({ id: undefined });
        else
          expect(result).toMatchObject({
            error: { kind: kind === 'deadline' ? 'timeout' : kind },
          });
        expect(onError).toHaveBeenCalledTimes(1);
        expect(
          onEvent.mock.calls.filter(([e]) => e.type === 'conversation-created'),
        ).toHaveLength(0);
      } finally {
        blocked.resolve();
        await engine.shutdown();
      }
    });
  }
}
for (const cancel of [true, false]) {
  it(`parent owns late scope results and closes retained scopes (cancel=${cancel})`, async () => {
    const blocked = gate(),
      entered = gate(),
      completed = gate();
    const onCreditUsage = vi.fn();
    const engine = createCaesuraEngine({
      mode: 'async',
      onCreditUsage,
      onCompletion: (c) => {
        if (c.status === 'completed') completed.resolve();
      },
      transport: {
        analyze: async () => {
          entered.resolve();
          await blocked.promise;
          return { analysis: 'paid result', creditUsage: 7 };
        },
      },
    });
    const scope = engine.createStatelessScope();
    await scope.observe(undefined, input);
    await bounded(entered.promise);
    const shutdown = engine.shutdown({ cancel });
    await expect(scope.observe(undefined, input)).rejects.toMatchObject({
      kind: 'cancelled',
    });
    expect(() => scope.createStatelessScope()).toThrow();
    if (cancel) {
      expect((await bounded(shutdown)).map((c) => c.status)).toEqual([
        'cancelled',
      ]);
      blocked.resolve();
      await bounded(completed.promise);
      const late = await engine.flush();
      expect(late).toHaveLength(1);
      expect(late[0]).toMatchObject({
        status: 'completed',
        result: { creditUsage: 7 },
      });
      expect((await scope.getState(undefined)).recommendations).toEqual([]);
    } else {
      blocked.resolve();
      expect((await bounded(shutdown)).map((c) => c.status)).toEqual([
        'completed',
      ]);
      // Accepted provider finalization may still call the required transcript hook.
      await scope.recordMessages(undefined, [
        { id: 'reply', role: 'agent', text: 'answer' },
      ]);
    }
    expect(onCreditUsage).toHaveBeenCalledTimes(1);
    expect(await engine.flush()).toEqual([]);
  });
}

it('parent flush tracks accepted child creation independently from child analysis queues', async () => {
  const entered = gate(),
    release = gate();
  const engine = createCaesuraEngine({
    transport: {
      analyze: vi.fn(),
      createConversation: async () => {
        entered.resolve();
        await release.promise;
        return 'real-id';
      },
    },
  });
  const scope = engine.createStatelessScope();
  const creation = scope.createConversation();
  await bounded(entered.promise);
  let settled = false;
  const flush = engine.flush().then((value) => {
    settled = true;
    return value;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    release.resolve();
    expect(await bounded(creation)).toBe('real-id');
    expect(await bounded(flush)).toEqual([]);
  } finally {
    release.resolve();
    await engine.shutdown();
  }
});
