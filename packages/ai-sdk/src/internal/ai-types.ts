// Single source of truth for AI-SDK-version-coupled types.
// Instead of importing from `ai` directly (which breaks across versions like v7
// where `LanguageModelMiddleware` was renamed to `LanguageModelV4Middleware`),
// we define a structural type that satisfies `wrapLanguageModel`.
export interface CaesuraMiddleware {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  specificationVersion: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transformParams?: (args: { type: 'generate' | 'stream'; params: any; model: any }) => PromiseLike<any>;
}

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
