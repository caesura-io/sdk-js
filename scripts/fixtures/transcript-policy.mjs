/* global Response, ReadableStream, setTimeout, clearTimeout */
import assert from 'node:assert/strict';
import console from 'node:console';
import { createRequire } from 'node:module';
import OpenAI from 'openai';
import { wrapLanguageModel } from 'ai';
import { createCaesura } from '@caesura-io/openai';
import { caesuraMiddleware } from '@caesura-io/ai-sdk';
import { checkParticipantRoles } from './participant-role-contract.mjs';
const major = Number(
  createRequire(import.meta.url)('ai/package.json').version.split('.')[0],
);
const specificationVersion = major === 5 ? 'v2' : major === 6 ? 'v3' : 'v4';
const gate = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function bounded(work) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Transcript operation stalled')),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
for (const api of ['chat', 'responses', 'ai']) {
  for (const stream of [false, true]) {
    for (const mode of ['sync', 'async']) {
      for (const failurePolicy of ['continue', 'throw']) {
        for (const timeout of [true, false]) {
          const entered = gate(),
            blocked = gate();
          let providerCalls = 0,
            analyses = 0;
          const config = {
            conversationId: 'conversation',
            mode,
            failurePolicy,
            timeoutMs: timeout ? 25 : 2000,
            onError: () => {},
            transport: {
              getNextMessageId: async () => 1,
              appendMessages: async (messages) => {
                assert.equal(messages[0].role, 'customer');
                assert.equal(messages[0].speakerIndex, 0);
                entered.resolve();
                if (timeout) await blocked.promise;
              },
              analyze: async (body) => {
                analyses++;
                assert.deepEqual(body.messages, [
                  {
                    speakerRole: 'user',
                    speakerName: 'Customer',
                    speakerIndex: 0,
                    text: 'hello',
                  },
                ]);
                assert.equal(body.transcriptMessageId, timeout ? undefined : 1);
                assert.equal(body.persist, !timeout);
                return { analysis: 'SAME' };
              },
            },
          };
          const call = {
            turn: { id: 'customer-turn', origin: 'customer' },
            dialogue: [{ speakerRole: 'user', speakerIndex: 0, text: 'hello' }],
          };
          let request, engine;
          if (api === 'ai') {
            const middleware = caesuraMiddleware(config);
            engine = middleware.caesura;
            const invoke = async (params) => {
              providerCalls++;
              assert(
                params.prompt.some(
                  (m) => m.role === 'user' && m.content[0]?.text === 'hello',
                ),
              );
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
              middleware,
              model: {
                specificationVersion,
                provider: 'mock',
                modelId: 'mock',
                supportedUrls: {},
                doGenerate: invoke,
                doStream: invoke,
              },
            });
            const params = {
              prompt: [
                { role: 'user', content: [{ type: 'text', text: 'hello' }] },
              ],
              providerOptions: { caesura: call },
            };
            request = () =>
              stream ? model.doStream(params) : model.doGenerate(params);
          } else {
            const base = new OpenAI({
              apiKey: 'unused-mock',
              maxRetries: 0,
              fetch: async (_, init) => {
                providerCalls++;
                const body = JSON.parse(init.body);
                if (api === 'chat')
                  assert(
                    body.messages.some(
                      (m) => m.role === 'user' && m.content === 'hello',
                    ),
                  );
                return stream
                  ? new Response('data: [DONE]\n\n', {
                      headers: { 'content-type': 'text/event-stream' },
                    })
                  : Response.json({ id: 'response', choices: [], output: [] });
              },
            });
            const client = createCaesura(base, config);
            engine = client.caesura;
            request = () =>
              api === 'chat'
                ? client.chat.completions.create(
                    {
                      model: 'mock',
                      messages: [{ role: 'user', content: 'hello' }],
                      stream,
                    },
                    { caesura: call },
                  )
                : client.responses.create(
                    { model: 'mock', input: 'hello', stream },
                    { caesura: call },
                  );
          }
          const result = Promise.resolve(request()).then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          try {
            await bounded(entered.promise);
            const outcome = await bounded(result);
            if (timeout && failurePolicy === 'throw') {
              assert.equal(
                outcome.error?.kind,
                'timeout',
                `${api}/${stream}/${mode}/${failurePolicy}`,
              );
              assert.equal(providerCalls, 0);
              assert.equal(analyses, 0);
            } else {
              assert.equal(outcome.error, undefined);
              assert.equal(providerCalls, 1);
              if (stream) {
                if (api === 'ai')
                  assert.equal(
                    (await outcome.value.stream.getReader().read()).done,
                    true,
                  );
                else for await (const part of outcome.value) void part;
              }
            }
            blocked.resolve();
            await bounded(engine.flush());
            assert.equal(
              providerCalls,
              timeout && failurePolicy === 'throw' ? 0 : 1,
            );
            assert.equal(
              analyses,
              timeout && failurePolicy === 'throw' ? 0 : 1,
            );
          } finally {
            blocked.resolve();
            await engine.shutdown();
          }
        }
      }
    }
  }
}
console.log(
  'Packed transcript policy: strict hosted timeouts prevent generation; continue falls back; customer index 0 reaches analysis across all adapters/modes',
);

for (const api of ['chat', 'responses', 'ai']) {
  for (const mode of ['sync', 'async']) {
    await checkParticipantRoles({
      api,
      mode,
      createClient(config, requests) {
        if (api === 'ai') {
          const middleware = caesuraMiddleware(config);
          const model = wrapLanguageModel({
            middleware,
            model: {
              specificationVersion,
              provider: 'mock',
              modelId: 'mock',
              supportedUrls: {},
              doGenerate: async (params) => {
                requests.push(params.prompt);
                return { content: [] };
              },
            },
          });
          return {
            engine: middleware.caesura,
            call: (prompt, caesura) =>
              model.doGenerate({ prompt, providerOptions: { caesura } }),
          };
        }
        const base = new OpenAI({
          apiKey: 'mock',
          maxRetries: 0,
          fetch: async (_, init) => {
            const body = JSON.parse(init.body);
            requests.push(body.messages ?? body.input);
            return Response.json({ choices: [], output: [] });
          },
        });
        const client = createCaesura(base, config);
        return {
          engine: client.caesura,
          call: (messages, caesura) =>
            api === 'chat'
              ? client.chat.completions.create(
                  { model: 'mock', messages },
                  { caesura },
                )
              : client.responses.create(
                  { model: 'mock', input: messages },
                  { caesura },
                ),
        };
      },
    });
  }
}
console.log(
  'Packed participant roles: defaults, explicit indices/origins, prior guidance and tool/internal continuations passed',
);
