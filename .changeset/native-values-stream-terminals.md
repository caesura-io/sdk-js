---
'@caesura-io/core': minor
'@caesura-io/ai-sdk': minor
'@caesura-io/openai': minor
---

Preserve provider-native URL and binary inputs while isolating SDK request transformations
and audit snapshots. Avoid URL structuredClone failures, including on Node 24.

Add the incomplete provider-stream terminal status. Require API-specific finish evidence
before reporting completion or persisting completed agent text; retain native finish reasons,
late usage, cancellation and iteration errors. Valid protocol completion (including length)
does not imply semantic completeness. Lock the existing SDK provenance header contract
with exact creation/analysis assertions against package-derived versions.
