---
'@caesura-io/ai-sdk': patch
'@caesura-io/openai': patch
---

Append skillPrompt to the last eligible instruction message while preserving its
role, structured content and provider metadata. Check all eligible instructions
for the exact prompt before insertion; prepend a system message only when absent.
Responses continues to use instructions and avoids duplicates in reused requests.
Empty or whitespace-only skillPrompt disables insertion. Preserve dialogue anchors
and finalized audit capture without changing the default prompt or analysis placement.
