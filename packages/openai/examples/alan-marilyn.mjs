/* global fetch, AbortSignal */
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import OpenAI from 'openai';
import { createCaesura } from '../dist/index.js';
import { createCaesuraEngine, MemoryCaesuraStore } from '@caesura-io/core';

// Build the local packages first. Both credentials must be supplied through the environment.
assert.ok(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY is required');
assert.ok(process.env.CAESURA_API_KEY, 'CAESURA_API_KEY is required');
const baseUrl = 'https://api.caesurao.com';
const resultPath = process.env.CAESURA_EXAMPLE_RESULT_PATH;
const requests = [];
const errors = [];
const transcript = [];
const config = {
  apiKey: process.env.CAESURA_API_KEY,
  baseUrl,
  mode: 'sync',
  persist: true,
  timeoutMs: 60000,
  speakerNames: { customer: 'Alan', agent: 'Marilyn SDR' },
  store: new MemoryCaesuraStore(),
  onError: (error) => errors.push(error),
  onEvent: (event) => {
    if (event.type === 'request') requests.push(event.body);
  },
};
const client = createCaesura(
  new OpenAI({ maxRetries: 0, timeout: 60000 }),
  config,
);
// The wrapper observes model INPUT. Explicitly observe each generated reply too,
// sharing the store so all four utterances get analyzed once in this conversation.
const observer = createCaesuraEngine(config);
const messages = [
  {
    role: 'system',
    content:
      'You are Marilyn SDR, a sales representative speaking with Alan about CaesuraO, which provides real-time conversation analysis and guidance to agents. Reply in exactly one concise sentence per turn, with no bullet points or abbreviations; ask one relevant question or address his concern without inventing product capabilities, pricing, or results.',
  },
];
let conversationId;
async function checkpoint(extra = {}) {
  if (resultPath)
    await writeFile(
      resultPath,
      JSON.stringify(
        { conversationId, transcript, requests, ...extra },
        null,
        2,
      ) + '\n',
    );
}
function checkAnalysisErrors() {
  if (errors.length)
    throw new Error(
      `CaesuraO analysis failed: ${errors.map((error) => (error instanceof Error ? error.message : String(error))).join('; ')}`,
    );
}

try {
  conversationId = await client.createConversation({
    name: 'Alan and Marilyn SDR — four-sentence SDK example',
  });
  console.log(`Conversation: ${conversationId}`);
  await checkpoint();
  for (const text of [
    "I'm Alan, and our sales team struggles to notice when prospects lose interest during calls.",
    'I like the idea, but I worry that real-time guidance will distract our reps.',
  ]) {
    messages.push({ role: 'user', content: text });
    transcript.push({ text, speakerName: 'Alan', speakerIndex: 1 });
    console.log(`Alan: ${text}`);
    const response = await client.chat.completions.create(
      {
        model: 'gpt-5.4-mini',
        messages,
        max_completion_tokens: 600,
      },
      { caesura: { conversationId } },
    );
    checkAnalysisErrors();
    const reply = response.choices[0]?.message.content;
    assert.ok(reply?.trim(), 'OpenAI returned no agent text');
    messages.push({ role: 'assistant', content: reply });
    transcript.push({
      text: reply,
      speakerName: 'Marilyn SDR',
      speakerIndex: 0,
    });
    console.log(`Marilyn SDR: ${reply}`);
    await observer.observe(
      conversationId,
      transcript.map((utterance) => ({
        ...utterance,
        speakerRole: 'user',
      })),
    );
    checkAnalysisErrors();
    await checkpoint();
  }
  assert.equal(requests.length, 4);
  requests.forEach((request, index) => {
    assert.equal(request.currentUser, 'Marilyn SDR');
    assert.equal(request.sessionId, conversationId);
    assert.equal(request.persist, true);
    assert.deepEqual(request.messages.at(-1), {
      ...transcript[index],
      speakerRole: 'user',
    });
    for (const message of request.messages.filter(
      (m) => m.speakerRole === 'assistant',
    ))
      assert.equal(message.speakerIndex, -1);
  });
  const fetched = await fetch(
    `${baseUrl}/api/conversation?conversationId=${encodeURIComponent(conversationId)}`,
    {
      headers: { authorization: `Bearer ${process.env.CAESURA_API_KEY}` },
      signal: AbortSignal.timeout(15000),
    },
  );
  assert.equal(fetched.status, 200, 'Fetching the saved conversation failed');
  const result = await fetched.json();
  assert.equal(result.success, true);
  const rows = result.conversation.analyses;
  rows.sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id,
  );
  assert.deepEqual(
    rows.map(({ text, speakerName, speakerIndex }) => ({
      text,
      speakerName,
      speakerIndex,
    })),
    transcript,
  );
  await checkpoint({ verified: true, persistedRows: rows });
  console.log(
    'Verified four persisted utterances, indices [1,0,1,0], and currentUser="Marilyn SDR" on all requests.',
  );
} catch (error) {
  await checkpoint({ verified: false, error: error.message });
  console.error(error.message);
  process.exitCode = 1;
}
