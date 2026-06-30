/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CaesuraClient } from './client.js';

describe('CaesuraClient', () => {
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
