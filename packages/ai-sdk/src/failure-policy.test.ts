/* eslint-disable @typescript-eslint/no-explicit-any */
import { it } from 'vitest';
import { createRequire } from 'node:module';
import { wrapLanguageModel } from 'ai';
import { caesuraMiddleware } from './middleware.js';
import {
  checkFailurePolicy,
  fallbackCases,
} from '../../../scripts/fixtures/failure-policy-contract.mjs';
const major = Number(
  createRequire(import.meta.url)('ai/package.json').version.split('.')[0],
);
const specificationVersion = major === 5 ? 'v2' : major === 6 ? 'v3' : 'v4';
for (const mode of ['sync', 'async'])
  for (const stream of [false, true]) {
    it.each(fallbackCases)(
      `AI/${mode}/stream=${stream} fallback %s`,
      async (scenario) => {
        await checkFailurePolicy({
          api: 'ai',
          mode,
          stream,
          scenario,
          createClient(config: any, requests: any[], providerFailure: boolean) {
            const middleware = caesuraMiddleware(config);
            let count = 0;
            const invoke = async (params: any, streaming: boolean) => {
              requests.push(params);
              if (providerFailure) throw new Error('native provider failure');
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
                doGenerate: (params: any) => invoke(params, false),
                doStream: (params: any) => invoke(params, true),
              } as any,
            });
            return {
              engine: middleware.caesura,
              call(text: string, options: any, streaming: boolean) {
                const { signal, ...caesura } = options;
                const params = {
                  prompt: [{ role: 'user', content: [{ type: 'text', text }] }],
                  abortSignal: signal,
                  providerOptions: { caesura },
                };
                return streaming
                  ? model.doStream(params)
                  : model.doGenerate(params);
              },
            };
          },
        });
      },
    );
  }
