---
'@caesura-io/core': patch
'@caesura-io/ai-sdk': patch
'@caesura-io/openai': patch
---

Monitor cancellation and explicit deadlines while awaiting required finalized-request
persistence. Pass live ProviderAuditContext controls separately from detached audit
snapshots, and prevent provider invocation after cancellation or timeout across both
OpenAI APIs and AI SDK generate/stream. Preserve strict/continue handling of ordinary
storage errors and safely handle late audit callback settlement. Cancellation cannot
roll back application-owned writes or interrupt synchronous blocking work.
