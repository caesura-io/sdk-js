# @caesura-io/ai-sdk

Conversation analysis middleware for AI SDK 5, 6 and 7, including streaming.

## Install and use

```sh
npm install @caesura-io/ai-sdk ai @ai-sdk/openai
```

Set `CAESURA_API_KEY` and your model provider key (`OPENAI_API_KEY` in this example) on the server.

```ts
import { generateText, wrapLanguageModel } from 'ai';
import { openai } from '@ai-sdk/openai';
import { caesuraMiddleware } from '@caesura-io/ai-sdk';

const middleware = caesuraMiddleware({ mode: 'sync' });
const conversationId = await middleware.createConversation({ name: 'Chat' });
const model = wrapLanguageModel({ model: openai('gpt-5.4-mini'), middleware });
const { text } = await generateText({
  model,
  prompt: 'I have a question.',
  providerOptions: {
    caesura: {
      ...(conversationId ? { conversationId } : { stateless: true }),
      turn: { id: 'customer-1', origin: 'customer' },
    },
  },
});
console.log(text);
```

Create once and retain a defined `conversationId` for subsequent calls. Under continue, recoverable creation failure returns `undefined`; explicitly select `stateless: true` to proceed as above. Supply growing application dialogue separately: the ID does not load history. Give each customer message a distinct turn ID and reuse it for retries/tool continuations. Keep tool/RAG content separate from customer dialogue.

## Defaults and lifecycle

- The default endpoint is `https://api.caesurao.com`; `baseUrl` is optional.
- `mode: 'async'` runs analysis in the background; `sync` uses same-call guidance.
- `failurePolicy: 'continue'` permits generation after analysis/storage failure. Use `throw` with `sync` when analysis must succeed. Cancellation always rejects.
- `persist: true` saves customer turns, completed agent replies and analyses to the backend. Use `recordMessages` for greetings created by your application.
- The default store is in-memory. An ID remains required with `persist: false`; explicit [stateless invocations](../../docs/conversations.md#continuing-without-hosted-storage) are isolated from conversation state.
- `send.maxMessages` defaults to 10. Send limits affect analysis input, not the provider's dialogue.

Await `middleware.caesura.flush()` to finish background analysis and `middleware.caesura.shutdown()` when disposing the integration. Clear guidance through the engine, not directly through its store.

[Runnable examples](https://github.com/caesura-io/examples-sdk-js) · [Conversations and persistence](../../docs/conversations.md) · [Advanced integrations](../../docs/application-adapters.md) · [Migration](../../MIGRATION.md)
