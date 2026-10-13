/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { createCaesura } from './wrapper.js';

const delta = {
  id: 'reply',
  choices: [
    {
      index: 0,
      delta: { content: 'unfinished sentence' },
      finish_reason: null,
    },
  ],
};
it.each([undefined, 'stop', 'length', 'other-choice'])(
  'real OpenAI SSE requires the primary choice finish marker: %s',
  async (finish) => {
    const events: any[] = [],
      messages: any[] = [];
    const chunks: any[] = [delta];
    if (finish) {
      chunks.push({
        id: 'reply',
        choices: [
          {
            index: finish === 'other-choice' ? 1 : 0,
            delta: {},
            finish_reason: finish === 'other-choice' ? 'stop' : finish,
          },
        ],
      });
      chunks.push({ id: 'reply', choices: [], usage: { total_tokens: 19 } });
    }
    const native = new OpenAI({
      apiKey: 'mock-provider-key',
      maxRetries: 0,
      fetch: async () =>
        new Response(
          chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    });
    const client = createCaesura(native, {
      conversationId: 'authoritative',
      transport: { analyze: async () => ({ analysis: 'SAME' }) },
      mode: 'sync',
      onProviderEvent: (event) => {
        events.push(event);
      },
      persistMessages: (batch) => {
        messages.push(...batch.messages);
      },
    });
    const stream = await client.chat.completions.create({
      model: 'mock',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });
    expect(events.some((e) => e.type === 'stream-end')).toBe(false);
    const actual = [];
    for await (const chunk of stream) actual.push(chunk);
    expect(actual).toEqual(chunks);
    const terminal = events.find((e) => e.type === 'stream-end');
    const completed = finish === 'stop' || finish === 'length';
    expect(terminal.status).toBe(completed ? 'completed' : 'incomplete');
    expect(terminal.correlation.conversationId).toBe('authoritative');
    expect(messages.filter((m) => m.role === 'agent')).toHaveLength(
      completed ? 1 : 0,
    );
    if (completed) {
      expect(terminal.value.finishReason).toBe(finish);
      expect(terminal.value.usage).toEqual({ total_tokens: 19 });
    }
  },
);
it.each([
  'response.completed',
  'response.failed',
  'response.incomplete',
  'eof',
])('requires successful Responses completion: %s', async (outcome) => {
  const events: any[] = [],
    messages: any[] = [];
  const chunks: any[] = [
    { type: 'response.output_text.delta', delta: 'partial' },
  ];
  if (outcome !== 'eof')
    chunks.push({
      type: outcome,
      response: {
        id: 'reply',
        usage: { total_tokens: 3 },
        error: outcome === 'response.failed' ? { code: 'failed' } : null,
      },
    });
  const native = new OpenAI({
    apiKey: 'mock',
    maxRetries: 0,
    fetch: async () =>
      new Response(
        chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  const client = createCaesura(native, {
    conversationId: 'id',
    transport: { analyze: async () => ({ analysis: 'SAME' }) },
    onProviderEvent: (e) => {
      events.push(e);
    },
    persistMessages: (b) => {
      messages.push(...b.messages);
    },
  });
  const stream = await client.responses.create({
    model: 'mock',
    input: 'hello',
    stream: true,
  });
  const actual = [];
  for await (const part of stream) actual.push(part);
  expect(actual).toEqual(chunks);
  expect(events.find((e) => e.type === 'stream-end').status).toBe(
    outcome === 'response.completed'
      ? 'completed'
      : outcome === 'response.failed'
        ? 'failed'
        : 'incomplete',
  );
  expect(messages.filter((m) => m.role === 'agent')).toHaveLength(
    outcome === 'response.completed' ? 1 : 0,
  );
});
it('keeps iteration errors after a finish marker and never persists a failed stream', async () => {
  const cause = new Error('connection broke after finish');
  const events: any[] = [],
    messages: any[] = [];
  const create = vi.fn(async () => ({
    async *[Symbol.asyncIterator]() {
      yield delta;
      yield { choices: [{ index: 0, finish_reason: 'stop', delta: {} }] };
      throw cause;
    },
  }));
  const client = createCaesura({ chat: { completions: { create } } } as any, {
    conversationId: 'id',
    transport: { analyze: async () => ({ analysis: 'SAME' }) },
    onProviderEvent: (e) => {
      events.push(e);
    },
    persistMessages: (b) => {
      messages.push(...b.messages);
    },
  });
  const stream = await client.chat.completions.create({
    model: 'mock',
    messages: [],
    stream: true,
  });
  await expect(
    (async () => {
      for await (const part of stream) expect(part).toBeDefined();
    })(),
  ).rejects.toBe(cause);
  expect(events.find((e) => e.type === 'stream-end').status).toBe('failed');
  expect(events.find((e) => e.type === 'error').error.cause).toBe(cause);
  expect(messages.filter((m) => m.role === 'agent')).toEqual([]);
});
