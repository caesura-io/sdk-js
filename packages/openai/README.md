# @caesura-io/openai

Asynchronous, non-blocking recommendation injection for the official [OpenAI Node SDK](https://github.com/openai/openai-node).

Caesura listens to your agent's dialogue and pushes short, real-time recommendations ("analysis") into the model's context without blocking the conversation. It plugs in as a transparent proxy wrapper around the OpenAI client.

> **Status:** early development. API is not yet stable.

## Install

```bash
npm i @caesura-io/openai openai
```

## Quick start

Wrap your existing `OpenAI` client with `createCaesura`. Every call to `responses.create` or `chat.completions.create` is automatically intercepted. All other methods and nested resources pass through untouched.

### Chat Completions

```diff
 import OpenAI from 'openai';
+import { createCaesura } from '@caesura-io/openai';

-const client = new OpenAI();
+const client = createCaesura(new OpenAI(), {
+  baseUrl: 'https://dev.caesura.io',
+  // apiKey auto-read from CAESURA_API_KEY if omitted
+});

 const completion = await client.chat.completions.create({
   model: 'gpt-5.4-mini',
   messages: conversation,
+}, {
+  caesura: { conversationId: sessionId },
 });
```

### Responses API

```diff
 import OpenAI from 'openai';
+import { createCaesura } from '@caesura-io/openai';

-const client = new OpenAI();
+const client = createCaesura(new OpenAI(), {
+  baseUrl: 'https://dev.caesura.io',
+});

 const response = await client.responses.create({
   model: 'gpt-5.4-mini',
   input: 'Hello agent!',
+}, {
+  caesura: { conversationId: sessionId },
 });
```

## Credit Usage Reporting

You can request credit-usage metadata on every analyze call and receive the reported value via the `onCreditUsage` callback.

```diff
+import { createCaesura, createCreditMeter } from '@caesura-io/openai';
 import OpenAI from 'openai';
+
+const meter = createCreditMeter();

-const client = new OpenAI();
+const client = createCaesura(new OpenAI(), {
+  baseUrl: 'https://dev.caesura.io',
+  onCreditUsage: meter.record,
+});

+// Query credit metrics later
+console.log('total credits consumed:', meter.total());
+console.log('credits by conversation:', meter.breakdown());
+console.log('retained credit events:', meter.events());
```

> [!NOTE]
> In `async` mode (default), the `onCreditUsage` callback fires out-of-band as soon as the asynchronous analyze call completes, decoupled from the synchronous OpenAI request resolution.
