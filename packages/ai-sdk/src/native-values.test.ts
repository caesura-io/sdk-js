/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect, it } from 'vitest';
import { wrapLanguageModel } from 'ai';
import { createRequire } from 'node:module';
import { caesuraMiddleware } from './middleware.js';
const major = Number(
  createRequire(import.meta.url)('ai/package.json').version.split('.')[0],
);
const specificationVersion = major === 5 ? 'v2' : major === 6 ? 'v3' : 'v4';
it.each([false, true])(
  'preserves URL image/file inputs and isolated auditing, streaming=%s',
  async (stream) => {
    const events: any[] = [],
      requests: any[] = [],
      analyzed: any[] = [];
    const image = new URL('https://example.test/image.png');
    const file = new URL('https://example.test/document.pdf');
    const middleware = caesuraMiddleware({
      conversationId: 'id',
      mode: 'sync',
      transport: {
        analyze: async (body) => {
          analyzed.push(body);
          return { analysis: 'guidance' };
        },
      },
      onProviderEvent: (e) => {
        events.push(e);
      },
    });
    const model = wrapLanguageModel({
      middleware,
      model: {
        specificationVersion,
        modelId: 'test',
        provider: 'local',
        supportedUrls: {},
        async doGenerate(params: any) {
          requests.push(params);
          return { content: [] };
        },
        async doStream(params: any) {
          requests.push(params);
          return {
            stream: new ReadableStream({
              start(c) {
                c.enqueue({ type: 'finish', finishReason: 'stop' });
                c.close();
              },
            }),
          };
        },
      } as any,
    });
    const params: any = {
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe these.' },
            { type: 'image', image },
            { type: 'file', data: file, mediaType: 'application/pdf' },
          ],
        },
      ],
      providerOptions: { caesura: { metadata: { attachment: file } } },
    };
    const result = await (stream
      ? model.doStream(params)
      : model.doGenerate(params));
    if (stream) {
      const reader = result.stream.getReader();
      while (!(await reader.read()).done) {
        /* drain */
      }
    }
    const sent = requests[0].prompt.find(
      (m: any) => m.role === 'user' && m.content.length === 3,
    ).content;
    expect(sent[1].image).toBeInstanceOf(URL);
    expect(sent[1].image.href).toBe(image.href);
    expect(sent[2].data).toBeInstanceOf(URL);
    expect(sent[2].data.href).toBe(file.href);
    expect(params.prompt).toHaveLength(1);
    expect(params.prompt[0].content[1].image).toBe(image);
    expect(analyzed[0].messages.map((m: any) => m.text)).toEqual([
      'Describe these.',
    ]);
    const captured = events
      .find((e) => e.type === 'request')
      .parameters.prompt.find((m: any) => m.content?.length === 3).content;
    expect(captured[1].image.href).toBe(image.href);
    sent[1].image.pathname = '/changed';
    expect(image.pathname).toBe('/image.png');
    expect(captured[1].image.pathname).toBe('/image.png');
  },
);
it.each(['eof', 'finish', 'error', 'finish-error'])(
  'classifies AI SDK terminal parts: %s',
  async (outcome) => {
    const events: any[] = [],
      messages: any[] = [];
    const parts: any[] = [{ type: 'text-delta', id: 'text', delta: 'partial' }];
    if (outcome === 'finish' || outcome === 'finish-error')
      parts.push({
        type: 'finish',
        finishReason: 'length',
        usage: { totalTokens: 7 },
      });
    if (outcome.includes('error'))
      parts.push({ type: 'error', error: new Error('failure') });
    const middleware = caesuraMiddleware({
      conversationId: 'id',
      transport: { analyze: async () => ({ analysis: 'SAME' }) },
      onProviderEvent: (e) => {
        events.push(e);
      },
      persistMessages: (b) => {
        messages.push(...b.messages);
      },
    });
    const model = wrapLanguageModel({
      middleware,
      model: {
        specificationVersion,
        provider: 'local',
        modelId: 'test',
        supportedUrls: {},
        async doStream() {
          return {
            stream: new ReadableStream({
              start(c) {
                for (const part of parts) c.enqueue(part);
                c.close();
              },
            }),
          };
        },
      } as any,
    });
    const result = await model.doStream({ prompt: [] } as any);
    const reader = result.stream.getReader();
    const actual = [];
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      actual.push(part.value);
    }
    expect(actual).toEqual(parts);
    const terminal = events.find((e) => e.type === 'stream-end');
    expect(terminal.status).toBe(
      outcome === 'eof'
        ? 'incomplete'
        : outcome.includes('error')
          ? 'failed'
          : 'completed',
    );
    expect(messages.filter((m) => m.role === 'agent')).toHaveLength(
      outcome === 'finish' ? 1 : 0,
    );
    if (outcome === 'finish')
      expect(terminal.value.terminal).toMatchObject({
        finishReason: 'length',
        usage: { totalTokens: 7 },
      });
  },
);
