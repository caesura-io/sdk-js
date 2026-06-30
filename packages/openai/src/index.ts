export { createCaesura, withCaesura } from './wrapper.js';
export type { CaesuraOpenAIOptions } from './types.js';

// Re-export utility functions and classes from core for developer convenience
export {
  MemoryCaesuraStore,
  createCreditMeter,
  createDebugLogger,
  DEFAULT_TEMPLATE,
  DEFAULT_SKILL_PROMPT,
} from '@caesura-io/core';

export type {
  CaesuraStore,
  ConversationState,
  StoredRecommendation,
  MemoryStoreOptions,
  CreditMeter,
  CreditMeterOptions,
  DebugLoggerOptions,
  CaesuraAnalysis,
  CaesuraMode,
  Placement,
  InjectAs,
  SpeakerNames,
  CadenceConfig,
  SendConfig,
  InjectConfig,
  TtlPolicy,
  CreditUsageInfo,
  CaesuraEvent,
} from '@caesura-io/core';
