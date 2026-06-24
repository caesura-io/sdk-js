import type { PromptMessageLike, TextPartLike } from './internal/ai-types.js';
import type { AnalyzeMessage } from './client.js';
import type {
  CaesuraAnalysis,
  InjectConfig,
  ResolvedConfig,
  SendConfig,
  SpeakerNames,
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

type CollectedMessage = AnalyzeMessage;

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
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const text = messageText(m.content);
      return {
        speakerRole: 'user' as const,
        speakerName: m.role === 'assistant' ? speakers.agent : speakers.customer,
        text,
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
 * Build the backend `messages` array: the dialogue window with the SDK's
 * buffered prior analyses interleaved at their correct chronological position
 * as assistant-role JSON. Preserves exact conversation order.
 *
 * Uses content hashes (not indices) to find insertion points, so the result
 * is correct even when the prompt has been trimmed, reordered, or mutated
 * between turns.
 */
export function buildAnalyzeMessages(
  collected: CollectedMessage[],
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

function stringifyValue(value: unknown): string {
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

/**
 * Splice the rendered block into the prompt as a new message.
 * 'end' appends. 'after-last-analyzed' inserts right after the last prompt
 * message whose text starts with the last analyzed message's text; falls back
 * to 'end' if not found.
 */
export interface InjectBlockResult {
  prompt: PromptMessageLike[];
  indices: number[]; // The array index where each block landed
}

export function injectBlocks(
  prompt: PromptMessageLike[],
  blocks: { recommendationId: string; text: string; afterMessageHash: string; createdAtTurn: number }[],
  inject: Required<Omit<InjectConfig, 'skillPrompt'>>,
  speakerNames: Required<SpeakerNames>,
): InjectBlockResult {
  if (blocks.length === 0) return { prompt, indices: [] };

  if (inject.placement === 'end') {
    // Append them all individually
    const newPrompt = [...prompt];
    const indices: number[] = [];
    for (const b of blocks) {
      newPrompt.push({ role: inject.as, content: [{ type: 'text', text: b.text }] });
      indices.push(newPrompt.length - 1);
    }
    return { prompt: newPrompt, indices };
  }

  // placement === 'after-last-analyzed' -> interleave them chronologically
  // 1. Hash the prompt
  const hashToPositions = new Map<string, number[]>();
  for (let i = 0; i < prompt.length; i++) {
    const msg = prompt[i]!;
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const speakerName = msg.role === 'user' ? speakerNames.customer : speakerNames.agent;
    const text = messageText(msg.content);
    const hash = hashMessage(speakerName, text);
    let positions = hashToPositions.get(hash);
    if (!positions) {
      positions = [];
      hashToPositions.set(hash, positions);
    }
    positions.push(i);
  }

  // 2. Map blocks to indices backwards by turn
  const turnGroups = new Map<number, typeof blocks>();
  for (const b of blocks) {
    let group = turnGroups.get(b.createdAtTurn);
    if (!group) {
      group = [];
      turnGroups.set(b.createdAtTurn, group);
    }
    group.push(b);
  }

  const sortedTurns = Array.from(turnGroups.keys()).sort((a, b) => b - a);
  const insertions: { index: number; text: string; blockIndex: number }[] = [];
  let latestUnanchoredTurn: number | undefined;

  for (const turn of sortedTurns) {
    const groupBlocks = turnGroups.get(turn)!;
    // All blocks in a turn share the same anchor
    const afterHash = groupBlocks[0]!.afterMessageHash;
    const positions = hashToPositions.get(afterHash);
    const pos = positions && positions.length > 0 ? positions.pop() : undefined;

    if (pos !== undefined) {
      // Insert *after* the anchor message
      for (const b of groupBlocks) {
        insertions.push({ index: pos + 1, text: b.text, blockIndex: blocks.indexOf(b) });
      }
    } else {
      if (latestUnanchoredTurn === undefined) {
        latestUnanchoredTurn = turn; // keep the latest turn
      }
    }
  }

  if (latestUnanchoredTurn !== undefined) {
    // Prepend at index 0
    const groupBlocks = turnGroups.get(latestUnanchoredTurn)!;
    for (const b of groupBlocks) {
      insertions.push({ index: 0, text: b.text, blockIndex: blocks.indexOf(b) });
    }
  }

  // Group insertions by index so we can merge texts at the same index
  const groupedInsertions = new Map<number, { texts: string[]; blockIndices: number[] }>();
  for (const ins of insertions) {
    let group = groupedInsertions.get(ins.index);
    if (!group) {
      group = { texts: [], blockIndices: [] };
      groupedInsertions.set(ins.index, group);
    }
    // We want chronological order. The `blocks` array was chronological.
    // We can just keep them in order by sorting them below.
    group.texts.push(ins.text);
    group.blockIndices.push(ins.blockIndex);
  }

  // 3. Splice into prompt in a forward pass, updating offsets
  const sortedIndices = Array.from(groupedInsertions.keys()).sort((a, b) => a - b);
  let newPrompt = [...prompt];
  const finalIndices: number[] = new Array(blocks.length).fill(-1);
  let offset = 0;

  for (const index of sortedIndices) {
    const group = groupedInsertions.get(index)!;

    // Sort blockIndices so texts are joined chronologically
    const sortedGroup = group.blockIndices.map((bi, i) => ({ bi, text: group.texts[i]! })).sort((a, b) => a.bi - b.bi);
    const mergedText = sortedGroup.map(g => g.text).join('\n\n');

    const insertPos = index + offset;
    const msg: PromptMessageLike = { role: inject.as, content: [{ type: 'text', text: mergedText }] };
    newPrompt = [...newPrompt.slice(0, insertPos), msg, ...newPrompt.slice(insertPos)];

    for (const { bi } of sortedGroup) {
      finalIndices[bi] = insertPos;
    }
    offset += 1;
  }

  return { prompt: newPrompt, indices: finalIndices };
}

/**
 * Appends the skillPrompt to the system prompt (if present) or prepends a new
 * system message (if absent). Skips if skillPrompt is empty or already present.
 */
export function applySkillPrompt(
  prompt: PromptMessageLike[],
  skillPrompt: string | undefined,
): PromptMessageLike[] {
  if (!skillPrompt || skillPrompt.trim() === '') {
    return prompt;
  }

  const sysIndex = prompt.findIndex((m) => m.role === 'system');

  if (sysIndex !== -1) {
    const sysMsg = prompt[sysIndex]!;
    const currentContent = sysMsg.content;

    const currentText = messageText(currentContent);
    if (currentText.includes(skillPrompt)) {
      return prompt;
    }

    const newContent =
      typeof currentContent === 'string'
        ? `${currentContent}\n\n${skillPrompt}`
        : [...(Array.isArray(currentContent) ? currentContent : []), { type: 'text', text: `\n\n${skillPrompt}` }];

    const newSysMsg: PromptMessageLike = {
      ...sysMsg,
      content: newContent as PromptMessageLike['content'],
    };

    const newPrompt = [...prompt];
    newPrompt[sysIndex] = newSysMsg;
    return newPrompt;
  } else {
    const newSysMsg: PromptMessageLike = {
      role: 'system',
      content: [{ type: 'text', text: skillPrompt }],
    };
    return [newSysMsg, ...prompt];
  }
}
