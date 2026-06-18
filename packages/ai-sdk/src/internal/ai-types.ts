// Single source of truth for AI-SDK-version-coupled types.
// We re-export the middleware type from `ai` itself, so the consumer's
// installed major (v5 -> LanguageModelV2*, v6 -> LanguageModelV3*) decides
// the spec version. If `ai` doesn't export a clean alias under some version,
// this is the ONE place to adjust.
import type { LanguageModelMiddleware } from 'ai';

export type CaesuraMiddleware = LanguageModelMiddleware;

/**
 * Minimal structural type for the prompt parts we read.
 * Deliberately NOT importing the versioned Prompt type so we stay
 * compatible across v5/v6. We only ever read `text` parts.
 */
export type TextPartLike = { type: 'text'; text: string };
export type PromptMessageLike = {
  role: string;
  content: string | Array<{ type: string; [k: string]: unknown }>;
};
