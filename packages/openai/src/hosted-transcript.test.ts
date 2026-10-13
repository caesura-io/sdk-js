/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { createCaesura } from './wrapper.js';
afterEach(() => vi.unstubAllGlobals());
function backend() {
  const messages: any[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('/conversation/messages?'))
        return Response.json({
          success: true,
          conversationId: new URL(url).searchParams.get('conversationId'),
          nextMessageId: 1,
        });
      const body = JSON.parse(init.body as string);
      if (url.endsWith('/conversation/messages'))
        messages.push(...body.messages);
      return Response.json(
        url.endsWith('/analyze') ? 'SAME' : { success: true, ...body },
      );
    }),
  );
  return messages;
}
it.each(['chat', 'responses'])(
  'uploads %s replies by default without an application hook',
  async (api) => {
    const messages = backend();
    const provider = vi.fn(async () => ({
      id: 'reply',
      choices: [{ message: { content: 'Hello' } }],
      status: 'completed',
      output: [
        {
          id: 'reply-message',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello' }],
        },
      ],
    }));
    const client = createCaesura(
      {
        chat: { completions: { create: provider } },
        responses: { create: provider },
      } as any,
      {
        apiKey: 'key',
        conversationId: 'id',
        mode: 'sync',
        failurePolicy: 'throw',
      },
    );
    if (api === 'chat')
      await client.chat.completions.create({
        model: 'local',
        messages: [{ role: 'user', content: 'Hi' }],
      });
    else await client.responses.create({ model: 'local', input: 'Hi' });
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Hi'],
      ['assistant', 'Hello'],
    ]);
  },
);
it.each([true, false])(
  'default HTTP capture only saves a protocol-completed chat stream: %s',
  async (completed) => {
    const messages = backend();
    const chunks: any[] = [
      {
        id: 'reply',
        choices: [
          { index: 0, delta: { content: 'Hello' }, finish_reason: null },
        ],
      },
    ];
    if (completed)
      chunks.push({
        id: 'reply',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
    const provider = new OpenAI({
      apiKey: 'mock',
      fetch: async () =>
        new Response(
          chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    });
    const client = createCaesura(provider, {
      apiKey: 'key',
      conversationId: 'id',
      mode: 'sync',
      failurePolicy: 'throw',
    });
    for await (const chunk of await client.chat.completions.create({
      model: 'local',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    }))
      void chunk;
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(
      completed ? 1 : 0,
    );
  },
);

it.each(['chat', 'responses'])(
  'saves completed %s refusal replies without analyzing them',
  async (api) => {
    for (const stream of [false, true]) {
      for (const completed of [false, true]) {
        if (!stream && !completed) continue;
        const messages = backend();
        const refusal = 'I cannot help with that request.';
        const reply =
          api === 'chat'
            ? {
                id: 'refusal',
                choices: [
                  {
                    message: { role: 'assistant', content: null, refusal },
                    finish_reason: 'stop',
                  },
                ],
              }
            : {
                id: 'refusal',
                status: 'completed',
                output: [
                  {
                    id: 'refusal-message',
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'refusal', refusal }],
                  },
                ],
              };
        const parts: any[] =
          api === 'chat'
            ? [
                {
                  id: 'refusal',
                  choices: [
                    { index: 0, delta: { refusal }, finish_reason: null },
                  ],
                },
              ]
            : [{ type: 'response.refusal.delta', delta: refusal }];
        if (completed)
          parts.push(
            api === 'chat'
              ? {
                  id: 'refusal',
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                }
              : { type: 'response.completed', response: { id: reply.id } },
          );
        const provider = new OpenAI({
          apiKey: 'mock',
          fetch: async () =>
            stream
              ? new Response(
                  parts
                    .map((part) => `data: ${JSON.stringify(part)}\n\n`)
                    .join(''),
                  { headers: { 'content-type': 'text/event-stream' } },
                )
              : Response.json(reply),
        });
        const client = createCaesura(provider, {
          apiKey: 'key',
          conversationId: 'id',
          mode: 'sync',
          failurePolicy: 'throw',
        });
        const result = await (api === 'chat'
          ? client.chat.completions.create({
              model: 'mock',
              messages: [{ role: 'user', content: 'Hi' }],
              stream,
            })
          : client.responses.create({ model: 'mock', input: 'Hi', stream }));
        if (stream) for await (const part of result as any) void part;
        expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
          { role: 'user', text: 'Hi' },
          ...(completed ? [{ role: 'assistant', text: refusal }] : []),
        ]);
        const analysis = vi
          .mocked(fetch)
          .mock.calls.filter(([url]) => String(url).endsWith('/analyze'));
        expect(analysis).toHaveLength(1);
        expect(
          JSON.parse(analysis[0][1]!.body as string).messages.at(-1).text,
        ).toBe('Hi');
      }
    }
  },
);
