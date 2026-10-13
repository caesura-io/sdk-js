/* global Response, ReadableStream */
import process from 'node:process';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import OpenAI from 'openai';
import { wrapLanguageModel } from 'ai';
import { createCaesura } from '@caesura-io/openai';
import { caesuraMiddleware } from '@caesura-io/ai-sdk';
const require = createRequire(import.meta.url);
const identity = (name) => {
  const json = JSON.parse(
    readFileSync(
      join(dirname(dirname(require.resolve(name))), 'package.json'),
      'utf8',
    ),
  );
  return { name: json.name, version: json.version };
};
const core = identity('@caesura-io/core');
const contexts = [],
  audit = [],
  transcript = [];
const transport = {
  async createConversation(_, context) {
    contexts.push(context);
    return 'application:identity';
  },
  async analyze(_, context) {
    contexts.push(context);
    return { analysis: 'guidance' };
  },
};
const provider = new OpenAI({
  apiKey: 'provider-only',
  maxRetries: 0,
  fetch: async (url, opts) => {
    assert(!JSON.stringify(opts.headers).includes('x-caesura-sdk'));
    const body = JSON.parse(opts.body);
    assert(!JSON.stringify(body).includes('@caesura-io'));
    const chat = String(url).includes('/chat/');
    if (body.stream) {
      const chunks = chat
        ? [
            {
              id: 'reply',
              choices: [{ index: 0, delta: { content: 'Hello' } }],
            },
            {
              id: 'reply',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            },
            { id: 'reply', choices: [], usage: { total_tokens: 8 } },
          ]
        : [
            { type: 'response.output_text.delta', delta: 'Hello' },
            {
              type: 'response.completed',
              response: { id: 'reply', usage: { total_tokens: 8 } },
            },
          ];
      return new Response(
        chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return Response.json(
      chat
        ? {
            id: 'reply',
            choices: [{ message: { role: 'assistant', content: 'Hello' } }],
          }
        : {
            id: 'reply',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Hello' }],
              },
            ],
          },
    );
  },
});
const client = createCaesura(provider, {
  transport,
  mode: 'sync',
  onProviderEvent: (e) => {
    audit.push(e);
  },
  persistMessages: (b) => {
    transcript.push(b);
  },
});
await assert.rejects(
  async () => client.responses.create({ model: 'mock', input: 'yes' }),
  (e) => e.kind === 'configuration',
);
const conversationId = await client.createConversation();
for (const stream of [false, true])
  for (const api of ['chat', 'responses']) {
    const options = {
      caesura: {
        conversationId,
        turn: { id: `${api}-${stream}`, origin: 'customer' },
      },
    };
    const result = await (api === 'chat'
      ? client.chat.completions.create(
          {
            model: 'mock',
            messages: [{ role: 'user', content: 'yes' }],
            stream,
          },
          options,
        )
      : client.responses.create(
          { model: 'mock', input: 'yes', stream },
          options,
        ));
    if (stream)
      for await (const part of result) {
        assert(part);
      }
  }
for (const context of contexts) {
  assert.deepEqual(context.sdk.core, core);
  assert.deepEqual(context.sdk.integration, identity('@caesura-io/openai'));
}
assert.equal(
  audit.filter((e) => e.type === 'stream-end' && e.status === 'completed')
    .length,
  2,
);
assert.equal(
  transcript
    .flatMap((b) => b.messages)
    .filter((m) => m.role === 'agent' && m.text === 'Hello').length,
  4,
);
assert(audit.every((e) => e.correlation.conversationId === conversationId));
const major = Number(require('ai/package.json').version.split('.')[0]);
const middleware = caesuraMiddleware({
  transport,
  mode: 'sync',
  onProviderEvent: (e) => {
    audit.push(e);
  },
  persistMessages: (b) => {
    transcript.push(b);
  },
});
const id = await middleware.createConversation();
const model = wrapLanguageModel({
  middleware,
  model: {
    specificationVersion: major === 5 ? 'v2' : major === 6 ? 'v3' : 'v4',
    provider: 'local',
    modelId: 'test',
    supportedUrls: {},
    async doGenerate(params) {
      assert(!params.providerOptions.caesura);
      return {
        content: [{ type: 'text', text: 'Reply' }],
        usage: { inputTokens: 2 },
      };
    },
    async doStream(params) {
      assert(!params.providerOptions.caesura);
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: 'text-delta', id: 't', delta: 'Reply' });
            c.enqueue({ type: 'finish', usage: { inputTokens: 2 } });
            c.close();
          },
        }),
      };
    },
  },
});
for (const stream of [false, true]) {
  const params = {
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'yes' }] }],
    providerOptions: {
      caesura: {
        conversationId: id,
        turn: { id: `ai-${stream}`, origin: 'customer' },
      },
    },
  };
  const result = await (stream
    ? model.doStream(params)
    : model.doGenerate(params));
  if (stream) {
    const reader = result.stream.getReader();
    while (!(await reader.read()).done) {
      /* native consumption */
    }
  }
}
assert.deepEqual(
  contexts.at(-1).sdk.integration,
  identity('@caesura-io/ai-sdk'),
);
assert.deepEqual(contexts.at(-1).sdk.core, core);
assert.equal(audit.at(-1).type, 'stream-end');
assert.equal(
  transcript
    .flatMap((b) => b.messages)
    .filter((m) => m.role === 'agent' && m.text === 'Reply').length,
  2,
);
process.stdout.write(
  'Packed authoritative creation, provenance versions, transcripts and terminal stream audit passed.\n',
);
