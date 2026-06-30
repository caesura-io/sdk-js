# @caesura-io/openai

Asynchronous, non-blocking recommendation injection for the official [OpenAI Node SDK](https://github.com/openai/openai-node).

Caesura listens to your agent's dialogue and pushes short, real-time recommendations ("analysis") into the model's context without blocking the conversation. It plugs in as a transparent proxy wrapper around the OpenAI client.

> **Status:** early development. API is not yet stable.

## Install

```bash
npm i @caesura-io/openai openai
```

## Quick start

Wrap your `OpenAI` client instance with `createCaesura`. Every call to `responses.create` or `chat.completions.create` will automatically and transparently be intercepted to collect messages and inject recommendations.

All other methods and nested resources are passed through untouched.

```ts
import OpenAI from 'openai';
import { createCaesura } from '@caesura-io/openai';

const client = createCaesura(new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
}), {
  baseUrl: 'https://dev.caesura.io',
  // apiKey auto-read from CAESURA_API_KEY if omitted
});

// 1. Chat Completions example
const completion = await client.chat.completions.create({
  model: 'gpt-5.4-mini',
  messages: [
    { role: 'user', content: 'Hello agent!' },
  ],
}, {
  // Pass conversationId per-call via request options
  caesura: { conversationId: 'session-123' },
});

// 2. Responses API example
const response = await client.responses.create({
  model: 'gpt-5.4-mini',
  input: 'Hello agent!',
}, {
  caesura: { conversationId: 'session-123' },
});
```

## Credit Usage Reporting

You can request credit-usage metadata on every analyze call and receive the reported value via the `onCreditUsage` callback.

```ts
import { createCaesura, createCreditMeter } from '@caesura-io/openai';
import OpenAI from 'openai';

// 1. Create a credit meter to accumulate and query metrics
const meter = createCreditMeter();

const client = createCaesura(new OpenAI(), {
  baseUrl: 'https://dev.caesura.io',
  // Supply the callback to opt-in to credit-usage reporting
  onCreditUsage: meter.record,
});

// 2. Query credit metrics later
console.log('total credits consumed:', meter.total());
console.log('credits by conversation:', meter.breakdown());
console.log('retained credit events:', meter.events());
```

> [!NOTE]
> In `async` mode (default), the `onCreditUsage` callback fires out-of-band as soon as the asynchronous analyze call completes, decoupled from the synchronous OpenAI request resolution.
