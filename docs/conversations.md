# Conversations and persistence

Create a conversation once with `createConversation({ name?, calendarId?, eventId? })` on the core engine, OpenAI client or AI SDK middleware. On success, retain the returned backend ID and pass it as `conversationId` on every subsequent call. Create another conversation when the user starts a new chat.

An ID does not load history: your application supplies provider dialogue and restores SDK state as needed. `clear(id)` resets guidance state; it neither deletes nor creates a backend conversation. Stateful calls require an ID even with `persist: false`. Use the explicit stateless option below to proceed without one. Otherwise a missing ID is a configuration error, as is the removed `autoCreateConversation` option.

Creation supports cancellation/deadlines without automatic retries. Under `continue`, a recoverable transport failure or dependency timeout is reported and returns `undefined`; under `throw`, it rejects. Caller interruption, invalid configuration and unsupported creation always reject. A service may finish creation after cancellation, so reconcile an uncertain result before retrying. The optional `conversation-created` event is observational; use the returned ID.

## Continuing without hosted storage

With the default `failurePolicy: 'continue'`, a failed hosted customer-message save is reported through `onError`/`onEvent` and that invocation attempts analysis with `persist: false`, without backend conversation or transcript references. Successful guidance is injected according to the analysis mode; failed analysis leaves any previous usable guidance intact. Failed reply saves are reported without withholding the provider reply. Future calls still attempt persistence. `throw` rejects storage failures instead. Hosted counter-read and append timeouts also permit fallback while the caller remains active. Analysis receives a fresh `timeoutMs` budget, bounded by the remaining caller deadline; an analysis timeout under continue still permits generation. Caller cancellation/deadline expiry and required application hooks are never bypassed.

`createConversation()` returns `Promise<string | undefined>`. An undefined result requires an explicit choice to proceed without hosted storage:

```ts
const conversationId = await client.createConversation({
  name: 'Support request',
});
await client.responses.create(
  { model: 'your-model', input: 'I have a question.' },
  { caesura: conversationId ? { conversationId } : { stateless: true } },
);
```

The example assumes the default continue policy. For AI SDK, use the same options in `providerOptions.caesura`. Stateless calls cannot also supply a conversation ID; they ignore a configured default ID, use isolated invocation state, and never create a conversation. Application hooks still run, with `correlation.conversationId` absent. Use synchronous mode for guidance in that call. Background stateless analysis remains observable through completion hooks and `caesura.flush()`, but its guidance is not reused by later calls. Core callers can use `engine.createStatelessScope()` and pass `undefined` as its conversation ID; the parent tracks its background work for flush/shutdown.

Correlation records expose `persistence: 'disabled'` for stateless analysis and `'requested'` when hosted analysis persistence was requested; the latter is not proof of a completed write. Audits retain a supplied conversation ID for local correlation even when the analysis request omits it. No failed creation emits a success event or fabricates an ID. Error callbacks are opt-in; the SDK does not print failures to the console.

## Transcript persistence

By default, the HTTP transport saves new customer messages, completed agent replies and analyses to CaesuraO. Customer turns are saved even when analysis cadence skips a turn. Only customer messages trigger analysis. Previously supplied history is not imported automatically; use `recordMessages` for application-generated greetings or other completed dialogue.

`persist: false` disables saving transcripts and analyses to CaesuraO. Your configured application storage callbacks still run.

To additionally save text dialogue in your own application, configure `persistMessages`:

```ts
const client = createCaesura(openai, {
  failurePolicy: 'throw',
  async persistMessages({ correlation, messages }) {
    await transcript.upsert(correlation.conversationId, messages);
  },
});
const conversationId = await client.createConversation();
if (!conversationId) throw new Error('A saved conversation is required here.');
await client.caesura.recordMessages(conversationId, [
  { id: 'greeting-1', role: 'agent', text: 'Welcome. How can I help?' },
]);
await client.responses.create(
  { model: 'your-model', input: 'I have a question.' },
  {
    caesura: { conversationId, turn: { id: 'customer-1', origin: 'customer' } },
  },
);
```

Messages contain `id`, `role: 'customer' | 'agent'`, `text` and optional speaker name/index. Use unique IDs per conversation and retry the same completed message with the same ID. Reusing an ID with different text or speaker index is rejected; application storage should likewise upsert by `(conversationId, id)`. Use a durable SDK store to recognize retries across restarts. Without that state, previously submitted messages may be saved again. Coordinate concurrent writes to the same conversation. Customer text is captured before cadence/input limits. Completed agent text is captured from the provider response. Tool activity, reasoning, retrieval and injected guidance are excluded. Explicit turn identity and dialogue selection must distinguish customer text from application-generated user messages. A customer turn whose selected dialogue ends in an agent message is rejected before any upload or analysis.

When configured, the required application hook runs before the backend upload; its input is an isolated snapshot. Customer writes are awaited before analysis/generation, including in background analysis mode. Agent writes are awaited before response delivery or final stream completion. Under `failurePolicy: 'throw'`, a failed write rejects with a `store` error; an agent write can fail after paid model work has completed. Under `continue`, errors are reported and delivery proceeds; hosted customer-storage failures permit stateless analysis, while a failed required application transcript hook skips analysis. Caller interruption and required application-hook timeouts reject in either mode. Hosted-operation timeouts follow the storage failure policy. Use idempotent storage: transcript, analysis and SDK state writes are not one transaction.

`recordMessages` saves messages to the backend when persistence is enabled and also calls your configured application hook. It handles application-generated messages such as greetings without triggering analysis. Provider response IDs identify generated messages where available; otherwise invocation-based IDs are used. Supply stable invocation IDs when retrying without a provider response ID. These hooks archive text only; use provider audit events for other modalities.

## Streaming outcomes

Audit events include `request`, `response`, `stream-start`, `chunk`, `error` and `stream-end`. Terminal status is `completed`, `cancelled`, `failed` or `incomplete`.

A completed stream requires protocol finish evidence: a Chat choice-0 finish reason, Responses `response.completed`, or an AI SDK finish part. EOF alone is `incomplete`. Partial, cancelled, failed and incomplete output is not saved as a completed agent message; it remains available in audit events. Later usage is retained, and errors after a finish marker still fail the stream.

Protocol completion does not guarantee complete content: finish reasons such as `length` remain available for application policy. A transcript write may fail after provider completion; the completed audit outcome and storage error are reported separately.

Consume or cancel streams to observe their outcomes. OpenAI raw `asResponse()` and delegated helpers such as `tee()`/`toReadableStream()` bypass the iterator observer; use normal async iteration for transcript capture or handle those paths yourself. Engine shutdown signals cancellation but cannot read abandoned streams or stop an uncooperative provider.

## SDK diagnostics

SDK requests and audit events include the SDK language, package versions, and runtime for troubleshooting. This information is separate from model prompts. Application correlation metadata stays in your local hooks and is not sent to CaesuraO.

See [runnable examples](https://github.com/caesura-io/examples-sdk-js) for conversation creation and reuse, and [advanced integrations](application-adapters.md) for stores, cancellation and auditing.
