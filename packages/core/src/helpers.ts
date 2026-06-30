import type { AnalyzeMessage } from './client.js';
import type {
  CaesuraAnalysis,
  InjectConfig,
} from './types.js';
import type { ConversationState, StoredRecommendation } from './store.js';

/**
 * FNV-1a hash of a message's identity (speakerName + text).
 * Used to track which dialogue message an analysis was generated after,
 * independent of prompt array indices.
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
 * Build the backend `messages` array: the dialogue window with the SDK's
 * buffered prior analyses interleaved at their correct chronological position
 * as assistant-role JSON. Preserves exact conversation order.
 *
 * Uses content hashes (not indices) to find insertion points, so the result
 * is correct even when the prompt has been trimmed, reordered, or mutated
 * between turns.
 */
export function buildAnalyzeMessages(
  collected: AnalyzeMessage[],
  state: ConversationState,
): AnalyzeMessage[] {
  if (state.recommendations.length === 0) {
    // Fast path: no analyses to interleave.
    return collected.map((c) => ({
      speakerRole: c.speakerRole,
      speakerName: c.speakerName,
      text: c.text,
    }));
  }

  // O(n): build hash → array of positions.
  // This allows us to perfectly pair multiple identical messages (e.g. "yes", "yes")
  // with their corresponding analyses.
  const hashToPositions = new Map<string, number[]>();
  for (let i = 0; i < collected.length; i++) {
    const c = collected[i]!;
    const hash = hashMessage(c.speakerName ?? '', c.text);
    let positions = hashToPositions.get(hash);
    if (!positions) {
      positions = [];
      hashToPositions.set(hash, positions);
    }
    positions.push(i);
  }

  // O(m): resolve each recommendation's insertion position backwards.
  // The newest recommendation gets the last occurrence of the message,
  // the second newest gets the second last, etc.
  // position === undefined  →  message was trimmed, prepend as context.
  const placements = new Array<{ msg: AnalyzeMessage; position: number | undefined }>(
    state.recommendations.length
  );
  for (let i = state.recommendations.length - 1; i >= 0; i--) {
    const r = state.recommendations[i]!;
    const positions = hashToPositions.get(r.afterMessageHash);
    const position = positions && positions.length > 0 ? positions.pop() : undefined;
    placements[i] = {
      msg: { speakerRole: 'assistant' as const, text: JSON.stringify(r.analysis) },
      position,
    };
  }

  // Build the result array.
  const result: AnalyzeMessage[] = [];

  // Prepend at most 1 analysis (the latest one) if its anchor message was trimmed.
  const unanchored = placements.filter((p) => p.position === undefined);
  if (unanchored.length > 0) {
    const latestUnanchored = unanchored[unanchored.length - 1]!;
    result.push(latestUnanchored.msg);
  }

  // Walk collected messages and insert analyses after their anchor.
  for (let ci = 0; ci < collected.length; ci++) {
    const c = collected[ci]!;
    result.push({
      speakerRole: c.speakerRole,
      speakerName: c.speakerName,
      text: c.text,
    });

    for (const p of placements) {
      if (p.position === ci) {
        result.push(p.msg);
      }
    }
  }

  return result;
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

export function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Render the full injection block (rendered active analyses). */
export function renderBlock(
  recs: StoredRecommendation[],
  inject: Required<Omit<InjectConfig, 'skillPrompt'>> & { skillPrompt?: string },
): { recommendationId: string; text: string; afterMessageHash: string; createdAtTurn: number }[] {
  return recs
    .map((r) => ({
      recommendationId: r.id,
      text: renderAnalysis(r.analysis, inject.template),
      afterMessageHash: r.afterMessageHash,
      createdAtTurn: r.createdAtTurn,
    }))
    .filter((b) => b.text.trim() !== '');
}
