/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect, it } from 'vitest';
import {
  checkSkillPrompt,
  promptCases,
} from '../../../scripts/fixtures/skill-prompt-contract.mjs';

import { createCaesura } from './wrapper.js';
for (const api of ['chat', 'responses']) {
  for (const stream of [false, true]) {
    it.each(promptCases)(
      `final prompt and dialogue anchors: ${api}, stream=${stream}, %s`,
      async (scenario) => {
        await checkSkillPrompt({
          api,
          scenario,
          stream,
          createClient(config: any, requests: any[]) {
            const invoke = async (params: any) => {
              requests.push(params);
              return params.stream
                ? {
                    async *[Symbol.asyncIterator]() {
                      /* not consumed */
                    },
                  }
                : { choices: [], output: [] };
            };
            const client = createCaesura(
              {
                chat: { completions: { create: invoke } },
                responses: { create: invoke },
              } as any,
              config,
            );
            return (params: any, caesura: any, streaming: boolean) =>
              (api === 'chat'
                ? client.chat.completions
                : client.responses
              ).create(
                { model: 'test', ...params, stream: streaming },
                { caesura },
              );
          },
        });
      },
    );
  }
}

it.each(['duplicate', 'disabled'])(
  'preserves missing Responses instructions when insertion is %s',
  async (scenario) => {
    const requests: any[] = [];
    const create = async (params: any) => {
      requests.push(params);
      return { output: [] };
    };
    const client = createCaesura({ responses: { create } } as any, {
      conversationId: 'existing',
      mode: 'sync',
      transport: {
        async analyze() {
          return { analysis: null };
        },
      },
      inject: {
        skillPrompt: scenario === 'disabled' ? ' \n ' : 'Exact skill prompt',
      },
    });
    const params: any = {
      model: 'test',
      input: [
        { role: 'developer', content: 'Exact skill prompt' },
        { role: 'user', content: 'hello' },
      ],
    };
    await client.responses.create(params);
    await client.responses.create(requests[0]);
    expect(requests).toEqual([params, params]);
    expect(requests[0]).not.toHaveProperty('instructions');
  },
);
