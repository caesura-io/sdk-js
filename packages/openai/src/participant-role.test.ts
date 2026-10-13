/* eslint-disable @typescript-eslint/no-explicit-any */
import { it } from 'vitest';
import { checkParticipantRoles } from '../../../scripts/fixtures/participant-role-contract.mjs';
import { createCaesura } from './wrapper.js';
for (const api of ['chat', 'responses']) {
  it.each(['sync', 'async'])(
    `preserves participant identity through ${api} collection, persistence and analysis (%s)`,
    async (mode) => {
      await checkParticipantRoles({
        api,
        mode,
        createClient(config: any, requests: any[]) {
          const invoke = async (body: any) => {
            requests.push(body.messages ?? body.input);
            return { choices: [], output: [] };
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
            call: (messages: any[], caesura: any) =>
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
    },
  );
}
