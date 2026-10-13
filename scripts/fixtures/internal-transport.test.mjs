/* global AbortController, structuredClone */
// Internal transport regression: no credentials, fetch replacement or network.
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wrapLanguageModel } from '../../packages/ai-sdk/node_modules/ai/dist/index.js';
import {
  caesuraMiddleware,
  MemoryCaesuraStore,
} from '../../packages/ai-sdk/dist/index.js';

test('internal transport, detached store, transcript and cancellation lifecycle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'caesura-internal-test-'));
  const path = join(directory, 'state.json');
  await writeFile(path, '{}');
  // Detached values + explicit asynchronous writes. One engine owns this file.
  // Multiple workers require an application-owned distributed conversation lock.
  let fileOperations = Promise.resolve();
  const serialized = (operation) => {
    const result = fileOperations.then(operation);
    fileOperations = result.catch(() => {});
    return result;
  };
  const store = {
    get(id) {
      return serialized(async () => {
        const data = JSON.parse(await readFile(path, 'utf8'));
        return data[id] ?? new MemoryCaesuraStore().get(id);
      });
    },
    set(id, state) {
      return serialized(async () => {
        const data = JSON.parse(await readFile(path, 'utf8'));
        data[id] = state;
        await writeFile(path + '.tmp', JSON.stringify(data));
        await rename(path + '.tmp', path);
      });
    },
    clear(id) {
      return serialized(async () => {
        const data = JSON.parse(await readFile(path, 'utf8'));
        delete data[id];
        await writeFile(path, JSON.stringify(data));
      });
    },
    clearAll() {
      return serialized(() => writeFile(path, '{}'));
    },
  };
  const completed = [];
  const captured = [];
  async function applicationAnalysis(input, context) {
    await delay(10, undefined, { signal: context.signal });
    return {
      analysis: {
        recommendation: 'Ask one relevant clarifying question.',
        evidence: input.messages.at(-1).text,
      },
      requestId: context.analysisId,
      usage: { inputTokens: 12, outputTokens: 8 },
      metadata: { service: 'internal-test' },
    };
  }
  const transcript = new Map();
  const middleware = caesuraMiddleware({
    transport: {
      analyze: applicationAnalysis,
      async createConversation() {
        // This local application service owns and returns the identity.
        return 'test-owned-conversation';
      },
    },
    persistMessages: async ({ correlation, messages }) => {
      for (const message of messages)
        transcript.set(
          JSON.stringify([
            correlation.conversationId,
            message.role,
            message.id,
          ]),
          structuredClone(message),
        );
    },
    store,
    mode: 'sync',
    failurePolicy: 'throw',
    // Application owns the actual authorization, billing and durable result write.
    persistAnalysis: async (record) => {
      completed.push(structuredClone(record));
    },
    onProviderEvent: (event) => {
      captured.push(event);
    },
    onError: () => {},
  });
  const base = {
    specificationVersion: 'v4',
    provider: 'internal-test',
    modelId: 'deterministic',
    supportedUrls: {},
    async doGenerate(params) {
      const audit = captured.findLast((e) => e.type === 'request');
      assert.deepEqual(audit.parameters.prompt, params.prompt);
      assert.match(JSON.stringify(params.prompt), /CONVERSATION ANALYSIS/);
      assert.equal(params.providerOptions.caesura, undefined);
      return {
        content: [{ type: 'text', text: 'What would you like to clarify?' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 12 }, outputTokens: { total: 8 } },
        warnings: [],
      };
    },
  };
  const model = wrapLanguageModel({ model: base, middleware });
  const conversationId = await middleware.createConversation();
  await middleware.caesura.recordMessages(conversationId, [
    { id: 'greeting', role: 'agent', text: 'Welcome!' },
  ]);
  const parameters = {
    prompt: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'I need more information.' }],
      },
    ],
    providerOptions: {
      caesura: {
        conversationId,
        turn: { id: 'customer-1', origin: 'customer' },
        metadata: { traceId: 'test-1' },
      },
    },
  };
  try {
    await model.doGenerate(parameters);
    await model.doGenerate(parameters); // Provider retry, same customer turn: reuse guidance.
    assert.equal(completed.length, 1);
    assert.equal(
      [...transcript.values()].filter((m) => m.role === 'customer').length,
      1,
    );
    assert.equal(
      [...transcript.values()].filter((m) => m.role === 'agent').length,
      3,
    );
    assert.equal(
      captured.find((e) => e.type === 'request').correlation.conversationId,
      conversationId,
    );
    const reloaded = await store.get(conversationId);
    assert.deepEqual(reloaded.processedTurnIds, ['customer-1']);
    assert.equal(reloaded.injectedMessages.length, 1);

    const background = caesuraMiddleware({
      transport: { analyze: applicationAnalysis },
      mode: 'async',
      onError: () => {},
    });
    const controller = new AbortController();
    await background.caesura.observe(
      conversationId,
      [{ speakerRole: 'user', text: 'A distinct turn' }],
      {
        turn: { id: 'customer-2', origin: 'customer' },
        signal: controller.signal,
      },
    );
    controller.abort();
    const results = await background.caesura.flush();
    assert.equal(results[0].status, 'cancelled');
    await background.caesura.shutdown();
  } finally {
    await middleware.caesura.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
