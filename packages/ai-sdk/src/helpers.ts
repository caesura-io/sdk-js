import type { PromptMessageLike, TextPartLike } from './internal/ai-types.js';
import type { AnalyzeMessage } from './client.js';
import type {
  CaesuraAnalysis,
  InjectConfig,
  ResolvedConfig,
  SendConfig,
} from './types.js';
import type { ConversationState, StoredRecommendation } from './store.js';

/** Extract concatenated text from a provider-level message's content. */
export function messageText(content: PromptMessageLike['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is TextPartLike => p.type === 'text' && typeof (p as TextPartLike).text === 'string')
    .map((p) => p.text)
    .join('');
}

interface CollectedMessage extends AnalyzeMessage {
  /** Index of the source message within the original prompt. */
  sourceIndex: number;
}

/**
 * Collect the dialogue window to send. Maps roles to assistant/user, labels
 * speakers, applies maxMessages, then char-trims from the START.
 */
export function collectMessages(
  prompt: PromptMessageLike[],
  send: Required<Pick<SendConfig, 'maxMessages'>> & SendConfig,
  speakers: ResolvedConfig['speakerNames'],
  injectedTexts: ReadonlySet<string>,
): CollectedMessage[] {
  let msgs: CollectedMessage[] = prompt
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.role === 'user' || m.role === 'assistant')
    .map(({ m, i }) => {
      const text = messageText(m.content);
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      return {
        speakerRole: role as 'assistant' | 'user',
        speakerName: role === 'assistant' ? speakers.agent : speakers.customer,
        text,
        sourceIndex: i,
      };
    })
    .filter((c) => !injectedTexts.has(c.text)); // skip our own injected blocks

  if (send.maxMessages !== 'all') {
    msgs = msgs.slice(-send.maxMessages);
  }

  if (send.maxInputChars != null) {
    let total = msgs.reduce((n, c) => n + c.text.length, 0);
    while (total > send.maxInputChars && msgs.length > 1) {
      total -= msgs[0]!.text.length;
      msgs.shift();
    }
    if (msgs.length === 1 && msgs[0]!.text.length > send.maxInputChars) {
      msgs[0] = { ...msgs[0]!, text: msgs[0]!.text.slice(-send.maxInputChars) };
    }
  }

  return msgs;
}

/**
 * Build the backend `messages` array: the dialogue window (user-role quotes)
 * plus the SDK's buffered prior analyses interleaved as assistant-role JSON,
 * so the route's existing dedup (obj.recommendation || obj.actionItem) works.
 */
export function buildAnalyzeMessages(
  collected: CollectedMessage[],
  state: ConversationState,
): AnalyzeMessage[] {
  const prior: AnalyzeMessage[] = state.recommendations.map((r) => ({
    speakerRole: 'assistant',
    text: JSON.stringify(r.analysis),
  }));
  const dialogue: AnalyzeMessage[] = collected.map((c) => ({
    speakerRole: c.speakerRole,
    speakerName: c.speakerName,
    text: c.text,
  }));
  // Prior analyses first (as context), then the new dialogue window.
  return [...prior, ...dialogue];
}

/** Apply TTL + keepLast to pick recommendations currently eligible for context. */
export function selectActive(
  state: ConversationState,
  inject: Required<Omit<InjectConfig, 'skillPrompt'>>,
  nowMs: number,
): StoredRecommendation[] {
  let recs = state.recommendations;

  if (inject.ttl.type === 'turns') {
    const minTurn = state.turn - inject.ttl.turns;
    recs = recs.filter((r) => r.createdAtTurn >= minTurn);
  } else if (inject.ttl.type === 'seconds') {
    const cutoff = nowMs - inject.ttl.seconds * 1000;
    recs = recs.filter((r) => r.createdAtMs >= cutoff);
  }

  if (inject.keepLast !== 'all') {
    recs = recs.slice(-inject.keepLast);
  }
  return recs;
}

const FIELD_TOKEN = /\{analysis(?:\.([a-zA-Z0-9_$]+))?\}/g;

/** Render one analysis through the template, resolving {analysis} / {analysis.field}. */
export function renderAnalysis(analysis: CaesuraAnalysis, template: string): string {
  // Replace tokens line-aware: if a token resolves to '', drop its whole line.
  const lines = template.split('\n');
  const rendered = lines
    .map((line) => {
      let sawToken = false;
      let allEmpty = true;
      const out = line.replace(FIELD_TOKEN, (_full, field?: string) => {
        sawToken = true;
        const value = field === undefined ? analysis : analysis[field];
        const str = stringifyValue(value);
        if (str !== '') allEmpty = false;
        return str;
      });
      // Drop lines whose only content was empty token(s).
      if (sawToken && allEmpty) return null;
      return out;
    })
    .filter((l): l is string => l !== null);
  return rendered.join('\n');
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Render the full injection block (skillPrompt + rendered active analyses). */
export function renderBlock(
  recs: StoredRecommendation[],
  inject: Required<Omit<InjectConfig, 'skillPrompt'>> & { skillPrompt?: string },
): string {
  const body = recs
    .map((r) => renderAnalysis(r.analysis, inject.template))
    .filter((s) => s.trim() !== '')
    .join('\n\n');
  if (body.trim() === '') return '';
  return inject.skillPrompt ? `${inject.skillPrompt}\n\n${body}` : body;
}

/**
 * Splice the rendered block into the prompt as a new message.
 * 'end' appends. 'after-last-analyzed' inserts right after the last prompt
 * message whose text starts with the last analyzed message's text; falls back
 * to 'end' if not found.
 */
export function injectBlock(
  prompt: PromptMessageLike[],
  blockText: string,
  inject: Required<Omit<InjectConfig, 'skillPrompt'>>,
  lastAnalyzedText: string | undefined,
): PromptMessageLike[] {
  const msg: PromptMessageLike = {
    role: inject.as,
    content: [{ type: 'text', text: blockText }],
  };

  if (inject.placement === 'end' || !lastAnalyzedText) {
    return [...prompt, msg];
  }

  // Search backwards for the last message that starts with the analyzed text.
  for (let i = prompt.length - 1; i >= 0; i--) {
    const text = messageText(prompt[i]!.content);
    if (text.startsWith(lastAnalyzedText)) {
      return [...prompt.slice(0, i + 1), msg, ...prompt.slice(i + 1)];
    }
  }
  // No match -> fall back to end.
  return [...prompt, msg];
}
