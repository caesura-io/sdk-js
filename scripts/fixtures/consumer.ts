import { createCaesuraEngine, type CaesuraAnalysis } from '@caesura-io/core';
import { caesuraMiddleware } from '@caesura-io/ai-sdk';
import { wrapLanguageModel } from 'ai';
const values: CaesuraAnalysis[] = [
  null,
  false,
  0,
  'text',
  [],
  { 'next-step': 'ask' },
];
void values;
const engine = createCaesuraEngine({
  apiKey: 'test',
  send: { maxInputChars: 1 },
});
void engine.createConversation({ name: 'Example' });
// The installed AI SDK supplies its actual public middleware parameter type.
const middleware: Parameters<typeof wrapLanguageModel>[0]['middleware'] =
  caesuraMiddleware({ apiKey: 'test' });
void middleware;
