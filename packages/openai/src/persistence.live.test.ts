import type OpenAI from 'openai';
import { expect, it, vi } from 'vitest';
import { MemoryCaesuraStore, type AnalyzeRequestBody } from '@caesura-io/core';
import { createCaesura } from './wrapper.js';

/** Opt-in: creates one real conversation and incurs four backend analyses. */
it.runIf(process.env.CAESURA_LIVE_TEST === '1')(
  'fetches four persisted turns with distinct speaker identities from the backend',
  async () => {
    const baseUrl = process.env.CAESURA_BASE_URL ?? 'https://api.caesurao.com';
    const apiKey = process.env.CAESURA_API_KEY;
    expect(
      apiKey,
      'CAESURA_API_KEY is required for the live test',
    ).toBeTruthy();
    const store = new MemoryCaesuraStore();
    const errors: unknown[] = [];
    const requests: AnalyzeRequestBody[] = [];
    const chat = vi.fn().mockResolvedValue({ choices: [] });
    const responses = vi.fn().mockResolvedValue({ output: [] });
    const client = createCaesura(
      {
        chat: { completions: { create: chat } },
        responses: { create: responses },
      } as unknown as OpenAI,
      {
        apiKey,
        baseUrl,
        store,
        persist: true,
        mode: 'async',
        timeoutMs: 60000,
        calculateSimilarities: true,
        similarityThreshold: 0.8,
        inject: { skillPrompt: '' },
        onError: (error) => errors.push(error),
        onEvent: (event) => {
          if (event.type === 'request') requests.push(event.body);
        },
      },
    );
    const conversationId = await client.createConversation({
      name: `JS SDK speaker identity regression ${new Date().toISOString()}`,
    });
    // Keep the ID visible even if a later assertion fails; never print credentials.
    console.info(`Live regression conversation: ${conversationId}`);
    const text = 'I feel unsure about the next step.';
    const roles = ['user', 'assistant', 'user', 'assistant'] as const;
    const names = ['Customer', 'Agent', 'Customer', 'Agent'];
    for (const [turn, role] of roles.entries()) {
      const options = { caesura: { conversationId } };
      if (turn % 2 === 0) {
        const input = [
          { role, content: [{ type: 'input_text' as const, text }] },
        ];
        await client.responses.create(
          { model: 'offline-provider-stub', input },
          options,
        );
        expect(responses.mock.calls.at(-1)![0].input).toContainEqual(input[0]);
      } else {
        const messages = [{ role, content: text }];
        await client.chat.completions.create(
          { model: 'offline-provider-stub', messages },
          options,
        );
        expect(chat.mock.calls.at(-1)![0].messages).toContainEqual(messages[0]);
      }
      await vi.waitFor(
        () => {
          expect(errors).toEqual([]);
          expect(store.get(conversationId).inFlight).toBe(false);
        },
        { timeout: 65000, interval: 100 },
      );
      expect(requests[turn]!.messages.at(-1)).toEqual({
        speakerRole: 'user',
        speakerName: names[turn],
        speakerIndex: 1 - (turn % 2),
        text,
      });
      for (const message of requests[turn]!.messages.filter(
        (m) => m.speakerRole === 'assistant',
      ))
        expect(message.speakerIndex).toBe(-1);
    }
    const response = await fetch(
      `${baseUrl}/api/conversation?conversationId=${encodeURIComponent(conversationId)}`,
      {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15000),
      },
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.success).toBe(true);
    const rows = result.conversation.analyses;
    expect(rows).toHaveLength(4);
    // Compare chronologically even if the backend returns newest first.
    rows.sort(
      (
        a: { createdAt: string; id: number },
        b: { createdAt: string; id: number },
      ) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id,
    );
    expect(
      rows.map(
        (row: { text: string; speakerName: string; speakerIndex: number }) => ({
          text: row.text,
          speakerName: row.speakerName,
          speakerIndex: row.speakerIndex,
        }),
      ),
    ).toEqual(
      roles.map((_, turn) => ({
        text,
        speakerName: names[turn],
        speakerIndex: 1 - (turn % 2),
      })),
    );
    console.info(
      'Fetched persisted speaker indices: [1,0,1,0]; text and names match all four turns.',
    );
  },
  300000,
);
