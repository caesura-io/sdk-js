/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect, it, vi } from 'vitest';
import { wrapLanguageModel } from 'ai';
import { createRequire } from 'node:module';
const major = Number(
  createRequire(import.meta.url)('ai/package.json').version.split('.')[0],
);
const specificationVersion = major === 5 ? 'v2' : major === 6 ? 'v3' : 'v4';
import { caesuraMiddleware } from './middleware.js';

it.each([false, true])(
  'audits effective provider parameters inside actual middleware order; streaming=%s',
  async (stream) => {
    const order: string[] = [];
    const audit: any[] = [];
    const sent: any[] = [];
    const analyze = vi.fn(async () => ({ analysis: 'private guidance' }));
    const middleware = caesuraMiddleware({
      conversationId: 'fixture-conversation',
      transport: { analyze },
      mode: 'sync',
      inject: { skillPrompt: '', template: '{analysis}' },
      onProviderEvent: (event) => {
        audit.push(event);
        if (event.type === 'request') order.push('final audit');
      },
    });
    const provider = {
      specificationVersion,
      modelId: 'test',
      provider: 'local',
      supportedUrls: {},
      async doGenerate(params: any) {
        order.push('provider');
        sent.push(params);
        return { content: [], usage: { inputTokens: 3 }, marker: 'native' };
      },
      async doStream(params: any) {
        order.push('provider');
        sent.push(params);
        return {
          response: { id: 'native' },
          stream: new ReadableStream({
            start(c) {
              c.enqueue({
                type: 'finish',
                usage: { inputTokens: 3 },
                finishReason: 'stop',
              });
              c.close();
            },
          }),
        };
      },
    } as any;
    // The external audit wrapper belongs INSIDE Caesura so it sees transformParams' result.
    const audited = wrapLanguageModel({
      model: provider,
      middleware: {
        specificationVersion,
        wrapGenerate: async ({ params, doGenerate }) => {
          order.push('inner audit');
          expect(JSON.stringify(params.prompt)).toContain('private guidance');
          return doGenerate();
        },
        wrapStream: async ({ params, doStream }) => {
          order.push('inner audit');
          expect(JSON.stringify(params.prompt)).toContain('private guidance');
          return doStream();
        },
      },
    });
    const model = wrapLanguageModel({ model: audited, middleware });
    const input: any = {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'yes' }] }],
      providerOptions: {
        caesura: {
          turn: { id: 'a', origin: 'customer' },
          metadata: { trace: 'x' },
        },
        test: { setting: true },
      },
      tools: [{ type: 'function', name: 'lookup', inputSchema: {} }],
      temperature: 0.3,
    };
    if (stream) {
      const result = await model.doStream(input);
      for await (const part of result.stream)
        expect(part).toHaveProperty('usage');
    } else
      expect(await model.doGenerate(input)).toHaveProperty('marker', 'native');
    const captured = audit.find((e) => e.type === 'request').parameters;
    expect(captured.prompt).toEqual(sent[0].prompt);
    expect(captured.tools).toEqual(input.tools);
    expect(captured.temperature).toBe(0.3);
    expect(sent[0].providerOptions).not.toHaveProperty('caesura');
    expect(order).toEqual(['final audit', 'inner audit', 'provider']);
    sent[0].prompt[0].content[0].text = 'mutation';
    expect(JSON.stringify(captured.prompt)).not.toContain('mutation');
    const continuation = {
      ...input,
      prompt: [
        ...input.prompt,
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 't',
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
              toolCallId: 't',
              toolName: 'lookup',
              output: { type: 'text', value: 'RAG' },
            },
          ],
        },
      ],
    };
    await model.doGenerate(continuation);
    expect(analyze).toHaveBeenCalledOnce();
    await model.doGenerate({
      ...input,
      providerOptions: { caesura: { turn: { id: 'b', origin: 'customer' } } },
    });
    expect(analyze).toHaveBeenCalledTimes(2);
  },
);

it('selects explicit evidence positions without changing RAG/provider input', async () => {
  const requests: any[] = [];
  const middleware = caesuraMiddleware({
    conversationId: 'fixture-conversation',
    transport: {
      async analyze(body) {
        requests.push(body);
        return { analysis: 'yes' };
      },
    },
    mode: 'sync',
    inject: { skillPrompt: 'Private instructions', template: '{analysis}' },
  });
  const prompt = [
    { role: 'user', content: [{ type: 'text', text: 'RAG' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
    { role: 'user', content: [{ type: 'text', text: 'yes' }] },
  ];
  const run = (id: string) =>
    middleware.transformParams!({
      type: 'generate',
      model: {},
      params: {
        prompt,
        providerOptions: {
          caesura: {
            turn: { id, origin: 'customer' },
            dialoguePositions: [1, 2],
          },
        },
      },
    });
  await run('a');
  const result = await run('b');
  expect(
    requests[1].messages.map((m: any) => [m.speakerIndex, m.text]),
  ).toEqual([
    [0, 'Hello'],
    [-1, 'yes'],
    [1, 'yes'],
  ]);
  expect(
    result.prompt
      .filter((m: any) => m.role !== 'system')
      .map((m: any) => m.content[0].text),
  ).toEqual(['RAG', 'Hello', 'yes', 'yes\n\nyes']);
});

it('filters future guidance from a retry of an older customer event', async () => {
  let count = 0;
  const middleware = caesuraMiddleware({
    conversationId: 'fixture-conversation',
    transport: { analyze: async () => ({ analysis: `guidance-${++count}` }) },
    mode: 'sync',
    inject: { skillPrompt: '', template: '{analysis}' },
  });
  const prompt = [{ role: 'user', content: [{ type: 'text', text: 'one' }] }];
  const run = (id: string, input = prompt) =>
    middleware.transformParams!({
      type: 'generate',
      model: {},
      params: {
        prompt: input,
        providerOptions: { caesura: { turn: { id, origin: 'customer' } } },
      },
    });
  await run('a');
  await run('b', [
    ...prompt,
    { role: 'user', content: [{ type: 'text', text: 'two' }] },
  ]);
  const replay = await run('a');
  expect(count).toBe(2);
  expect(replay.prompt).toEqual([
    ...prompt,
    { role: 'user', content: [{ type: 'text', text: 'guidance-1' }] },
  ]);
});
