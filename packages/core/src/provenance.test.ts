import { afterEach, expect, it, vi } from 'vitest';
import { createCaesuraEngine } from './engine.js';
import { sdkHeaders } from './provenance.js';
import core from '../package.json';
import openai from '../../openai/package.json';
import ai from '../../ai-sdk/package.json';
afterEach(() => vi.unstubAllGlobals());
it.each([undefined, openai, ai])(
  'locks exact SDK headers for creation and analysis: $name',
  async (integration) => {
    const requests: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return Response.json(
          url.endsWith('/conversation') ? { id: 'opaque:id' } : 'guidance',
        );
      }),
    );
    const engine = createCaesuraEngine(
      { apiKey: 'secret', mode: 'sync' },
      integration,
    );
    const conversationId = await engine.createConversation(
      {},
      { metadata: { private: 'not-on-wire' } },
    );
    await engine.observe(
      conversationId,
      [{ speakerRole: 'user', text: 'Hello' }],
      { metadata: { private: 'not-on-wire' } },
    );
    expect(requests.map((r) => r.url)).toEqual([
      'https://api.caesurao.com/api/conversation',
      'https://api.caesurao.com/api/analyze',
    ]);
    const expected = {
      'x-caesura-sdk-language': 'javascript',
      'x-caesura-sdk-core-name': core.name,
      'x-caesura-sdk-core-version': core.version,
      'x-caesura-sdk-transport': 'http',
      'x-caesura-sdk-runtime-name': 'node',
      'x-caesura-sdk-runtime-version': process.versions.node,
      ...(integration
        ? {
            'x-caesura-sdk-integration-name': integration.name,
            'x-caesura-sdk-integration-version': integration.version,
          }
        : {}),
    };
    for (const { init } of requests) {
      expect(
        Object.fromEntries(
          [...new Headers(init.headers)].filter(([key]) =>
            key.startsWith('x-caesura-'),
          ),
        ),
      ).toEqual(expected);
      expect(init.body).not.toContain('not-on-wire');
    }
  },
);
it('omits optional provenance without adding alternate header aliases', () => {
  expect(
    sdkHeaders({
      language: 'javascript',
      core: { name: core.name, version: core.version },
      transport: 'http',
    }),
  ).toEqual({
    'x-caesura-sdk-language': 'javascript',
    'x-caesura-sdk-core-name': core.name,
    'x-caesura-sdk-core-version': core.version,
    'x-caesura-sdk-transport': 'http',
  });
});
