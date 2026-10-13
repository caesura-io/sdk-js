# Conversations and persistence

Create a conversation once with `createConversation({ name?, calendarId?, eventId? })` on the core engine, OpenAI client or AI SDK middleware. Retain the returned backend ID and pass it as `conversationId` on every subsequent call. Create another conversation when the user starts a new chat.

An ID does not load history: your application supplies provider dialogue and restores SDK state as needed. `clear(id)` resets guidance state; it neither deletes nor creates a backend conversation. IDs remain required with `persist: false`. Missing IDs and the removed `autoCreateConversation` option are configuration errors.

Creation supports cancellation/deadlines and propagates errors without automatic retries. A service may finish creation after cancellation, so reconcile an uncertain result before retrying. The optional `conversation-created` event is observational; use the returned ID.

## Transcript persistence

By default, HTTP analysis persistence saves the analyzed customer message and its analysis. It does **not** archive contextual messages, greetings, cadence-skipped turns or generated agent replies. The SDK does not call a transcript-append endpoint.

To save full text dialogue in your application, configure `persistMessages`:

```ts
const client = createCaesura(openai, {
  failurePolicy: 'throw',
  async persistMessages({ correlation, messages }) {
    await transcript.upsert(correlation.conversationId, messages);
  },
});
const conversationId = await client.createConversation();
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

Messages contain `id`, `role: 'customer' | 'agent'`, `text` and optional speaker name/index. Upsert by `(conversationId, role, id)` because retries may repeat writes. Customer text is captured before cadence/input limits. Completed agent text is captured from the provider response. Tool activity, reasoning, retrieval and injected guidance are excluded. Explicit turn identity and dialogue selection must distinguish customer text from application-generated user messages.

Customer writes are awaited before analysis/generation, including in background analysis mode. Agent writes are awaited before response delivery or final stream completion. Under `failurePolicy: 'throw'`, a failed write rejects with a `store` error; an agent write can fail after paid model work has completed. Under `continue`, errors are reported and delivery proceeds. Cancellation is never swallowed. Use idempotent storage: transcript, analysis and SDK state writes are not one transaction.

`recordMessages` saves application-owned messages such as greetings without triggering analysis. Provider response IDs identify generated messages where available; otherwise invocation-based IDs are used. Supply stable invocation IDs when retrying without a provider response ID. These hooks archive text only; use provider audit events for other modalities.

## Streaming outcomes

Audit events include `request`, `response`, `stream-start`, `chunk`, `error` and `stream-end`. Terminal status is `completed`, `cancelled`, `failed` or `incomplete`.

A completed stream requires protocol finish evidence: a Chat choice-0 finish reason, Responses `response.completed`, or an AI SDK finish part. EOF alone is `incomplete`. Partial, cancelled, failed and incomplete output is not saved as a completed agent message; it remains available in audit events. Later usage is retained, and errors after a finish marker still fail the stream.

Protocol completion does not guarantee complete content: finish reasons such as `length` remain available for application policy. A transcript write may fail after provider completion; the completed audit outcome and storage error are reported separately.

Consume or cancel streams to observe their outcomes. OpenAI raw `asResponse()` and delegated helpers such as `tee()`/`toReadableStream()` bypass the iterator observer; use normal async iteration for transcript capture or handle those paths yourself. Engine shutdown signals cancellation but cannot read abandoned streams or stop an uncooperative provider.

## SDK diagnostics

Creation, analysis and audit correlation carry the SDK language, core package/version, optional adapter package/version, transport and runtime. Versions come from installed packages. HTTP requests send this identity in `x-caesura-sdk-*` headers.

| Header suffix                             | Value                                       |
| ----------------------------------------- | ------------------------------------------- |
| `language`                                | `javascript`                                |
| `core-name`, `core-version`               | Core package name and version               |
| `integration-name`, `integration-version` | Adapter package name and version, when used |
| `transport`                               | `http`                                      |
| `runtime-name`, `runtime-version`         | Runtime identity, when available            |

These values are diagnostics, not authorization. SDK identity and private correlation metadata stay outside model prompts. Arbitrary correlation metadata is local to hooks; it is not sent in HTTP bodies or headers.

See [runnable examples](https://github.com/caesura-io/examples-sdk-js) for conversation creation and reuse, and [advanced integrations](application-adapters.md) for stores, cancellation and auditing.
