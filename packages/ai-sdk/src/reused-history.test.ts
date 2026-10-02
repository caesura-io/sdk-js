/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryCaesuraStore,
  type AnalyzeRequestBody,
  type CaesuraEvent,
} from '@caesura-io/core';
import { caesuraMiddleware } from './middleware.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const text = (m: any): string =>
  typeof m.content === 'string'
    ? m.content
    : m.content.map((p: any) => p.text ?? '').join('');
const format = (role: string, text: string) => ({
  role,
  content: role === 'system' ? text : [{ type: 'text', text }],
});
function setup(api: string, options: any): (input: any) => Promise<any[]> {
  const middleware = caesuraMiddleware(options);
  return async (prompt) =>
    (
      await middleware.transformParams!({
        type: api as 'generate' | 'stream',
        params: { prompt },
        model: {},
      })
    ).prompt;
}

describe.each(['sync', 'async'] as const)(
  'reused history in %s mode',
  (mode) => {
    describe.each(['generate', 'stream'] as const)('%s', (api) => {
      it.each(['user', 'assistant', 'system', 'developer'] as const)(
        'cleans and reinjects %s guidance once in the default session',
        async (as) => {
          const store = new MemoryCaesuraStore();
          const requests: AnalyzeRequestBody[] = [];
          const events: CaesuraEvent[] = [];
          let creations = 0;
          let release!: () => void;
          vi.stubGlobal(
            'fetch',
            vi.fn(async (url, init) => {
              if (url.endsWith('/api/conversation')) {
                creations++;
                return Response.json({ id: 'backend' });
              }
              requests.push(JSON.parse(init.body));
              if (mode === 'async')
                await new Promise<void>((resolve) => {
                  release = resolve;
                });
              return new Response(`G${requests.length}`, {
                headers: { 'content-type': 'text/plain' },
              });
            }),
          );
          const run = setup(api, {
            apiKey: 'test',
            mode,
            store,
            autoCreateConversation: true,
            speakerNames: { agent: 'Support', customer: 'Visitor' },
            inject: { as, skillPrompt: '', template: '{analysis}' },
            onEvent: (e: CaesuraEvent) => events.push(e),
          });
          let history: any[] = [];
          const dialogue: any[] = [];
          for (let turn = 1; turn <= 4; turn++) {
            const current = format(turn % 2 ? 'user' : 'assistant', 'same');
            dialogue.push(current);
            history.push(current);
            const original = structuredClone(history);
            const forwarded = await run(history);
            if (mode === 'async') {
              await vi.waitFor(() => expect(requests).toHaveLength(turn));
              release();
              await vi.waitFor(() =>
                expect(store.get('default').inFlight).toBe(false),
              );
            }
            expect(history).toEqual(original);
            const visible = mode === 'sync' ? turn : turn - 1;
            expect(forwarded).toEqual(
              dialogue.flatMap((m, i) => [
                m,
                ...(i < visible
                  ? [format(as === 'developer' ? 'system' : as, `G${i + 1}`)]
                  : []),
              ]),
            );
            const injected = events.filter((e) => e.type === 'injected').at(-1);
            if (visible) {
              expect(injected?.type).toBe('injected');
              if (injected?.type === 'injected') {
                expect(injected.blocks.map((b) => b.index)).toEqual(
                  Array.from({ length: visible }, (_, i) => i * 2 + 1),
                );
                expect(
                  injected.blocks.map((b) => text(forwarded[b.index])),
                ).toEqual(
                  Array.from({ length: visible }, (_, i) => `G${i + 1}`),
                );
              }
            }
            expect(requests.at(-1)).toMatchObject({
              conversationId: 'backend',
              sessionId: 'backend',
              persist: true,
              currentUser: 'Support',
            });
            expect(requests.at(-1)!.messages).toEqual(
              dialogue.flatMap((_, i) => [
                {
                  speakerRole: 'user',
                  speakerName: i % 2 ? 'Support' : 'Visitor',
                  speakerIndex: i % 2 ? 0 : 1,
                  text: 'same',
                },
                ...(i < turn - 1
                  ? [
                      {
                        speakerRole: 'assistant',
                        speakerIndex: -1,
                        text: `G${i + 1}`,
                      },
                    ]
                  : []),
              ]),
            );
            history = JSON.parse(JSON.stringify(forwarded));
          }
          expect(creations).toBe(1);
        },
      );
    });
  },
);

it.each(['opposite role', 'named', 'explicit index', 'multimodal'])(
  'keeps real dialogue matching guidance: %s',
  async (scenario) => {
    const requests: AnalyzeRequestBody[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return requests.length === 1
          ? new Response('guidance', {
              headers: { 'content-type': 'text/plain' },
            })
          : Response.json({ isSame: true });
      }),
    );
    const run = setup('generate', {
      apiKey: 'test',
      mode: 'sync',
      inject: { skillPrompt: '', template: '{analysis}' },
    });
    const first = await run([format('user', 'hello')]);
    const current =
      scenario === 'opposite role'
        ? format('assistant', 'guidance')
        : scenario === 'named'
          ? { ...format('user', 'guidance'), name: 'Alan' }
          : scenario === 'explicit index'
            ? { ...format('user', 'guidance'), speakerIndex: 42 }
            : {
                role: 'user',
                content: [
                  { type: 'text', text: 'guidance' },
                  { type: 'image', image: 'fixture' },
                ],
              };
    const result = await run([...first, current]);
    expect(requests[1]!.messages).toEqual([
      {
        speakerRole: 'user',
        speakerName: 'Customer',
        speakerIndex: 1,
        text: 'hello',
      },
      { speakerRole: 'assistant', speakerIndex: -1, text: 'guidance' },
      {
        speakerRole: 'user',
        speakerName:
          scenario === 'named'
            ? 'Alan'
            : scenario === 'opposite role'
              ? 'Agent'
              : 'Customer',
        speakerIndex:
          scenario === 'explicit index'
            ? 42
            : scenario === 'opposite role'
              ? 0
              : 1,
        text: 'guidance',
      },
    ]);
    expect(result).toEqual([...first, current]);
  },
);

it.each(['keepLast=0', 'TTL'] as const)(
  'removes reused guidance when ineligible through %s',
  async (scenario) => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const store = new MemoryCaesuraStore();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ isSame: true })),
    );
    store.add('default', [
      {
        id: 'r',
        analysis: 'guidance',
        afterMessageHash: '',
        createdAtMs: now,
        createdAtTurn: 1,
      },
    ]);
    const run = setup('generate', {
      apiKey: 'test',
      mode: 'sync',
      store,
      inject: { skillPrompt: '', template: '{analysis}' },
    });
    const first = await run([format('user', 'hello')]);
    now = 5000;
    const next = setup('generate', {
      apiKey: 'test',
      mode: 'sync',
      store,
      inject: {
        skillPrompt: '',
        template: '{analysis}',
        ...(scenario === 'keepLast=0'
          ? { keepLast: 0 }
          : { ttl: { type: 'seconds', seconds: 1 } }),
      },
    });
    const history = [...first, format('user', 'next')];
    const original = structuredClone(history);
    expect(await next(history)).toEqual([
      format('user', 'hello'),
      format('user', 'next'),
    ]);
    expect(history).toEqual(original);
    expect(store.get('default').recommendations).toHaveLength(1);
  },
);

it('recognizes older individual and merged renderings after retention changes', async () => {
  const store = new MemoryCaesuraStore();
  const requests: AnalyzeRequestBody[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return requests.length < 3
        ? new Response(requests.length === 1 ? 'first' : 'second', {
            headers: { 'content-type': 'text/plain' },
          })
        : Response.json({ isSame: true });
    }),
  );
  const cfg = {
    apiKey: 'test',
    mode: 'sync',
    store,
    inject: { skillPrompt: '', template: '{analysis}' },
  };
  const run = setup('generate', cfg);
  const original = [format('user', 'hello')];
  const first = (await run(original)).at(-1);
  const merged = (await run(original)).at(-1);
  expect(text(merged)).toBe('first\n\nsecond');
  const next = setup('generate', {
    ...cfg,
    inject: { ...cfg.inject, keepLast: 1 },
  });
  const current = format('user', 'next');
  expect(await next([...original, first, merged, current])).toEqual([
    ...original,
    format('user', 'second'),
    current,
  ]);
  expect(requests.at(-1)!.messages.map((m) => m.text)).toEqual([
    'hello',
    'first',
    'second',
    'next',
  ]);
});

it.each(['generate', 'stream'])(
  'retains one copy of deduped guidance across cadence gaps in %s',
  async (api) => {
    const requests: AnalyzeRequestBody[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return requests.length === 1
          ? new Response('guidance', {
              headers: { 'content-type': 'text/plain' },
            })
          : Response.json({ isSame: true });
      }),
    );
    const run = setup(api, {
      apiKey: 'test',
      mode: 'sync',
      cadence: { everyTurns: 2 },
      inject: { skillPrompt: '', template: '{analysis}' },
    });
    let history: any[] = [];
    for (let turn = 1; turn <= 4; turn++) {
      history.push(format('user', 'same'));
      history = await run(history);
      expect(history).toEqual([
        format('user', 'same'),
        format('user', 'guidance'),
        ...Array.from({ length: turn - 1 }, () => format('user', 'same')),
      ]);
    }
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.map((m) => [m.speakerRole, m.text])).toEqual([
      ['user', 'same'],
      ['assistant', 'guidance'],
      ['user', 'same'],
      ['user', 'same'],
    ]);
  },
);
