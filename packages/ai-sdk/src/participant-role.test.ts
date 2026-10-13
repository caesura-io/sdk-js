/* eslint-disable @typescript-eslint/no-explicit-any */
import { it } from 'vitest';
import { createRequire } from 'node:module';
import { wrapLanguageModel } from 'ai';
import { checkParticipantRoles } from '../../../scripts/fixtures/participant-role-contract.mjs';
import { caesuraMiddleware } from './middleware.js';
const major = Number(
  createRequire(import.meta.url)('ai/package.json').version.split('.')[0],
);
const specificationVersion = major === 5 ? 'v2' : major === 6 ? 'v3' : 'v4';
it.each(['sync', 'async'])(
  'preserves participant identity through AI SDK collection, persistence and analysis (%s)',
  async (mode) => {
    await checkParticipantRoles({
      api: 'ai',
      mode,
      createClient(config: any, requests: any[]) {
        const middleware = caesuraMiddleware(config);
        const model = wrapLanguageModel({
          middleware,
          model: {
            specificationVersion,
            provider: 'mock',
            modelId: 'mock',
            supportedUrls: {},
            doGenerate: async (params: any) => {
              requests.push(params.prompt);
              return { content: [] };
            },
          } as any,
        });
        return {
          engine: middleware.caesura,
          call: (prompt: any[], caesura: any) =>
            model.doGenerate({ prompt, providerOptions: { caesura } }),
        };
      },
    });
  },
);
