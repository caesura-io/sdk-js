# @caesura-io/ai-sdk

## 0.5.0

### Minor Changes

- 728e6a4: Require one authoritative conversationId for all stateful calls, including persist:false.
  Remove local-to-backend mappings and default-session fallback; reject the removed
  autoCreateConversation option. Explicit creation returns the ID and emits a
  conversation-created event with cancellation/deadline and provenance support.

  Add awaited application-owned transcript persistence independent of analysis cadence,
  completed agent text capture, terminal provider stream outcomes, and automatic SDK
  provenance from package metadata. Clarify that
  HTTP analysis persistence is not a complete transcript archive. See MIGRATION.md and
  docs/conversations.md for migration, idempotency, stream limitations and wire headers.

- 728e6a4: Add explicit customer-event selection, cancellation, FIFO background completion and
  shutdown, strict foreground failure handling, required awaited result persistence,
  and finalized provider request/response auditing.

  Breaking: observation cadence follows customer event identity; assistant and tool
  continuations no longer independently trigger analysis. Custom stores require
  explicit set() and may be asynchronous. Replace persisted inFlight polling with
  engine.flush(), and clear state through engine lifecycle APIs. See MIGRATION.md and
  docs/application-adapters.md for migration, concurrency, idempotency and audit ordering.

- 728e6a4: Preserve provider-native URL and binary inputs while isolating SDK request transformations
  and audit snapshots. Avoid URL structuredClone failures, including on Node 24.

  Add the incomplete provider-stream terminal status. Require API-specific finish evidence
  before reporting completion or persisting completed agent text; retain native finish reasons,
  late usage, cancellation and iteration errors. Valid protocol completion (including length)
  does not imply semantic completeness. Lock the existing SDK provenance header contract
  with exact creation/analysis assertions against package-derived versions.

### Patch Changes

- 728e6a4: Monitor cancellation and explicit deadlines while awaiting required finalized-request
  persistence. Pass live ProviderAuditContext controls separately from detached audit
  snapshots, and prevent provider invocation after cancellation or timeout across both
  OpenAI APIs and AI SDK generate/stream. Preserve strict/continue handling of ordinary
  storage errors and safely handle late audit callback settlement. Cancellation cannot
  roll back application-owned writes or interrupt synchronous blocking work.
- 728e6a4: Append skillPrompt to the last eligible instruction message while preserving its
  role, structured content and provider metadata. Check all eligible instructions
  for the exact prompt before insertion; prepend a system message only when absent.
  Responses continues to use instructions and avoids duplicates in reused requests.
  Empty or whitespace-only skillPrompt disables insertion. Preserve dialogue anchors
  and finalized audit capture without changing the default prompt or analysis placement.
- Updated dependencies [728e6a4]
- Updated dependencies [728e6a4]
- Updated dependencies [728e6a4]
- Updated dependencies [728e6a4]
  - @caesura-io/core@0.4.0

## 0.4.0

### Minor Changes

- c0619e2: **Breaking changes for these pre-1.0 packages:** persistence now defaults to true,
  wrappers analyze the default session when no ID is supplied, and CaesuraAnalysis
  accepts arbitrary JSON values or text rather than guaranteeing object fields.
  The default endpoint is https://api.caesurao.com. Create and reuse a backend
  conversation ID, enable autoCreateConversation, or set persist to false.
  OpenAI support is now >=4.87.3 <8; AI SDK majors 5/6/7 remain supported.
  See MIGRATION.md in the repository for configuration and type migration examples.

  Add explicit and automatic conversation creation, stable participant indices and
  currentUser, occurrence-based analysis ordering, and safe background snapshots.
  Enforce shared message/code-point budgets with partial older dialogue and whole,
  contiguous recent analysis history. Preserve raw analysis values, deduplicate
  boolean isSame responses, protect real audio/tool dialogue during guidance
  cleanup, and retain model-provider roles and tool ordering. Isolate callback
  failures and keep credit-meter counts cumulative.

  Add deterministic backend-contract regressions, clean packed-package consumer
  checks, separate ESM/CommonJS declaration exports, and release validation shared
  with PR CI. Product documentation now uses
  CaesuraO while package names and identifiers remain unchanged.

### Patch Changes

- Updated dependencies [c0619e2]
  - @caesura-io/core@0.3.0

## 0.3.0

### Minor Changes

- c0595a1: Added Vercel AI SDK v7 support

## 0.2.1

### Patch Changes

- 817cba6: Updated examples

## 0.2.0

### Minor Changes

- 30b4783: Moved reusable logic into the core package

### Patch Changes

- Updated dependencies [30b4783]
  - @caesura-io/core@0.2.0

## 0.1.1

### Patch Changes

- 9175518: Fixed package name

## 0.1.0

### Minor Changes

- 41fb221: The first version of SDK with asynchronous and synchronous modes
