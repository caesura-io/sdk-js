/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, expect, it, vi } from 'vitest';
import {
  setTimeout as realTimeout,
  clearTimeout as clearRealTimeout,
} from 'node:timers';
const gate = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
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
        () => reject(new Error('Audit cancellation did not settle promptly')),
        1000,
      );
    }),
  ]).finally(() => clearRealTimeout(timer));
};
afterEach(() => vi.useRealTimers());
import { caesuraMiddleware } from './middleware.js';
import { wrapLanguageModel } from 'ai';
import { createRequire } from 'node:module';
const major = Number(
  createRequire(import.meta.url)('ai/package.json').version.split('.')[0],
);
const specificationVersion = major === 5 ? 'v2' : major === 6 ? 'v3' : 'v4';

for (const entry of ['generate', 'stream']) {
  it.each([
    'before',
    'during',
    'deadline',
    'late-rejection',
    'success',
    'strict-failure',
    'continue-failure',
  ])(`%s audit outcome for ${entry}`, async (outcome) => {
    if (outcome === 'deadline') vi.useFakeTimers();
    const controller = new AbortController();
    const entered = gate(),
      blocked = gate();
    const stream = entry.endsWith('stream');
    const observer = vi.fn();
    const cause = new Error('audit database unavailable');
    const provider = vi.fn(async () =>
      stream
        ? {
            stream: new ReadableStream({
              start(c) {
                c.close();
              },
            }),
            async *[Symbol.asyncIterator]() {
              /* unused in these invocation tests */
            },
          }
        : { content: [], output: [], choices: [] },
    );
    let live: any;
    let captured: any;
    const persistProviderRequest = vi.fn(async (event, context) => {
      live = context;
      captured = event;
      entered.resolve();
      if (outcome.endsWith('failure')) throw cause;
      await blocked.promise;
    });
    const config: any = {
      transport: { analyze: async () => ({ analysis: 'audit guidance' }) },
      mode: 'sync',
      failurePolicy: outcome === 'strict-failure' ? 'throw' : 'continue',
      persistProviderRequest,
      onProviderEvent: observer,
      onError: () => {},
      inject: { skillPrompt: '' },
    };
    const deadline = outcome === 'deadline' ? Date.now() + 1000 : undefined;
    const middleware = caesuraMiddleware(config);
    const model = wrapLanguageModel({
      middleware,
      model: {
        specificationVersion,
        provider: 'local',
        modelId: 'test',
        supportedUrls: {},
        doGenerate: provider,
        doStream: provider,
      } as any,
    });
    const params = {
      abortSignal: controller.signal,
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      providerOptions: {
        caesura: {
          conversationId: 'id',
          deadline,
          turn: { id: 'customer', origin: 'customer' },
        },
      },
    } as any;
    const request = () =>
      stream ? model.doStream(params) : model.doGenerate(params);

    if (outcome === 'before') controller.abort('before request');
    // Attach rejection handling before triggering cancellation; the gate is deliberately still closed.
    const result = Promise.resolve(request()).then(
      (value) => ({ value, error: undefined }),
      (error) => ({ value: undefined, error }),
    );
    try {
      if (outcome !== 'before') {
        await bounded(entered.promise);
        expect(provider).not.toHaveBeenCalled();
        expect(JSON.stringify(captured.parameters)).toContain('audit guidance');
        expect(captured).not.toHaveProperty('deadline');
        expect(captured).not.toHaveProperty('signal');
        expect(captured.parameters.abortSignal).toBeUndefined();
        expect(live.signal).toBeInstanceOf(AbortSignal);
        expect(live.deadline).toBe(deadline);
        if (outcome === 'deadline') await vi.advanceTimersByTimeAsync(1000);
        else if (outcome === 'during' || outcome === 'late-rejection')
          controller.abort('during audit');
        else if (outcome === 'success') blocked.resolve();
      }
      const settled = await bounded(result);
      const succeeds = outcome === 'success' || outcome === 'continue-failure';
      expect(provider).toHaveBeenCalledTimes(succeeds ? 1 : 0);
      if (succeeds) expect(settled.error).toBeUndefined();
      else
        expect(settled.error).toMatchObject({
          kind:
            outcome === 'deadline'
              ? 'timeout'
              : outcome === 'strict-failure'
                ? 'store'
                : 'cancelled',
        });
      if (outcome === 'before')
        expect(persistProviderRequest).not.toHaveBeenCalled();
      if (outcome === 'late-rejection')
        blocked.reject(new Error('late audit failure'));
      else blocked.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(provider).toHaveBeenCalledTimes(succeeds ? 1 : 0);
      if (!succeeds) expect(observer).not.toHaveBeenCalled();
    } finally {
      blocked.resolve();
    }
  });
}
