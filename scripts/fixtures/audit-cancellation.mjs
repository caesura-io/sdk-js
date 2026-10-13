/* global AbortController, ReadableStream, Response, setTimeout, clearTimeout */
import assert from 'node:assert/strict';
import console from 'node:console';
import { createRequire } from 'node:module';
import OpenAI from 'openai';
import { wrapLanguageModel } from 'ai';
import { createCaesura } from '@caesura-io/openai';
import { caesuraMiddleware } from '@caesura-io/ai-sdk';
const major = Number(
  createRequire(import.meta.url)('ai/package.json').version.split('.')[0],
);
const specificationVersion = major === 5 ? 'v2' : major === 6 ? 'v3' : 'v4';
const gate = () => {
  let resolve, reject;
  const promise = new Promise((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
};
const bounded = async (promise) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('audit did not settle')),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
for (const api of ['chat', 'responses', 'ai']) {
  for (const stream of [false, true]) {
    for (const cancel of [false, true]) {
      const entered = gate(),
        blocked = gate(),
        controller = new AbortController();
      let providerCalls = 0;
      const config = {
        conversationId: 'authoritative',
        mode: 'sync',
        transport: {
          async analyze() {
            return { analysis: 'effective guidance' };
          },
        },
        async persistProviderRequest(event, context) {
          assert.equal(event.correlation.conversationId, 'authoritative');
          assert(
            JSON.stringify(event.parameters).includes('effective guidance'),
          );
          assert.equal(event.signal, undefined);
          assert.equal(event.parameters.abortSignal, undefined);
          assert.equal(context.signal.aborted, false);
          entered.resolve();
          await blocked.promise;
        },
      };
      let request;
      if (api === 'ai') {
        const invoke = async () => {
          providerCalls++;
          return stream
            ? {
                stream: new ReadableStream({
                  start(c) {
                    c.close();
                  },
                }),
              }
            : { content: [] };
        };
        const model = wrapLanguageModel({
          middleware: caesuraMiddleware(config),
          model: {
            specificationVersion,
            provider: 'test',
            modelId: 'test',
            supportedUrls: {},
            doGenerate: invoke,
            doStream: invoke,
          },
        });
        const params = {
          abortSignal: controller.signal,
          prompt: [
            { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          ],
        };
        request = () =>
          stream ? model.doStream(params) : model.doGenerate(params);
      } else {
        const base = new OpenAI({
          apiKey: 'unused-mock',
          maxRetries: 0,
          fetch: async () => {
            providerCalls++;
            return stream
              ? new Response('data: [DONE]\n\n', {
                  headers: { 'Content-Type': 'text/event-stream' },
                })
              : new Response(
                  JSON.stringify({ id: 'response', output: [], choices: [] }),
                  { headers: { 'Content-Type': 'application/json' } },
                );
          },
        });
        const client = createCaesura(base, config);
        request = () =>
          api === 'chat'
            ? client.chat.completions.create(
                {
                  model: 'test',
                  messages: [{ role: 'user', content: 'hello' }],
                  stream,
                },
                { signal: controller.signal },
              )
            : client.responses.create(
                { model: 'test', input: 'hello', stream },
                { signal: controller.signal },
              );
      }
      const result = Promise.resolve(request()).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await bounded(entered.promise);
        assert.equal(providerCalls, 0);
        if (cancel) controller.abort();
        else blocked.resolve();
        const outcome = await bounded(result);
        if (cancel) assert.equal(outcome.error?.kind, 'cancelled');
        else assert.equal(outcome.error, undefined);
        assert.equal(providerCalls, cancel ? 0 : 1);
        // A late rejecting application write cannot resume a cancelled provider call.
        if (cancel) blocked.reject(new Error('late audit rejection'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(providerCalls, cancel ? 0 : 1);
      } finally {
        blocked.resolve();
      }
    }
  }
}
console.log(
  'Packed audit cancellation: real OpenAI Chat/Responses and AI generate/stream passed',
);
