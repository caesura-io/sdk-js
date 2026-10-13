/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, expect, it, vi } from 'vitest';
import {
  setTimeout as realTimeout,
  clearTimeout as clearRealTimeout,
} from 'node:timers';
import { createCaesuraEngine } from './engine.js';
import type { ProviderAuditContext, ProviderAuditEvent } from './contracts.js';
const gate = () => {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
};
const bounded = <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof realTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = realTimeout(
        () => reject(new Error('Audit wait did not settle promptly')),
        1000,
      );
    }),
  ]).finally(() => clearRealTimeout(timer));
};
const event = (): Extract<ProviderAuditEvent, { type: 'request' }> => ({
  type: 'request',
  api: 'chat',
  correlation: { conversationId: 'authoritative' },
  parameters: {
    messages: [{ role: 'user', content: 'original' }],
    headers: { authorization: 'secret' },
  },
  analysisIds: ['analysis'],
});
afterEach(() => vi.useRealTimers());
it.each(['cancelled', 'timeout'] as const)(
  'rejects %s before invoking the required callback',
  async (kind) => {
    const persist = vi.fn();
    const controller = new AbortController();
    if (kind === 'cancelled') controller.abort('reason');
    const engine = createCaesuraEngine({
      transport: { analyze: vi.fn() },
      persistProviderRequest: persist,
    });
    await expect(
      engine.prepareProvider(event(), {
        signal: controller.signal,
        deadline: kind === 'timeout' ? Date.now() - 1 : undefined,
      }),
    ).rejects.toMatchObject({ kind });
    expect(persist).not.toHaveBeenCalled();
  },
);
it.each(['cancelled', 'timeout', 'clear', 'shutdown'] as const)(
  'interrupts blocked audit on %s and isolates late callback settlement',
  async (trigger) => {
    if (trigger === 'timeout') vi.useFakeTimers();
    for (const lateReject of [false, true]) {
      const entered = gate(),
        blocked = gate();
      const controller = new AbortController();
      const observer = vi.fn();
      let live!: ProviderAuditContext;
      const engine = createCaesuraEngine({
        transport: { analyze: vi.fn() },
        onProviderEvent: observer,
        persistProviderRequest: async (snapshot, context) => {
          live = context;
          expect(snapshot).not.toHaveProperty('signal');
          expect(snapshot.parameters).not.toHaveProperty('headers');
          entered.resolve();
          await blocked.promise;
        },
      });
      const deadline = trigger === 'timeout' ? Date.now() + 1000 : undefined;
      const result = engine
        .prepareProvider(event(), { signal: controller.signal, deadline })
        .then(
          () => ({ error: undefined }),
          (error) => ({ error }),
        );
      try {
        await bounded(entered.promise);
        expect(live.deadline).toBe(deadline);
        if (trigger === 'timeout') await vi.advanceTimersByTimeAsync(1000);
        else if (trigger === 'clear') await engine.clear('authoritative');
        else if (trigger === 'shutdown') await engine.shutdown();
        else controller.abort('custom cancellation');
        const outcome = await bounded(result);
        expect(outcome.error).toMatchObject({
          kind: trigger === 'timeout' ? 'timeout' : 'cancelled',
        });
        expect(live.signal.aborted).toBe(true);
        if (lateReject) blocked.reject(new Error('late rejection'));
        else blocked.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(observer).not.toHaveBeenCalled();
      } finally {
        blocked.resolve();
      }
    }
  },
);
it.each(['continue', 'throw'] as const)(
  'preserves ordinary audit error policy: %s',
  async (failurePolicy) => {
    const cause = new Error('database unavailable');
    const onError = vi.fn();
    const engine = createCaesuraEngine({
      transport: { analyze: vi.fn() },
      failurePolicy,
      onError,
      persistProviderRequest: async () => {
        throw cause;
      },
    });
    if (failurePolicy === 'throw')
      await expect(engine.prepareProvider(event())).rejects.toMatchObject({
        kind: 'store',
        cause,
      });
    else await expect(engine.prepareProvider(event())).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'store', cause }),
    );
  },
);
it.each(['AbortError', 'TimeoutError'])(
  'never swallows a callback %s under continue policy',
  async (name) => {
    const cause = new DOMException('stopped', name);
    const engine = createCaesuraEngine({
      transport: { analyze: vi.fn() },
      onError: () => {},
      persistProviderRequest: async () => {
        throw cause;
      },
    });
    await expect(engine.prepareProvider(event())).rejects.toMatchObject({
      kind: name === 'TimeoutError' ? 'timeout' : 'cancelled',
      cause,
    });
  },
);
it('keeps the captured request isolated from caller and callback mutation and excludes live controls', async () => {
  const entered = gate(),
    blocked = gate();
  const observed: any[] = [];
  const input = event();
  const signal = new AbortController().signal;
  const engine = createCaesuraEngine({
    transport: { analyze: vi.fn() },
    onProviderEvent: (e) => {
      observed.push(e);
    },
    persistProviderRequest: async (snapshot, context) => {
      expect(context.signal).toBeInstanceOf(AbortSignal);
      expect((snapshot.parameters as any).messages[0].content).toBe('original');
      (snapshot.parameters as any).messages[0].content = 'callback mutation';
      entered.resolve();
      await blocked.promise;
    },
  });
  const result = engine.prepareProvider(input, { signal });
  await bounded(entered.promise);
  (input.parameters as any).messages[0].content = 'caller mutation';
  blocked.resolve();
  await bounded(result);
  expect(observed[0].parameters.messages[0].content).toBe('original');
  expect(observed[0]).not.toHaveProperty('signal');
  expect(observed[0]).not.toHaveProperty('deadline');
});
it('checks time after synchronous callback work even before a deadline timer runs', async () => {
  vi.useFakeTimers();
  const deadline = Date.now() + 1000;
  const engine = createCaesuraEngine({
    transport: { analyze: vi.fn() },
    persistProviderRequest: () => {
      vi.setSystemTime(deadline);
    },
  });
  await expect(
    engine.prepareProvider(event(), { deadline }),
  ).rejects.toMatchObject({ kind: 'timeout' });
});

it('checks cancellation again before entering the scheduled callback', async () => {
  const controller = new AbortController();
  const persist = vi.fn();
  const engine = createCaesuraEngine({
    transport: { analyze: vi.fn() },
    persistProviderRequest: persist,
  });
  const result = engine.prepareProvider(event(), { signal: controller.signal });
  controller.abort();
  await expect(bounded(result)).rejects.toMatchObject({ kind: 'cancelled' });
  expect(persist).not.toHaveBeenCalled();
});

it('retains timeout classification from the operation signal', async () => {
  const controller = new AbortController();
  const cause = new DOMException('native timeout', 'TimeoutError');
  const engine = createCaesuraEngine({ transport: { analyze: vi.fn() } });
  controller.abort(cause);
  await expect(
    engine.prepareProvider(event(), { signal: controller.signal }),
  ).rejects.toMatchObject({ kind: 'timeout', cause });
});
