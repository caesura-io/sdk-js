---
'@caesura-io/core': minor
'@caesura-io/openai': minor
'@caesura-io/ai-sdk': minor
---

Save new customer messages and completed agent replies by default, including
cadence-skipped customer turns and explicitly recorded greetings. Recording a
message does not trigger analysis. `persist: false` disables hosted saving while
leaving application storage hooks enabled.

**Migration required:** `createConversation()` now returns
`Promise<string | undefined>`. Under `continue`, recoverable creation failures and
dependency timeouts report an error and return `undefined`. Check the result before
saving or reusing it; explicitly select `stateless: true` to proceed without an ID.
Hooks for stateless calls must handle an absent conversation ID.

Under `continue`, hosted-storage failures permit stateless analysis for that call;
analysis failures permit generation without new guidance. Failed reply storage does
not withhold the reply. Strict policy, required application hooks, caller cancellation
and deadlines retain their contracts. Both fallback paths respect the configured
analysis mode; use `sync` for guidance in the current response.

Preserve explicit participant roles and speaker indices. Transcript writes remain
ordered per conversation; reuse message IDs and durable SDK state for retries.
Late analysis results and credit usage remain available through completion hooks
and parent `flush()` after cancellation. Cancellation does not roll back writes.

See `MIGRATION.md` in the SDK repository for caller updates and the stateless
workflow.
