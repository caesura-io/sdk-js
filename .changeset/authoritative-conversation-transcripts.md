---
'@caesura-io/core': minor
'@caesura-io/openai': minor
'@caesura-io/ai-sdk': minor
---

Require one authoritative conversationId for all stateful calls, including persist:false.
Remove local-to-backend mappings and default-session fallback; reject the removed
autoCreateConversation option. Explicit creation returns the ID and emits a
conversation-created event with cancellation/deadline and provenance support.

Add awaited application-owned transcript persistence independent of analysis cadence,
completed agent text capture, terminal provider stream outcomes, and automatic SDK
provenance from package metadata. Clarify that
HTTP analysis persistence is not a complete transcript archive. See MIGRATION.md and
docs/conversations.md for migration, idempotency, stream limitations and wire headers.
