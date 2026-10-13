/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect, it, vi } from 'vitest';
import { createCaesura } from './wrapper.js';
import { MemoryCaesuraStore, type ProviderAuditEvent } from '@caesura-io/core';

it.each(['chat', 'responses'] as const)(
  'prepares %s requests, keeps native metadata, and skips continuations',
  async (api) => {
    const sent: any[] = [];
    const audits: ProviderAuditEvent[] = [];
    const native = { id: 'response', usage: { total_tokens: 12 } };
    const provider = vi.fn((body, options) => {
      sent.push({ body: structuredClone(body), options });
      return Object.assign(Promise.resolve(native), {
        withResponse: async () => ({
          data: native,
          request_id: 'native-id',
          response: new Response(''),
        }),
        asResponse: async () => new Response(''),
      });
    });
    const analyze = vi.fn(async () => ({
      analysis: 'guidance',
      usage: { tokens: 2 },
    }));
    const client = createCaesura(
      {
        chat: { completions: { create: provider } },
        responses: { create: provider },
      } as any,
      {
        conversationId: 'fixture-conversation',
        transport: { analyze },
        mode: 'sync',
        onProviderEvent: (event) => {
          audits.push(event);
        },
        inject: { skillPrompt: '', template: '{analysis}' },
      },
    );
    const messages: any[] = [{ role: 'user', content: 'yes' }];
    const call = (id: string, body: any = messages) =>
      api === 'chat'
        ? client.chat.completions.create(
            {
              model: 'test',
              messages: body,
              tools: [{ type: 'function', function: { name: 'lookup' } }],
            },
            {
              caesura: {
                turn: { id, origin: 'customer' },
                metadata: { trace: 'private' },
              },
              headers: { authorization: 'secret' },
            },
          )
        : client.responses.create(
            { model: 'test', input: body, instructions: 'original' },
            {
              caesura: {
                turn: { id, origin: 'customer' },
                metadata: { trace: 'private' },
              },
              headers: { authorization: 'secret' },
            },
          );
    const response = await call('a').withResponse();
    expect(response.data).toBe(native);
    expect(response.request_id).toBe('native-id');
    const request = audits.find((e) => e.type === 'request') as any;
    expect(request.parameters).toEqual(sent[0].body);
    expect(request.analysisIds).toHaveLength(1);
    expect(JSON.stringify(request)).not.toContain('secret');
    expect(sent[0].options).not.toHaveProperty('caesura');
    expect(sent[0].options.headers.authorization).toBe('secret');
    messages[0].content = 'mutation';
    expect(JSON.stringify(request.parameters)).toContain('yes');
    if (api === 'chat') {
      const continuation = [
        { role: 'user', content: 'yes' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'tool',
              type: 'function',
              function: { name: 'lookup', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'tool', content: 'RAG' },
      ];
      await call('a', continuation);
      const final = sent.at(-1).body.messages;
      expect(final.findIndex((m: any) => m.role === 'tool')).toBe(
        final.findIndex((m: any) => m.tool_calls) + 1,
      );
    } else
      await call('a', [
        { role: 'user', content: 'yes' },
        { type: 'function_call_output', call_id: 'tool', output: 'RAG' },
      ]);
    expect(analyze).toHaveBeenCalledOnce();
    await call('b', [{ role: 'user', content: 'yes' }]);
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(
      audits.some(
        (e) =>
          e.type === 'response' && (e.value as any).usage.total_tokens === 12,
      ),
    ).toBe(true);
  },
);

it.each(['sync', 'async'] as const)(
  'handles %s cancellation and strict required persistence before provider invocation',
  async (mode) => {
    const provider = vi.fn(async () => ({ id: 'model' }));
    const transport = {
      analyze: vi.fn(
        async (_input, context) =>
          new Promise((_resolve, reject) =>
            context.signal.addEventListener('abort', () =>
              reject(context.signal.reason),
            ),
          ),
      ),
    };
    const client = createCaesura(
      { chat: { completions: { create: provider } } } as any,
      {
        conversationId: 'fixture-conversation',
        transport,
        mode,
        failurePolicy: 'throw',
        onError: () => {},
      },
    );
    const ctrl = new AbortController();
    const call = client.chat.completions.create(
      { model: 'test', messages: [{ role: 'user', content: 'yes' }] },
      {
        signal: ctrl.signal,
        caesura: { turn: { id: 'a', origin: 'customer' } },
      },
    );
    const result = Promise.resolve(call).catch((error) => error);
    await vi.waitFor(() => expect(transport.analyze).toHaveBeenCalledOnce());
    ctrl.abort();
    if (mode === 'sync') {
      expect(await result).toMatchObject({ kind: 'cancelled' });
      expect(provider).not.toHaveBeenCalled();
    } else {
      await result;
      expect((await client.caesura.flush())[0]?.status).toBe('cancelled');
    }
    const strict = createCaesura(
      { chat: { completions: { create: provider } } } as any,
      {
        conversationId: 'fixture-conversation',
        transport: { analyze: async () => ({ analysis: 'ok' }) },
        mode: 'sync',
        failurePolicy: 'throw',
        persistAnalysis: async () => {
          throw new Error('DB down');
        },
        onError: () => {},
      },
    );
    provider.mockClear();
    await expect(
      strict.chat.completions.create({
        model: 'test',
        messages: [{ role: 'user', content: 'yes' }],
      }),
    ).rejects.toMatchObject({ kind: 'store' });
    expect(provider).not.toHaveBeenCalled();
  },
);

it('persists injection tracking with detached values and supports API switching and SAME', async () => {
  const memory = new MemoryCaesuraStore();
  const store = {
    async get(id: string) {
      return structuredClone(memory.get(id));
    },
    async set(id: string, state: any) {
      memory.set(id, structuredClone(state));
    },
    async clear(id: string) {
      memory.clear(id);
    },
    async clearAll() {
      memory.clearAll();
    },
  };
  const analyze = vi
    .fn()
    .mockResolvedValueOnce({ analysis: { advice: 'first', full: 42 } })
    .mockResolvedValue({ analysis: 'SAME' });
  const provider = vi.fn(async () => ({ id: 'ok' }));
  const client = createCaesura(
    {
      chat: { completions: { create: provider } },
      responses: { create: provider },
    } as any,
    {
      conversationId: 'fixture-conversation',
      store,
      transport: { analyze },
      mode: 'sync',
      inject: { skillPrompt: '' },
    },
  );
  await client.responses.create(
    { model: 'test', input: 'yes' },
    { caesura: { turn: { id: 'a', origin: 'customer' } } },
  );
  const original = provider.mock.calls[0][0].input;
  const history = [...original, { role: 'user', content: 'yes' }];
  await client.chat.completions.create(
    { model: 'test', messages: history },
    { caesura: { turn: { id: 'b', origin: 'customer' } } },
  );
  expect(analyze.mock.calls[1][0].messages.map((m: any) => m.text)).toEqual([
    'yes',
    '{"advice":"first","full":42}',
    'yes',
  ]);
  expect(memory.get('fixture-conversation').recommendations).toHaveLength(1);
  expect(memory.get('fixture-conversation').injectedMessages).toHaveLength(1);
  expect(JSON.stringify(provider.mock.calls[1][0])).not.toContain('SAME');
});

it.each(['chat', 'responses'] as const)(
  'anchors selected evidence around RAG in %s and protects a new customer echo',
  async (api) => {
    const inputs: any[] = [],
      sent: any[] = [];
    const create = vi.fn(async (body) => {
      sent.push(body);
      return {};
    });
    const client = createCaesura(
      { chat: { completions: { create } }, responses: { create } } as any,
      {
        conversationId: 'fixture-conversation',
        transport: {
          async analyze(body) {
            inputs.push(body);
            return { analysis: inputs.length === 1 ? 'yes' : 'next' };
          },
        },
        mode: 'sync',
        inject: { skillPrompt: 'Private instructions', template: '{analysis}' },
      },
    );
    const call = async (history: any[], id: string, positions: number[]) => {
      const options = {
        caesura: {
          turn: { id, origin: 'customer' as const },
          dialoguePositions: positions,
        },
      };
      if (api === 'chat')
        await client.chat.completions.create(
          { model: 'test', messages: history },
          options,
        );
      else
        await client.responses.create(
          { model: 'test', input: history },
          options,
        );
    };
    const first = [
      { role: 'user', content: 'RAG context' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'yes' },
    ];
    await call(first, 'a', [1, 2]);
    const second = [
      ...first,
      { role: 'assistant', content: 'Follow-up' },
      { role: 'user', content: 'more RAG' },
      { role: 'user', content: 'yes' },
    ];
    await call(second, 'b', [1, 2, 3, 5]);
    expect(
      inputs[1].messages.map((m: any) => [m.speakerIndex, m.text]),
    ).toEqual([
      [0, 'Hello'],
      [1, 'yes'],
      [-1, 'yes'],
      [0, 'Follow-up'],
      [1, 'yes'],
    ]);
    const forwarded = (
      api === 'chat' ? sent[1].messages : sent[1].input
    ).filter((m: any) => m.role !== 'system');
    expect(forwarded.map((m: any) => m.content)).toEqual([
      'RAG context',
      'Hello',
      'yes',
      'yes',
      'Follow-up',
      'more RAG',
      'yes',
      'next',
    ]);
    expect(second).toHaveLength(6);
  },
);

it('awaits required provider-request persistence and fails strictly before the native call', async () => {
  const create = vi.fn(async () => ({ usage: {} }));
  const persistProviderRequest = vi.fn(async (event) => {
    expect(event.parameters.messages).toEqual(
      expect.arrayContaining([{ role: 'user', content: 'yes' }]),
    );
    throw new Error('audit store unavailable');
  });
  const client = createCaesura({ chat: { completions: { create } } } as any, {
    conversationId: 'fixture-conversation',
    transport: { analyze: async () => ({ analysis: 'guidance' }) },
    mode: 'sync',
    failurePolicy: 'throw',
    persistProviderRequest,
    onError: () => {},
  });
  await expect(
    client.chat.completions.create({
      model: 'test',
      messages: [{ role: 'user', content: 'yes' }],
    }),
  ).rejects.toMatchObject({ kind: 'store' });
  expect(create).not.toHaveBeenCalled();
  expect(persistProviderRequest).toHaveBeenCalledOnce();
});

it('a retry of an older customer event cannot inject guidance from a later event', async () => {
  const create = vi.fn(async () => ({}));
  let count = 0;
  const client = createCaesura({ chat: { completions: { create } } } as any, {
    conversationId: 'fixture-conversation',
    transport: { analyze: async () => ({ analysis: `guidance-${++count}` }) },
    mode: 'sync',
    inject: { skillPrompt: '', template: '{analysis}' },
  });
  const first = [{ role: 'user' as const, content: 'one' }];
  const second = [...first, { role: 'user' as const, content: 'two' }];
  const call = (messages: typeof first, id: string) =>
    client.chat.completions.create(
      { model: 'test', messages },
      { caesura: { turn: { id, origin: 'customer' } } },
    );
  await call(first, 'a');
  await call(second, 'b');
  await call(first, 'a');
  expect(count).toBe(2);
  expect(create.mock.calls[2][0].messages).toEqual([
    ...first,
    { role: 'user', content: 'guidance-1' },
  ]);
});
