# @caesura-io/core

Framework-agnostic core for Caesura — shared analyze, inject, and credit-metering logic used by all SDK integrations.

> **This package is not meant to be used directly.** It is the shared engine consumed by:
>
> - [`@caesura-io/ai-sdk`](https://www.npmjs.com/package/@caesura-io/ai-sdk) — Vercel AI SDK middleware
> - [`@caesura-io/openai`](https://www.npmjs.com/package/@caesura-io/openai) — OpenAI Node SDK wrapper

## What's inside

| Module | Purpose |
|--------|---------|
| `CaesuraClient` | HTTP client that calls the `/api/analyze` endpoint |
| `MemoryCaesuraStore` | In-memory conversation state with LRU + idle-time eviction |
| `createCaesuraEngine` | Orchestrator: cadence checks, observe/analyze cycle, buffering, event emission |
| `createCreditMeter` | Accumulates and queries credit-usage metrics |
| `createDebugLogger` | Structured `onEvent` logger for debugging |
| Helpers | `hashMessage`, `selectActive`, `renderAnalysis`, `renderBlock`, `buildAnalyzeMessages` |
| Types | `CaesuraConfig`, `CaesuraEvent`, `InjectConfig`, `SendConfig`, etc. |

## Install

```bash
npm i @caesura-io/core
```

## Usage

Most consumers should use the framework-specific adapters. If you're building your own integration:

```ts
import { createCaesuraEngine, selectActive, renderBlock } from '@caesura-io/core';

const engine = createCaesuraEngine({
  baseUrl: 'https://dev.caesura.io',
  apiKey: process.env.CAESURA_API_KEY,
});

// 1. Observe a conversation turn
await engine.observe('conversation-id', [
  { speakerRole: 'user', speakerName: 'Customer', text: 'I need help preparing for the next meeting' },
]);

// 2. Retrieve buffered recommendations
const state = engine.store.get('conversation-id');
const active = selectActive(state, engine.config.inject, Date.now());
const blocks = renderBlock(active, engine.config.inject);
// → blocks contains rendered recommendation text ready for injection
```

## License

Apache-2.0
