/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, expect, it, vi } from 'vitest';
import { wrapLanguageModel } from 'ai';
import { createRequire } from 'node:module';
import { caesuraMiddleware } from './middleware.js';
const major = Number(
  createRequire(import.meta.url)('ai/package.json').version.split('.')[0],
);
const specificationVersion = major === 5 ? 'v2' : major === 6 ? 'v3' : 'v4';
afterEach(() => vi.unstubAllGlobals());
it.each(['generate', 'complete-stream', 'partial-stream'])(
  'default HTTP saves completed agent text for %s',
  async (kind) => {
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
    const middleware = caesuraMiddleware({
      apiKey: 'key',
      conversationId: 'id',
      mode: 'sync',
      failurePolicy: 'throw',
    });
    const model = wrapLanguageModel({
      middleware,
      model: {
        specificationVersion,
        provider: 'local',
        modelId: 'local',
        supportedUrls: {},
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'Hello' }],
          response: { id: 'reply' },
          usage: {},
        }),
        doStream: async () => ({
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: 'text-delta', id: 'text', delta: 'Hello' });
              if (kind === 'complete-stream')
                c.enqueue({ type: 'finish', finishReason: 'stop', usage: {} });
              c.close();
            },
          }),
          response: { id: 'reply' },
        }),
      } as any,
    });
    const params: any = {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    };
    if (kind === 'generate') await model.doGenerate(params);
    else {
      const reader = (await model.doStream(params)).stream.getReader();
      while (!(await reader.read()).done) {
        /* Consume the complete stream. */
      }
    }
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(
      kind === 'partial-stream' ? 0 : 1,
    );
  },
);
