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
    const result = await client.analyze(
      { messages: [] },
      { includeCreditUsage: true },
    );

    expect(result.analysis).toEqual({ recommendation: 'try caching' });
    expect(result.creditUsage).toBe(15);

    // Verify header was sent
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/analyze'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-include-credit-usage': 'true',
        }),
      }),
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
    const result1 = await client.analyze(
      { messages: [] },
      { includeCreditUsage: true },
    );
    expect(result1.creditUsage).toBeUndefined();

    const headers2 = new Headers();
    headers2.set('content-type', 'application/json');
    headers2.set('X-Credit-Usage', 'not-a-number');

    fetchMock.mockResolvedValue({
      ok: true,
      headers: headers2,
      json: async () => ({ recommendation: 'try caching' }),
    });

    const result2 = await client.analyze(
      { messages: [] },
      { includeCreditUsage: true },
    );
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

describe('response formats and conversation creation', () => {
  afterEach(() => vi.unstubAllGlobals());
  const client = new CaesuraClient('https://api.caesurao.com/', 'key', 100);

  it.each([
    0,
    false,
    null,
    [],
    ['שלום 😊'],
    { latest_speaker: 'Visitor', emoji: '😊', is_same: false },
  ])('preserves JSON %j', async (value) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(value), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    expect((await client.analyze({ messages: [] })).analysis).toEqual(value);
  });

  it.each(['text/plain', 'application/octet-stream', ''])(
    'accepts plain text with content type %s',
    async (contentType) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response('שלום 😊', {
            headers: { 'content-type': contentType },
          }),
        ),
      );
      expect((await client.analyze({ messages: [] })).analysis).toBe('שלום 😊');
    },
  );

  it('parses unlabelled JSON and keeps explicit text as text', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('false', { headers: { 'content-type': '' } }),
      )
      .mockResolvedValueOnce(
        new Response('false', { headers: { 'content-type': 'text/plain' } }),
      );
    vi.stubGlobal('fetch', fetcher);
    expect((await client.analyze({ messages: [] })).analysis).toBe(false);
    expect((await client.analyze({ messages: [] })).analysis).toBe('false');
  });

  it.each(['application/json', 'application/problem+json'])(
    'rejects malformed advertised JSON: %s',
    async (contentType) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response('broken {', {
            headers: { 'content-type': contentType },
          }),
        ),
      );
      await expect(client.analyze({ messages: [] })).rejects.toThrow();
    },
  );

  it.each([{ isSame: true }, { is_same: false }, { isSame: 'false' }])(
    'extracts only boolean dedup metadata %j',
    async (value) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(value), {
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );
      const result = await client.analyze({ messages: [] });
      expect(result.analysis).toEqual(value);
      const flag = 'isSame' in value ? value.isSame : value.is_same;
      expect(result.isSame).toBe(typeof flag === 'boolean' ? flag : undefined);
    },
  );

  it.each([
    null,
    false,
    { id: 1 },
    { id: '' },
    { id: '  ' },
    { id: 'ok', success: false },
  ])('rejects invalid conversation response %j', async (value) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(value)));
    await expect(client.createConversation()).rejects.toThrow(
      'nonempty string id',
    );
  });

  it('propagates HTTP creation errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('denied', { status: 403 })),
    );
    await expect(client.createConversation()).rejects.toThrow('403: denied');
  });

  it('aborts timed out creation and analysis requests', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            );
          }),
      ),
    );
    await expect(client.createConversation()).rejects.toThrow('aborted');
    await expect(client.analyze({ messages: [] })).rejects.toThrow('aborted');
  });
});
