# Migrating to the next CaesuraO SDK release

Package names, environment-variable names, and code identifiers are unchanged.
Release tooling sets the version numbers and generates changelogs.

## Endpoint, persistence, and sessions

The default `baseUrl` is now `https://api.caesurao.com`. Environments belong to the
account; most applications should omit `baseUrl`.

`persist` now defaults to `true`. Create a backend conversation once and reuse its
ID, or enable `autoCreateConversation: true` to map each local session label to a
backend conversation before its first eligible analysis. Set `persist: false` to
keep analysis without backend storage. A generated UUID or local label is not a
backend conversation ID.

```ts
const client = createCaesura(openai, { apiKey: process.env.CAESURA_API_KEY });
const conversationId = await client.createConversation({
  name: 'Support call',
});
await client.responses.create(
  { model: 'your-model', input: 'Hello' },
  { caesura: { conversationId } },
);
```

The engine and AI SDK middleware also expose `createConversation()`.
Explicit creation errors propagate; automatic creation errors reach `onError`.

Wrappers use the per-call ID, then the configured ID, then the local session label
`"default"`. Missing IDs no longer bypass analysis. Use a distinct stable ID for
each independent conversation, especially when sharing an SDK instance across
users. With persistence enabled, use a backend ID or enable automatic creation.
Automatic mappings are reused after analysis failures and are lost on store
clearing, eviction, or restart. Save explicit backend IDs for durable reuse.

## Analysis values and public types

`CaesuraAnalysis` now represents any JSON value or plain text. Code that reads
`analysis.recommendation` must first narrow the value to an object and validate
the field. Unknown fields remain in their original location; no `extra` object is
created. Malformed responses advertised as JSON are errors.

```ts
function recommendation(analysis: CaesuraAnalysis): string | undefined {
  if (
    analysis !== null &&
    typeof analysis === 'object' &&
    !Array.isArray(analysis)
  ) {
    const value = analysis.recommendation;
    return typeof value === 'string' ? value : undefined;
  }
}
```

`{analysis}` renders the full value. `{analysis.next-step}` and
`{analysis.latest.speaker}` read those exact object keys, without nested lookup.
Zero and false are valid values. Boolean `isSame: true` suppresses new guidance
while preserving previous guidance; it does not suppress the dialogue request.
`keepLast: 0` injects no guidance and leaves stored history intact.

OpenAI's wrapped create methods retain streaming overloads and promise helpers.
The per-call `caesura` option belongs to the wrapped client, not the original
OpenAI client. Supported OpenAI versions are `>=4.87.3 <8`; AI SDK supports majors
5, 6, and 7. Node.js 22 or newer is required by this repository's build/validation.

## Shared text and budgeting policy

Text parts concatenate exactly, without inserted spaces or newlines. Supplied
whitespace is preserved. Only customer and agent text becomes dialogue context;
system instructions, tool results, and reasoning items do not.

`send.maxMessages` (default `10`) and `send.maxInputChars` apply to the complete
outbound analysis request, including previous analyses. Character limits count
Unicode code points, not UTF-16 units, bytes, or grapheme clusters. Emoji are not
split into surrogate halves; combining sequences may span multiple code points.

Newest dialogue has priority. The remaining character budget retains a suffix
of the oldest dialogue message that fits. Whole analyses use the remaining
message and character budget newest-first, stopping at the first that cannot
fit. Older, smaller guidance cannot replace newer guidance that exceeds the
budget. Structured analyses use compact Unicode-preserving JSON, and the budget
counts that actual serialized text. Zero limits skip analysis; negative limits
are rejected.

Occurrence anchors identify the original dialogue prefix, including participant
identity, before any SDK trimming. Retained occurrences keep their placements;
analyses whose anchors are missing collapse to the latest leading context entry
before history budgeting. Anchors still use FNV-1a/64 over UTF-16 for compatibility
with Python. Background work snapshots dialogue before waiting. These operations
do not alter caller-owned messages or original provider roles.

Both participants use backend `speakerRole: "user"`, with default indices
Customer `1` and Agent `0`. Previous analyses use `"assistant"` and `-1`. Explicit
indices survive trimming. `currentUser` always identifies the configured agent
(default `"Agent"`), independent of the current speaker. The current dialogue
utterance stays last because that is the message the backend persists.

Reused SDK guidance is removed before collecting dialogue and reinjected only
while eligible. Messages carrying names, indices, audio, tool metadata, or
non-text content remain real provider messages. An anonymous text-only message
identical in role and text to guidance is inherently ambiguous after serialization;
retain a name or explicit index on real dialogue to distinguish it.
