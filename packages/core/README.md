# @caesura-io/core

Framework-agnostic core for CaesuraO — shared analyze, inject, and credit-metering logic used by all SDK integrations.

> **This package is not meant to be used directly.** It is the shared engine consumed by:
>
> - [`@caesura-io/ai-sdk`](https://www.npmjs.com/package/@caesura-io/ai-sdk) — Vercel AI SDK middleware
> - [`@caesura-io/openai`](https://www.npmjs.com/package/@caesura-io/openai) — OpenAI Node SDK wrapper

## What's inside

| Module                | Purpose                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------- |
| `CaesuraClient`       | HTTP client that calls `/api/analyze` and creates conversations via `/api/conversation` |
| `MemoryCaesuraStore`  | In-memory conversation state with LRU + idle-time eviction                              |
| `createCaesuraEngine` | Orchestrator: cadence checks, observe/analyze cycle, buffering, event emission          |
| `createCreditMeter`   | Accumulates and queries credit-usage metrics                                            |
| `createDebugLogger`   | Structured `onEvent` logger for debugging                                               |
| Helpers               | `hashMessage`, `selectActive`, `renderAnalysis`, `renderBlock`, `buildAnalyzeMessages`  |
| Types                 | `CaesuraConfig`, `CaesuraEvent`, `InjectConfig`, `SendConfig`, etc.                     |

## Install

```bash
npm i @caesura-io/core
```

## Usage

Most consumers should use the framework-specific adapters. If you're building your own integration:

```ts
import {
  createCaesuraEngine,
  selectActive,
  renderBlock,
} from '@caesura-io/core';

const engine = createCaesuraEngine({
  mode: 'sync', // Await analysis before rendering it in this example.
  apiKey: process.env.CAESURA_API_KEY,
});

// Create once, save the backend ID, and reuse it for all subsequent turns.
const conversationId = await engine.createConversation({
  name: 'Support session',
});

// 1. Observe a conversation turn (the engine advances the turn counter).
await engine.observe(conversationId, [
  {
    speakerRole: 'user',
    speakerName: 'Customer',
    text: 'I need help preparing for the next meeting',
  },
]);

// 2. Retrieve buffered recommendations
const state = engine.store.get(conversationId);
const active = selectActive(state, engine.config.inject, Date.now());
const blocks = renderBlock(active, engine.config.inject);
// → blocks contains rendered recommendation text ready for injection
```

## Configuration and lifecycle

The default endpoint is `https://api.caesurao.com`. Environments follow the user account;
`baseUrl` is an optional override. Package names, identifiers, and `CAESURA_API_KEY` are unchanged.

`persist: true` is the default and requires a backend conversation ID. A local label or UUID is
insufficient. `engine.createConversation({ name?, calendarId?, eventId? })` returns a validated
backend ID string and propagates failures. The HTTP client exposes the same method.

Alternatively, set `autoCreateConversation: true` (default `false`) and use stable local session labels
with `observe()`. The engine creates one backend conversation before the first analysis, reuses it
after analysis failures, and prevents concurrent observations from duplicating creation. Failures
reach `onError`. No conversation is created for empty dialogue, zero send limits, or `persist: false`.
The in-memory mapping is lost on eviction, clearing, or restart; explicit saved IDs provide durable reuse.

`observe()` advances the turn exactly once, including skipped observations. Integrations must not
increment `state.turn` themselves. Active observations are protected from default-store eviction;
custom stores should also retain states whose `inFlight` flag is true. The store can temporarily
exceed its size limit while observations are active. Background responses retain their originating turn.

`send.maxMessages` (default `10`) and `send.maxInputChars` limit the full outbound request,
including buffered history. Newest dialogue takes priority; history uses remaining space.
Zero skips analysis, and negative limits are rejected. Configured speaker names fill missing labels;
explicit labels and original message anchors are preserved. The engine never changes caller-owned messages.

Analyses may be any JSON value or plain text. `{analysis}` renders the full value, while
`{analysis.field}` reads the exact key. Objects are not reshaped. Zero and false are valid analyses;
empty payloads are skipped. Boolean `isSame`/`is_same` metadata is read separately without changing
the payload. Malformed bodies advertised as JSON remain errors. `inject.keepLast: 0` suppresses
injection without deleting stored history. Rendering and hashing preserve Unicode.

Event, credit, and error callback exceptions cannot break observations. Credit totals and request counts
remain cumulative even when retained event details are evicted. SDK requests omit `notifyIntegrations`
and leave the backend's default `callType` unchanged unless explicitly configured.

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

## License

Apache-2.0
