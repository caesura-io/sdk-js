# @caesura-io/ai-sdk

Asynchronous, non-blocking recommendation injection for the [Vercel AI SDK](https://ai-sdk.dev).

CaesuraO listens to your agent's dialogue and pushes short, real-time
recommendations ("analysis") into the model's context _before the next call_ —
without blocking the conversation. It plugs in as a standard AI SDK language
model middleware.

> **Status:** early development. API is not yet stable.

## Install

```bash
npm i @caesura-io/ai-sdk ai
```

## Quick start

Wrap your existing model with `caesuraMiddleware` — the only changes to your code are the highlighted lines:

```diff
 import { wrapLanguageModel, generateText } from 'ai';
 import { anthropic } from '@ai-sdk/anthropic';
+import { caesuraMiddleware } from '@caesura-io/ai-sdk';

-const model = anthropic('claude-sonnet-4-6');
+const model = wrapLanguageModel({
+  model: anthropic('claude-sonnet-4-6'),
+  middleware: caesuraMiddleware({
+    autoCreateConversation: true,
+    // apiKey auto-read from CAESURA_API_KEY if omitted
+  }),
+});

 const result = await generateText({
   model,
   messages: conversation,
+  providerOptions: { caesura: { conversationId: sessionId } },
 });
```

## Conversations and persistence

`baseUrl` defaults to `https://api.caesurao.com`. Your account determines the environment;
most applications do not need a URL override. `CAESURA_API_KEY` remains unchanged.

`persist` defaults to `true`. Persistence requires a backend conversation ID:
a local label or generated UUID alone does not create a conversation. Choose one of these approaches:

- **Explicit creation (default):** create once, save the returned ID, and reuse it on every turn.
- **Automatic creation:** set `autoCreateConversation: true` and pass a stable, unique local session label.
  The SDK creates a backend conversation before its first analysis and reuses it, including after analysis failures.
  Overlapping observations share the same creation. Empty dialogue and `persist: false` skip creation.

Automatic creation defaults to `false`. Its local-label mapping is stored in memory by default and
is lost on eviction, clearing, or restart; use explicit IDs for durable reuse. Use a distinct ID or label
for each independent conversation.

If neither a per-call nor configured ID is supplied, JS uses the shared `"default"` session.
A client serving multiple users must supply distinct IDs or labels.
Creation failures from `createConversation()` reject its promise;
automatic failures go to `onError` and leave the model call running.

```ts
const middleware = caesuraMiddleware({});
const conversationId = await middleware.createConversation({
  name: 'Support session',
});
const model = wrapLanguageModel({
  model: anthropic('claude-sonnet-4-6'),
  middleware,
});
// Save conversationId; reuse it on subsequent calls.
await generateText({
  model,
  prompt: 'Hello!',
  providerOptions: { caesura: { conversationId } },
});
```

`createConversation({ name?, calendarId?, eventId? })` calls `POST /api/conversation`
and returns a validated backend ID string. Set `persist: false` to analyze without backend storage.
Ordinary SDK analysis requests omit `notifyIntegrations` and do not override the backend's default `callType`.

## Analysis and limits

Responses are preserved as returned: JSON objects, arrays, strings, numbers, booleans, or null,
and plain text. `{analysis}` renders the complete value; `{analysis.field}` reads the exact object key.
Zero and false are valid guidance. Empty values are not buffered. Only boolean `isSame` or `is_same`
metadata suppresses duplicates; deduplication depends on the backend returning that signal.

Only user and assistant text is analyzed. System/developer instructions, tool metadata/results,
and reasoning items are excluded. Tool results remain adjacent to their assistant tool calls.
The skill prompt stays in system/developer instructions, independently of the analysis injection role.

`send.maxMessages` (default `10`) and `send.maxInputChars` cap the actual outgoing analysis request,
including prior analyses. Newest dialogue has priority; history uses the remaining budget.
Zero disables analysis. `inject.keepLast: 0` disables recommendation injection while retaining history.
Negative limits are rejected. Model input and caller-owned messages are preserved.

## Reusing injected history

Previously emitted guidance is tracked per stored conversation by provider role
and exact rendered text, including older merged blocks. Before analysis and
injection, recognized anonymous text-only guidance messages are removed from reused
history; only currently eligible guidance is inserted again. This avoids duplicate
injections and removes expired guidance or guidance excluded by `keepLast`.
Named messages, explicit speaker indices, tool calls, and multimodal content are
preserved. Messages with a different provider role are not mistaken for guidance.
Keep application dialogue separate from injected requests when possible; an
anonymous message with the same role and exact text as prior SDK guidance is
indistinguishable after serialization.

## Credit Usage Reporting

You can request credit-usage metadata on every analyze call and receive the reported value via the `onCreditUsage` callback.

```diff
+import { caesuraMiddleware, createCreditMeter } from '@caesura-io/ai-sdk';
+
+const meter = createCreditMeter();

 const model = wrapLanguageModel({
   model,
   middleware: caesuraMiddleware({
     autoCreateConversation: true,
+    onCreditUsage: meter.record,
   }),
 });

+// Query credit metrics later
+console.log('total credits consumed:', meter.total());
+console.log('credits by conversation:', meter.breakdown());
+console.log('retained credit events:', meter.events());
```

> [!NOTE]
> In `async` mode, the `onCreditUsage` callback fires out-of-band as soon as the asynchronous analyze call completes, decoupled from the synchronous `generateText` response.

## Backend message roles and persistence

Every analysis request sets `currentUser` to `speakerNames.agent` (default `"Agent"`).
This identifies the guidance recipient even on customer turns; per-message name
overrides affect only the message, not `currentUser`.

`/api/analyze` uses `speakerRole` for the analysis prompt: both customer and agent
**dialogue** are sent as `"user"`, with identity preserved by `speakerName` and
`speakerIndex` (`1` for customer, `0` for agent). Explicit indices survive copying
and trimming. Previous CaesuraO analyses use `"assistant"` with index `-1`. JSON-formatted agent dialogue is
still dialogue; its content is never used to reclassify it as an analysis.

The backend persists the last outbound message as the current utterance. The SDK
keeps that dialogue message last, even if repeated text matches an earlier
analysis anchor. Retained analyses stay before it and use only the remaining
message/character budget. These backend adaptations do not change the original
roles or messages sent to the model provider.

Analyses are anchored to the dialogue prefix through the analyzed turn, including
speaker names and indices, before SDK send limits are applied. Repeated dialogue
therefore keeps its original analysis order, including with
`placement: "after-last-analyzed"`. Pass growing dialogue history to retain those
positions. If callers edit or remove earlier history, unmatched analyses use the
latest-context fallback instead of attaching to another identical utterance.
Background analysis snapshots the collected dialogue before awaiting work.
The prefix fingerprint uses FNV-1a/64 over UTF-16 code units; it is local occurrence
metadata, not a security hash or a backend field.

Similarity calculation and duplicate suppression are separate: `calculateSimilarities`
defaults to `true`, while `similarityThreshold` is omitted unless you configure it.
Calculating similarities alone does not enable threshold suppression. The SDK forwards
both options unchanged and buffers no new guidance when the backend returns boolean
`isSame: true`; it retains previous guidance and still sends subsequent dialogue turns
for analysis and persistence, subject to the configured cadence and in-flight guard.

## Text budgets and migration

Text parts concatenate without added separators. Character limits count Unicode
code points. Newest dialogue takes priority, with a suffix of the oldest retained
message using any remaining space. Whole analyses then use the remaining budget
newest-first, stopping when the next analysis cannot fit. Missing-anchor analyses
collapse to one latest leading context entry before budgeting. Objects and arrays
use compact Unicode-preserving JSON. Provider input remains unchanged.

See the [migration notes](https://github.com/caesura-io/sdk-js/blob/main/MIGRATION.md)
for persistence defaults, default sessions, arbitrary analysis types, and examples.
