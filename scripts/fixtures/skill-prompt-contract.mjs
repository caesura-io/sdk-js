/* global structuredClone */
import assert from 'node:assert/strict';

export const promptCases = [
  'multiple',
  'earlier duplicate',
  'missing',
  'structured',
  'disabled',
];
const skill = 'Exact skill prompt';
const text = (content) =>
  typeof content === 'string'
    ? content
    : content
        .filter((p) => ['text', 'input_text', 'output_text'].includes(p.type))
        .map((p) => p.text)
        .join('');

// Runs against source adapters in Vitest and installed tarballs in the package matrix.
export async function checkSkillPrompt({
  api,
  scenario,
  stream,
  createClient,
}) {
  const requests = [],
    audits = [],
    analyses = [];
  const config = {
    conversationId: 'prompt-contract',
    mode: 'sync',
    transport: {
      async analyze(body) {
        analyses.push(body);
        return { analysis: `analysis ${analyses.length}` };
      },
    },
    inject: {
      skillPrompt: scenario === 'disabled' ? ' \n\t ' : skill,
      template: '{analysis}',
      as: 'assistant',
      placement: 'after-last-analyzed',
    },
    persistProviderRequest(event) {
      audits.push(event);
    },
  };
  const call = createClient(config, requests);
  const instructionRole = api === 'chat' ? 'developer' : 'system';
  const instructions =
    scenario === 'missing'
      ? []
      : [
          {
            role: 'system',
            content:
              scenario === 'earlier duplicate' ? `base\n\n${skill}` : 'base',
          },
          {
            role: instructionRole,
            content:
              scenario === 'structured'
                ? [
                    {
                      type: 'text',
                      text: 'last',
                      providerOptions: { local: { cache: true } },
                    },
                  ]
                : 'last',
            providerOptions: { local: { marker: 'preserve' } },
          },
        ];
  const makeMessage = (role, value) => ({
    role,
    content: api === 'ai' ? [{ type: 'text', text: value }] : value,
  });
  const key = api === 'ai' ? 'prompt' : api === 'chat' ? 'messages' : 'input';
  let parameters = {
    [key]: [
      ...instructions,
      makeMessage('user', 'first'),
      makeMessage('user', 'internal RAG'),
    ],
  };
  if (api === 'responses' && scenario !== 'missing')
    parameters.instructions = 'base';
  const original = structuredClone(parameters);
  const expectedInstructions = structuredClone(instructions);
  if (
    api !== 'responses' &&
    scenario !== 'disabled' &&
    scenario !== 'earlier duplicate'
  ) {
    if (scenario === 'missing')
      expectedInstructions.unshift({ role: 'system', content: skill });
    else {
      const last = expectedInstructions.at(-1);
      last.content =
        typeof last.content === 'string'
          ? `${last.content}\n\n${skill}`
          : [...last.content, { type: 'text', text: `\n\n${skill}` }];
    }
  }
  for (const turn of [1, 2, 2]) {
    if (turn === 2 && analyses.length === 1) {
      parameters = {
        ...requests.at(-1),
        [key]: [
          ...requests.at(-1)[key],
          makeMessage('assistant', 'reply'),
          makeMessage('user', 'second'),
        ],
      };
    }
    const before = structuredClone(parameters);
    const dialoguePositions = parameters[key].flatMap((m, i) =>
      ['first', 'reply', 'second'].includes(text(m.content)) ? [i] : [],
    );
    await call(
      parameters,
      { turn: { id: `turn-${turn}`, origin: 'customer' }, dialoguePositions },
      stream,
    );
    assert.deepEqual(parameters, before, 'caller-owned parameters');
    const sent = requests.at(-1),
      audit = audits.at(-1);
    assert.equal(audit.correlation.conversationId, 'prompt-contract');
    assert.deepEqual(
      audit.parameters[key],
      sent[key],
      'finalized capture includes the exact injected input',
    );
    if (api === 'responses') {
      const expected =
        scenario === 'disabled' || scenario === 'earlier duplicate'
          ? 'base'
          : scenario === 'missing'
            ? skill
            : `base\n\n${skill}`;
      assert.equal(sent.instructions, expected);
      assert.equal(audit.parameters.instructions, expected);
    }
    const eligible = sent[key].filter(
      (m) => m.role === 'system' || m.role === 'developer',
    );
    assert.deepEqual(eligible, expectedInstructions);
    const rest = sent[key]
      .filter((m) => m.role !== 'system' && m.role !== 'developer')
      .map((m) => text(m.content));
    assert.deepEqual(
      rest,
      turn === 1
        ? ['first', 'analysis 1', 'internal RAG']
        : [
            'first',
            'analysis 1',
            'internal RAG',
            'reply',
            'second',
            'analysis 2',
          ],
    );
    // Reuse exactly the provider request, including instructions and prior guidance.
    parameters = sent;
  }
  assert.deepEqual(
    original[key].filter((m) => m.role === 'system' || m.role === 'developer'),
    instructions,
  );
  assert.equal(
    analyses.length,
    2,
    'repeated invocation is not another customer turn',
  );
  assert.deepEqual(
    analyses[0].messages.map((m) => m.text),
    ['first'],
  );
  assert.deepEqual(
    analyses[1].messages.map((m) => m.text),
    ['first', 'analysis 1', 'reply', 'second'],
  );
  // Provider mutation after capture must not alter persisted audit snapshots.
  requests.at(-1)[key][0].content = 'later provider mutation';
  assert.notEqual(
    audits.at(-1).parameters[key][0].content,
    'later provider mutation',
  );
}
