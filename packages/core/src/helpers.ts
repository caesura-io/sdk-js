import type { AnalyzeMessage } from './client.js';
import type { CaesuraAnalysis, InjectConfig, SendConfig } from './types.js';
import type { ConversationState, StoredRecommendation } from './store.js';

/**
 * FNV-1a hash of a message's identity (speakerName + text).
 * Retained for compatibility with recommendations stored before occurrence anchors.
 */
export function hashMessage(speakerName: string, text: string): string {
  const input = `${speakerName}\0${text}`;
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  return (h >>> 0).toString(36);
}

/**
 * Fingerprint each dialogue prefix, including participant identity. Compute on
 * the full collected snapshot before send limits. Repeated text from the same
 * speaker has a different anchor at every occurrence. Edited/truncated caller
 * history deliberately does not match: use the latest-context fallback instead.
 * FNV-1a/64 over UTF-16 keeps this synchronous and portable to browser runtimes.
 */
export function dialogueAnchors(
  collected: readonly AnalyzeMessage[],
): string[] {
  let hash = 0xcbf29ce484222325n;
  return collected.map((message, i) => {
    const identity =
      JSON.stringify([
        message.speakerIndex ?? (message.speakerRole === 'assistant' ? 0 : 1),
        message.speakerName ?? '',
        message.text,
      ]) + '\n';
    for (let j = 0; j < identity.length; j++) {
      hash = BigInt.asUintN(
        64,
        (hash ^ BigInt(identity.charCodeAt(j))) * 0x100000001b3n,
      );
    }
    return `v1:${i + 1}:${hash.toString(36)}`;
  });
}

/** Number of Unicode code points (not UTF-16 units or grapheme clusters). */
function characterCount(text: string): number {
  return Array.from(text).length;
}

/** Keep newest dialogue and the suffix of the oldest message that still fits. */
export function limitMessages(
  messages: AnalyzeMessage[],
  send: SendConfig,
): AnalyzeMessage[] {
  if (send.maxMessages === 0 || send.maxInputChars === 0) return [];
  const maxMessages =
    send.maxMessages === undefined || send.maxMessages === 'all'
      ? Infinity
      : send.maxMessages;
  let remaining = send.maxInputChars ?? Infinity;
  const result: AnalyzeMessage[] = [];
  for (
    let i = messages.length - 1;
    i >= 0 && result.length < maxMessages;
    i--
  ) {
    if (remaining <= 0) break;
    const message = messages[i]!;
    const points = Array.from(message.text);
    const text =
      points.length > remaining
        ? points.slice(-remaining).join('')
        : message.text;
    result.push({ ...message, text });
    remaining -= characterCount(text);
  }
  return result.reverse();
}

/**
 * Dialogue has priority. Resolve anchors before trimming, collapse removed
 * anchors to one latest context entry, then budget whole analyses newest first.
 */
export function buildAnalyzeMessages(
  collected: AnalyzeMessage[],
  state: ConversationState,
  send: SendConfig = {},
): AnalyzeMessage[] {
  const dialogue = limitMessages(collected, send);
  if (!dialogue.length) return [];
  const start = collected.length - dialogue.length;
  const anchorPositions = new Map(
    dialogueAnchors(collected).map((a, i) => [a, i]),
  );
  const hashPositions = new Map<string, number[]>();
  collected.forEach((message, i) => {
    const hash = hashMessage(message.speakerName ?? '', message.text);
    const positions = hashPositions.get(hash) ?? [];
    positions.push(i);
    hashPositions.set(hash, positions);
  });
  const placements = state.recommendations.map((rec) => ({
    rec,
    position: undefined as number | undefined,
    message: {
      speakerRole: 'assistant' as const,
      speakerIndex: -1,
      text: stringifyValue(rec.analysis),
    },
  }));
  // Reverse matching is only for legacy content-hash records. New records use
  // exact occurrence anchors, including when a retained message is shortened.
  for (let i = placements.length - 1; i >= 0; i--) {
    const p = placements[i]!;
    const position =
      p.rec.afterMessageAnchor !== undefined
        ? anchorPositions.get(p.rec.afterMessageAnchor)
        : hashPositions.get(p.rec.afterMessageHash)?.pop();
    p.position =
      position !== undefined && position >= start ? position : undefined;
  }
  const fallback = [...placements]
    .reverse()
    .find((p) => p.position === undefined);
  const candidates = placements.filter(
    (p) => p.position !== undefined || p === fallback,
  );
  let remainingMessages =
    send.maxMessages === undefined || send.maxMessages === 'all'
      ? Infinity
      : send.maxMessages - dialogue.length;
  let remainingChars =
    (send.maxInputChars ?? Infinity) -
    dialogue.reduce((n, m) => n + characterCount(m.text), 0);
  const selected = new Set<(typeof placements)[number]>();
  for (let i = candidates.length - 1; i >= 0; i--) {
    const p = candidates[i]!;
    const size = characterCount(p.message.text);
    // Never substitute smaller, older advice for newer advice that cannot fit.
    if (remainingMessages <= 0 || size > remainingChars) break;
    selected.add(p);
    remainingMessages--;
    remainingChars -= size;
  }
  const result: AnalyzeMessage[] = [];
  if (fallback && selected.has(fallback)) result.push(fallback.message);
  dialogue.forEach((message, i) => {
    const current = i === dialogue.length - 1;
    const normalized = {
      ...message,
      speakerRole: 'user' as const,
      speakerIndex:
        message.speakerIndex ?? (message.speakerRole === 'assistant' ? 0 : 1),
    };
    if (!current) result.push(normalized);
    for (const p of candidates) {
      if (p.position === start + i && selected.has(p)) result.push(p.message);
    }
    // The backend persists this entry, so analysis must never follow it.
    if (current) result.push(normalized);
  });
  return result;
}

export function hasAnalysis(value: CaesuraAnalysis): boolean {
  if (value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
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
    if (inject.keepLast < 0)
      throw new Error('CaesuraO: inject.keepLast must be nonnegative.');
    recs = inject.keepLast === 0 ? [] : recs.slice(-inject.keepLast);
  }
  return recs;
}

const FIELD_TOKEN = /\{analysis(?:\.([^{}]+))?\}/g;

/** Render one analysis through the template, resolving {analysis} / {analysis.field}. */
export function renderAnalysis(
  analysis: CaesuraAnalysis,
  template: string,
): string {
  // Replace tokens line-aware: if a token resolves to '', drop its whole line.
  const lines = template.split('\n');
  const rendered = lines
    .map((line) => {
      let sawToken = false;
      let allEmpty = true;
      const out = line.replace(FIELD_TOKEN, (_full, field?: string) => {
        sawToken = true;
        const value =
          field === undefined
            ? analysis
            : analysis !== null &&
                typeof analysis === 'object' &&
                !Array.isArray(analysis) &&
                Object.hasOwn(analysis, field)
              ? analysis[field]
              : undefined;
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

export function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return JSON.stringify(value);
}

/** Render the full injection block (rendered active analyses). */
export function renderBlock(
  recs: StoredRecommendation[],
  inject: Required<Omit<InjectConfig, 'skillPrompt'>> & {
    skillPrompt?: string;
  },
): {
  recommendationId: string;
  text: string;
  afterMessageHash: string;
  afterMessageAnchor?: string;
  createdAtTurn: number;
}[] {
  return recs
    .map((r) => ({
      recommendationId: r.id,
      text: renderAnalysis(r.analysis, inject.template),
      afterMessageHash: r.afterMessageHash,
      ...(r.afterMessageAnchor !== undefined
        ? { afterMessageAnchor: r.afterMessageAnchor }
        : {}),
      createdAtTurn: r.createdAtTurn,
    }))
    .filter((b) => b.text.trim() !== '');
}
