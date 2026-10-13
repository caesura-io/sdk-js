/* global Response, ReadableStream, structuredClone, AbortController, console */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import OpenAI from 'openai';
import { wrapLanguageModel } from 'ai';
import { createCaesura } from '@caesura-io/openai';
import { caesuraMiddleware } from '@caesura-io/ai-sdk';
import { MemoryCaesuraStore } from '@caesura-io/core';
const require = createRequire(import.meta.url);
const aiMajor = Number(
  JSON.parse(
    readFileSync(require.resolve('ai/package.json'), 'utf8'),
  ).version.split('.')[0],
);
const makeStore = () => {
  const rows = new Map();
  return {
    async get(id) {
      return rows.has(id)
        ? JSON.parse(rows.get(id))
        : new MemoryCaesuraStore().get(id);
    },
    async set(id, state) {
      rows.set(id, JSON.stringify(state));
    },
    async clear(id) {
      rows.delete(id);
    },
    async clearAll() {
      rows.clear();
    },
  };
};
for (const mode of ['sync', 'async']) {
  for (const stream of [false, true]) {
    const audits = [],
      analyses = [],
      wire = [],
      completed = [];
    const transport = {
      async analyze(input, context) {
        analyses.push({ input: structuredClone(input), context });
        return {
          analysis:
            analyses.length === 1
              ? { recommendation: 'guidance', full: { retained: true } }
              : 'SAME',
          usage: { tokens: 7 },
          requestId: 'analysis-id',
        };
      },
    };
    const base = new OpenAI({
      apiKey: 'provider-only-test',
      maxRetries: 0,
      fetch: async (url, options) => {
        const body = JSON.parse(options.body);
        wire.push(body);
        const chat = String(url).includes('chat/completions');
        if (body.stream)
          return new Response(
            `data: ${JSON.stringify(chat ? { id: 'c', choices: [], usage: { total_tokens: 8 } } : { type: 'response.completed', response: { id: 'r', usage: { total_tokens: 8 } } })}\n\ndata: [DONE]\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          );
        return Response.json(
          chat
            ? { id: 'c', choices: [], usage: { total_tokens: 8 } }
            : { id: 'r', output: [], usage: { total_tokens: 8 } },
        );
      },
    });
    const client = createCaesura(base, {
      conversationId: 'fixture-conversation',
      transport,
      store: makeStore(),
      mode,
      failurePolicy: 'throw',
      inject: { skillPrompt: '', template: '{analysis}' },
      onProviderEvent: (e) => audits.push(e),
      persistAnalysis: async (record) => {
        completed.push(record);
      },
    });
    const history = [{ role: 'user', content: 'yes' }];
    for (const [api, id, continuation] of [
      ['responses', 'a', false],
      ['chat', 'a', true],
      ['responses', 'b', false],
    ]) {
      const input = continuation
        ? [
            ...history,
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 't',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{}' },
                },
              ],
            },
            { role: 'tool', tool_call_id: 't', content: 'RAG' },
          ]
        : history;
      const options = {
        caesura: {
          conversationId: 'one',
          turn: { id, origin: 'customer' },
          metadata: { traceId: 'private' },
        },
      };
      const request =
        api === 'chat'
          ? client.chat.completions.create(
              { model: 'test', messages: input, stream },
              options,
            )
          : client.responses.create({ model: 'test', input, stream }, options);
      const response = await request.withResponse();
      if (stream) {
        for await (const chunk of response.data) assert.ok(chunk);
      } else assert.equal(response.data.usage.total_tokens, 8);
      await client.caesura.flush();
      assert.deepEqual(
        audits.filter((e) => e.type === 'request').at(-1).parameters,
        wire.at(-1),
      );
      assert.equal(JSON.stringify(wire.at(-1)).includes('traceId'), false);
    }
    assert.equal(analyses.length, 2);
    assert.equal(completed.length, 2);
    assert.equal(completed[0].result.usage.tokens, 7);
    assert.match(JSON.stringify(wire[1]), /guidance/);
    assert.equal(
      (await client.caesura.getState('one')).recommendations.length,
      1,
    );
    await client.responses.create({
      model: 'test',
      input: [{ role: 'assistant', content: 'greeting' }],
    });
    await client.caesura.flush();
    assert.equal(analyses.length, 2);
    await client.caesura.shutdown();

    const order = [],
      captured = [],
      sent = [];
    const middleware = caesuraMiddleware({
      conversationId: 'fixture-conversation',
      transport,
      store: makeStore(),
      mode: 'sync',
      onProviderEvent: (e) => {
        captured.push(e);
        if (e.type === 'request') order.push('prepared');
      },
      inject: { skillPrompt: '' },
    });
    // New first result for this independent conversation.
    analyses.length = 0;
    const native = {
      specificationVersion: aiMajor === 5 ? 'v2' : aiMajor === 6 ? 'v3' : 'v4',
      provider: 'test',
      modelId: 'test',
      supportedUrls: {},
      async doGenerate(params) {
        sent.push(params);
        order.push('provider');
        return { usage: { totalTokens: 8 }, marker: 'native' };
      },
      async doStream(params) {
        sent.push(params);
        order.push('provider');
        return {
          response: { id: 'native' },
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: 'finish', usage: { totalTokens: 8 } });
              c.close();
            },
          }),
        };
      },
    };
    const inner = wrapLanguageModel({
      model: native,
      middleware: {
        specificationVersion: native.specificationVersion,
        wrapGenerate: async ({ params, doGenerate }) => {
          order.push('inner audit');
          assert.match(JSON.stringify(params.prompt), /guidance/);
          return doGenerate();
        },
        wrapStream: async ({ params, doStream }) => {
          order.push('inner audit');
          assert.match(JSON.stringify(params.prompt), /guidance/);
          return doStream();
        },
      },
    });
    const model = wrapLanguageModel({ model: inner, middleware });
    const params = {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'yes' }] }],
      providerOptions: { caesura: { turn: { id: 'a', origin: 'customer' } } },
      tools: [{ type: 'function', name: 'lookup', inputSchema: {} }],
    };
    if (stream) {
      const result = await model.doStream(params);
      for await (const part of result.stream)
        assert.equal(part.usage.totalTokens, 8);
    } else assert.equal((await model.doGenerate(params)).marker, 'native');
    assert.deepEqual(order, ['prepared', 'inner audit', 'provider']);
    assert.deepEqual(captured[0].parameters.prompt, sent[0].prompt);
    assert.deepEqual(captured[0].parameters.tools, params.tools);
    assert.equal(sent[0].providerOptions.caesura, undefined);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      model.doGenerate({ ...params, abortSignal: controller.signal }),
    );
    await middleware.caesura.shutdown();
  }
}

console.log(
  'Packed local transports, detached stores, audit ordering, continuations, and cancellation passed.',
);
