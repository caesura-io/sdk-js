# Stores, cancellation and auditing

Use these options when your integration needs durable guidance state, full transcript storage or model-request auditing.

## Customer turns and trusted dialogue

Pass `turn: { id, origin: 'customer' }` for each genuine customer event. Reuse that ID for repeated provider calls and tool continuations; distinct customer messages need distinct IDs, even when their text matches. `origin: 'internal'` injects existing guidance without triggering analysis.

When provider input includes RAG or application-generated user messages, supply `dialoguePositions`: increasing indices of real participant messages in the original input. Alternatively, supply trusted `dialogue`, with `origin: 'customer' | 'agent' | 'internal'` on its entries. Internal entries are excluded. Put the current customer utterance last. Supply matching `dialoguePositions` with detached dialogue when exact injection placement matters; otherwise unmatched guidance falls back to the latest context.

Without explicit selection, wrappers infer a turn only when the last input message is a user message. They cannot distinguish application-generated user text or identical single-message requests. Use explicit turn IDs and selection for these cases.

Accepted turns run FIFO per conversation and advance cadence once. The SDK does not automatically retry failed operations. Retry failed customer storage with the same turn ID. Hosted storage failure can still produce a successful stateless analysis; retrying that turn attempts storage again without repeating accepted analysis. Once a turn has been accepted for analysis, reusing its ID does not rerun analysis; reconcile its outcome before submitting a new turn. Retain durable SDK state to recognize message retries across restarts.

## Cancellation and background work

`mode: 'sync'` waits for analysis before generation. `mode: 'async'` injects guidance available when the invocation starts and completes analysis in the background.

- `engine.flush(conversationId?)` waits for accepted analysis and transcript work and returns analysis completion records, including results and errors. Standalone transcript failures are reported through `recordMessages()` and error hooks, not as analysis completions. Drain it regularly. ID-free stateless scopes are included by `flush()` without an ID.
- `engine.clear(id)` and `clearAll()` cancel work before clearing guidance state; do not clear the store directly.
- `engine.shutdown()` rejects new work and cancels accepted work. `shutdown({ cancel: false })` drains it instead.

The engine is available as `client.caesura` (OpenAI) or `middleware.caesura` (AI SDK). Native provider signals and SDK lifecycle cancellation propagate to analysis and provider calls. Storage and analysis have separate `timeoutMs` budgets. Analysis queue waiting after transcript storage counts against its budget; both stages respect the caller deadline. Cancellation is reported as `cancelled`, deadline expiry as `timeout`.

Cancellation prevents late results from becoming active guidance. A noncooperative analysis may still complete paid work: completion hooks and a later parent `flush()` expose its result and usage, even after shutdown. Flush/shutdown do not wait indefinitely for it. Parent shutdown rejects new analysis in retained stateless scopes, including graceful shutdown; accepted stream finalization can still finish required writes. Shutdown cannot forcibly stop application code or consume an unread provider stream.

## Required persistence and failure handling

`failurePolicy: 'continue'` permits generation after analysis or storage failure. Use `throw` with synchronous mode when analysis and required writes must succeed first. Background failures cannot reject an already returned provider call. Cancellation always rejects a pending foreground call. Hosted transcript failures permit per-invocation stateless analysis; see [storage fallback](conversations.md#continuing-without-hosted-storage). Explicit application hooks are not bypassed by that fallback.

Core `observe()` retains its `Promise<void>` return type. `observeWithPersistence()` additionally returns the invocation’s analysis persistence mode (`requested` or `disabled`), or `undefined` when no analysis persistence mode is selected. It does not assert that an analysis or backend write completed; use completion records for outcomes.

| Hook                                                                     | Purpose                                                                                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `persistAnalysis(completion)`                                            | Await durable storage of a successful analysis before committing guidance.                                                     |
| `persistMessages(batch)`                                                 | Await customer and completed agent transcript writes; see [conversation persistence](conversations.md#transcript-persistence). |
| `persistProviderRequest(event, context)`                                 | Await final request storage before calling the model.                                                                          |
| `onEvent`, `onCompletion`, `onCreditUsage`, `onProviderEvent`, `onError` | Observe results; callback errors are isolated.                                                                                 |

Required write failures are `CaesuraError` values with kind `store` and the original `cause`. Other kinds include `transport`, `timeout`, `cancelled`, `configuration`, `unsupported` and audit-reported `provider` errors. Provider calls retain their native errors. Result storage and SDK state writes are separate operations; use correlation IDs for idempotency and recovery.

## Stores and multiple workers

A custom `CaesuraStore` implements `get`, `set`, `clear` and `clearAll`; methods may return values or promises. `get` returns an empty state for an unknown ID. The SDK awaits every `set` and supports detached/deserialized values. State contains guidance, processed turn IDs, cadence and injection tracking; deprecated `inFlight` is always false.

One engine serializes work per conversation. Transcript hooks and uploads run in submission order. Queue waiting counts against the transcript timeout. Cancelling a queued write skips it without allowing later writes to overtake earlier work. `flush()` and graceful shutdown also await accepted transcript writes. An application hook that ignores cancellation may still finish its own write; cancellation cannot roll it back.

Across engines or workers, the application must coordinate conversation ownership from state selection through analysis, injection and background completion. A shared database/Redis store alone does not provide that coordination. Restore both provider dialogue and SDK state when resuming; the conversation ID alone restores neither.

## Final provider audit

`onProviderEvent` observes SDK-prepared requests after guidance injection, native responses/chunks and errors. Requests include model settings, tools, correlation and injected analysis IDs. Credentials and headers are excluded; do not put secrets in prompt/settings or correlation metadata. These are provider parameters, not wire bytes.

For required storage:

```ts
persistProviderRequest: async (event, { signal, deadline }) => {
  await applicationAudit.save(event, { signal, deadline });
},
```

Native cancellation and an explicit per-call `caesura.deadline` apply while awaiting this hook. Cancellation/timeout prevents the provider invocation under either failure policy. The analysis `timeoutMs` does not bound audit storage; configure an explicit deadline. Hooks should honor the signal: cancellation cannot roll back completed writes or interrupt synchronous code. Late completion cannot restart the model call.

With AI SDK, place an external audit middleware inside Caesura so it sees the injected request:

```ts
const auditedBase = wrapLanguageModel({
  model: base,
  middleware: auditMiddleware,
});
const model = wrapLanguageModel({
  model: auditedBase,
  middleware: caesuraMiddleware(config),
});
```

Keep other request-transforming middleware outside the final audit wrapper. For OpenAI, wrap the base client with your audit layer before passing it to `createCaesura`. Observers cannot capture transformations made later by another wrapper or the provider.

Audit snapshots preserve native URL and binary values. Your sink must serialize them appropriately; opaque provider handles retain identity. Streaming observations follow consumption without eagerly reading the stream. See [streaming outcomes](conversations.md#streaming-outcomes) for incomplete responses and raw-stream limitations.

## Skill prompt placement

Chat Completions appends `skillPrompt` to the last existing system or developer
message, preserving its role and content parts. AI SDK middleware does the same
for its supported system role. Before inserting, each adapter checks all eligible
instruction messages for the exact, case-sensitive prompt text. An existing match
leaves instructions unchanged; otherwise a system message is prepended when none
exists. Responses uses its `instructions` field and checks both that field and
system/developer input messages for an existing match. Reusing transformed requests
does not duplicate the prompt. Empty or whitespace-only `skillPrompt` disables it.

This changes neither the default prompt wording nor analysis-message placement.
Caller inputs and provider metadata remain intact, dialogue position mappings are
adjusted when prepending, and finalized audit capture includes the resulting input.
