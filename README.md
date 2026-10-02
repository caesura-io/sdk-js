# CaesuraO JS/TS SDKs

This repository is a monorepo containing the SDKs and framework adapters for CaesuraO in JavaScript/TypeScript.

- [Core (Framework Agnostic)](./packages/core/)
- [Vercel AI SDK Adapter](./packages/ai-sdk/)
- [OpenAI SDK Adapter](./packages/openai/)

The default API endpoint is `https://api.caesurao.com`; environments are linked to the user account.
`persist` defaults to `true`. Create a backend conversation once with `createConversation()` and reuse its ID,
or enable `autoCreateConversation: true` to map local session labels automatically. Set `persist: false`
for analysis without backend storage. See each adapter's README for complete examples.

Package names, code identifiers, and `CAESURA_API_KEY` are unchanged.

See [migration notes](./MIGRATION.md) for changed defaults, public types, and shared
text/budgeting policies. OpenAI support is `>=4.87.3 <8`; AI SDK majors 5/6/7 are
validated with packed-package consumers before release.
