/* eslint-disable @typescript-eslint/no-explicit-any */
import { it } from 'vitest';
import { createCaesura } from './wrapper.js';
import {
  checkFailurePolicy,
  fallbackCases,
} from '../../../scripts/fixtures/failure-policy-contract.mjs';
for (const api of ['chat', 'responses'])
  for (const mode of ['sync', 'async'])
    for (const stream of [false, true]) {
      it.each(fallbackCases)(
        `${api}/${mode}/stream=${stream} fallback %s`,
        async (scenario) => {
          await checkFailurePolicy({
            api,
            mode,
            stream,
            scenario,
            createClient(
              config: any,
              requests: any[],
              providerFailure: boolean,
            ) {
              let count = 0;
              const invoke = async (body: any) => {
                requests.push(body);
                if (providerFailure) throw new Error('native provider failure');
                const id = `reply-${++count}`;
                if (body.stream)
                  return {
                    async *[Symbol.asyncIterator]() {
                      if (api === 'chat')
                        yield {
                          id,
                          choices: [
                            {
                              index: 0,
                              delta: { content: 'Answer' },
                              finish_reason: 'stop',
                            },
                          ],
                        };
                      else {
                        yield {
                          type: 'response.output_text.delta',
                          delta: 'Answer',
                        };
                        yield { type: 'response.completed', response: { id } };
                      }
                    },
                  };
                return {
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
                };
              };
              const client = createCaesura(
                {
                  chat: { completions: { create: invoke } },
                  responses: { create: invoke },
                } as any,
                config,
              );
              return {
                engine: client.caesura,
                call(text: string, options: any, streaming: boolean) {
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
        },
      );
    }
