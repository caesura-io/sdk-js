# @caesura/ai-sdk

Asynchronous, non-blocking recommendation injection for the [Vercel AI SDK](https://ai-sdk.dev).

Caesura listens to your agent's dialogue and pushes short, real-time
recommendations ("analysis") into the model's context *before the next call* —
without blocking the conversation. It plugs in as a standard AI SDK language
model middleware.

> **Status:** early development. API is not yet stable.

## Install

```bash
npm i @caesura/ai-sdk ai
```

## Quick start

```ts
import { wrapLanguageModel, generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { caesuraMiddleware } from '@caesura/ai-sdk';

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
