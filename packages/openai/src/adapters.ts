import {
  hashMessage,
  type AnalyzeMessage,
  type InjectConfig,
  type ResolvedConfig,
  type SpeakerNames,
} from '@caesura-io/core';

interface MessageLike {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
}

/**
 * Extracts string content from an OpenAI message or response input content.
 */
export function getMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: 'text'; text: string } => {
        return p && typeof p === 'object' && 'type' in p && p.type === 'text' && 'text' in p && typeof p.text === 'string';
      })
      .map((p) => p.text)
      .join('');
  }
  return '';
}

/**
 * Normalizes OpenAI Chat completion messages or Responses API inputs into AnalyzeMessage[].
 */
export function collectOpenAIMessages(
  messagesOrInput: unknown,
  send: { maxMessages?: number | 'all'; maxInputChars?: number },
  speakers: ResolvedConfig['speakerNames'],
  injectedTexts: ReadonlySet<string>,
): AnalyzeMessage[] {
  let rawItems: MessageLike[];

  if (typeof messagesOrInput === 'string') {
    rawItems = [{ role: 'user', content: messagesOrInput }];
  } else if (Array.isArray(messagesOrInput)) {
    rawItems = messagesOrInput as MessageLike[];
  } else {
    return [];
  }

  let msgs: AnalyzeMessage[] = rawItems
    .filter((m): m is MessageLike & { role: 'user' | 'assistant' } => {
      return !!(m && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant'));
    })
    .map((m) => {
      const text = getMessageText(m.content);
      return {
        speakerRole: 'user' as const,
        speakerName: m.role === 'assistant' ? speakers.agent : speakers.customer,
        text,
      };
    })
    .filter((c) => !injectedTexts.has(c.text));

  if (send.maxMessages !== 'all' && send.maxMessages !== undefined) {
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
 * Appends the skillPrompt to the system prompt or prepends a new system message.
 * For Responses API, we can either append it to instructions or modify messages if it's an array input.
 */
export function applySkillPromptOpenAI(
  messagesOrInput: unknown,
  skillPrompt: string | undefined,
  responsesInstructions?: string | null,
): { result: unknown; instructions?: string | null } {
  if (!skillPrompt || skillPrompt.trim() === '') {
    return { result: messagesOrInput, instructions: responsesInstructions };
  }

  // If we are using Responses API and instructions are specified/used
  if (responsesInstructions !== undefined) {
    if (responsesInstructions && responsesInstructions.includes(skillPrompt)) {
      return { result: messagesOrInput, instructions: responsesInstructions };
    }
    const newInstructions = responsesInstructions
      ? `${responsesInstructions}\n\n${skillPrompt}`
      : skillPrompt;
    return { result: messagesOrInput, instructions: newInstructions };
  }

  // Otherwise, handle messages or input array
  let rawItems: MessageLike[];
  let isStringInput = false;

  if (typeof messagesOrInput === 'string') {
    rawItems = [{ role: 'user', content: messagesOrInput }];
    isStringInput = true;
  } else if (Array.isArray(messagesOrInput)) {
    rawItems = [...(messagesOrInput as MessageLike[])];
  } else {
    return { result: messagesOrInput };
  }

  // Find system or developer message
  const sysIndex = rawItems.findIndex((m) => m && (m.role === 'system' || m.role === 'developer'));

  if (sysIndex !== -1) {
    const sysMsg = rawItems[sysIndex]!;
    const currentContent = sysMsg.content;
    const currentText = getMessageText(currentContent);

    if (currentText.includes(skillPrompt)) {
      return { result: messagesOrInput };
    }

    let newContent: unknown;
    if (typeof currentContent === 'string') {
      newContent = `${currentContent}\n\n${skillPrompt}`;
    } else if (Array.isArray(currentContent)) {
      newContent = [...currentContent, { type: 'text', text: `\n\n${skillPrompt}` }];
    } else {
      newContent = skillPrompt;
    }

    rawItems[sysIndex] = {
      ...sysMsg,
      content: newContent,
    };
  } else {
    // Prepend a new system message
    rawItems.unshift({
      role: 'system',
      content: skillPrompt,
    });
  }

  return {
    result: isStringInput && rawItems.length === 1 && rawItems[0] && rawItems[0].role === 'user'
      ? rawItems[0].content
      : rawItems,
  };
}

/**
 * Splices the rendered blocks into the messages/input list.
 */
export function injectBlocksOpenAI(
  messagesOrInput: unknown,
  blocks: { recommendationId: string; text: string; afterMessageHash: string; createdAtTurn: number }[],
  inject: Required<Omit<InjectConfig, 'skillPrompt'>>,
  speakerNames: Required<SpeakerNames>,
): { result: unknown; indices: number[] } {
  if (blocks.length === 0) {
    return { result: messagesOrInput, indices: [] };
  }

  let rawItems: MessageLike[];
  let isStringInput = false;

  if (typeof messagesOrInput === 'string') {
    rawItems = [{ role: 'user', content: messagesOrInput }];
    isStringInput = true;
  } else if (Array.isArray(messagesOrInput)) {
    rawItems = [...(messagesOrInput as MessageLike[])];
  } else {
    return { result: messagesOrInput, indices: [] };
  }

  if (inject.placement === 'end') {
    const indices: number[] = [];
    for (const b of blocks) {
      rawItems.push({ role: inject.as, content: b.text });
      indices.push(rawItems.length - 1);
    }
    return {
      result: isStringInput && rawItems.length === 1 && rawItems[0] && rawItems[0].role === 'user' ? rawItems[0].content : rawItems,
      indices,
    };
  }

  // placement === 'after-last-analyzed' -> interleave them chronologically
  // 1. Hash the prompt items
  const hashToPositions = new Map<string, number[]>();
  for (let i = 0; i < rawItems.length; i++) {
    const msg = rawItems[i];
    if (!msg || msg.role !== 'user' && msg.role !== 'assistant') {
      continue;
    }
    const speakerName = msg.role === 'user' ? speakerNames.customer : speakerNames.agent;
    const text = getMessageText(msg.content);
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
    const afterHash = groupBlocks[0]!.afterMessageHash;
    const positions = hashToPositions.get(afterHash);
    const pos = positions && positions.length > 0 ? positions.pop() : undefined;

    if (pos !== undefined) {
      for (const b of groupBlocks) {
        insertions.push({ index: pos + 1, text: b.text, blockIndex: blocks.indexOf(b) });
      }
    } else {
      if (latestUnanchoredTurn === undefined) {
        latestUnanchoredTurn = turn;
      }
    }
  }

  if (latestUnanchoredTurn !== undefined) {
    const groupBlocks = turnGroups.get(latestUnanchoredTurn)!;
    for (const b of groupBlocks) {
      insertions.push({ index: 0, text: b.text, blockIndex: blocks.indexOf(b) });
    }
  }

  const groupedInsertions = new Map<number, { texts: string[]; blockIndices: number[] }>();
  for (const ins of insertions) {
    let group = groupedInsertions.get(ins.index);
    if (!group) {
      group = { texts: [], blockIndices: [] };
      groupedInsertions.set(ins.index, group);
    }
    group.texts.push(ins.text);
    group.blockIndices.push(ins.blockIndex);
  }

  const sortedIndices = Array.from(groupedInsertions.keys()).sort((a, b) => a - b);
  let newItems = [...rawItems];
  const finalIndices: number[] = new Array(blocks.length).fill(-1);
  let offset = 0;

  for (const index of sortedIndices) {
    const group = groupedInsertions.get(index)!;
    const sortedGroup = group.blockIndices
      .map((bi, i) => ({ bi, text: group.texts[i]! }))
      .sort((a, b) => a.bi - b.bi);
    const mergedText = sortedGroup.map((g) => g.text).join('\n\n');

    const insertPos = index + offset;
    const msg = { role: inject.as, content: mergedText };
    newItems = [...newItems.slice(0, insertPos), msg, ...newItems.slice(insertPos)];

    for (const { bi } of sortedGroup) {
      finalIndices[bi] = insertPos;
    }
    offset += 1;
  }

  return {
    result: isStringInput && newItems.length === 1 && newItems[0] && newItems[0].role === 'user' ? newItems[0].content : newItems,
    indices: finalIndices,
  };
}
