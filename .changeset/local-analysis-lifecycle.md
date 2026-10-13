---
'@caesura-io/core': minor
'@caesura-io/openai': minor
'@caesura-io/ai-sdk': minor
---

Add explicit customer-event selection, cancellation, FIFO background completion and
shutdown, strict foreground failure handling, required awaited result persistence,
and finalized provider request/response auditing.

Breaking: observation cadence follows customer event identity; assistant and tool
continuations no longer independently trigger analysis. Custom stores require
explicit set() and may be asynchronous. Replace persisted inFlight polling with
engine.flush(), and clear state through engine lifecycle APIs. See MIGRATION.md and
docs/application-adapters.md for migration, concurrency, idempotency and audit ordering.
