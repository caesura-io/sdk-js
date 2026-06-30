/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { caesuraMiddleware } from './middleware.js';
import { MemoryCaesuraStore } from './store.js';

describe('caesuraMiddleware credit callback integration', () => {
  let fetchMock: any;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fires onCreditUsage callback when credits are reported in response', async () => {
    const headers = new Headers();
    headers.set('content-type', 'application/json');
    headers.set('X-Credit-Usage', '42');

    fetchMock.mockResolvedValue({
      ok: true,
      headers,
      json: async () => ({ recommendation: 'new rec', isSame: false }),
    });

    const mockCallback = vi.fn();
    const mockOnError = vi.fn();

    const store = new MemoryCaesuraStore();
    const middleware = caesuraMiddleware({
      baseUrl: 'http://localhost:3000',
      apiKey: 'test-key',
      mode: 'sync', // Use sync mode so analyze executes synchronously and we can assert immediately
      store,
      onCreditUsage: mockCallback,
      onError: mockOnError,
    });

    const params = {
      prompt: [{ role: 'user', content: 'hello agent' }],
      providerOptions: { caesura: { conversationId: 'test-conv' } },
    } as any;

    await middleware.transformParams!({ params } as any);

    expect(mockCallback).toHaveBeenCalledTimes(1);
    const callbackArg = mockCallback.mock.calls[0][0];
    expect(callbackArg.credits).toBe(42);
    expect(callbackArg.conversationId).toBe('test-conv');
    expect(callbackArg.queryTurn).toBe(1);
    expect(callbackArg.isSame).toBe(false);
    expect(callbackArg.recommendationId).toBeDefined();
    expect(callbackArg.timestampMs).toBeLessThanOrEqual(Date.now());
    expect(mockOnError).not.toHaveBeenCalled();
  });

  it('routes callback errors to onError without breaking the middleware flow', async () => {
    const headers = new Headers();
    headers.set('content-type', 'application/json');
    headers.set('X-Credit-Usage', '10');

    fetchMock.mockResolvedValue({
      ok: true,
      headers,
      json: async () => ({ recommendation: 'rec text', isSame: false }),
    });

    const mockCallback = vi.fn().mockImplementation(() => {
      throw new Error('Callback failed');
    });
    const mockOnError = vi.fn();

    const store = new MemoryCaesuraStore();
    const middleware = caesuraMiddleware({
      baseUrl: 'http://localhost:3000',
      apiKey: 'test-key',
      mode: 'sync',
      store,
      onCreditUsage: mockCallback,
      onError: mockOnError,
    });

    const params = {
      prompt: [{ role: 'user', content: 'hello agent' }],
      providerOptions: { caesura: { conversationId: 'test-conv' } },
    } as any;

    // The middleware transformParams should complete successfully and not throw
    const result = await middleware.transformParams!({ params } as any);
    expect(result).toBeDefined();

    expect(mockCallback).toHaveBeenCalledTimes(1);
    expect(mockOnError).toHaveBeenCalledTimes(1);
    expect(mockOnError.mock.calls[0][0].message).toBe('Callback failed');
  });

  describe('observability onEvent hook', () => {
    it('emits correct sequence of events on a normal successful turn with injection', async () => {
      const headers = new Headers();
      headers.set('content-type', 'application/json');
      headers.set('X-Credit-Usage', '5');

      fetchMock.mockResolvedValue({
        ok: true,
        headers,
        json: async () => ({ recommendation: 'useful advice', isSame: false }),
      });

      const events: any[] = [];
      const onEvent = vi.fn((e) => events.push(e));
      const onError = vi.fn();

      const store = new MemoryCaesuraStore();
      const middleware = caesuraMiddleware({
        baseUrl: 'http://localhost:3000',
        apiKey: 'test-key',
        mode: 'sync',
        store,
        onEvent,
        onError,
      });

      const params = {
        prompt: [{ role: 'user', content: 'how to do X?' }],
        providerOptions: { caesura: { conversationId: 'test-obs' } },
      } as any;

      await middleware.transformParams!({ params } as any);

      // In sync mode, query completes and recommendations are injected in the same turn.
      // So we expect 4 events: request, response, buffered, injected.
      expect(onEvent).toHaveBeenCalledTimes(4);
      expect(events[0].type).toBe('request');
      expect(events[0].conversationId).toBe('test-obs');
      expect(events[0].queryTurn).toBe(1);
      expect(events[0].body.messages[0].text).toBe('how to do X?');
      expect(events[0].includeCreditUsage).toBe(true);

      expect(events[1].type).toBe('response');
      expect(events[1].conversationId).toBe('test-obs');
      expect(events[1].queryTurn).toBe(1);
      expect(events[1].analysis).toEqual({ recommendation: 'useful advice', isSame: false });
      expect(events[1].creditUsage).toBe(5);
      expect(events[1].durationMs).toBeGreaterThanOrEqual(0);

      expect(events[2].type).toBe('buffered');
      expect(events[2].conversationId).toBe('test-obs');
      expect(events[2].queryTurn).toBe(1);
      expect(events[2].recommendationId).toBeDefined();

      expect(events[3].type).toBe('injected');
      expect(events[3].conversationId).toBe('test-obs');
      expect(events[3].turn).toBe(1);
      expect(events[3].blocks[0].text).toContain('useful advice');
      expect(events[3].blocks[0].index).toBe(2);
    });

    it('emits skipped events with correct reasons', async () => {
      const store = new MemoryCaesuraStore();
      const events: any[] = [];
      const onEvent = vi.fn((e) => events.push(e));

      // 1. no-messages reason
      const middlewareNoMsgs = caesuraMiddleware({
        baseUrl: 'http://localhost:3000',
        apiKey: 'test-key',
        mode: 'sync',
        store,
        onEvent,
      });
      await middlewareNoMsgs.transformParams!({
        params: { prompt: [] },
      } as any);
      expect(events[events.length - 1]).toEqual(expect.objectContaining({
        type: 'skipped',
        reason: 'no-messages',
      }));

      // 2. cadence-turns reason
      const middlewareTurns = caesuraMiddleware({
        baseUrl: 'http://localhost:3000',
        apiKey: 'test-key',
        mode: 'sync',
        store,
        onEvent,
        cadence: { everyTurns: 2 },
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        json: async () => ({ recommendation: 'ok' }),
      });
      // Turn 1: queries
      await middlewareTurns.transformParams!({
        params: {
          prompt: [{ role: 'user', content: 'test' }],
          providerOptions: { caesura: { conversationId: 'conv-turns' } },
        },
      } as any);
      // Turn 2: skips because everyTurns is 2 and only 1 turn has passed since query
      await middlewareTurns.transformParams!({
        params: {
          prompt: [{ role: 'user', content: 'test' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'test2' }],
          providerOptions: { caesura: { conversationId: 'conv-turns' } },
        },
      } as any);
      const skippedTurns = events.find((e) => e.type === 'skipped' && e.conversationId === 'conv-turns');
      expect(skippedTurns).toEqual(expect.objectContaining({
        type: 'skipped',
        conversationId: 'conv-turns',
        reason: 'cadence-turns',
      }));
      // 3. cadence-seconds reason
      const middlewareSecs = caesuraMiddleware({
        baseUrl: 'http://localhost:3000',
        apiKey: 'test-key',
        mode: 'sync',
        store,
        onEvent,
        cadence: { everyTurns: 1, everySeconds: 10 },
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        json: async () => ({ recommendation: 'ok' }),
      });
      await middlewareSecs.transformParams!({
        params: {
          prompt: [{ role: 'user', content: 'test' }],
          providerOptions: { caesura: { conversationId: 'conv-secs' } },
        },
      } as any);
      await middlewareSecs.transformParams!({
        params: {
          prompt: [{ role: 'user', content: 'test' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'test2' }],
          providerOptions: { caesura: { conversationId: 'conv-secs' } },
        },
      } as any);
      const skippedSecs = events.find((e) => e.type === 'skipped' && e.conversationId === 'conv-secs');
      expect(skippedSecs).toEqual(expect.objectContaining({
        type: 'skipped',
        conversationId: 'conv-secs',
        reason: 'cadence-seconds',
      }));

      // 4. in-flight reason
      const convState = store.get('conv-inflight');
      convState.inFlight = true;
      const middlewareInflight = caesuraMiddleware({
        baseUrl: 'http://localhost:3000',
        apiKey: 'test-key',
        mode: 'sync',
        store,
        onEvent,
      });
      await middlewareInflight.transformParams!({
        params: {
          prompt: [{ role: 'user', content: 'test' }],
          providerOptions: { caesura: { conversationId: 'conv-inflight' } },
        },
      } as any);
      expect(events[events.length - 1]).toEqual(expect.objectContaining({
        type: 'skipped',
        conversationId: 'conv-inflight',
        reason: 'in-flight',
      }));
    });

    it('emits deduped event on duplicate analysis response', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({ isSame: true }),
      });

      const events: any[] = [];
      const onEvent = vi.fn((e) => events.push(e));

      const store = new MemoryCaesuraStore();
      const middleware = caesuraMiddleware({
        baseUrl: 'http://localhost:3000',
        apiKey: 'test-key',
        mode: 'sync',
        store,
        onEvent,
      });

      await middleware.transformParams!({
        params: {
          prompt: [{ role: 'user', content: 'hello' }],
          providerOptions: { caesura: { conversationId: 'test-dedup' } },
        },
      } as any);

      expect(events.some((e) => e.type === 'deduped')).toBe(true);
    });

    it('emits injected event when recommendations are injected', async () => {
      const store = new MemoryCaesuraStore();
      store.add('test-inject', [{
        id: 'rec-1',
        analysis: { recommendation: 'do something' },
        afterMessageHash: 'placeholder',
        createdAtMs: Date.now(),
        createdAtTurn: 1,
      }]);

      const events: any[] = [];
      const onEvent = vi.fn((e) => events.push(e));

      const middleware = caesuraMiddleware({
        baseUrl: 'http://localhost:3000',
        apiKey: 'test-key',
        mode: 'sync',
        store,
        onEvent,
        inject: { placement: 'end' },
      });

      fetchMock.mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({ isSame: true }),
      });

      await middleware.transformParams!({
        params: {
          prompt: [{ role: 'user', content: 'hello' }],
          providerOptions: { caesura: { conversationId: 'test-inject' } },
        },
      } as any);

      const injectedEvent = events.find((e) => e.type === 'injected');
      expect(injectedEvent).toBeDefined();
      expect(injectedEvent.blocks[0].text).toContain('do something');
      expect(injectedEvent.blocks).toHaveLength(1);
      expect(injectedEvent.placement).toBe('end');
      expect(injectedEvent.blocks[0]!.index).toBe(2);
    });

    it('emits error event when Caesura backend client call fails', async () => {
      fetchMock.mockRejectedValue(new Error('Network failure'));

      const events: any[] = [];
      const onEvent = vi.fn((e) => events.push(e));
      const onError = vi.fn();

      const middleware = caesuraMiddleware({
        baseUrl: 'http://localhost:3000',
        apiKey: 'test-key',
        mode: 'sync',
        onEvent,
        onError,
      });

      await middleware.transformParams!({
        params: {
          prompt: [{ role: 'user', content: 'hello' }],
          providerOptions: { caesura: { conversationId: 'test-err' } },
        },
      } as any);

      expect(events.some((e) => e.type === 'error')).toBe(true);
      const errorEv = events.find((e) => e.type === 'error');
      expect(errorEv.error.message).toBe('Network failure');
      expect(onError).toHaveBeenCalled();
    });

    it('protects main thread: error inside onEvent callback does not crash middleware', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({ isSame: true }),
      });

      const onEvent = vi.fn().mockImplementation(() => {
        throw new Error('Logger failure');
      });
      const onError = vi.fn();

      const middleware = caesuraMiddleware({
        baseUrl: 'http://localhost:3000',
        apiKey: 'test-key',
        mode: 'sync',
        onEvent,
        onError,
      });

      const result = await middleware.transformParams!({
        params: {
          prompt: [{ role: 'user', content: 'hello' }],
          providerOptions: { caesura: { conversationId: 'test-prot' } },
        },
      } as any);

      expect(result).toBeDefined();
      expect(onEvent).toHaveBeenCalled();
      expect(onError).toHaveBeenCalled();
      expect(onError.mock.calls[0][0].message).toBe('Logger failure');
    });
  });
});
