/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect, it, vi } from 'vitest';
import { wrapLanguageModel } from 'ai';
import { createRequire } from 'node:module';
import { caesuraMiddleware } from './middleware.js';
import metadata from '../package.json';
const major = Number(
  createRequire(import.meta.url)('ai/package.json').version.split('.')[0],
);
const specificationVersion = major === 5 ? 'v2' : major === 6 ? 'v3' : 'v4';
const base = (methods: any) =>
  ({
    specificationVersion,
    provider: 'local',
    modelId: 'test',
    supportedUrls: {},
    ...methods,
  }) as any;
const params = (caesura: any = {}) =>
  ({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'yes' }] }],
    providerOptions: { caesura },
  }) as any;
it('rejects missing IDs before analysis and actual provider execution', async () => {
  const analyze = vi.fn();
  const doGenerate = vi.fn();
  const doStream = vi.fn();
  const middleware = caesuraMiddleware({
    transport: { analyze },
    persist: false,
  });
  const model = wrapLanguageModel({
    model: base({ doGenerate, doStream }),
    middleware,
  });
  await expect(model.doGenerate(params())).rejects.toMatchObject({
    kind: 'configuration',
  });
  await expect(model.doStream(params())).rejects.toMatchObject({
    kind: 'configuration',
  });
  expect(analyze).not.toHaveBeenCalled();
  expect(doGenerate).not.toHaveBeenCalled();
  expect(doStream).not.toHaveBeenCalled();
});
it('uses creation identity/provenance in finalized audit and persists messages without analyzing continuations', async () => {
  const events: any[] = [];
  const transcript: any[] = [];
  const contexts: any[] = [];
  const createConversation = vi.fn(async (_, ctx) => {
    contexts.push(ctx);
    return 'created:id';
  });
  const analyze = vi.fn(async (_, ctx) => {
    contexts.push(ctx);
    return { analysis: 'guidance' };
  });
  const middleware = caesuraMiddleware({
    transport: { analyze, createConversation },
    mode: 'sync',
    cadence: { everyTurns: 9 },
    onProviderEvent: (e) => {
      events.push(e);
    },
    persistMessages: async (b) => {
      transcript.push(b);
    },
  });
  const id = await middleware.createConversation();
  const doGenerate = vi.fn(async (p) => {
    const audit = events.findLast((e) => e.type === 'request');
    expect(audit.parameters.prompt).toEqual(p.prompt);
    expect(p.providerOptions).not.toHaveProperty('caesura');
    expect(JSON.stringify(p)).not.toContain('x-caesura-sdk');
    return {
      content: [{ type: 'text', text: 'Reply' }],
      usage: { inputTokens: 3 },
      response: { id: 'response' },
    };
  });
  const model = wrapLanguageModel({ model: base({ doGenerate }), middleware });
  await middleware.caesura.recordMessages(id, [
    { id: 'greeting', role: 'agent', text: 'Welcome' },
  ]);
  for (const turnId of ['1', '2'])
    await model.doGenerate(
      params({ conversationId: id, turn: { id: turnId, origin: 'customer' } }),
    );
  const continuation = params({
    conversationId: id,
    turn: { id: '2', origin: 'internal' },
  });
  continuation.prompt.push(
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 't', toolName: 'lookup', input: {} },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 't',
          toolName: 'lookup',
          output: { type: 'text', value: 'RAG' },
        },
      ],
    },
  );
  await model.doGenerate(continuation);
  expect(analyze).toHaveBeenCalledTimes(1);
  expect(createConversation).toHaveBeenCalledTimes(1);
  expect(
    transcript
      .flatMap((b) => b.messages)
      .filter((m) => m.role === 'customer')
      .map((m) => m.id),
  ).toEqual(['1', '2']);
  expect(
    transcript.flatMap((b) => b.messages).some((m) => m.text.includes('RAG')),
  ).toBe(false);
  for (const event of events) {
    expect(event.correlation.conversationId).toBe(id);
    expect(event.correlation.sdk.integration).toEqual({
      name: metadata.name,
      version: metadata.version,
    });
  }
  for (const ctx of contexts)
    expect(ctx.sdk.integration).toEqual({
      name: metadata.name,
      version: metadata.version,
    });
});
it.each(['completed', 'cancelled', 'failed', 'error-part'] as const)(
  'reports actual AI stream outcome: %s',
  async (outcome) => {
    const events: any[] = [];
    const transcript: any[] = [];
    const cause = new Error('stream failed');
    let reads = 0;
    const middleware = caesuraMiddleware({
      conversationId: 'id',
      transport: { analyze: async () => ({ analysis: 'SAME' }) },
      mode: 'sync',
      onProviderEvent: (e) => {
        events.push(e);
      },
      persistMessages: async (b) => {
        transcript.push(b);
      },
    });
    const source = new ReadableStream(
      {
        pull(c) {
          reads++;
          if (reads === 1)
            c.enqueue({ type: 'text-delta', id: 'text', delta: 'Hello' });
          else if (outcome === 'failed') c.error(cause);
          else {
            c.enqueue(
              outcome === 'error-part'
                ? { type: 'error', error: cause }
                : {
                    type: 'finish',
                    usage: { inputTokens: 5 },
                    finishReason: 'stop',
                  },
            );
            c.close();
          }
        },
      },
      { highWaterMark: 0 },
    );
    const model = wrapLanguageModel({
      model: base({
        doStream: async () => ({
          stream: source,
          response: { id: 'response' },
        }),
      }),
      middleware,
    });
    const result = await model.doStream(params());
    expect(reads).toBe(0);
    expect(
      events.some((e) => e.type === 'response' || e.type === 'stream-end'),
    ).toBe(false);
    const reader = result.stream.getReader();
    await reader.read();
    if (outcome === 'cancelled') await reader.cancel('stop');
    else if (outcome === 'failed')
      await expect(reader.read()).rejects.toBe(cause);
    else {
      await reader.read();
      expect((await reader.read()).done).toBe(true);
    }
    expect(events.find((e) => e.type === 'stream-end').status).toBe(
      outcome === 'error-part' ? 'failed' : outcome,
    );
    const agents = transcript
      .flatMap((b) => b.messages)
      .filter((m) => m.role === 'agent');
    expect(agents).toHaveLength(outcome === 'completed' ? 1 : 0);
    if (outcome === 'completed') {
      expect(agents[0].text).toBe('Hello');
      expect(
        events.find((e) => e.type === 'stream-end').value.terminal.usage
          .inputTokens,
      ).toBe(5);
    }
  },
);
it('propagates strict transcript failures before provider work and during terminal stream reads', async () => {
  for (const role of ['customer', 'agent']) {
    const cause = new Error('persistence failed');
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: 'text-delta', delta: 'reply' });
          c.enqueue({ type: 'finish', finishReason: 'stop' });
          c.close();
        },
      }),
    }));
    const middleware = caesuraMiddleware({
      conversationId: 'id',
      transport: { analyze: async () => ({ analysis: 'SAME' }) },
      failurePolicy: 'throw',
      onError: () => {},
      persistMessages: async (b) => {
        if (b.messages[0]?.role === role) throw cause;
      },
    });
    const model = wrapLanguageModel({ model: base({ doStream }), middleware });
    if (role === 'customer') {
      await expect(model.doStream(params())).rejects.toMatchObject({
        kind: 'store',
        cause,
      });
      expect(doStream).not.toHaveBeenCalled();
    } else {
      const result = await model.doStream(params());
      const reader = result.stream.getReader();
      await reader.read();
      expect((await reader.read()).value.type).toBe('finish');
      await expect(reader.read()).rejects.toMatchObject({
        kind: 'store',
        cause,
      });
    }
  }
});

it('cancelling while a source read is pending never archives partial text as completed', async () => {
  const events: any[] = [];
  const messages: any[] = [];
  let reads = 0;
  const middleware = caesuraMiddleware({
    conversationId: 'id',
    transport: { analyze: async () => ({ analysis: 'SAME' }) },
    onProviderEvent: (e) => {
      events.push(e);
    },
    persistMessages: (b) => {
      messages.push(...b.messages);
    },
  });
  const model = wrapLanguageModel({
    middleware,
    model: base({
      doStream: async () => ({
        stream: new ReadableStream(
          {
            pull(c) {
              reads++;
              if (reads === 1)
                c.enqueue({ type: 'text-delta', delta: 'Partial' });
            },
          },
          { highWaterMark: 0 },
        ),
      }),
    }),
  });
  const result = await model.doStream(params());
  const reader = result.stream.getReader();
  await reader.read();
  const pending = reader.read();
  await vi.waitFor(() => expect(reads).toBe(2));
  await reader.cancel();
  await pending;
  expect(
    events.filter((e) => e.type === 'stream-end').map((e) => e.status),
  ).toEqual(['cancelled']);
  expect(messages.filter((m) => m.role === 'agent')).toEqual([]);
});
