/* global Response, ReadableStream, setTimeout, structuredClone */
import process from 'node:process';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import OpenAI from 'openai';
import { wrapLanguageModel } from 'ai';
import { createCaesura } from '@caesura-io/openai';
import { caesuraMiddleware } from '@caesura-io/ai-sdk';
import { MemoryCaesuraStore } from '@caesura-io/core';
const require = createRequire(import.meta.url);
for (const name of ['core', 'openai', 'ai-sdk']) {
  assert.ok(Object.keys(require(`@caesura-io/${name}`)).length > 0);
  assert.ok(Object.keys(await import(`@caesura-io/${name}`)).length > 0);
}
const settle = async (store) => {
  for (let i = 0; i < 100 && store.get('one').inFlight; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(store.get('one').inFlight, false);
};
const backend = [];
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), 'https://api.caesurao.com/api/analyze');
  backend.push(JSON.parse(init.body));
  return Response.json(backend.length === 1 ? 'advice' : { isSame: true });
};
const dialogue = (index) => ({
  speakerRole: 'user',
  speakerName: index % 2 ? 'Marilyn SDR' : 'Alan',
  speakerIndex: index % 2 ? 0 : 1,
  text: 'same 😊',
});
const advice = { speakerRole: 'assistant', speakerIndex: -1, text: 'advice' };
const config = (store, mode) => ({
  apiKey: 'test',
  store,
  mode,
  conversationId: 'one',
  persist: true,
  speakerNames: { agent: 'Marilyn SDR', customer: 'Alan' },
  inject: { skillPrompt: '', template: '{analysis}' },
});
function checkBackend(turn) {
  const request = backend.at(-1);
  assert.equal(request.persist, true);
  assert.equal(request.currentUser, 'Marilyn SDR');
  assert.equal(request.conversationId, 'one');
  const expected = Array.from({ length: turn }, (_, i) => dialogue(i));
  if (turn > 1) expected.splice(1, 0, advice);
  assert.deepEqual(request.messages, expected);
}
for (const mode of ['sync', 'async']) {
  for (const api of ['chat', 'responses', 'switch']) {
    for (const stream of [false, true]) {
      backend.length = 0;
      const store = new MemoryCaesuraStore();
      const sent = [];
      const original = new OpenAI({
        apiKey: 'test',
        maxRetries: 0,
        fetch: async (url, init) => {
          const body = JSON.parse(init.body);
          sent.push(body);
          const chat = String(url).includes('/chat/completions');
          if (body.stream) {
            const event = chat
              ? {
                  id: 'chat',
                  object: 'chat.completion.chunk',
                  choices: [
                    { index: 0, delta: { content: 'ok' }, finish_reason: null },
                  ],
                }
              : {
                  type: 'response.output_text.delta',
                  delta: 'ok',
                  output_index: 0,
                  content_index: 0,
                  item_id: 'msg',
                  sequence_number: 1,
                };
            return new Response(
              `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`,
              { headers: { 'content-type': 'text/event-stream' } },
            );
          }
          return Response.json(
            chat
              ? {
                  id: 'chat',
                  object: 'chat.completion',
                  choices: [
                    {
                      index: 0,
                      message: { role: 'assistant', content: 'ok' },
                      finish_reason: 'stop',
                    },
                  ],
                }
              : {
                  id: 'response',
                  object: 'response',
                  output: [
                    {
                      type: 'message',
                      id: 'msg',
                      role: 'assistant',
                      status: 'completed',
                      content: [
                        { type: 'output_text', text: 'ok', annotations: [] },
                      ],
                    },
                  ],
                },
          );
        },
      });
      const client = createCaesura(original, config(store, mode));
      const history = [];
      for (let turn = 1; turn <= 4; turn++) {
        history.push({
          role: turn % 2 ? 'user' : 'assistant',
          content: 'same 😊',
        });
        const snapshot = structuredClone(history);
        const responses =
          api === 'responses' || (api === 'switch' && turn % 2 === 1);
        const call = responses
          ? client.responses.create({ model: 'test', input: history, stream })
          : client.chat.completions.create({
              model: 'test',
              messages: history,
              stream,
            });
        const { data } = await call.withResponse();
        if (stream) {
          let chunks = 0;
          for await (const chunk of data) {
            assert.ok(chunk);
            chunks++;
          }
          assert.equal(chunks, 1);
        }
        await settle(store);
        checkBackend(turn);
        assert.deepEqual(history, snapshot);
        assert.deepEqual(
          (sent.at(-1).input ?? sent.at(-1).messages).filter(
            (m) => m.content === 'same 😊',
          ),
          history,
        );
        assert.equal(store.get('one').recommendations.length, 1);
      }
    }
  }
}
// Exercise the real AI SDK middleware dispatcher, not just transformParams.
const aiMajor = Number(
  JSON.parse(
    readFileSync(require.resolve('ai/package.json'), 'utf8'),
  ).version.split('.')[0],
);
for (const mode of ['sync', 'async']) {
  for (const stream of [false, true]) {
    backend.length = 0;
    const store = new MemoryCaesuraStore();
    const sent = [];
    const model = wrapLanguageModel({
      middleware: caesuraMiddleware(config(store, mode)),
      model: {
        specificationVersion:
          aiMajor === 5 ? 'v2' : aiMajor === 6 ? 'v3' : 'v4',
        provider: 'test',
        modelId: 'test',
        supportedUrls: {},
        doGenerate: async (params) => {
          sent.push(params);
          return { marker: 'generated' };
        },
        doStream: async (params) => {
          sent.push(params);
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({
                  type: 'text-delta',
                  id: '1',
                  delta: 'ok',
                });
                controller.close();
              },
            }),
          };
        },
      },
    });
    const prompt = [];
    for (let turn = 1; turn <= 4; turn++) {
      prompt.push({
        role: turn % 2 ? 'user' : 'assistant',
        content: [
          { type: 'text', text: 'same ' },
          { type: 'text', text: '😊' },
        ],
      });
      const snapshot = structuredClone(prompt);
      if (stream) {
        const result = await model.doStream({ prompt });
        const chunks = [];
        for await (const chunk of result.stream) chunks.push(chunk);
        assert.equal(chunks[0].delta, 'ok');
      } else
        assert.equal((await model.doGenerate({ prompt })).marker, 'generated');
      await settle(store);
      checkBackend(turn);
      assert.deepEqual(prompt, snapshot);
      assert.deepEqual(
        sent
          .at(-1)
          .prompt.filter(
            (m) => Array.isArray(m.content) && m.content.length === 2,
          ),
        prompt,
      );
    }
  }
}
process.stdout.write(
  'Packed ESM/CJS imports, OpenAI APIs/streaming/background, and AI SDK wrapLanguageModel passed.\n',
);
