/* global Response, structuredClone */
import assert from 'node:assert/strict';

// Shared source/packed contract: provider participant roles survive collection;
// only the analysis HTTP body converts all participant dialogue to role "user".
export async function checkParticipantRoles({ api, mode, createClient }) {
  const previousFetch = globalThis.fetch;
  const saved = new Map(),
    analyses = [],
    requests = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/messages?'))
      return Response.json({
        success: true,
        conversationId: 'roles',
        nextMessageId: 1,
      });
    const body = JSON.parse(init.body);
    assert.equal(body.conversationId, 'roles');
    if (String(url).endsWith('/messages')) {
      for (const m of body.messages) saved.set(m.id, m);
      return Response.json({ success: true, ...body });
    }
    assert(String(url).endsWith('/analyze'));
    const current = body.messages.at(-1);
    const row = saved.get(body.transcriptMessageId);
    assert.equal(row.text, current.text);
    assert.equal(row.speakerIndex, current.speakerIndex);
    assert.equal(row.speakerName, current.speakerName);
    assert.equal(row.role, 'user');
    assert.equal(current.speakerRole, 'user');
    analyses.push(body);
    return Response.json(analyses.length === 1 ? 'Guidance' : 'SAME');
  };
  const { call, engine } = createClient(
    {
      apiKey: 'mock',
      conversationId: 'roles',
      mode,
      failurePolicy: 'throw',
      inject: { skillPrompt: '', template: '{analysis}', as: 'assistant' },
    },
    requests,
  );
  const message = (role, text, speakerIndex) => ({
    role,
    ...(speakerIndex === undefined ? {} : { speakerIndex }),
    content: api === 'ai' ? [{ type: 'text', text }] : text,
  });
  const send = async (messages, options = {}) => {
    const original = structuredClone(messages);
    const result = await call(messages, options);
    await engine.flush();
    assert.deepEqual(messages, original);
    return result;
  };
  try {
    const first = message('user', 'first');
    await send([first]);
    assert.equal(analyses.length, 1);
    assert.equal(saved.get(1).speakerIndex, 1);
    // Default agent and a positive-index agent are background, even with equal text.
    await send([first, message('assistant', 'first')]);
    await send([first, message('assistant', 'first', 42)]);
    assert.equal(analyses.length, 1);
    await assert.rejects(
      send([message('assistant', 'agent', 42)], {
        turn: { id: 'invalid-agent', origin: 'customer' },
      }),
      { kind: 'configuration' },
    );
    const history = [
      first,
      message('assistant', 'default agent'),
      message('assistant', 'positive agent', 42),
      message('user', 'customer zero', 0),
    ];
    await send(history);
    assert.equal(analyses.length, 2);
    assert.deepEqual(
      analyses[1].messages.map((m) => [m.speakerRole, m.speakerIndex, m.text]),
      [
        ['user', 1, 'first'],
        ['assistant', -1, 'Guidance'],
        ['user', 0, 'default agent'],
        ['user', 42, 'positive agent'],
        ['user', 0, 'customer zero'],
      ],
    );
    const native = requests.at(-1);
    for (const original of history)
      assert(
        native.some(
          (m) =>
            m.role === original.role &&
            JSON.stringify(m.content) === JSON.stringify(original.content),
        ),
      );
    history.push(message('user', 'customer zero', 0));
    await send(history, { turn: { id: 'explicit-zero', origin: 'customer' } });
    assert.equal(analyses.length, 3);
    assert.deepEqual(
      [...saved.values()].map((m) => m.speakerIndex),
      [1, 0, 0],
    );
    // Reused guidance and tool continuations never become new customer evidence.
    const toolMessages =
      api === 'responses'
        ? [
            {
              type: 'function_call',
              call_id: 'tool',
              name: 'lookup',
              arguments: '{}',
            },
            {
              type: 'function_call_output',
              call_id: 'tool',
              output: 'private tool result',
            },
          ]
        : api === 'ai'
          ? [
              {
                role: 'assistant',
                content: [
                  {
                    type: 'tool-call',
                    toolCallId: 'tool',
                    toolName: 'lookup',
                    input: {},
                  },
                ],
              },
              {
                role: 'tool',
                content: [
                  {
                    type: 'tool-result',
                    toolCallId: 'tool',
                    toolName: 'lookup',
                    output: { type: 'text', value: 'private tool result' },
                  },
                ],
              },
            ]
          : [
              {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'tool',
                    type: 'function',
                    function: { name: 'lookup', arguments: '{}' },
                  },
                ],
              },
              {
                role: 'tool',
                tool_call_id: 'tool',
                content: 'private tool result',
              },
            ];
    await send([...requests.at(-1), ...toolMessages]);
    assert.equal(analyses.length, 3);
    assert.deepEqual(requests.at(-1).slice(-toolMessages.length), toolMessages);
    await send([message('user', 'RAG/internal')], {
      turn: { id: 'internal', origin: 'internal' },
    });
    await send([message('user', 'RAG/internal')], {
      dialogue: [
        {
          speakerRole: 'user',
          speakerIndex: 0,
          origin: 'internal',
          text: 'RAG/internal',
        },
      ],
    });
    assert.equal(analyses.length, 3);
    // Explicit origins override both original roles and indices.
    await send([message('assistant', 'trusted customer')], {
      turn: { id: 'origin-customer', origin: 'customer' },
      dialogue: [
        {
          speakerRole: 'assistant',
          speakerIndex: 7,
          origin: 'customer',
          text: 'trusted customer',
        },
      ],
    });
    assert.equal(analyses.length, 4);
    assert.equal(saved.get(4).speakerIndex, 7);
    assert.equal(saved.get(4).speakerName, 'Customer');
    await send([message('user', 'trusted agent')], {
      dialogue: [
        {
          speakerRole: 'user',
          speakerIndex: 9,
          origin: 'agent',
          text: 'trusted agent',
        },
      ],
    });
    assert.equal(analyses.length, 4);
    assert.equal(saved.size, 4);
  } finally {
    await engine.shutdown();
    globalThis.fetch = previousFetch;
  }
}
