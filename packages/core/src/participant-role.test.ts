import { expect, it, vi } from 'vitest';
import { createCaesuraEngine } from './engine.js';
import { normalizeDialogue } from './helpers.js';
import type { DialogueMessage } from './contracts.js';

const cases: {
  message: DialogueMessage;
  customer: boolean;
  index: number;
  name: string;
}[] = [
  {
    message: { speakerRole: 'user', speakerIndex: 0, text: 'customer' },
    customer: true,
    index: 0,
    name: 'Customer',
  },
  {
    message: { speakerRole: 'assistant', speakerIndex: 42, text: 'agent' },
    customer: false,
    index: 42,
    name: 'Agent',
  },
  {
    message: {
      speakerRole: 'assistant',
      speakerIndex: 0,
      origin: 'customer',
      text: 'customer',
    },
    customer: true,
    index: 0,
    name: 'Customer',
  },
  {
    message: {
      speakerRole: 'user',
      speakerIndex: 42,
      origin: 'agent',
      text: 'agent',
    },
    customer: false,
    index: 42,
    name: 'Agent',
  },
  {
    message: { speakerRole: 'user', text: 'default customer' },
    customer: true,
    index: 1,
    name: 'Customer',
  },
  {
    message: { speakerRole: 'assistant', text: 'default agent' },
    customer: false,
    index: 0,
    name: 'Agent',
  },
  {
    message: {
      speakerRole: 'assistant',
      origin: 'customer',
      text: 'default customer',
    },
    customer: true,
    index: 1,
    name: 'Customer',
  },
  {
    message: { speakerRole: 'user', origin: 'agent', text: 'default agent' },
    customer: false,
    index: 0,
    name: 'Agent',
  },
];
for (const explicitTurn of [false, true]) {
  it.each(cases)(
    `uses role/origin independently of participant index (explicit turn=${explicitTurn}): $message`,
    async ({ message, customer, index, name }) => {
      const analyze = vi.fn(async () => ({ analysis: 'SAME' }));
      const original = structuredClone(message);
      const engine = createCaesuraEngine({
        transport: { analyze },
        mode: 'sync',
        failurePolicy: 'throw',
      });
      expect(
        normalizeDialogue([message], { agent: 'Agent', customer: 'Customer' }),
      ).toEqual([
        {
          speakerRole: customer ? 'user' : 'assistant',
          speakerIndex: index,
          speakerName: name,
          text: message.text,
        },
      ]);
      const work = engine.observe('test', [message], {
        ...(message.origin ? { dialogue: [message] } : {}),
        ...(explicitTurn
          ? { turn: { id: 'turn', origin: 'customer' as const } }
          : {}),
      });
      if (explicitTurn && !customer)
        await expect(work).rejects.toMatchObject({ kind: 'configuration' });
      else await work;
      expect(analyze).toHaveBeenCalledTimes(customer ? 1 : 0);
      if (customer)
        expect(analyze.mock.calls[0][0].messages).toEqual([
          {
            speakerRole: 'user',
            speakerIndex: index,
            speakerName: name,
            text: message.text,
          },
        ]);
      expect(message).toEqual(original);
      await engine.shutdown();
    },
  );
}
it.each(['user', 'assistant'] as const)(
  'never treats internal/RAG %s content as a customer turn',
  async (speakerRole) => {
    const analyze = vi.fn();
    const engine = createCaesuraEngine({
      transport: { analyze },
      mode: 'sync',
    });
    await engine.observe('test', [], {
      dialogue: [
        {
          speakerRole,
          speakerIndex: 0,
          origin: 'internal',
          text: 'retrieved context',
        },
      ],
    });
    expect(analyze).not.toHaveBeenCalled();
    await engine.shutdown();
  },
);
