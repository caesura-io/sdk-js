/* global Response, ReadableStream */
import console from 'node:console';
import { createRequire } from 'node:module';
import OpenAI from 'openai';
import { wrapLanguageModel } from 'ai';
import { createCaesura } from '@caesura-io/openai';
import { caesuraMiddleware } from '@caesura-io/ai-sdk';
import {
  checkFailurePolicy,
  fallbackCases,
} from './failure-policy-contract.mjs';
const major = Number(
  createRequire(import.meta.url)('ai/package.json').version.split('.')[0],
);
const specificationVersion = major === 5 ? 'v2' : major === 6 ? 'v3' : 'v4';
for (const api of ['chat', 'responses', 'ai'])
  for (const mode of ['sync', 'async'])
    for (const stream of [false, true]) {
      for (const scenario of fallbackCases.filter(
        (s) => s !== 'provider-failure',
      )) {
        await checkFailurePolicy({
          api,
          mode,
          stream,
          scenario,
          createClient(config, requests) {
            let count = 0;
            if (api === 'ai') {
              const middleware = caesuraMiddleware(config);
              const invoke = async (params, streaming) => {
                requests.push(params);
                const response = { id: `reply-${++count}` };
                return streaming
                  ? {
                      response,
                      stream: new ReadableStream({
                        start(c) {
                          c.enqueue({
                            type: 'text-delta',
                            delta: 'Answer',
                            id: 'text',
                          });
                          c.enqueue({
                            type: 'finish',
                            finishReason: 'stop',
                            usage: {},
                          });
                          c.close();
                        },
                      }),
                    }
                  : { response, content: [{ type: 'text', text: 'Answer' }] };
              };
              const model = wrapLanguageModel({
                middleware,
                model: {
                  specificationVersion,
                  provider: 'mock',
                  modelId: 'mock',
                  supportedUrls: {},
                  doGenerate: (p) => invoke(p, false),
                  doStream: (p) => invoke(p, true),
                },
              });
              return {
                engine: middleware.caesura,
                call(text, options, streaming) {
                  const { signal, ...caesura } = options;
                  const params = {
                    prompt: [
                      { role: 'user', content: [{ type: 'text', text }] },
                    ],
                    abortSignal: signal,
                    providerOptions: { caesura },
                  };
                  return streaming
                    ? model.doStream(params)
                    : model.doGenerate(params);
                },
              };
            }
            const provider = new OpenAI({
              apiKey: 'mock',
              maxRetries: 0,
              fetch: async (_, init) => {
                const body = JSON.parse(init.body);
                requests.push(body);
                const id = `reply-${++count}`;
                if (body.stream) {
                  const parts =
                    api === 'chat'
                      ? [
                          {
                            id,
                            choices: [
                              {
                                index: 0,
                                delta: { content: 'Answer' },
                                finish_reason: 'stop',
                              },
                            ],
                          },
                        ]
                      : [
                          {
                            type: 'response.output_text.delta',
                            delta: 'Answer',
                          },
                          { type: 'response.completed', response: { id } },
                        ];
                  return new Response(
                    parts
                      .map((part) => `data: ${JSON.stringify(part)}\n\n`)
                      .join(''),
                    { headers: { 'content-type': 'text/event-stream' } },
                  );
                }
                return Response.json({
                  id,
                  status: 'completed',
                  choices: [{ message: { content: 'Answer' } }],
                  output: [
                    {
                      id,
                      type: 'message',
                      role: 'assistant',
                      content: [{ type: 'output_text', text: 'Answer' }],
                    },
                  ],
                });
              },
            });
            const client = createCaesura(provider, config);
            return {
              engine: client.caesura,
              call(text, options, streaming) {
                const { signal, ...caesura } = options;
                return api === 'chat'
                  ? client.chat.completions.create(
                      {
                        model: 'mock',
                        messages: [{ role: 'user', content: text }],
                        stream: streaming,
                      },
                      { signal, caesura },
                    )
                  : client.responses.create(
                      { model: 'mock', input: text, stream: streaming },
                      { signal, caesura },
                    );
              },
            };
          },
        });
      }
    }
console.log(
  'Packed failure policies: old backend, creation/stateless flow, hosted failures, cancellation, deadlines, strict policy and streaming passed',
);
