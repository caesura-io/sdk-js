import type { ConversationState } from './store.js';

/** Exact provider role and rendered text, scoped to one stored conversation. */
export function injectedMessageKey(role: string, text: string): string {
  return JSON.stringify([role, text]);
}

export function knownInjectedMessages(
  state: ConversationState,
  fallbackRole: string,
): Set<string> {
  return new Set([
    ...(state.injectedMessages ?? []).map(({ role, text }) =>
      injectedMessageKey(role, text),
    ),
    // Compatibility with custom stores holding recommendations from older SDKs.
    ...state.recommendations.flatMap((r) =>
      r.injectedText === undefined ||
      state.injectedMessages?.some((message) => message.text === r.injectedText)
        ? []
        : [injectedMessageKey(fallbackRole, r.injectedText)],
    ),
  ]);
}

/** Keep earlier merged renderings recognizable after retention/template changes. */
export function rememberInjectedMessage(
  state: ConversationState,
  role: string,
  text: string,
): void {
  const messages = (state.injectedMessages ??= []);
  if (
    !messages.some((message) => message.role === role && message.text === text)
  )
    messages.push({ role, text });
}

/** Only anonymous, text-only messages can be reused SDK guidance. */
export function isInjectedMessage(
  message: {
    role?: string;
    name?: unknown;
    speakerIndex?: unknown;
    type?: unknown;
    content?: unknown;
    tool_calls?: unknown;
    function_call?: unknown;
    audio?: unknown;
  },
  text: string,
  known: ReadonlySet<string>,
): boolean {
  if (
    !message.role ||
    message.name != null ||
    message.speakerIndex != null ||
    (message.type !== undefined && message.type !== 'message') ||
    message.function_call != null ||
    message.audio != null ||
    (Array.isArray(message.tool_calls)
      ? message.tool_calls.length > 0
      : !!message.tool_calls)
  )
    return false;
  const content = message.content;
  const textOnly =
    typeof content === 'string' ||
    (Array.isArray(content) &&
      content.every(
        (part) =>
          part &&
          typeof part === 'object' &&
          ['text', 'input_text', 'output_text'].includes(part.type) &&
          typeof part.text === 'string',
      ));
  return textOnly && known.has(injectedMessageKey(message.role, text));
}
