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
            return { choices: [{ message: { role: 'assistant', content: 'completion text' } }] };
          }),
        },
      },
      responses: {
        create: vi.fn().mockImplementation(async () => {
          return { id: 'resp_123', output: [{ type: 'text', text: 'response text' }] };
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
    expect(mockOpenAI.embeddings.create).toHaveBeenCalledWith({ input: 'hello' });
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

    expect(res).toEqual({ choices: [{ message: { role: 'assistant', content: 'completion text' } }] });

    // Verify mock chat completions create was called with modified body
    expect(mockOpenAI.chat.completions.create).toHaveBeenCalledTimes(1);
    const [callBody, callOptions] = mockOpenAI.chat.completions.create.mock.calls[0];

    // Check skill prompt and recommendations in messages
    expect(callBody.messages).toHaveLength(3);
    expect(callBody.messages[0]).toEqual({ role: 'system', content: 'Act naturally.' });
    expect(callBody.messages[1]).toEqual({ role: 'user', content: 'hello model' });
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
    expect(events.some(e => e.type === 'injected')).toBe(true);
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
    expect(callBody.input[0]).toEqual({ role: 'user', content: 'responses prompt' });
    expect(callBody.input[1].role).toBe('user');
    expect(callBody.input[1].content).toContain('responses advice');
  });
});
