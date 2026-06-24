# @caesura-io/ai-sdk

Asynchronous, non-blocking recommendation injection for the [Vercel AI SDK](https://ai-sdk.dev).

Caesura listens to your agent's dialogue and pushes short, real-time
recommendations ("analysis") into the model's context *before the next call* —
without blocking the conversation. It plugs in as a standard AI SDK language
model middleware.

> **Status:** early development. API is not yet stable.

## Install

```bash
npm i @caesura-io/ai-sdk ai
```

## Quick start

```ts
import { wrapLanguageModel, generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { caesuraMiddleware } from '@caesura-io/ai-sdk';

const model = wrapLanguageModel({
  model: anthropic('claude-sonnet-4-6'),
  middleware: caesuraMiddleware({
    baseUrl: 'https://dev.caesura.io',
    // apiKey auto-read from CAESURA_API_KEY if omitted
  }),
});

const result = await generateText({
  model,
  messages: conversation,
  providerOptions: { caesura: { conversationId: sessionId } },
});
```

## Credit Usage Reporting

You can request credit-usage metadata on every analyze call and receive the reported value via the `onCreditUsage` callback.

```ts
import { caesuraMiddleware, createCreditMeter } from '@caesura-io/ai-sdk';

// 1. Create a credit meter to accumulate and query metrics
const meter = createCreditMeter();

const model = wrapLanguageModel({
  model,
  middleware: caesuraMiddleware({
    baseUrl: 'https://dev.caesura.io',
    // Supply the callback to opt-in to credit-usage reporting
    onCreditUsage: meter.record,
  }),
});

// 2. Query credit metrics later
console.log('total credits consumed:', meter.total());
console.log('credits by conversation:', meter.breakdown());
console.log('retained credit events:', meter.events());
```

> [!NOTE]
> In `async` mode, the `onCreditUsage` callback fires out-of-band as soon as the asynchronous analyze call completes, decoupled from the synchronous `generateText` response.

