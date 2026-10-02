import { afterEach, expect, it, vi } from 'vitest';
import { createCaesuraEngine } from './engine.js';
import {
  dialogueAnchors,
  buildAnalyzeMessages,
  hashMessage,
} from './helpers.js';
import { MemoryCaesuraStore } from './store.js';
import type { AnalyzeMessage, AnalyzeRequestBody } from './client.js';

afterEach(() => vi.unstubAllGlobals());
const message = (speakerIndex = 1): AnalyzeMessage => ({
  speakerRole: 'user',
  speakerIndex,
  speakerName: 'Shared name',
  text: 'same שלום 😊',
});
it('distinguishes same-name participants and repeated occurrences', () => {
  const customer = message(1),
    agent = message(0);
  const [first, second] = dialogueAnchors([customer, customer]);
  expect(first).not.toBe(second);
  expect(first).not.toBe(dialogueAnchors([agent])[0]);
  expect(dialogueAnchors([customer, agent])[1]).not.toBe(
    dialogueAnchors([agent, agent])[1],
  );
});

it.each(['edited', 'trimmed'] as const)(
  'does not reattach an unmatched prefix to repeated text in %s caller history',
  (change) => {
    const original = [{ ...message(), text: 'earlier' }, message(), message()];
    const store = new MemoryCaesuraStore();
    store.add('one', [
      {
        id: 'a',
        analysis: 1,
        afterMessageHash: hashMessage('Shared name', original[1]!.text),
        afterMessageAnchor: dialogueAnchors(original)[1],
        createdAtMs: 0,
        createdAtTurn: 1,
      },
    ]);
    const current =
      change === 'trimmed'
        ? original.slice(1)
        : [{ ...original[0]!, text: 'edited' }, ...original.slice(1)];
    expect(buildAnalyzeMessages(current, store.get('one'))).toEqual([
      { speakerRole: 'assistant', speakerIndex: -1, text: '1' },
      ...current,
    ]);
  },
);

it('snapshots direct engine inputs and anchors before awaiting automatic creation', async () => {
  const requests: AnalyzeRequestBody[] = [];
  let release!: () => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      if (url.endsWith('/api/conversation')) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return Response.json({ id: 'backend' });
      }
      requests.push(JSON.parse(init.body));
      return Response.json(requests.length);
    }),
  );
  const engine = createCaesuraEngine({
    apiKey: 'test',
    mode: 'async',
    autoCreateConversation: true,
  });
  const input = [message(7)];
  const snapshot = structuredClone(input);
  await engine.observe('local', input);
  input[0]!.text = 'changed';
  input[0]!.speakerIndex = 99;
  input.push(message(9));
  release();
  await vi.waitFor(() =>
    expect(engine.store.get('local').inFlight).toBe(false),
  );
  expect(requests[0]!.messages).toEqual(snapshot);
  expect(engine.store.get('local').recommendations[0]!.afterMessageAnchor).toBe(
    dialogueAnchors(snapshot)[0],
  );
  await engine.observe('local', [...snapshot, message(8)]);
  await vi.waitFor(() =>
    expect(engine.store.get('local').inFlight).toBe(false),
  );
  expect(requests[1]!.messages).toEqual([
    snapshot[0],
    { speakerRole: 'assistant', speakerIndex: -1, text: '1' },
    message(8),
  ]);
});

it('anchors before character trimming and preserves explicit indices', async () => {
  const requests: AnalyzeRequestBody[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json(requests.length);
    }),
  );
  const engine = createCaesuraEngine({
    apiKey: 'test',
    mode: 'sync',
    send: { maxInputChars: 20 },
  });
  const first = { ...message(7), text: 'a long message that is trimmed' };
  await engine.observe('one', [first]);
  expect(requests[0]!.messages).toEqual([
    { ...first, text: first.text.slice(-20) },
  ]);
  expect(engine.store.get('one').recommendations[0]!.afterMessageAnchor).toBe(
    dialogueAnchors([first])[0],
  );
  const second = { ...message(8), text: 'next' };
  await engine.observe('one', [first, second]);
  expect(requests[1]!.messages).toEqual([
    { ...first, text: first.text.slice(-16) },
    second,
  ]);
});

it.each(['text/plain', 'application/json'])(
  'preserves string history and its exact character budget from %s',
  async (contentType) => {
    const requests: AnalyzeRequestBody[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return new Response(
          contentType === 'text/plain' ? 'hello' : JSON.stringify('hello'),
          { headers: { 'content-type': contentType } },
        );
      }),
    );
    const engine = createCaesuraEngine({
      apiKey: 'test',
      mode: 'sync',
      send: { maxInputChars: 10 },
    });
    await engine.observe('one', [{ speakerRole: 'user', text: 'a' }]);
    await engine.observe('one', [
      { speakerRole: 'user', text: 'a' },
      { speakerRole: 'user', text: 'next' },
    ]);
    expect(requests[1]!.messages).toEqual([
      {
        speakerRole: 'user',
        speakerName: 'Customer',
        speakerIndex: 1,
        text: 'a',
      },
      { speakerRole: 'assistant', speakerIndex: -1, text: 'hello' },
      {
        speakerRole: 'user',
        speakerName: 'Customer',
        speakerIndex: 1,
        text: 'next',
      },
    ]);
    expect(requests[1]!.messages.reduce((n, m) => n + m.text.length, 0)).toBe(
      10,
    );
  },
);

// Shared with the Python SDK for the lightweight prefix fingerprint contract.
import anchorVectors from './fixtures/dialogue-anchors.json';
it.each(anchorVectors)(
  'matches dialogue anchor reference vector: $name',
  ({ messages, anchors }) => {
    expect(dialogueAnchors(messages as AnalyzeMessage[])).toEqual(anchors);
  },
);
