---
'@caesura-io/core': minor
'@caesura-io/openai': minor
'@caesura-io/ai-sdk': minor
---

**Breaking changes for these pre-1.0 packages:** persistence now defaults to true,
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
