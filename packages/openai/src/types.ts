import type OpenAI from 'openai';
import type { CaesuraConfig } from '@caesura-io/core';

export interface CaesuraOpenAIOptions extends Omit<CaesuraConfig, 'store'> {
  store?: CaesuraConfig['store'];
}

/** Per-call metadata consumed by the wrapper, never forwarded to OpenAI. */
interface CaesuraRequestMetadata {
  caesura?: { conversationId?: string };
}

/** Extend the three native create overloads without importing SDK internals.
 * Preserve non-streaming, streaming, and dynamic-stream return types and
 * APIPromise helpers. Only wrapped methods accept CaesuraO request metadata.
 */
type WithCaesuraOptions<Create> = Create extends {
  (body: infer B1, options?: infer O1): infer R1;
  (body: infer B2, options?: infer O2): infer R2;
  (body: infer B3, options?: infer O3): infer R3;
}
  ? {
      (body: B1, options?: O1 & CaesuraRequestMetadata): R1;
      (body: B2, options?: O2 & CaesuraRequestMetadata): R2;
      (body: B3, options?: O3 & CaesuraRequestMetadata): R3;
    }
  : never;

export type CaesuraOpenAI = OpenAI & {
  createConversation: import('@caesura-io/core').CaesuraEngine['createConversation'];
  chat: OpenAI['chat'] & {
    completions: OpenAI['chat']['completions'] & {
      create: WithCaesuraOptions<OpenAI['chat']['completions']['create']>;
    };
  };
  responses: OpenAI['responses'] & {
    create: WithCaesuraOptions<OpenAI['responses']['create']>;
  };
};
