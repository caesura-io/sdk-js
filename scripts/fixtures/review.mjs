/* global URL, Response, ReadableStream */
import assert from 'node:assert/strict';
import process from 'node:process';
import { createRequire } from 'node:module';
import OpenAI from 'openai';
import { wrapLanguageModel } from 'ai';
import { createCaesura } from '@caesura-io/openai';
import { caesuraMiddleware } from '@caesura-io/ai-sdk';
const require = createRequire(import.meta.url);
const major = Number(require('ai/package.json').version.split('.')[0]);
const specificationVersion = major === 5 ? 'v2' : major === 6 ? 'v3' : 'v4';
for (const streaming of [false, true]) {
  const requests = [],
    events = [],
    analyzed = [];
  const image = new URL('https://example.test/image.png'),
    file = new URL('https://example.test/document.pdf');
  const middleware = caesuraMiddleware({
    conversationId: 'id',
    mode: 'sync',
    transport: {
      async analyze(body) {
        analyzed.push(body);
        return { analysis: 'guidance' };
      },
    },
    onProviderEvent(e) {
      events.push(e);
    },
  });
  const model = wrapLanguageModel({
    middleware,
    model: {
      specificationVersion,
      provider: 'local',
      modelId: 'test',
      supportedUrls: {},
      async doGenerate(params) {
        requests.push(params);
        return { content: [] };
      },
      async doStream(params) {
        requests.push(params);
        return {
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: 'finish', finishReason: 'stop' });
              c.close();
            },
          }),
        };
      },
    },
  });
  const params = {
    prompt: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this.' },
          { type: 'image', image },
          { type: 'file', data: file, mediaType: 'application/pdf' },
        ],
      },
    ],
  };
  const result = await (streaming
    ? model.doStream(params)
    : model.doGenerate(params));
  if (streaming) {
    const reader = result.stream.getReader();
    while (!(await reader.read()).done) {
      /* drain */
    }
  }
  const sent = requests[0].prompt.find(
    (m) => m.role === 'user' && m.content.length === 3,
  ).content;
  assert(sent[1].image instanceof URL);
  assert.equal(sent[1].image.href, image.href);
  assert(sent[2].data instanceof URL);
  assert.equal(sent[2].data.href, file.href);
  assert.equal(params.prompt.length, 1);
  assert.equal(params.prompt[0].content[1].image, image);
  assert.deepEqual(
    analyzed[0].messages.map((m) => m.text),
    ['Describe this.'],
  );
  const audit = events
    .find((e) => e.type === 'request')
    .parameters.prompt.find((m) => m.content?.length === 3).content;
  assert.equal(audit[1].image.href, image.href);
  sent[1].image.pathname = '/mutated';
  assert.equal(image.pathname, '/image.png');
  assert.equal(audit[1].image.pathname, '/image.png');
}
for (const api of ['chat', 'responses'])
  for (const complete of [false, true]) {
    const events = [],
      messages = [];
    const chunks =
      api === 'chat'
        ? [
            {
              id: 'reply',
              choices: [
                {
                  index: 0,
                  delta: { content: 'unfinished sentence' },
                  finish_reason: null,
                },
              ],
            },
          ]
        : [
            {
              type: 'response.output_text.delta',
              delta: 'unfinished sentence',
            },
          ];
    if (complete) {
      chunks.push(
        api === 'chat'
          ? {
              id: 'reply',
              choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
            }
          : { type: 'response.completed', response: { id: 'reply' } },
      );
      if (api === 'chat')
        chunks.push({ id: 'reply', choices: [], usage: { total_tokens: 9 } });
    }
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
      transport: {
        async analyze() {
          return { analysis: 'SAME' };
        },
      },
      onProviderEvent(e) {
        events.push(e);
      },
      persistMessages(b) {
        messages.push(...b.messages);
      },
    });
    const stream = await (api === 'chat'
      ? client.chat.completions.create({
          model: 'test',
          messages: [],
          stream: true,
        })
      : client.responses.create({ model: 'test', input: [], stream: true }));
    const actual = [];
    for await (const chunk of stream) actual.push(chunk);
    assert.deepEqual(actual, chunks);
    const terminal = events.find((e) => e.type === 'stream-end');
    assert.equal(terminal.status, complete ? 'completed' : 'incomplete');
    assert.equal(
      messages.filter((m) => m.role === 'agent').length,
      complete ? 1 : 0,
    );
    if (complete && api === 'chat') {
      assert.equal(terminal.value.finishReason, 'length');
      assert.equal(terminal.value.usage.total_tokens, 9);
    }
  }
for (const finish of [false, true]) {
  const events = [],
    messages = [];
  const middleware = caesuraMiddleware({
    conversationId: 'id',
    transport: {
      async analyze() {
        return { analysis: 'SAME' };
      },
    },
    onProviderEvent(e) {
      events.push(e);
    },
    persistMessages(b) {
      messages.push(...b.messages);
    },
  });
  const model = wrapLanguageModel({
    middleware,
    model: {
      specificationVersion,
      provider: 'local',
      modelId: 'test',
      supportedUrls: {},
      async doStream() {
        return {
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: 'text-delta', delta: 'partial' });
              if (finish)
                c.enqueue({
                  type: 'finish',
                  finishReason: 'length',
                  usage: { totalTokens: 9 },
                });
              c.close();
            },
          }),
        };
      },
    },
  });
  const result = await model.doStream({ prompt: [] });
  const reader = result.stream.getReader();
  while (!(await reader.read()).done) {
    /* drain */
  }
  assert.equal(
    events.find((e) => e.type === 'stream-end').status,
    finish ? 'completed' : 'incomplete',
  );
  assert.equal(
    messages.filter((m) => m.role === 'agent').length,
    finish ? 1 : 0,
  );
}
process.stdout.write(
  'Packed native URL inputs and protocol-terminal stream regressions passed.\n',
);
