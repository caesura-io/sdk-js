# @caesura-io/core

Shared analysis engine for custom integrations. Most applications should use the [OpenAI](../openai) or [AI SDK](../ai-sdk) adapter.

```sh
npm install @caesura-io/core
```

```ts
import {
  createCaesuraEngine,
  selectActive,
  renderBlock,
} from '@caesura-io/core';

const engine = createCaesuraEngine({ mode: 'sync' }); // CAESURA_API_KEY
const conversationId = await engine.createConversation({ name: 'Chat' });
await engine.observe(
  conversationId,
  [
    {
      speakerRole: 'user',
      speakerName: 'Customer',
      text: 'I have a question.',
    },
  ],
  { turn: { id: 'customer-1', origin: 'customer' } },
);
const state = await engine.getState(conversationId);
const blocks = renderBlock(
  selectActive(state, engine.config.inject, Date.now()),
  engine.config.inject,
);
console.log(blocks);
await engine.shutdown();
```

Reuse the returned conversation ID. Only genuine customer events trigger analysis; earlier agent dialogue can provide context. IDs do not load history, and analysis persistence does not archive a complete transcript.

The core exports `CaesuraClient`, `createCaesuraEngine`, `MemoryCaesuraStore`, `createCreditMeter`, `createDebugLogger`, and the store/persistence types used by both adapters.

[Conversations and persistence](../../docs/conversations.md) · [Advanced integrations](../../docs/application-adapters.md) · [Migration](../../MIGRATION.md)
