import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CaesuraClient } from './client.js';
import { caesuraMiddleware } from './middleware.js';
import { MemoryCaesuraStore } from './store.js';

describe('CaesuraClient integration', () => {
  let fetchMock: any;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses valid X-Credit-Usage header', async () => {
    const headers = new Headers();
    headers.set('content-type', 'application/json');
    headers.set('X-Credit-Usage', '15');

    fetchMock.mockResolvedValue({
      ok: true,
      headers,
      json: async () => ({ recommendation: 'try caching' }),
    });

    const client = new CaesuraClient('http://localhost:3000', 'apikey', 5000);
    const result = await client.analyze({ messages: [] }, { includeCreditUsage: true });

    expect(result.analysis).toEqual({ recommendation: 'try caching' });
    expect(result.creditUsage).toBe(15);

    // Verify header was sent
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/analyze'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-include-credit-usage': 'true',
        }),
      })
    );
  });

  it('handles missing or malformed X-Credit-Usage header gracefully', async () => {
    const headers1 = new Headers();
    headers1.set('content-type', 'application/json');
    // missing header

    fetchMock.mockResolvedValue({
      ok: true,
      headers: headers1,
      json: async () => ({ recommendation: 'try caching' }),
    });

    const client = new CaesuraClient('http://localhost:3000', 'apikey', 5000);
    const result1 = await client.analyze({ messages: [] }, { includeCreditUsage: true });
    expect(result1.creditUsage).toBeUndefined();

    const headers2 = new Headers();
    headers2.set('content-type', 'application/json');
    headers2.set('X-Credit-Usage', 'not-a-number');

    fetchMock.mockResolvedValue({
      ok: true,
      headers: headers2,
      json: async () => ({ recommendation: 'try caching' }),
    });

    const result2 = await client.analyze({ messages: [] }, { includeCreditUsage: true });
    expect(result2.creditUsage).toBeUndefined();
  });

  it('does not send x-include-credit-usage header when includeCreditUsage is false', async () => {
    const headers = new Headers();
    headers.set('content-type', 'application/json');

    fetchMock.mockResolvedValue({
      ok: true,
      headers,
      json: async () => ({ recommendation: 'try caching' }),
    });

    const client = new CaesuraClient('http://localhost:3000', 'apikey', 5000);
    await client.analyze({ messages: [] }, { includeCreditUsage: false });

    const fetchHeaders = fetchMock.mock.calls[0][1].headers;
    expect(fetchHeaders['x-include-credit-usage']).toBeUndefined();
  });
});

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
});
