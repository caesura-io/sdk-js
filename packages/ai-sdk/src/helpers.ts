import type { PromptMessageLike, TextPartLike } from './internal/ai-types.js';
import {
  hashMessage,
  isInjectedMessage,
  dialogueAnchors,
  limitMessages,
  type AnalyzeMessage,
  type InjectConfig,
  type ResolvedConfig,
  type SendConfig,
  type SpeakerNames,
} from '@caesura-io/core';

export {
  hashMessage,
  buildAnalyzeMessages,
  selectActive,
  renderAnalysis,
  renderBlock,
} from '@caesura-io/core';

/** Extract concatenated text from a provider-level message's content. */
export function messageText(content: PromptMessageLike['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter(
      (p): p is TextPartLike =>
        p.type === 'text' && typeof (p as TextPartLike).text === 'string',
    )
    .map((p) => p.text)
    .join('');
}

/** Remove recognized prior SDK guidance before collecting or reinjecting. */
export function stripInjectedMessages(
  prompt: PromptMessageLike[],
  known: ReadonlySet<string>,
): PromptMessageLike[] {
  return prompt.filter(
    (message) =>
      !isInjectedMessage(message, messageText(message.content), known),
  );
}

type CollectedMessage = AnalyzeMessage;

/**
 * Collect the dialogue window to send. Maps both dialogue roles to user, labels
 * speakers, applies maxMessages, then char-trims from the START.
 */
export function collectMessages(
  prompt: PromptMessageLike[],
  send: Required<Pick<SendConfig, 'maxMessages'>> & SendConfig,
  speakers: ResolvedConfig['speakerNames'],
  injectedMessages: ReadonlySet<string>,
): CollectedMessage[] {
  let msgs: CollectedMessage[] = stripInjectedMessages(prompt, injectedMessages)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const text = messageText(m.content);
      return {
        // Both participants are input to the analysis prompt.
        speakerRole: 'user' as const,
        speakerIndex:
          typeof m.speakerIndex === 'number'
            ? m.speakerIndex
            : m.role === 'assistant'
              ? 0
              : 1,
        speakerName:
          typeof m.name === 'string'
            ? m.name
            : m.role === 'assistant'
              ? speakers.agent
              : speakers.customer,
        text,
      };
    })
    .filter((c) => c.text.trim() !== '');

  msgs = limitMessages(msgs, send);

  return msgs;
}

/**
 * Splice the rendered block into the prompt as a new message.
 * 'end' appends. 'after-last-analyzed' inserts right after the last prompt
 * analyzed occurrence. Unmatched latest guidance is prepended as context.
 */
export interface InjectBlockResult {
  prompt: PromptMessageLike[];
  indices: number[]; // The array index where each block landed
}

function injectionMessage(role: string, text: string): PromptMessageLike {
  // Provider-level AI SDK prompts represent instructions as system strings.
  if (role === 'system' || role === 'developer')
    return { role: 'system', content: text };
  return { role, content: [{ type: 'text', text }] };
}

export function injectBlocks(
  prompt: PromptMessageLike[],
  blocks: {
    recommendationId: string;
    text: string;
    afterMessageHash: string;
    afterMessageAnchor?: string;
    createdAtTurn: number;
  }[],
  inject: Required<Omit<InjectConfig, 'skillPrompt'>>,
  speakerNames: Required<SpeakerNames>,
  injectedMessages: ReadonlySet<string> = new Set(),
): InjectBlockResult {
  prompt = stripInjectedMessages(prompt, injectedMessages);
  if (blocks.length === 0) return { prompt, indices: [] };

  if (inject.placement === 'end') {
    // Append them all individually
    const newPrompt = [...prompt];
    const indices: number[] = [];
    for (const b of blocks) {
      newPrompt.push(injectionMessage(inject.as, b.text));
      indices.push(newPrompt.length - 1);
    }
    return { prompt: newPrompt, indices };
  }

  // placement === 'after-last-analyzed' -> interleave them chronologically
  // Use the same collection rules as observation, retaining provider indices.
  const dialogue: AnalyzeMessage[] = [];
  const dialoguePositions: number[] = [];
  const hashToPositions = new Map<string, number[]>();
  for (let i = 0; i < prompt.length; i++) {
    const [message] = collectMessages(
      [prompt[i]!],
      { maxMessages: 'all' },
      speakerNames,
      new Set(), // Guidance was already stripped; string input is fresh dialogue.
    );
    if (!message) continue;
    dialogue.push(message);
    dialoguePositions.push(i);
    const hash = hashMessage(message.speakerName ?? '', message.text);
    const positions = hashToPositions.get(hash) ?? [];
    positions.push(i);
    hashToPositions.set(hash, positions);
  }
  const anchorToPosition = new Map(
    dialogueAnchors(dialogue).map((anchor, i) => [
      anchor,
      dialoguePositions[i]!,
    ]),
  );

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
    const anchor = groupBlocks[0]!.afterMessageAnchor;
    const pos =
      anchor !== undefined ? anchorToPosition.get(anchor) : positions?.pop();

    if (pos !== undefined) {
      // Insert *after* the anchor message
      for (const b of groupBlocks) {
        let boundary = pos + 1;
        while (boundary < prompt.length && prompt[boundary]?.role === 'tool')
          boundary++;
        insertions.push({
          index: boundary,
          text: b.text,
          blockIndex: blocks.indexOf(b),
        });
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
      insertions.push({
        index: 0,
        text: b.text,
        blockIndex: blocks.indexOf(b),
      });
    }
  }

  // Group insertions by index so we can merge texts at the same index
  const groupedInsertions = new Map<
    number,
    { texts: string[]; blockIndices: number[] }
  >();
  for (const ins of insertions) {
    let group = groupedInsertions.get(ins.index);
    if (!group) {
      group = { texts: [], blockIndices: [] };
      groupedInsertions.set(ins.index, group);
    }
    group.texts.push(ins.text);
    group.blockIndices.push(ins.blockIndex);
  }

  // 3. Splice into prompt in a forward pass, updating offsets
  const sortedIndices = Array.from(groupedInsertions.keys()).sort(
    (a, b) => a - b,
  );
  let newPrompt = [...prompt];
  const finalIndices: number[] = new Array(blocks.length).fill(-1);
  let offset = 0;

  for (const index of sortedIndices) {
    const group = groupedInsertions.get(index)!;

    // Sort blockIndices so texts are joined chronologically
    const sortedGroup = group.blockIndices
      .map((bi, i) => ({ bi, text: group.texts[i]! }))
      .sort((a, b) => a.bi - b.bi);
    const mergedText = sortedGroup.map((g) => g.text).join('\n\n');

    const insertPos = index + offset;
    const msg = injectionMessage(inject.as, mergedText);
    newPrompt = [
      ...newPrompt.slice(0, insertPos),
      msg,
      ...newPrompt.slice(insertPos),
    ];

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

    const newContent = `${currentText}\n\n${skillPrompt}`;

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
      content: skillPrompt,
    };
    return [newSysMsg, ...prompt];
  }
}
