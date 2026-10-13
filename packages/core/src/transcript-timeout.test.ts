import { expect, it, vi } from 'vitest';
import { createCaesuraEngine } from './engine.js';
import type { AnalysisTransport } from './contracts.js';
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
        timer = setTimeout(
          () => reject(new Error('Blocked operation did not settle')),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const input = [{ speakerRole: 'user' as const, text: 'customer' }];
const turn = { turn: { id: 'turn', origin: 'customer' as const } };
for (const mode of ['sync', 'async'] as const) {
  for (const failurePolicy of ['continue', 'throw'] as const) {
    it.each(['timeout', 'cancelled', 'store'] as const)(
      `handles required transcript %s in ${mode}/${failurePolicy}`,
      async (kind) => {
        const entered = gate(),
          blocked = gate();
        const controller = new AbortController();
        const cause = new Error('storage unavailable');
        const transport: AnalysisTransport = {
          getNextMessageId: async () => 1,
          appendMessages: async () => {
            entered.resolve();
            if (kind === 'store') throw cause;
            await blocked.promise;
          },
          analyze: vi.fn(async () => ({ analysis: 'SAME' })),
        };
        const engine = createCaesuraEngine({
          transport,
          mode,
          failurePolicy,
          timeoutMs: kind === 'timeout' ? 25 : 1000,
          onError: () => {},
        });
        const result = engine
          .observe('id', input, { ...turn, signal: controller.signal })
          .then(
            () => undefined,
            (e) => e,
          );
        await bounded(entered.promise);
        if (kind === 'cancelled') controller.abort('stop');
        const error = await bounded(result);
        if (kind !== 'cancelled' && failurePolicy === 'continue')
          expect(error).toBeUndefined();
        else expect(error).toMatchObject({ kind });
        blocked.resolve();
        await bounded(engine.flush());
        const fallback = kind !== 'cancelled' && failurePolicy === 'continue';
        expect(transport.analyze).toHaveBeenCalledTimes(fallback ? 1 : 0);
        if (fallback)
          expect(vi.mocked(transport.analyze).mock.calls[0][0]).toMatchObject({
            persist: false,
          });
        expect((await engine.getState('id')).processedTurnIds ?? []).toEqual(
          fallback ? ['turn'] : [],
        );
        await engine.shutdown();
      },
    );
    it.each(['timeout', 'transport'] as const)(
      `preserves analysis %s policy in ${mode}/${failurePolicy}`,
      async (kind) => {
        const entered = gate(),
          blocked = gate();
        const transport: AnalysisTransport = {
          getNextMessageId: async () => 1,
          appendMessages: async () => {},
          analyze: async () => {
            entered.resolve();
            if (kind === 'transport') throw new Error('analysis unavailable');
            await blocked.promise;
            return { analysis: 'SAME' };
          },
        };
        const engine = createCaesuraEngine({
          transport,
          mode,
          failurePolicy,
          timeoutMs: kind === 'timeout' ? 25 : 1000,
          onError: () => {},
        });
        const result = engine.observe('id', input, turn).then(
          () => undefined,
          (e) => e,
        );
        await bounded(entered.promise);
        const error = await bounded(result);
        if (mode === 'sync' && failurePolicy === 'throw')
          expect(error).toMatchObject({ kind });
        else expect(error).toBeUndefined();
        const completions = await bounded(engine.flush());
        expect(completions).toContainEqual(
          expect.objectContaining({
            status: 'failed',
            error: expect.objectContaining({ kind }),
          }),
        );
        blocked.resolve();
        await engine.shutdown();
      },
    );
  }
}
it.each(['continue', 'throw'] as const)(
  'standalone hosted transcript timeout follows %s',
  async (failurePolicy) => {
    const entered = gate(),
      blocked = gate();
    const engine = createCaesuraEngine({
      failurePolicy,
      timeoutMs: 25,
      onError: () => {},
      transport: {
        getNextMessageId: async () => 1,
        appendMessages: async () => {
          entered.resolve();
          await blocked.promise;
        },
        analyze: vi.fn(),
      },
    });
    const result = engine
      .recordMessages('id', [{ id: 'greeting', role: 'agent', text: 'Hello' }])
      .catch((e) => e);
    await bounded(entered.promise);
    if (failurePolicy === 'throw')
      expect(await bounded(result)).toMatchObject({ kind: 'timeout' });
    else expect(await bounded(result)).toBeUndefined();
    blocked.resolve();
    await engine.shutdown();
  },
);
