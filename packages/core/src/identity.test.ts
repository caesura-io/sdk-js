import { afterEach, expect, it, vi } from 'vitest';
import { createCaesuraEngine } from './engine.js';
import { MemoryCaesuraStore } from './store.js';
import type {
  AnalysisContext,
  CreationContext,
  TranscriptBatch,
} from './contracts.js';
import metadata from '../package.json';

afterEach(() => vi.unstubAllGlobals());
const dialogue = [{ speakerRole: 'user' as const, text: 'yes' }];
const turn = (id: string) => ({ turn: { id, origin: 'customer' as const } });
it.each([true, false])(
  'requires opaque IDs even with persist=%s and continue policy',
  async (persist) => {
    const analyze = vi.fn();
    const engine = createCaesuraEngine({ transport: { analyze }, persist });
    for (const id of [undefined, '', '  ', 42])
      await expect(
        engine.observe(id as string, dialogue),
      ).rejects.toMatchObject({ kind: 'configuration' });
    expect(analyze).not.toHaveBeenCalled();
  },
);
it('uses exactly the created ID across resets, eviction, restart and concurrent conversations', async () => {
  const createConversation = vi.fn(async () => 'opaque/account:α');
  const analyze = vi.fn(async () => ({ analysis: 'advice' }));
  const onEvent = vi.fn();
  const store = new MemoryCaesuraStore({ maxConversations: 1 });
  let engine = createCaesuraEngine({
    transport: { analyze, createConversation },
    store,
    mode: 'sync',
    onEvent,
  });
  const id = await engine.createConversation({ name: 'General conversation' });
  expect(onEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'conversation-created',
      conversationId: id,
    }),
  );
  await engine.observe(id, dialogue, turn('1'));
  await engine.clear(id);
  await engine.observe(id, dialogue, turn('2'));
  store.get('another');
  await engine.observe(id, dialogue, turn('3'));
  engine = createCaesuraEngine({
    transport: { analyze, createConversation },
    mode: 'sync',
  });
  await Promise.all([
    engine.observe(id, dialogue, turn('4')),
    engine.observe('other:id', dialogue, turn('4')),
  ]);
  expect(createConversation).toHaveBeenCalledTimes(1);
  expect(
    analyze.mock.calls.map(
      (c: unknown[]) => (c[0] as { conversationId: string }).conversationId,
    ),
  ).toEqual([id, id, id, id, 'other:id']);
  for (const [body, context] of analyze.mock.calls as unknown as [
    Record<string, unknown>,
    AnalysisContext,
  ][]) {
    expect(body.sessionId).toBe(body.conversationId);
    expect(context.conversationId).toBe(body.conversationId);
    expect(context.sdk.core).toEqual({
      name: metadata.name,
      version: metadata.version,
    });
  }
  expect(await engine.getState(id)).not.toHaveProperty('backendConversationId');
  expect(
    (await engine.flush()).map((c) => c.correlation.conversationId),
  ).toEqual([id, 'other:id']);
});
it('creation gets metadata, provenance and deadlines, with no invented conversation identity', async () => {
  let context!: CreationContext;
  const engine = createCaesuraEngine({
    transport: {
      analyze: vi.fn(),
      createConversation: async (_, ctx) => {
        context = ctx;
        return 'returned-id';
      },
    },
  });
  const deadline = Date.now() + 1000;
  expect(
    await engine.createConversation(
      {},
      { deadline, metadata: { trace: 1 }, invocationId: 'create-1' },
    ),
  ).toBe('returned-id');
  expect(context).toMatchObject({
    deadline,
    metadata: { trace: 1 },
    invocationId: 'create-1',
    sdk: { language: 'javascript', transport: 'in-process' },
  });
  expect(context).not.toHaveProperty('conversationId');
  await expect(
    engine.createConversation({}, { deadline: Date.now() - 1 }),
  ).rejects.toMatchObject({ kind: 'timeout' });
  const ctrl = new AbortController();
  ctrl.abort();
  await expect(
    engine.createConversation({}, { signal: ctrl.signal }),
  ).rejects.toMatchObject({ kind: 'cancelled' });
  const pending = createCaesuraEngine({
    transport: {
      analyze: vi.fn(),
      createConversation: async (_, ctx) => {
        context = ctx;
        return new Promise(() => {});
      },
    },
  });
  const controller = new AbortController();
  const promise = pending.createConversation({}, { signal: controller.signal });
  controller.abort();
  await expect(promise).rejects.toMatchObject({ kind: 'cancelled' });
  expect(context.signal.aborted).toBe(true);
  await expect(
    pending.createConversation({}, { deadline: Date.now() + 10 }),
  ).rejects.toMatchObject({ kind: 'timeout' });
});
it('sends SDK-only headers on HTTP creation/analysis without serializing private context', async () => {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes('/conversation/messages?'))
      return Response.json({
        success: true,
        conversationId: 'server:id',
        nextMessageId: 1,
      });
    if (url.endsWith('/conversation/messages'))
      return Response.json({
        success: true,
        ...JSON.parse(init.body as string),
      });
    return Response.json(
      url.endsWith('/conversation') ? { id: 'server:id' } : 'guidance',
    );
  });
  vi.stubGlobal('fetch', fetcher);
  const engine = createCaesuraEngine(
    { apiKey: 'secret', mode: 'sync' },
    { name: '@caesura-io/test', version: '9.2.1' },
  );
  const id = await engine.createConversation(
    {},
    { metadata: { private: 'value' } },
  );
  await engine.observe(id, dialogue, {
    ...turn('1'),
    metadata: { private: 'value' },
  });
  for (const [, init] of fetcher.mock.calls as unknown as [
    string,
    RequestInit,
  ][]) {
    const headers = new Headers(init.headers);
    expect(headers.get('x-caesura-sdk-core-version')).toBe(metadata.version);
    expect(headers.get('x-caesura-sdk-integration-version')).toBe('9.2.1');
    expect(headers.get('x-caesura-sdk-transport')).toBe('http');
    expect(headers.has('x-caesura-client')).toBe(false);
    expect(headers.has('x-caesura-version')).toBe(false);
    expect(init.body ?? '').not.toContain('private');
    expect(init.body ?? '').not.toContain('sdk');
  }
});
it.each(['sync', 'async'] as const)(
  'awaits transcript persistence independently of %s analysis cadence',
  async (mode) => {
    const records: TranscriptBatch[] = [];
    const analyze = vi.fn(async () => ({ analysis: 'SAME' }));
    const engine = createCaesuraEngine({
      transport: { analyze },
      mode,
      cadence: { everyTurns: 3 },
      persistMessages: async (b) => {
        await Promise.resolve();
        records.push(b);
      },
    });
    await engine.recordMessages('id', [
      { id: 'greeting', role: 'agent', text: 'Welcome' },
    ]);
    for (const id of ['1', '2', '3'])
      await engine.observe('id', dialogue, turn(id));
    await engine.observe('id', dialogue, {
      turn: { id: 'rag', origin: 'internal' },
    });
    await engine.recordMessages('id', [
      { id: 'reply', role: 'agent', text: 'How can I help?' },
    ]);
    await engine.flush();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(
      records.flatMap((b) => b.messages.map((m) => [m.id, m.role, m.text])),
    ).toEqual([
      ['greeting', 'agent', 'Welcome'],
      ['1', 'customer', 'yes'],
      ['2', 'customer', 'yes'],
      ['3', 'customer', 'yes'],
      ['reply', 'agent', 'How can I help?'],
    ]);
  },
);
it('strict transcript failures preserve their cause and block analysis; cancellation never fails open', async () => {
  const cause = new Error('database offline');
  const analyze = vi.fn();
  const engine = createCaesuraEngine({
    transport: { analyze },
    failurePolicy: 'throw',
    onError: () => {},
    persistMessages: async () => {
      throw cause;
    },
  });
  await expect(engine.observe('id', dialogue)).rejects.toMatchObject({
    kind: 'store',
    cause,
  });
  expect(analyze).not.toHaveBeenCalled();
  const ctrl = new AbortController();
  ctrl.abort();
  await expect(
    engine.recordMessages('id', [], { signal: ctrl.signal }),
  ).rejects.toMatchObject({ kind: 'cancelled' });
});

it('preserves FIFO and cancellation while required customer transcript writes are pending', async () => {
  let release!: () => void;
  const analyzed: string[] = [];
  const engine = createCaesuraEngine({
    transport: {
      analyze: async (_, context) => {
        analyzed.push(context.customerTurnId!);
        return { analysis: 'guidance' };
      },
    },
    mode: 'async',
    onError: () => {},
    persistMessages: async (batch) => {
      if (batch.messages[0]?.id === '1')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    },
  });
  const first = engine.observe('id', dialogue, turn('1'));
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const second = engine.observe('id', dialogue, turn('2'));
  expect(analyzed).toEqual([]);
  release();
  await Promise.all([first, second]);
  await engine.flush();
  expect(analyzed).toEqual(['1', '2']);
  const previousRelease = release;
  const pending = engine.observe('id', dialogue, turn('1'));
  await vi.waitFor(() => expect(release).not.toBe(previousRelease));
  const cancelled = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
  await engine.clear('id');
  await cancelled;
  release();
  await engine.flush();
  expect((await engine.getState('id')).recommendations).toEqual([]);
});

it('uses the fallback occurrence identity consistently in transcript and analysis correlation', async () => {
  const transcript: TranscriptBatch[] = [];
  const contexts: AnalysisContext[] = [];
  const engine = createCaesuraEngine({
    mode: 'sync',
    transport: {
      analyze: async (_, context) => {
        contexts.push(context);
        return { analysis: 'guidance' };
      },
    },
    persistMessages: (batch) => {
      transcript.push(batch);
    },
  });
  await engine.observe('authoritative', dialogue);
  expect(transcript[0]!.correlation.customerTurnId).toBe(
    transcript[0]!.messages[0]!.id,
  );
  expect(transcript[0]!.correlation.customerTurnId).toBe(
    contexts[0]!.customerTurnId,
  );
});
