# CaesuraO JavaScript SDKs

Add conversation analysis and guidance to your agent:

- [OpenAI adapter](packages/openai): Chat Completions and Responses.
- [AI SDK adapter](packages/ai-sdk): model middleware for AI SDK 5, 6 and 7.
- [Core](packages/core): shared analysis engine and lifecycle helpers.

Start with an adapter README or the [runnable examples](https://github.com/caesura-io/examples-sdk-js).

Every stateful call requires a `conversationId`. Create it explicitly and reuse it; an ID does not load history. Analysis persistence is enabled by default and saves the analyzed customer message plus analysis, not a full transcript.

## Guides

- [Conversations, persistence and diagnostics](docs/conversations.md)
- [Stores, cancellation and auditing](docs/application-adapters.md)
- [Migration](MIGRATION.md)
- [Contributing](CONTRIBUTING.md)
