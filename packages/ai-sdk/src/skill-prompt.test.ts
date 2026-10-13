/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect, it } from 'vitest';
import { applySkillPrompt } from './helpers.js';
const apply = (messages: any, prompt: string | undefined): any =>
  applySkillPrompt(messages, prompt);
const skill = 'Exact skill prompt';
const text = (content: any) =>
  typeof content === 'string'
    ? content
    : content
        .filter((p: any) => p.type === 'text')
        .map((p: any) => p.text)
        .join('');
it.each(
  [
    ['system', 'system'],
    ['system', 'system', 'system'],
    ['system', 'system', 'system', 'system'],
  ].map((roles) => [roles]),
)('appends only to the last instruction, roles=%j', (roles) => {
  const messages = roles.map((role, i) => ({
    role,
    content: `instruction ${i}`,
    providerOptions: { local: { index: i } },
  }));
  messages.splice(1, 0, {
    role: 'user',
    content: 'background',
    providerOptions: { local: { index: -1 } },
  });
  const before = structuredClone(messages);
  const result = apply(messages, skill);
  expect(result.slice(0, -1)).toEqual(before.slice(0, -1));
  expect(result.at(-1)).toEqual({
    ...before.at(-1),
    content: `${before.at(-1)!.content}\n\n${skill}`,
  });
  expect(messages).toEqual(before);
  expect(apply(result, skill)).toBe(result);
});
it.each([0, 1, 2])('finds an exact duplicate in instruction %i', (position) => {
  const messages = Array.from({ length: 3 }, (_, i) => ({
    role: 'system',
    content:
      i === position
        ? [
            {
              type: 'text',
              text: `prefix ${skill} suffix`,
              providerOptions: { local: { cache: true } },
            },
          ]
        : `instruction ${i}`,
  }));
  expect(apply(messages, skill)).toBe(messages);
});
it('retains structured instruction parts and message metadata without mutation', () => {
  const part = Object.freeze({
    type: 'text',
    text: 'Keep existing content',
    providerOptions: { local: { cacheControl: 'keep' } },
  });
  const second = Object.freeze({ type: 'text', text: ' and whitespace. ' });
  const target = Object.freeze({
    role: 'system',
    content: Object.freeze([part, second]),
    providerOptions: { local: { flag: true } },
    name: 'policy',
  });
  const messages = Object.freeze([
    { role: 'system', content: 'first' },
    target,
    { role: 'user', content: 'hello' },
  ]);
  const result = apply(messages, skill);
  expect(result[1]).toEqual({
    ...target,
    content: [part, second, { type: 'text', text: `\n\n${skill}` }],
  });
  expect(result[1].role).toBe(target.role);
  expect(target.content).toHaveLength(2);
  expect(result[0]).toBe(messages[0]);
  expect(apply(result, skill)).toBe(result);
});
it.each([undefined, '', ' \n\t '])('disables insertion for %j', (disabled) => {
  const messages = [
    { role: 'system', content: 'first' },
    { role: 'system', content: [{ type: 'text', text: 'last' }] },
    { role: 'user', content: 'hello' },
  ];
  expect(apply(messages, disabled)).toBe(messages);
});
it('prepends system instructions when absent, even if dialogue contains the prompt', () => {
  const messages = [{ role: 'user', content: skill }];
  const result = apply(messages, skill);
  expect(result).toEqual([{ role: 'system', content: skill }, ...messages]);
  expect(messages).toHaveLength(1);
  expect(apply(result, skill)).toBe(result);
});
it('does not match a differently cased prompt', () => {
  const messages = [{ role: 'system', content: skill.toLowerCase() }];
  expect(text(apply(messages, skill)[0].content)).toBe(
    `${skill.toLowerCase()}\n\n${skill}`,
  );
});
