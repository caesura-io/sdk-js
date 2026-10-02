/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCaesura } from './wrapper.js';
import { MemoryCaesuraStore } from '@caesura-io/core';

describe('OpenAI proxy wrapper', () => {
  let fetchMock: any;
  let mockOpenAI: any;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    mockOpenAI = {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async () => {
            return {
              choices: [
                { message: { role: 'assistant', content: 'completion text' } },
              ],
            };
          }),
        },
      },
      responses: {
        create: vi.fn().mockImplementation(async () => {
          return {
            id: 'resp_123',
            output: [{ type: 'text', text: 'response text' }],
          };
        }),
      },
      embeddings: {
        create: vi.fn().mockResolvedValue({ data: [] }),
      },
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('transparently passes through non-intercepted methods', async () => {
    const wrapped = createCaesura(mockOpenAI, {
      baseUrl: 'http://localhost:3000',
      apiKey: 'test-key',
    });

    const res = await wrapped.embeddings.create({ input: 'hello' });
    expect(res).toEqual({ data: [] });
    expect(mockOpenAI.embeddings.create).toHaveBeenCalledWith({
      input: 'hello',
    });
  });

  it('intercepts chat.completions.create and injects skill prompt and recommendations', async () => {
    const headers = new Headers();
    headers.set('content-type', 'application/json');
    headers.set('X-Credit-Usage', '12');

    fetchMock.mockResolvedValue({
      ok: true,
      headers,
      json: async () => ({ recommendation: 'try buffering', isSame: false }),
    });

    const events: any[] = [];
    const onEvent = vi.fn((e) => events.push(e));
    const onCreditUsage = vi.fn();

    const store = new MemoryCaesuraStore();
    const wrapped = createCaesura(mockOpenAI, {
      baseUrl: 'http://localhost:3000',
      apiKey: 'test-key',
      mode: 'sync',
      store,
      onEvent,
      onCreditUsage,
      inject: {
        skillPrompt: 'Act naturally.',
      },
    });

    const body = {
      messages: [{ role: 'user', content: 'hello model' }],
    };

    const res = await wrapped.chat.completions.create(body, {
      signal: new AbortController().signal,
      caesura: { conversationId: 'conv-chat' },
    });

    expect(res).toEqual({
      choices: [{ message: { role: 'assistant', content: 'completion text' } }],
    });

    // Verify mock chat completions create was called with modified body
    expect(mockOpenAI.chat.completions.create).toHaveBeenCalledTimes(1);
    const [callBody, callOptions] =
      mockOpenAI.chat.completions.create.mock.calls[0];

    // Check skill prompt and recommendations in messages
    expect(callBody.messages).toHaveLength(3);
    expect(callBody.messages[0]).toEqual({
      role: 'system',
      content: 'Act naturally.',
    });
    expect(callBody.messages[1]).toEqual({
      role: 'user',
      content: 'hello model',
    });
    expect(callBody.messages[2].role).toBe('user');
    expect(callBody.messages[2].content).toContain('try buffering');

    // Check options: caesura stripped, others preserved
    expect(callOptions.signal).toBeDefined();
    expect(callOptions.caesura).toBeUndefined();

    // Check credit usage callback
    expect(onCreditUsage).toHaveBeenCalledTimes(1);
    expect(onCreditUsage.mock.calls[0][0].credits).toBe(12);
    expect(onCreditUsage.mock.calls[0][0].conversationId).toBe('conv-chat');

    // Check event emission
    expect(onEvent).toHaveBeenCalled();
    expect(events.some((e) => e.type === 'injected')).toBe(true);
  });

  it('intercepts responses.create and injects skill prompt/recommendations', async () => {
    const headers = new Headers();
    headers.set('content-type', 'application/json');
    headers.set('X-Credit-Usage', '5');

    fetchMock.mockResolvedValue({
      ok: true,
      headers,
      json: async () => ({ recommendation: 'responses advice', isSame: false }),
    });

    const store = new MemoryCaesuraStore();
    const wrapped = createCaesura(mockOpenAI, {
      baseUrl: 'http://localhost:3000',
      apiKey: 'test-key',
      mode: 'sync',
      store,
      inject: {
        skillPrompt: 'Be concise.',
      },
    });

    const body = {
      model: 'gpt-4o',
      input: 'responses prompt',
      instructions: 'Original instructions.',
    };

    await wrapped.responses.create(body, {
      caesura: { conversationId: 'conv-responses' },
    });

    expect(mockOpenAI.responses.create).toHaveBeenCalledTimes(1);
    const [callBody] = mockOpenAI.responses.create.mock.calls[0];

    // Verify skill prompt was appended to instructions
    expect(callBody.instructions).toBe('Original instructions.\n\nBe concise.');

    // Verify recommendation was injected into input array
    expect(Array.isArray(callBody.input)).toBe(true);
    expect(callBody.input).toHaveLength(2);
    expect(callBody.input[0]).toEqual({
      role: 'user',
      content: 'responses prompt',
    });
    expect(callBody.input[1].role).toBe('user');
    expect(callBody.input[1].content).toContain('responses advice');
  });
});

describe('wrapper review regressions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([false, true])(
    'supports Responses inputs/instructions and preserves streaming=%s',
    async (stream) => {
      const fetcher = vi
        .fn()
        .mockImplementation(() => Promise.resolve(Response.json(false)));
      vi.stubGlobal('fetch', fetcher);
      const output = stream
        ? (async function* () {
            yield { delta: 'hello' };
          })()
        : { output_text: 'hello' };
      const create = vi.fn().mockResolvedValue(output);
      const wrapped = createCaesura({ responses: { create } } as any, {
        apiKey: 'key',
        mode: 'sync',
        inject: { skillPrompt: 'Guidance', as: 'user' },
      });
      for (const instructions of [
        undefined,
        null,
        'Original',
        'Original\n\nGuidance',
      ]) {
        const body = {
          model: 'model',
          stream,
          instructions,
          input: [
            {
              role: 'user',
              content: [{ type: 'input_text', text: 'question' }],
            },
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'answer' }],
            },
          ],
        };
        const before = structuredClone(body);
        expect(await wrapped.responses.create(body)).toBe(output);
        const sent = create.mock.calls.at(-1)![0];
        expect(sent.instructions).toBe(
          instructions?.startsWith('Original')
            ? 'Original\n\nGuidance'
            : 'Guidance',
        );
        expect(sent.input.some((m: any) => m.role === 'system')).toBe(false);
        expect(
          sent.input.some(
            (m: any) =>
              typeof m.content === 'string' && m.content.includes('false'),
          ),
        ).toBe(true);
        expect(body).toEqual(before);
      }
      const messages = JSON.parse(fetcher.mock.calls[0]![1].body).messages;
      expect(messages.map((m: any) => m.text)).toEqual(['question', 'answer']);
      if (stream) {
        const chunks = [];
        for await (const chunk of output as AsyncIterable<unknown>)
          chunks.push(chunk);
        expect(chunks).toEqual([{ delta: 'hello' }]);
      }
    },
  );

  it('exposes creation and preserves original resource receivers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ id: 'backend' })),
    );
    const completions = {
      marker: 'original',
      create: vi.fn(function (this: any) {
        expect(this).toBe(completions);
        return 'ok';
      }),
    };
    const wrapped = createCaesura({ chat: { completions } } as any, {
      apiKey: 'key',
    });
    expect(await wrapped.createConversation({ name: 'Support' })).toBe(
      'backend',
    );
    expect(await wrapped.chat.completions.create({ messages: [] } as any)).toBe(
      'ok',
    );
  });

  it('keeps the model request working when creation and all hooks fail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const fail = () => {
      throw new Error('hook');
    };
    const create = vi.fn().mockResolvedValue('model response');
    const wrapped = createCaesura(
      { chat: { completions: { create } } } as any,
      {
        apiKey: 'key',
        mode: 'sync',
        autoCreateConversation: true,
        onError: fail,
        onEvent: fail,
      },
    );
    await expect(
      wrapped.chat.completions.create({
        messages: [{ role: 'user', content: 'hello' }],
      } as any),
    ).resolves.toBe('model response');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('handles filtered rendered blocks without indexing the wrong recommendation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ isSame: true })),
    );
    const store = new MemoryCaesuraStore();
    store.add('default', [
      {
        id: 'empty',
        analysis: { unknown: 'value' },
        afterMessageHash: '',
        createdAtMs: 0,
        createdAtTurn: 0,
      },
      {
        id: 'visible',
        analysis: { recommendation: 'advice' },
        afterMessageHash: '',
        createdAtMs: 0,
        createdAtTurn: 1,
      },
    ]);
    const create = vi.fn().mockResolvedValue('ok');
    const wrapped = createCaesura(
      { chat: { completions: { create } } } as any,
      {
        apiKey: 'key',
        mode: 'sync',
        store,
        inject: { template: '{analysis.recommendation}' },
      },
    );
    await expect(
      wrapped.chat.completions.create({
        messages: [{ role: 'user', content: 'hi' }],
      } as any),
    ).resolves.toBe('ok');
    expect(
      store.get('default').recommendations[0]?.injectedText,
    ).toBeUndefined();
    expect(store.get('default').recommendations[1]?.injectedText).toBe(
      'advice',
    );
  });
});

describe('OpenAI request lifecycle', () => {
  it.each(['asResponse', 'withResponse', 'await'] as const)(
    'preserves %s with the real OpenAI client',
    async (method) => {
      const { default: OpenAI } = await import('openai');
      const response = new Response(
        JSON.stringify({ id: 'chat-test', choices: [] }),
        {
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'request-test',
          },
        },
      );
      const fetcher = vi.fn().mockResolvedValue(response);
      const original = new OpenAI({ apiKey: 'openai-test', fetch: fetcher });
      const wrapped = createCaesura(original, {
        apiKey: 'caesura-test',
        persist: false,
      });
      const request = wrapped.chat.completions.create({
        model: 'test',
        messages: [],
      });
      if (method === 'asResponse') {
        expect(await request.asResponse()).toBe(response);
        expect(response.bodyUsed).toBe(false);
      } else if (method === 'withResponse') {
        expect(await request.withResponse()).toMatchObject({
          data: { id: 'chat-test' },
          response,
          request_id: 'request-test',
        });
      } else {
        expect(await request).toMatchObject({ id: 'chat-test' });
      }
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
});
