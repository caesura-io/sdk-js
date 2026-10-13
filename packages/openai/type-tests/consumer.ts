import OpenAI from 'openai';
import { createCaesura } from '../dist/index.js';

// Typecheck the shipped declarations, including the documented per-call option.
async function consumer() {
  const original = new OpenAI({ apiKey: 'test' });
  const client = createCaesura(original, { apiKey: 'test' });
  const conversationId: string | undefined = await client.createConversation();
  const invocation = conversationId ? { conversationId } : { stateless: true };
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'user', content: 'hello' },
  ];
  const chat = client.chat.completions.create(
    { model: 'test', messages },
    { caesura: invocation, signal: new AbortController().signal },
  );
  void (await chat).choices[0]?.message.content;
  void (await chat.withResponse()).data.choices;
  const raw = await chat.asResponse();
  const status: number = raw.status;
  void status;
  // @ts-expect-error Raw responses do not have parsed chat choices.
  void raw.choices;
  // @ts-expect-error Non-streaming chat output has no Responses output array.
  void (await chat).output;
  const chatStream = await client.chat.completions.create(
    { model: 'test', messages, stream: true },
    { caesura: invocation },
  );
  for await (const chunk of chatStream) {
    void chunk.choices[0]?.delta.content;
    // @ts-expect-error Streaming chat chunks have no Responses output array.
    void chunk.output;
  }
  const response = client.responses.create(
    { model: 'test', input: 'hello', stream: false },
    { caesura: invocation, maxRetries: 1 },
  );
  void (await response).output_text;
  void (await response.withResponse()).data.output;
  await response.asResponse();
  // @ts-expect-error Responses output is not a chat completion.
  void (await response).choices;
  const stream = await client.responses.create(
    { model: 'test', input: 'hello', stream: true },
    { caesura: invocation },
  );
  for await (const event of stream) {
    const type: string = event.type;
    void type;
    // @ts-expect-error Response stream events have no chat choices.
    void event.choices;
  }
  const dynamicStream: boolean = Math.random() > 0.5;
  const dynamicChat: ReturnType<OpenAI['chat']['completions']['create']> =
    client.chat.completions.create(
      { model: 'test', messages, stream: dynamicStream },
      { caesura: invocation },
    );
  const dynamicResponse: ReturnType<OpenAI['responses']['create']> =
    client.responses.create(
      { model: 'test', input: 'hello', stream: dynamicStream },
      { caesura: invocation },
    );
  void dynamicChat;
  void dynamicResponse;
  // @ts-expect-error Only wrapped create methods accept CaesuraO metadata.
  original.responses.create(
    { model: 'test', input: 'hello' },
    { caesura: invocation },
  );
  client.responses.create(
    { model: 'test', input: 'hello' },
    // @ts-expect-error Conversation IDs remain strings.
    { caesura: { conversationId: 123 } },
  );
  await client.embeddings.create({ model: 'test', input: 'hello' });
}
void consumer;
