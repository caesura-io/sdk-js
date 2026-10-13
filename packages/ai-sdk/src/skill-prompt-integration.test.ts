/* eslint-disable @typescript-eslint/no-explicit-any */
import { it } from 'vitest';
import {
  checkSkillPrompt,
  promptCases,
} from '../../../scripts/fixtures/skill-prompt-contract.mjs';

import { caesuraMiddleware } from './middleware.js';
import { wrapLanguageModel } from 'ai';
import { createRequire } from 'node:module';
const major = Number(
  createRequire(import.meta.url)('ai/package.json').version.split('.')[0],
);
const specificationVersion = major === 5 ? 'v2' : major === 6 ? 'v3' : 'v4';
for (const stream of [false, true]) {
  it.each(promptCases)(
    `final prompt and dialogue anchors: stream=${stream}, %s`,
    async (scenario) => {
      await checkSkillPrompt({
        api: 'ai',
        scenario,
        stream,
        createClient(config: any, requests: any[]) {
          const invoke = async (params: any, streaming: boolean) => {
            const { abortSignal, ...snapshot } = params;
            void abortSignal;
            requests.push(snapshot);
            return streaming
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
              doGenerate: (p: any) => invoke(p, false),
              doStream: (p: any) => invoke(p, true),
            } as any,
          });
          return (params: any, caesura: any, streaming: boolean) =>
            model[streaming ? 'doStream' : 'doGenerate']({
              ...params,
              providerOptions: { caesura },
            });
        },
      });
    },
  );
}
