import { expect, it } from 'vitest';
import {
  buildAnalyzeMessages,
  dialogueAnchors,
  limitMessages,
} from './helpers.js';
import { MemoryCaesuraStore } from './store.js';
import type { AnalyzeMessage } from './client.js';
import type { CaesuraAnalysis } from './types.js';

const dialogue = (texts: string[]): AnalyzeMessage[] =>
  texts.map((text, i) => ({
    text,
    speakerRole: i % 2 ? 'assistant' : 'user',
    speakerName: i % 2 ? 'Agent' : 'Customer',
    speakerIndex: i % 2 ? 7 : 9,
  }));
const analysisMessage = (text: string) => ({
  speakerRole: 'assistant',
  speakerIndex: -1,
  text,
});
function history(messages: AnalyzeMessage[], analyses: CaesuraAnalysis[]) {
  const state = new MemoryCaesuraStore().get('one');
  const anchors = dialogueAnchors(messages);
  state.recommendations = analyses.map((analysis, i) => ({
    id: String(i),
    analysis,
    afterMessageHash: '',
    afterMessageAnchor: anchors[i],
    createdAtMs: i,
    createdAtTurn: i,
  }));
  return state;
}
it.each([
  [['abcdef', 'xyz'], 5, ['ef', 'xyz']],
  [['old', '😊'], 1, ['😊']],
  [['a😊ב', 'z'], 3, ['😊ב', 'z']],
  [['a', 'e\u0301'], 1, ['\u0301']],
] as const)(
  'packs code-point suffixes: %j',
  (texts, maxInputChars, expected) => {
    const input = dialogue([...texts]);
    const original = structuredClone(input);
    const result = limitMessages(input, { maxInputChars });
    expect(result.map((m) => m.text)).toEqual(expected);
    expect(result.map((m) => m.speakerIndex)).toEqual(
      input.slice(-result.length).map((m) => m.speakerIndex),
    );
    expect(input).toEqual(original);
  },
);
it('does not skip oversized recent guidance to use smaller older guidance', () => {
  const input = dialogue(['x', 'y', 'z']);
  const state = history(input, ['a', 'too long']);
  expect(buildAnalyzeMessages(input, state, { maxInputChars: 6 })).toEqual(
    input.map((m) => ({ ...m, speakerRole: 'user' })),
  );
});
it('keeps a contiguous suffix of history in chronological positions', () => {
  const input = dialogue(['a', 'b', 'c', 'd']);
  const state = history(input, ['old', 'large', '😊']);
  expect(buildAnalyzeMessages(input, state, { maxInputChars: 6 })).toEqual([
    ...input.slice(0, 3).map((m) => ({ ...m, speakerRole: 'user' })),
    analysisMessage('😊'),
    { ...input[3], speakerRole: 'user' },
  ]);
});
it('charges compact Unicode JSON and retains it whole at the exact boundary', () => {
  const input = dialogue(['a', 'b']);
  const state = history(input, [{ emoji: '😊', עברית: 'כן' }]);
  const serialized = JSON.stringify(state.recommendations[0]!.analysis);
  const budget = Array.from(serialized).length + 2;
  expect(buildAnalyzeMessages(input, state, { maxInputChars: budget })).toEqual(
    [
      { ...input[0], speakerRole: 'user' },
      analysisMessage(serialized),
      { ...input[1], speakerRole: 'user' },
    ],
  );
  expect(
    buildAnalyzeMessages(input, state, { maxInputChars: budget - 1 }),
  ).toHaveLength(2);
});
it('collapses unmatched context before allocating the message budget', () => {
  const original = dialogue(['a', 'b', 'c', 'd']);
  const state = history(original, [
    'old context',
    'latest context',
    'anchored',
  ]);
  const input = original.slice(2);
  // Use a matching prefix anchor for the retained occurrence; older prefixes are gone.
  state.recommendations[2]!.afterMessageAnchor = dialogueAnchors(input)[0];
  expect(buildAnalyzeMessages(input, state, { maxMessages: 4 })).toEqual([
    analysisMessage('latest context'),
    { ...input[0], speakerRole: 'user' },
    analysisMessage('anchored'),
    { ...input[1], speakerRole: 'user' },
  ]);
  expect(state.recommendations).toHaveLength(3);
});
it('does not recover an older fallback when the latest fallback is too large', () => {
  const state = history(dialogue(['removed', 'also removed']), [
    'a',
    'too large',
  ]);
  const input = dialogue(['now']);
  expect(buildAnalyzeMessages(input, state, { maxInputChars: 5 })).toEqual(
    input,
  );
});
it('keeps the latest utterance last with repeated occurrences and message limits', () => {
  const input = dialogue(['same', 'same', 'same', 'same']);
  const state = history(input, ['1', '2', '3']);
  expect(buildAnalyzeMessages(input, state, { maxMessages: 6 })).toEqual([
    { ...input[0], speakerRole: 'user' },
    { ...input[1], speakerRole: 'user' },
    analysisMessage('2'),
    { ...input[2], speakerRole: 'user' },
    analysisMessage('3'),
    { ...input[3], speakerRole: 'user' },
  ]);
});
