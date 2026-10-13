/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect, it, vi } from 'vitest';
import { createCaesura } from './wrapper.js';
import metadata from '../package.json';

const native = (provider: any) =>
  ({
    chat: { completions: { create: provider } },
    responses: { create: provider },
  }) as any;
const call = (client: any, api: string, options: any = {}, stream = false) =>
  api === 'chat'
    ? client.chat.completions.create(
        {
          model: 'local',
          messages: [{ role: 'user', content: 'yes' }],
          stream,
        },
        { caesura: options },
      )
    : client.responses.create(
        { model: 'local', input: 'yes', stream },
        { caesura: options },
      );
it.each(['chat', 'responses'])(
  '%s requires an ID before provider/transport work',
  async (api) => {
    const analyze = vi.fn();
    const provider = vi.fn();
    const client = createCaesura(native(provider), {
      transport: { analyze },
      persist: false,
    });
    await expect(call(client, api)).rejects.toMatchObject({
      kind: 'configuration',
    });
    expect(analyze).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  },
);
it.each(['sync', 'async'] as const)(
  'shares the created identity between both APIs in %s mode; transcripts are independent of cadence',
  async (mode) => {
    const audits: any[] = [];
    const transcript: any[] = [];
    const contexts: any[] = [];
    const provider = vi.fn(async () => ({
      id: 'response-id',
      choices: [{ message: { content: 'Reply' } }],
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Reply' }],
        },
      ],
      usage: { total_tokens: 3 },
    }));
    const createConversation = vi.fn(async (_options, ctx) => {
      contexts.push(ctx);
      return 'authoritative:α';
    });
    const analyze = vi.fn(async (_body, ctx) => {
      contexts.push(ctx);
      return { analysis: 'guidance' };
    });
    const client = createCaesura(native(provider), {
      transport: { analyze, createConversation },
      mode,
      cadence: { everyTurns: 10 },
      inject: { skillPrompt: '' },
      persistMessages: async (batch) => {
        transcript.push(batch);
      },
      onProviderEvent: (event) => {
        audits.push(event);
      },
    });
    const conversationId = await client.createConversation({ name: 'General' });
    await client.caesura.recordMessages(conversationId, [
      { id: 'greeting', role: 'agent', text: 'Welcome' },
    ]);
    for (const [i, api] of ['chat', 'responses', 'chat'].entries())
      await call(client, api, {
        conversationId,
        turn: { id: `c${i}`, origin: 'customer' },
        metadata: { privateTrace: 'private' },
      });
    await client.caesura.flush();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(transcript.flatMap((b) => b.messages).map((m) => m.role)).toEqual([
      'agent',
      'customer',
      'agent',
      'customer',
      'agent',
      'customer',
      'agent',
    ]);
    for (const event of audits) {
      expect(event.correlation.conversationId).toBe(conversationId);
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
    for (const [body, opts] of provider.mock.calls as unknown as any[]) {
      expect(JSON.stringify(body)).not.toContain('privateTrace');
      expect(JSON.stringify(body)).not.toContain('sdk');
      expect(opts).not.toHaveProperty('caesura');
    }
    expect(await client.caesura.flush()).toEqual([]);
  },
);
it.each(['chat', 'responses'])(
  '%s observes stream completion, early return and errors without archiving partial output',
  async (api) => {
    for (const outcome of ['completed', 'cancelled', 'failed']) {
      const audits: any[] = [];
      const transcript: any[] = [];
      let reads = 0;
      const error = new Error('iteration failed');
      const provider = vi.fn(async () => ({
        async *[Symbol.asyncIterator]() {
          reads++;
          yield api === 'chat'
            ? { id: 'reply', choices: [{ delta: { content: 'Hello' } }] }
            : { type: 'response.output_text.delta', delta: 'Hello' };
          if (outcome === 'failed') throw error;
          if (api === 'chat')
            yield {
              id: 'reply',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            };
          yield api === 'chat'
            ? { id: 'reply', usage: { total_tokens: 7 }, choices: [] }
            : {
                type: 'response.completed',
                response: { id: 'reply', usage: { total_tokens: 7 } },
              };
        },
      }));
      const client = createCaesura(native(provider), {
        conversationId: 'id',
        transport: { analyze: async () => ({ analysis: 'SAME' }) },
        mode: 'sync',
        persistMessages: async (b) => {
          transcript.push(b);
        },
        onProviderEvent: (e) => {
          audits.push(e);
        },
      });
      const stream = await call(
        client,
        api,
        { turn: { id: outcome, origin: 'customer' } },
        true,
      );
      expect(reads).toBe(0);
      expect(audits.filter((e) => e.type === 'stream-end')).toHaveLength(0);
      const consume = async () => {
        for await (const part of stream) {
          expect(part).toBeDefined();
          if (outcome === 'cancelled') break;
        }
      };
      if (outcome === 'failed') await expect(consume()).rejects.toBe(error);
      else await consume();
      expect(audits.find((e) => e.type === 'stream-end').status).toBe(outcome);
      const agents = transcript
        .flatMap((b) => b.messages)
        .filter((m) => m.role === 'agent');
      expect(agents).toHaveLength(outcome === 'completed' ? 1 : 0);
      if (outcome === 'completed') {
        expect(agents[0]).toMatchObject({ id: 'reply', text: 'Hello' });
        expect(
          audits.find((e) => e.type === 'stream-end').value.usage.total_tokens,
        ).toBe(7);
      }
    }
  },
);
it('required transcript failures block provider invocation and completed-response delivery in strict mode', async () => {
  for (const failingRole of ['customer', 'agent']) {
    const provider = vi.fn(async () => ({
      choices: [{ message: { content: 'reply' } }],
    }));
    const cause = new Error('write failed');
    const client = createCaesura(native(provider), {
      conversationId: 'id',
      transport: { analyze: async () => ({ analysis: 'SAME' }) },
      mode: 'sync',
      failurePolicy: 'throw',
      onError: () => {},
      persistMessages: async (b) => {
        if (b.messages[0]?.role === failingRole) throw cause;
      },
    });
    await expect(call(client, 'chat')).rejects.toMatchObject({
      kind: 'store',
      cause,
    });
    expect(provider).toHaveBeenCalledTimes(failingRole === 'customer' ? 0 : 1);
  }
});

it('observes native OpenAI stream controller cancellation without archiving partial text', async () => {
  const events: any[] = [];
  const messages: any[] = [];
  const controller = new AbortController();
  const provider = vi.fn(async () => ({
    controller,
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ index: 0, delta: { content: 'Partial' } }] };
      if (controller.signal.aborted) return;
      yield { choices: [] };
    },
  }));
  const client = createCaesura(native(provider), {
    conversationId: 'id',
    transport: { analyze: async () => ({ analysis: 'SAME' }) },
    onProviderEvent: (e) => {
      events.push(e);
    },
    persistMessages: (b) => {
      messages.push(...b.messages);
    },
  });
  const stream = await call(client, 'chat', {}, true);
  for await (const part of stream) {
    expect(part).toBeDefined();
    stream.controller.abort();
  }
  expect(events.find((e) => e.type === 'stream-end').status).toBe('cancelled');
  expect(messages.filter((m) => m.role === 'agent')).toEqual([]);
});

it.each([false, true])(
  'retains Responses output-message IDs in completed transcripts; streaming=%s',
  async (stream) => {
    const messages: any[] = [];
    const response = {
      id: 'response-id',
      status: 'completed',
      output: [
        {
          id: 'message-id',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Complete reply' }],
        },
      ],
    };
    const provider = vi.fn(async () =>
      stream
        ? {
            async *[Symbol.asyncIterator]() {
              yield { type: 'response.completed', response };
            },
          }
        : response,
    );
    const client = createCaesura(native(provider), {
      conversationId: 'id',
      transport: { analyze: async () => ({ analysis: 'SAME' }) },
      persistMessages: (b) => {
        messages.push(...b.messages);
      },
    });
    const result = await call(client, 'responses', {}, stream);
    if (stream)
      for await (const part of result)
        expect(part.type).toBe('response.completed');
    expect(messages.filter((m) => m.role === 'agent')).toEqual([
      {
        id: 'message-id',
        role: 'agent',
        text: 'Complete reply',
        speakerName: 'Agent',
        speakerIndex: 0,
      },
    ]);
  },
);
