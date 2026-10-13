/* global ReadableStream */
import { createRequire } from 'node:module';
import { wrapLanguageModel } from 'ai';
import { createCaesura } from '@caesura-io/openai';
import { caesuraMiddleware } from '@caesura-io/ai-sdk';
import { checkSkillPrompt, promptCases } from './skill-prompt-contract.mjs';
const major = Number(
  createRequire(import.meta.url)('ai/package.json').version.split('.')[0],
);
const specificationVersion = major === 5 ? 'v2' : major === 6 ? 'v3' : 'v4';
export function makeClientFactory(api) {
  return (config, requests) => {
    if (api === 'ai') {
      const invoke = async (params, stream) => {
        // Audit snapshots intentionally omit live native cancellation controls.
        const { abortSignal, ...snapshot } = params;
        void abortSignal;
        requests.push(snapshot);
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
          provider: 'local',
          modelId: 'test',
          supportedUrls: {},
          doGenerate: (p) => invoke(p, false),
          doStream: (p) => invoke(p, true),
        },
      });
      return (params, caesura, stream) =>
        model[stream ? 'doStream' : 'doGenerate']({
          ...params,
          providerOptions: { caesura },
        });
    }
    const invoke = async (params) => {
      requests.push(params);
      return params.stream
        ? {
            async *[Symbol.asyncIterator]() {
              /* not consumed here */
            },
          }
        : { choices: [], output: [] };
    };
    const client = createCaesura(
      {
        chat: { completions: { create: invoke } },
        responses: { create: invoke },
      },
      config,
    );
    return (params, caesura, stream) =>
      (api === 'chat' ? client.chat.completions : client.responses).create(
        { model: 'test', ...params, stream },
        { caesura },
      );
  };
}
for (const api of ['chat', 'responses', 'ai'])
  for (const scenario of promptCases)
    for (const stream of [false, true])
      await checkSkillPrompt({
        api,
        scenario,
        stream,
        createClient: makeClientFactory(api),
      });
