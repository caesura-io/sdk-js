import {
  hashMessage,
  isInjectedMessage,
  dialogueAnchors,
  limitMessages,
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
        return (
          p &&
          typeof p === 'object' &&
          'type' in p &&
          ['text', 'input_text', 'output_text'].includes(p.type) &&
          'text' in p &&
          typeof p.text === 'string'
        );
      })
      .map((p) => p.text)
      .join('');
  }
  return '';
}

/** Remove recognized prior SDK guidance without changing caller-owned messages. */
export function stripInjectedOpenAIMessages(
  input: unknown,
  known: ReadonlySet<string>,
): unknown {
  // String input is fresh dialogue, never an SDK-emitted message array.
  if (!Array.isArray(input)) return input;
  return input.filter(
    (m: MessageLike) =>
      !m || !isInjectedMessage(m, getMessageText(m.content), known),
  );
}

/**
 * Normalizes OpenAI Chat completion messages or Responses API inputs into AnalyzeMessage[].
 */
export function collectOpenAIMessages(
  messagesOrInput: unknown,
  send: { maxMessages?: number | 'all'; maxInputChars?: number },
  speakers: ResolvedConfig['speakerNames'],
  injectedMessages: ReadonlySet<string>,
): AnalyzeMessage[] {
  messagesOrInput = stripInjectedOpenAIMessages(
    messagesOrInput,
    injectedMessages,
  );
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
      return !!(
        m &&
        typeof m === 'object' &&
        (m.role === 'user' || m.role === 'assistant') &&
        (m.type === undefined || m.type === 'message')
      );
    })
    .map((m) => {
      const text = getMessageText(m.content);
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
  const sysIndex = rawItems.findIndex(
    (m) => m && (m.role === 'system' || m.role === 'developer'),
  );

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
      newContent = [
        ...currentContent,
        { type: 'text', text: `\n\n${skillPrompt}` },
      ];
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
    result:
      isStringInput &&
      rawItems.length === 1 &&
      rawItems[0] &&
      rawItems[0].role === 'user'
        ? rawItems[0].content
        : rawItems,
  };
}

/**
 * Splices the rendered blocks into the messages/input list.
 */
export function injectBlocksOpenAI(
  messagesOrInput: unknown,
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
): { result: unknown; indices: number[] } {
  messagesOrInput = stripInjectedOpenAIMessages(
    messagesOrInput,
    injectedMessages,
  );
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
      result:
        isStringInput &&
        rawItems.length === 1 &&
        rawItems[0] &&
        rawItems[0].role === 'user'
          ? rawItems[0].content
          : rawItems,
      indices,
    };
  }

  // placement === 'after-last-analyzed' -> interleave them chronologically
  // Use the same collection rules as observation, retaining provider indices.
  const dialogue: AnalyzeMessage[] = [];
  const dialoguePositions: number[] = [];
  const hashToPositions = new Map<string, number[]>();
  for (let i = 0; i < rawItems.length; i++) {
    const [message] = collectOpenAIMessages(
      [rawItems[i]!],
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
    const afterHash = groupBlocks[0]!.afterMessageHash;
    const positions = hashToPositions.get(afterHash);
    const anchor = groupBlocks[0]!.afterMessageAnchor;
    const pos =
      anchor !== undefined ? anchorToPosition.get(anchor) : positions?.pop();

    if (pos !== undefined) {
      for (const b of groupBlocks) {
        let boundary = pos + 1;
        while (
          boundary < rawItems.length &&
          (rawItems[boundary]?.role === 'tool' ||
            rawItems[boundary]?.type === 'function_call' ||
            rawItems[boundary]?.type === 'function_call_output' ||
            rawItems[boundary]?.type === 'reasoning')
        )
          boundary++;
        insertions.push({
          index: boundary,
          text: b.text,
          blockIndex: blocks.indexOf(b),
        });
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
      insertions.push({
        index: 0,
        text: b.text,
        blockIndex: blocks.indexOf(b),
      });
    }
  }

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

  const sortedIndices = Array.from(groupedInsertions.keys()).sort(
    (a, b) => a - b,
  );
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
    newItems = [
      ...newItems.slice(0, insertPos),
      msg,
      ...newItems.slice(insertPos),
    ];

    for (const { bi } of sortedGroup) {
      finalIndices[bi] = insertPos;
    }
    offset += 1;
  }

  return {
    result:
      isStringInput &&
      newItems.length === 1 &&
      newItems[0] &&
      newItems[0].role === 'user'
        ? newItems[0].content
        : newItems,
    indices: finalIndices,
  };
}
