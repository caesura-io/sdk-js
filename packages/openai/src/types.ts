import type { CaesuraConfig } from '@caesura-io/core';
import 'openai';

export interface CaesuraOpenAIOptions extends Omit<CaesuraConfig, 'store'> {
  // Let the user supply custom stores or other fields as well.
  // We can just inherit all of CaesuraConfig.
  store?: CaesuraConfig['store'];
}

declare module 'openai' {
  export interface RequestOptions {
    caesura?: {
      conversationId?: string;
    };
  }
}
