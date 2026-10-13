/* global Response, ReadableStream, setTimeout, structuredClone, URL */
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
const settle = async (store, engine) => {
  await engine.flush();
  for (let i = 0; i < 100 && store.get('one').inFlight; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(store.get('one').inFlight, false);
};
const backend = [];
const saved = new Map();
let counterReads = 0;
const resetBackend = () => {
  backend.length = 0;
  saved.clear();
  counterReads = 0;
};
globalThis.fetch = async (url, init) => {
  const target = new URL(url);
  assert.equal(target.origin, 'https://api.caesurao.com');
  if (target.pathname === '/api/conversation/messages' && !init.body) {
    assert.equal(target.searchParams.get('conversationId'), 'one');
    counterReads++;
    return Response.json({
      success: true,
      conversationId: 'one',
      nextMessageId: 1,
    });
  }
  const body = JSON.parse(init.body);
  assert.equal(body.conversationId, 'one');
  if (target.pathname === '/api/conversation/messages') {
    for (const message of body.messages) {
      assert(Number.isInteger(message.id) && message.id > 0);
      if (saved.has(message.id))
        assert.deepEqual(saved.get(message.id), message);
      else saved.set(message.id, message);
    }
    return Response.json({ success: true, ...body });
  }
  assert.equal(target.pathname, '/api/analyze');
  assert.equal(saved.get(body.transcriptMessageId)?.role, 'user');
  assert.equal(saved.get(body.transcriptMessageId)?.text, 'same 😊');
  backend.push(body);
  return Response.json(backend.length === 1 ? 'advice' : { isSame: true });
};
const dialogue = (agent = false) => ({
  speakerRole: 'user',
  speakerName: agent ? 'Marilyn SDR' : 'Alan',
  speakerIndex: agent ? 0 : 1,
  text: agent ? 'ok' : 'same 😊',
});
const advice = { speakerRole: 'assistant', speakerIndex: -1, text: 'advice' };
const config = (store, mode) => ({
  apiKey: 'test',
  store,
  mode,
  conversationId: 'one',
  persist: true,
  failurePolicy: 'throw',
  speakerNames: { agent: 'Marilyn SDR', customer: 'Alan' },
  inject: { skillPrompt: '', template: '{analysis}' },
});
function checkBackend(turn) {
  const request = backend.at(-1);
  assert.equal(request.persist, true);
  assert.equal(request.currentUser, 'Marilyn SDR');
  assert.equal(request.conversationId, 'one');
  assert.equal(backend.length, turn);
  assert.equal(request.transcriptMessageId, turn * 2 - 1);
  assert.equal(counterReads, 1);
  assert.deepEqual(
    [...saved.values()].map(({ id, role, text }) => ({ id, role, text })),
    Array.from({ length: turn * 2 }, (_, i) => ({
      id: i + 1,
      role: i % 2 ? 'assistant' : 'user',
      text: i % 2 ? 'ok' : 'same 😊',
    })),
  );
  const expected = Array.from({ length: turn * 2 - 1 }, (_, i) =>
    dialogue(i % 2 === 1),
  );
  if (turn > 1) expected.splice(1, 0, advice);
  assert.deepEqual(request.messages, expected);
}
for (const mode of ['sync', 'async']) {
  for (const api of ['chat', 'responses', 'switch']) {
    for (const stream of [false, true]) {
      resetBackend();
      const store = new MemoryCaesuraStore();
      const sent = [];
      const original = new OpenAI({
        apiKey: 'test',
        maxRetries: 0,
        fetch: async (url, init) => {
          const body = JSON.parse(init.body);
          sent.push(body);
          const chat = String(url).includes('/chat/completions');
          const replyId = `reply-${sent.length}`;
          if (body.stream) {
            const event = chat
              ? {
                  id: replyId,
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
                  item_id: replyId,
                  sequence_number: 1,
                };
            const terminal = chat
              ? {
                  id: replyId,
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                }
              : { type: 'response.completed', response: { id: replyId } };
            return new Response(
              [event, terminal]
                .map((part) => `data: ${JSON.stringify(part)}\n\n`)
                .join('') + 'data: [DONE]\n\n',
              { headers: { 'content-type': 'text/event-stream' } },
            );
          }
          return Response.json(
            chat
              ? {
                  id: replyId,
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
                  id: replyId,
                  object: 'response',
                  output: [
                    {
                      type: 'message',
                      id: replyId,
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
          role: 'user',
          content: 'same 😊',
        });
        const snapshot = structuredClone(history);
        const responses =
          api === 'responses' || (api === 'switch' && turn % 2 === 1);
        const call = responses
          ? client.responses.create(
              { model: 'test', input: history, stream },
              { caesura: { turn: { id: String(turn), origin: 'customer' } } },
            )
          : client.chat.completions.create(
              {
                model: 'test',
                messages: history,
                stream,
              },
              { caesura: { turn: { id: String(turn), origin: 'customer' } } },
            );
        const { data } = await call.withResponse();
        if (stream) {
          let chunks = 0;
          for await (const chunk of data) {
            assert.ok(chunk);
            chunks++;
          }
          assert.equal(chunks, 2);
        }
        await settle(store, client.caesura);
        checkBackend(turn);
        assert.deepEqual(history, snapshot);
        assert.deepEqual(
          (sent.at(-1).input ?? sent.at(-1).messages).filter(
            (m) => m.content === 'same 😊' || m.content === 'ok',
          ),
          history,
        );
        assert.equal(store.get('one').recommendations.length, 1);
        history.push({ role: 'assistant', content: 'ok' });
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
    resetBackend();
    const store = new MemoryCaesuraStore();
    const sent = [];
    const middleware = caesuraMiddleware(config(store, mode));
    const model = wrapLanguageModel({
      middleware,
      model: {
        specificationVersion:
          aiMajor === 5 ? 'v2' : aiMajor === 6 ? 'v3' : 'v4',
        provider: 'test',
        modelId: 'test',
        supportedUrls: {},
        doGenerate: async (params) => {
          sent.push(params);
          return {
            marker: 'generated',
            content: [{ type: 'text', text: 'ok' }],
            response: { id: `reply-${sent.length}` },
          };
        },
        doStream: async (params) => {
          sent.push(params);
          return {
            response: { id: `reply-${sent.length}` },
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({
                  type: 'text-delta',
                  id: '1',
                  delta: 'ok',
                });
                controller.enqueue({
                  type: 'finish',
                  finishReason: 'stop',
                  usage: {},
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
        role: 'user',
        content: [
          { type: 'text', text: 'same ' },
          { type: 'text', text: '😊' },
        ],
      });
      const snapshot = structuredClone(prompt);
      if (stream) {
        const result = await model.doStream({
          prompt,
          providerOptions: {
            caesura: { turn: { id: String(turn), origin: 'customer' } },
          },
        });
        const chunks = [];
        for await (const chunk of result.stream) chunks.push(chunk);
        assert.equal(chunks[0].delta, 'ok');
      } else
        assert.equal(
          (
            await model.doGenerate({
              prompt,
              providerOptions: {
                caesura: { turn: { id: String(turn), origin: 'customer' } },
              },
            })
          ).marker,
          'generated',
        );
      await settle(store, middleware.caesura);
      checkBackend(turn);
      assert.deepEqual(prompt, snapshot);
      assert.deepEqual(
        sent
          .at(-1)
          .prompt.filter(
            (m) =>
              Array.isArray(m.content) &&
              (m.content.length === 2 || m.content[0]?.text === 'ok'),
          ),
        prompt,
      );
      prompt.push({
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
      });
    }
  }
}
process.stdout.write(
  'Packed ESM/CJS imports, OpenAI APIs/streaming/background, and AI SDK wrapLanguageModel passed.\n',
);

await import('./lifecycle.mjs');
