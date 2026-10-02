/* eslint-disable @typescript-eslint/no-explicit-any */
import type OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryCaesuraStore,
  injectedMessageKey,
  type AnalyzeMessage,
  type AnalyzeRequestBody,
  type SendConfig,
} from '@caesura-io/core';
import { createCaesura } from './wrapper.js';
import { getMessageText } from './adapters.js';

const text = 'same 😊';
const cases: {
  label: string;
  sameSpeaker?: boolean;
  cadence?: number;
  dedup?: boolean;
  send?: SendConfig;
}[] = [
  { label: 'alternating participants' },
  { label: 'repeated same participant', sameSpeaker: true },
  { label: 'deduplication gaps', dedup: true },
  { label: 'cadence gaps', cadence: 2 },
  { label: 'message budget', send: { maxMessages: 5 } },
  {
    label: 'character budget',
    send: { maxInputChars: Array.from(text).length * 4 + 2 },
  },
  { label: 'trimmed dialogue', send: { maxMessages: 2 } },
  { label: 'trimmed current text', send: { maxInputChars: 3 } },
];
afterEach(() => vi.unstubAllGlobals());

describe.each(['sync', 'async'] as const)(
  'occurrence ordering in %s mode',
  (mode) => {
    describe.each(['chat', 'responses', 'switch'] as const)('%s', (api) => {
      it.each(cases)('$label', async (scenario) => {
        const store = new MemoryCaesuraStore();
        const requests: AnalyzeRequestBody[] = [];
        let release: (() => void) | undefined;
        let turn = 0;
        vi.stubGlobal(
          'fetch',
          vi.fn(async (_url, init) => {
            requests.push(JSON.parse(init.body));
            const requestedTurn = turn;
            if (mode === 'async')
              await new Promise<void>((resolve) => {
                release = resolve;
              });
            return Response.json(
              scenario.dedup && requestedTurn > 1
                ? { isSame: true, duplicate: requestedTurn }
                : requestedTurn,
            );
          }),
        );
        const chat = vi.fn().mockResolvedValue({ choices: [] });
        const responses = vi.fn().mockResolvedValue({ output: [] });
        const client = createCaesura(
          {
            chat: { completions: { create: chat } },
            responses: { create: responses },
          } as unknown as OpenAI,
          {
            apiKey: 'test',
            mode,
            store,
            persist: true,
            conversationId: 'one',
            cadence: { everyTurns: scenario.cadence ?? 1 },
            send: scenario.send,
            inject: {
              skillPrompt: '',
              placement: 'after-last-analyzed',
              template: 'A{analysis}',
            },
          },
        );
        const buffered: number[] = [];
        const count = scenario.cadence ? 6 : 4;
        for (turn = 1; turn <= count; turn++) {
          const dialogue: AnalyzeMessage[] = Array.from(
            { length: turn },
            (_, i) => ({
              speakerRole: 'user',
              speakerName:
                scenario.sameSpeaker || i % 2 === 0 ? 'Customer' : 'Agent',
              speakerIndex: scenario.sameSpeaker ? 1 : 1 - (i % 2),
              text,
            }),
          );
          const useResponses =
            api === 'responses' || (api === 'switch' && turn % 2 === 1);
          const input: any[] = dialogue.map((m) => ({
            role: m.speakerIndex === 0 ? 'assistant' : 'user',
            ...(useResponses ? { type: 'message' } : {}),
            content: useResponses
              ? [
                  {
                    type: m.speakerIndex === 0 ? 'output_text' : 'input_text',
                    text,
                  },
                ]
              : text,
          }));
          const before = structuredClone(input);
          const queried = (turn - 1) % (scenario.cadence ?? 1) === 0;
          const accepted = queried && (!scenario.dedup || turn === 1);
          const prior = [...buffered];
          if (useResponses)
            await client.responses.create({ model: 'test', input });
          else
            await client.chat.completions.create({
              model: 'test',
              messages: input,
            });
          expect(input).toEqual(before);
          const body = (useResponses ? responses : chat).mock.calls.at(-1)![0];
          const forwarded = (
            useResponses ? body.input : body.messages
          ) as any[];
          const visible = [
            ...prior,
            ...(mode === 'sync' && accepted ? [turn] : []),
          ];
          const expectedProvider = before.flatMap((m, i) => [
            m,
            ...(visible.includes(i + 1)
              ? [{ role: 'user', content: `A${i + 1}` }]
              : []),
          ]);
          expect(forwarded).toEqual(expectedProvider);
          expect(
            forwarded.filter((m) => getMessageText(m.content) === text),
          ).toEqual(before);

          // Change caller-owned nested content and array while background HTTP is pending.
          if (mode === 'async' && queried) {
            if (useResponses) input.at(-1).content[0].text = 'MUTATED';
            else input.at(-1).content = 'MUTATED';
            input.at(-1).name = 'Wrong participant';
            input.push({ role: 'user', content: 'NEW TURN' });
            release!();
            await vi.waitFor(() =>
              expect(store.get('one').inFlight).toBe(false),
            );
          }
          if (queried) {
            let retainedDialogue = dialogue;
            let retainedAnalyses = prior;
            if (scenario.label === 'message budget')
              retainedAnalyses = prior.slice(-Math.max(0, 5 - turn));
            if (scenario.label === 'character budget')
              retainedAnalyses = prior.slice(
                -Math.min(
                  prior.length,
                  Array.from(text).length * 4 +
                    2 -
                    turn * Array.from(text).length,
                ),
              );
            if (scenario.label === 'trimmed dialogue') {
              retainedDialogue = dialogue.slice(-2);
              retainedAnalyses = [];
            }
            if (scenario.label === 'trimmed current text') {
              retainedDialogue = [{ ...dialogue.at(-1)!, text: 'e 😊' }];
              retainedAnalyses = [];
            }
            const expectedBackend = retainedDialogue.flatMap((m, i) => {
              const occurrence =
                dialogue.length - retainedDialogue.length + i + 1;
              return [
                m,
                ...(retainedAnalyses.includes(occurrence)
                  ? [
                      {
                        speakerRole: 'assistant',
                        speakerIndex: -1,
                        text: String(occurrence),
                      },
                    ]
                  : []),
              ];
            });
            const request = requests.at(-1)!;
            expect(request).toMatchObject({
              conversationId: 'one',
              persist: true,
              currentUser: 'Agent',
            });
            expect(request.messages).toEqual(expectedBackend);
            expect(request.messages.at(-1)).toEqual(retainedDialogue.at(-1));
          }
          if (accepted) buffered.push(turn);
          expect(
            store.get('one').recommendations.map((r) => r.analysis),
          ).toEqual(buffered);
        }
      });
    });
  },
);

it.each(['chat', 'responses'] as const)(
  'excludes reused guidance and non-dialogue when locating %s injection anchors',
  async (api) => {
    const { dialogueAnchors, resolveConfig } = await import('@caesura-io/core');
    const { collectOpenAIMessages, injectBlocksOpenAI } =
      await import('./adapters.js');
    const cfg = resolveConfig({
      apiKey: 'test',
      inject: { placement: 'after-last-analyzed', skillPrompt: '' },
    });
    const first = { role: 'user', content: 'same' };
    const second = { role: 'assistant', content: 'same' };
    const last = { role: 'user', content: 'same' };
    const nonDialogue =
      api === 'responses'
        ? [
            { type: 'reasoning', role: 'assistant', content: 'same' },
            { type: 'function_call_output', call_id: 'x', output: 'same' },
          ]
        : [
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'x',
                  type: 'function',
                  function: { name: 'tool', arguments: '{}' },
                },
              ],
            },
            { role: 'tool', tool_call_id: 'x', content: 'same' },
          ];
    const reusedGuidance = { role: 'user', content: 'SDK guidance' };
    const items = [
      { role: 'system', content: 'instructions' },
      first,
      ...nonDialogue,
      reusedGuidance,
      second,
      last,
    ];
    const ignored = new Set([injectedMessageKey('user', 'SDK guidance')]);
    const collected = collectOpenAIMessages(
      items,
      { maxMessages: 'all' },
      cfg.speakerNames,
      ignored,
    );
    expect(
      collected.map((m) => [m.speakerName, m.speakerIndex, m.text]),
    ).toEqual([
      ['Customer', 1, 'same'],
      ['Agent', 0, 'same'],
      ['Customer', 1, 'same'],
    ]);
    const result = injectBlocksOpenAI(
      items,
      [
        {
          recommendationId: 'a',
          text: 'A2',
          createdAtTurn: 2,
          afterMessageHash: '',
          afterMessageAnchor: dialogueAnchors(collected)[1],
        },
      ],
      cfg.inject,
      cfg.speakerNames,
      ignored,
    );
    expect(result.result).toEqual([
      ...items.slice(0, -1).filter((m) => m !== reusedGuidance),
      { role: 'user', content: 'A2' },
      last,
    ]);
    expect(result.indices).toEqual([items.length - 2]);
  },
);
