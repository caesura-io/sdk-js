import { describe, it, expect } from 'vitest';
import {
  collectMessages,
  buildAnalyzeMessages,
  hashMessage,
  renderAnalysis,
  selectActive,
  injectBlocks,
  messageText,
  renderBlock,
  applySkillPrompt,
} from './helpers.js';
import type { ConversationState } from './store.js';
import type { PromptMessageLike } from './internal/ai-types.js';

describe('helpers', () => {
  describe('messageText', () => {
    it('handles string content', () => {
      expect(messageText('hello')).toBe('hello');
    });

    it('handles text parts array', () => {
      expect(messageText([{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }])).toBe('hello world');
    });

    it('skips non-text parts', () => {
      expect(messageText([{ type: 'image', text: 'ignored' }, { type: 'text', text: 'hello' }])).toBe('hello');
    });
  });

  describe('collectMessages', () => {
    const speakers = { agent: 'Agent', customer: 'Customer' };

    it('collects assistant and user messages', () => {
      const prompt: PromptMessageLike[] = [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'user message' },
        { role: 'assistant', content: 'assistant response' },
      ];

      const collected = collectMessages(prompt, { maxMessages: 10 }, speakers, new Set());
      expect(collected).toHaveLength(2);
      expect(collected[0]).toEqual({
        speakerRole: 'user',
        speakerName: 'Customer',
        text: 'user message',
      });
      expect(collected[1]).toEqual({
        speakerRole: 'user',
        speakerName: 'Agent',
        text: 'assistant response',
      });
    });

    it('skips injected blocks based on text match', () => {
      const prompt: PromptMessageLike[] = [
        { role: 'user', content: 'hello' },
        { role: 'user', content: 'injected rec' },
      ];

      const collected = collectMessages(prompt, { maxMessages: 10 }, speakers, new Set(['injected rec']));
      expect(collected).toHaveLength(1);
      expect(collected[0]!.text).toBe('hello');
    });

    it('respects maxMessages and trims oldest first', () => {
      const prompt: PromptMessageLike[] = [
        { role: 'user', content: '1' },
        { role: 'user', content: '2' },
        { role: 'user', content: '3' },
      ];

      const collected = collectMessages(prompt, { maxMessages: 2 }, speakers, new Set());
      expect(collected).toHaveLength(2);
      expect(collected[0]!.text).toBe('2');
      expect(collected[1]!.text).toBe('3');
    });

    it('respects maxInputChars and trims oldest first', () => {
      const prompt: PromptMessageLike[] = [
        { role: 'user', content: 'hello' },
        { role: 'user', content: 'world' },
      ];

      const collected = collectMessages(prompt, { maxMessages: 10, maxInputChars: 7 }, speakers, new Set());
      expect(collected).toHaveLength(1);
      expect(collected[0]!.text).toBe('world');
    });

    it('trims head of a single message if it exceeds maxInputChars', () => {
      const prompt: PromptMessageLike[] = [
        { role: 'user', content: 'hello world' },
      ];

      const collected = collectMessages(prompt, { maxMessages: 10, maxInputChars: 5 }, speakers, new Set());
      expect(collected).toHaveLength(1);
      expect(collected[0]!.text).toBe('world');
    });
  });

  describe('buildAnalyzeMessages', () => {
    it('interleaves analyses at the correct chronological position', () => {
      const collected = [
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'msg 1' },
        { speakerRole: 'user' as const, speakerName: 'Agent', text: 'response 1' },
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'msg 2' },
        { speakerRole: 'user' as const, speakerName: 'Agent', text: 'response 2' },
      ];
      const state: ConversationState = {
        recommendations: [
          { id: '1', analysis: { recommendation: 'A' }, afterMessageHash: hashMessage('Agent', 'response 1'), createdAtMs: 1000, createdAtTurn: 1 },
          { id: '2', analysis: { recommendation: 'B' }, afterMessageHash: hashMessage('Agent', 'response 2'), createdAtMs: 2000, createdAtTurn: 2 },
        ],
        turn: 3,
        lastQueryTurn: 2,
        lastQueryMs: 2000,
        inFlight: false,
        lastAccessMs: 0,
      };

      const messages = buildAnalyzeMessages(collected, state);
      expect(messages).toEqual([
        { speakerRole: 'user', speakerName: 'Customer', text: 'msg 1' },
        { speakerRole: 'user', speakerName: 'Agent', text: 'response 1' },
        { speakerRole: 'assistant', text: JSON.stringify({ recommendation: 'A' }) },
        { speakerRole: 'user', speakerName: 'Customer', text: 'msg 2' },
        { speakerRole: 'user', speakerName: 'Agent', text: 'response 2' },
        { speakerRole: 'assistant', text: JSON.stringify({ recommendation: 'B' }) },
      ]);
    });

    it('all dialogue messages use speakerRole user', () => {
      const collected = [
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'hello' },
        { speakerRole: 'user' as const, speakerName: 'Agent', text: 'hi there' },
      ];
      const state: ConversationState = {
        recommendations: [],
        turn: 1,
        lastQueryTurn: 0,
        lastQueryMs: 0,
        inFlight: false,
        lastAccessMs: 0,
      };

      const messages = buildAnalyzeMessages(collected, state);
      expect(messages.every((m) => m.speakerRole === 'user' || m.speakerRole === 'assistant')).toBe(true);
      expect(messages[0]!.speakerRole).toBe('user');
      expect(messages[1]!.speakerRole).toBe('user');
    });

    it('analyses have no speakerName', () => {
      const collected = [
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'msg' },
      ];
      const state: ConversationState = {
        recommendations: [
          { id: '1', analysis: { recommendation: 'R' }, afterMessageHash: hashMessage('Customer', 'msg'), createdAtMs: 1000, createdAtTurn: 1 },
        ],
        turn: 2,
        lastQueryTurn: 1,
        lastQueryMs: 1000,
        inFlight: false,
        lastAccessMs: 0,
      };

      const messages = buildAnalyzeMessages(collected, state);
      const analysis = messages.find((m) => m.speakerRole === 'assistant');
      expect(analysis).toBeDefined();
      expect(analysis!.speakerName).toBeUndefined();
    });

    it('analysis with trimmed anchor message is prepended', () => {
      // The anchor message "msg 1" was trimmed out of the window
      const collected = [
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'msg 3' },
        { speakerRole: 'user' as const, speakerName: 'Agent', text: 'response 3' },
      ];
      const state: ConversationState = {
        recommendations: [
          { id: '1', analysis: { recommendation: 'old' }, afterMessageHash: hashMessage('Customer', 'msg 1'), createdAtMs: 500, createdAtTurn: 1 },
        ],
        turn: 3,
        lastQueryTurn: 1,
        lastQueryMs: 500,
        inFlight: false,
        lastAccessMs: 0,
      };

      const messages = buildAnalyzeMessages(collected, state);
      expect(messages[0]!.speakerRole).toBe('assistant');
      expect(messages[1]!.text).toBe('msg 3');
      expect(messages[2]!.text).toBe('response 3');
    });

    it('async mode: analysis from turn 1 placed correctly in turn 3 window', () => {
      // Simulates: Turn 1 prompt=[user:msg1], observe fires async.
      // Turn 3 the prompt has grown but msg 1 is still present.
      // Analysis from turn 1 stored with hash of "msg 1".
      const collected = [
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'msg 1' },
        { speakerRole: 'user' as const, speakerName: 'Agent', text: 'resp 1' },
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'msg 2' },
        { speakerRole: 'user' as const, speakerName: 'Agent', text: 'resp 2' },
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'msg 3' },
      ];
      const state: ConversationState = {
        recommendations: [
          { id: '1', analysis: { recommendation: 'A' }, afterMessageHash: hashMessage('Customer', 'msg 1'), createdAtMs: 500, createdAtTurn: 1 },
        ],
        turn: 3,
        lastQueryTurn: 1,
        lastQueryMs: 500,
        inFlight: false,
        lastAccessMs: 0,
      };

      const messages = buildAnalyzeMessages(collected, state);
      expect(messages[0]).toEqual({ speakerRole: 'user', speakerName: 'Customer', text: 'msg 1' });
      expect(messages[1]).toEqual({ speakerRole: 'assistant', text: JSON.stringify({ recommendation: 'A' }) });
      expect(messages[2]).toEqual({ speakerRole: 'user', speakerName: 'Agent', text: 'resp 1' });
      expect(messages).toHaveLength(6); // 5 dialogue + 1 analysis
    });

    it('maxMessages trimming: analysis from before window is prepended', () => {
      // maxMessages=2 trimmed the window to only the last 2 messages.
      // The analysis was generated from a message that's now outside the window.
      const collected = [
        { speakerRole: 'user' as const, speakerName: 'Agent', text: 'resp 2' },
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'msg 3' },
      ];
      const state: ConversationState = {
        recommendations: [
          { id: '1', analysis: { recommendation: 'old' }, afterMessageHash: hashMessage('Customer', 'msg 1'), createdAtMs: 500, createdAtTurn: 1 },
          { id: '2', analysis: { recommendation: 'recent' }, afterMessageHash: hashMessage('Agent', 'resp 2'), createdAtMs: 1500, createdAtTurn: 2 },
        ],
        turn: 3,
        lastQueryTurn: 2,
        lastQueryMs: 1500,
        inFlight: false,
        lastAccessMs: 0,
      };

      const messages = buildAnalyzeMessages(collected, state);
      expect(messages).toEqual([
        // "old" analysis prepended (anchor message "msg 1" no longer in window)
        { speakerRole: 'assistant', text: JSON.stringify({ recommendation: 'old' }) },
        { speakerRole: 'user', speakerName: 'Agent', text: 'resp 2' },
        // "recent" analysis placed after "resp 2" (hash matches)
        { speakerRole: 'assistant', text: JSON.stringify({ recommendation: 'recent' }) },
        { speakerRole: 'user', speakerName: 'Customer', text: 'msg 3' },
      ]);
    });

    it('afterMessageHash on last collected message appends analysis at end', () => {
      const collected = [
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'msg' },
        { speakerRole: 'user' as const, speakerName: 'Agent', text: 'resp' },
      ];
      const state: ConversationState = {
        recommendations: [
          { id: '1', analysis: { recommendation: 'R' }, afterMessageHash: hashMessage('Agent', 'resp'), createdAtMs: 1000, createdAtTurn: 1 },
        ],
        turn: 2,
        lastQueryTurn: 1,
        lastQueryMs: 1000,
        inFlight: false,
        lastAccessMs: 0,
      };

      const messages = buildAnalyzeMessages(collected, state);
      expect(messages).toEqual([
        { speakerRole: 'user', speakerName: 'Customer', text: 'msg' },
        { speakerRole: 'user', speakerName: 'Agent', text: 'resp' },
        { speakerRole: 'assistant', text: JSON.stringify({ recommendation: 'R' }) },
      ]);
    });

    it('handles multiple identical messages gracefully', () => {
      // Four identical messages from Customer
      const collected = [
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'yes' },
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'yes' },
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'yes' },
        { speakerRole: 'user' as const, speakerName: 'Customer', text: 'yes' },
      ];

      const hash = hashMessage('Customer', 'yes');
      const state: ConversationState = {
        // Five analyses all targeting the "yes" hash
        recommendations: [
          { id: '1', analysis: { recommendation: 'A1' }, afterMessageHash: hash, createdAtMs: 100, createdAtTurn: 1 },
          { id: '2', analysis: { recommendation: 'A2' }, afterMessageHash: hash, createdAtMs: 200, createdAtTurn: 2 },
          { id: '3', analysis: { recommendation: 'A3' }, afterMessageHash: hash, createdAtMs: 300, createdAtTurn: 3 },
          { id: '4', analysis: { recommendation: 'A4' }, afterMessageHash: hash, createdAtMs: 400, createdAtTurn: 4 },
          { id: '5', analysis: { recommendation: 'A5' }, afterMessageHash: hash, createdAtMs: 500, createdAtTurn: 5 },
        ],
        turn: 5,
        lastQueryTurn: 5,
        lastQueryMs: 500,
        inFlight: false,
        lastAccessMs: 0,
      };

      const messages = buildAnalyzeMessages(collected, state);
      // We have 4 messages, 5 analyses.
      // Iterating backwards:
      // A5 pairs with yes[3]
      // A4 pairs with yes[2]
      // A3 pairs with yes[1]
      // A2 pairs with yes[0]
      // A1 has no position left, so it prepends.
      expect(messages).toEqual([
        { speakerRole: 'assistant', text: JSON.stringify({ recommendation: 'A1' }) },
        { speakerRole: 'user', speakerName: 'Customer', text: 'yes' },
        { speakerRole: 'assistant', text: JSON.stringify({ recommendation: 'A2' }) },
        { speakerRole: 'user', speakerName: 'Customer', text: 'yes' },
        { speakerRole: 'assistant', text: JSON.stringify({ recommendation: 'A3' }) },
        { speakerRole: 'user', speakerName: 'Customer', text: 'yes' },
        { speakerRole: 'assistant', text: JSON.stringify({ recommendation: 'A4' }) },
        { speakerRole: 'user', speakerName: 'Customer', text: 'yes' },
        { speakerRole: 'assistant', text: JSON.stringify({ recommendation: 'A5' }) },
      ]);
    });
  });

  describe('renderAnalysis', () => {
    const analysis = {
      observation: 'User is confused',
      recommendation: 'Explain caching',
      sentiment: 'Neutral',
      customField: 42,
    };

    it('resolves basic dot-path tokens', () => {
      const template = 'Obs: {analysis.observation}\nRec: {analysis.recommendation}';
      expect(renderAnalysis(analysis, template)).toBe('Obs: User is confused\nRec: Explain caching');
    });

    it('resolves full analysis JSON', () => {
      const template = '{analysis}';
      expect(JSON.parse(renderAnalysis(analysis, template))).toEqual(analysis);
    });

    it('drops lines with only empty tokens', () => {
      const template = 'Obs: {analysis.observation}\nEmpty: {analysis.nonexistent}\nRec: {analysis.recommendation}';
      expect(renderAnalysis(analysis, template)).toBe('Obs: User is confused\nRec: Explain caching');
    });
  });

  describe('selectActive', () => {
    const state: ConversationState = {
      recommendations: [
        { id: '1', analysis: { recommendation: 'A' }, afterMessageHash: hashMessage('Customer', 'x'), createdAtMs: 1000, createdAtTurn: 1 },
        { id: '2', analysis: { recommendation: 'B' }, afterMessageHash: hashMessage('Customer', 'y'), createdAtMs: 2000, createdAtTurn: 2 },
      ],
      turn: 3,
      lastQueryTurn: 0,
      lastQueryMs: 0,
      inFlight: false,
      lastAccessMs: 0,
    };

    it('retains all under none TTL', () => {
      const active = selectActive(state, { keepLast: 'all', ttl: { type: 'none' }, placement: 'end', as: 'user', template: '' }, 3000);
      expect(active).toHaveLength(2);
    });

    it('respects turns TTL', () => {
      const active = selectActive(state, { keepLast: 'all', ttl: { type: 'turns', turns: 1 }, placement: 'end', as: 'user', template: '' }, 3000);
      expect(active).toHaveLength(1);
      expect(active[0]!.id).toBe('2');
    });

    it('respects seconds TTL', () => {
      const active = selectActive(state, { keepLast: 'all', ttl: { type: 'seconds', seconds: 1.5 }, placement: 'end', as: 'user', template: '' }, 3000);
      expect(active).toHaveLength(1);
      expect(active[0]!.id).toBe('2');
    });

    it('respects keepLast limit', () => {
      const active = selectActive(state, { keepLast: 1, ttl: { type: 'none' }, placement: 'end', as: 'user', template: '' }, 3000);
      expect(active).toHaveLength(1);
      expect(active[0]!.id).toBe('2');
    });
  });

  describe('injectBlocks', () => {
    it('appends them all individually to end if placement is end', () => {
      const prompt: PromptMessageLike[] = [
        { role: 'user', content: 'hello' },
      ];
      const blocks = [
        { recommendationId: '1', text: 'rec 1', afterMessageHash: 'h1', createdAtTurn: 1 },
        { recommendationId: '2', text: 'rec 2', afterMessageHash: 'h2', createdAtTurn: 2 },
      ];
      const injected = injectBlocks(prompt, blocks, { placement: 'end', as: 'user', keepLast: 'all', ttl: { type: 'none' }, template: '' }, { customer: 'Customer', agent: 'Agent' });
      
      expect(injected.prompt).toHaveLength(3);
      expect(injected.prompt[1]!.content[0]!.text).toBe('rec 1');
      expect(injected.prompt[2]!.content[0]!.text).toBe('rec 2');
      expect(injected.indices).toEqual([1, 2]);
    });

    it('interleaves blocks chronologically after their anchor message', () => {
      const speakerNames = { customer: 'Customer', agent: 'Agent' };
      const msg1Hash = hashMessage('Customer', 'first message');
      const msg2Hash = hashMessage('Customer', 'second message');
      const msg3Hash = hashMessage('Customer', 'third message');

      const prompt: PromptMessageLike[] = [
        { role: 'user', content: 'first message' },
        { role: 'user', content: 'second message' },
        { role: 'user', content: 'third message' },
      ];
      
      const blocks = [
        { recommendationId: '1', text: 'rec 1', afterMessageHash: msg1Hash, createdAtTurn: 1 },
        { recommendationId: '2', text: 'rec 2', afterMessageHash: msg2Hash, createdAtTurn: 2 },
      ];

      const injected = injectBlocks(
        prompt,
        blocks,
        { placement: 'after-last-analyzed', as: 'user', keepLast: 'all', ttl: { type: 'none' }, template: '' },
        speakerNames
      );

      expect(injected.prompt).toHaveLength(5);
      expect(messageText(injected.prompt[0]!.content)).toBe('first message');
      expect(injected.prompt[1]!.content[0]!.text).toBe('rec 1');
      expect(messageText(injected.prompt[2]!.content)).toBe('second message');
      expect(injected.prompt[3]!.content[0]!.text).toBe('rec 2');
      expect(messageText(injected.prompt[4]!.content)).toBe('third message');
      expect(injected.indices).toEqual([1, 3]);
    });

    it('prepends the latest unanchored block and skips older unanchored ones', () => {
      const speakerNames = { customer: 'Customer', agent: 'Agent' };
      const prompt: PromptMessageLike[] = [
        { role: 'user', content: 'only message' },
      ];
      
      const blocks = [
        { recommendationId: '1', text: 'old unanchored', afterMessageHash: 'missing', createdAtTurn: 1 },
        { recommendationId: '2', text: 'new unanchored', afterMessageHash: 'also missing', createdAtTurn: 2 },
      ];

      const injected = injectBlocks(
        prompt,
        blocks,
        { placement: 'after-last-analyzed', as: 'user', keepLast: 'all', ttl: { type: 'none' }, template: '' },
        speakerNames
      );

      expect(injected.prompt).toHaveLength(2);
      expect(injected.prompt[0]!.content[0]!.text).toBe('new unanchored');
      expect(messageText(injected.prompt[1]!.content)).toBe('only message');
      // Indices array maps back to original blocks array
      expect(injected.indices).toEqual([-1, 0]); // block 1 skipped, block 2 prepended
    });

    it('merges blocks that land at the exact same index', () => {
      const speakerNames = { customer: 'Customer', agent: 'Agent' };
      const msgHash = hashMessage('Customer', 'only message');

      const prompt: PromptMessageLike[] = [
        { role: 'user', content: 'only message' },
      ];
      
      const blocks = [
        { recommendationId: '1', text: 'rec A', afterMessageHash: msgHash, createdAtTurn: 1 },
        { recommendationId: '2', text: 'rec B', afterMessageHash: msgHash, createdAtTurn: 1 },
      ];

      const injected = injectBlocks(
        prompt,
        blocks,
        { placement: 'after-last-analyzed', as: 'user', keepLast: 'all', ttl: { type: 'none' }, template: '' },
        speakerNames
      );

      expect(injected.prompt).toHaveLength(2);
      expect(messageText(injected.prompt[0]!.content)).toBe('only message');
      expect(injected.prompt[1]!.content[0]!.text).toBe('rec A\n\nrec B');
      expect(injected.indices).toEqual([1, 1]);
    });
  });

  describe('renderBlock', () => {
    it('concatenates recommendations without prepending skillPrompt', () => {
      const recs = [
        { id: '1', analysis: { recommendation: 'Rec A' }, afterMessageHash: hashMessage('Customer', 'x'), createdAtMs: 1000, createdAtTurn: 1 },
        { id: '2', analysis: { recommendation: 'Rec B' }, afterMessageHash: hashMessage('Customer', 'y'), createdAtMs: 2000, createdAtTurn: 2 },
      ];
      const blocks = renderBlock(recs, {
        template: 'Rec: {analysis.recommendation}',
        skillPrompt: 'Should be ignored in renderBlock',
        placement: 'end',
        as: 'user',
        keepLast: 'all',
        ttl: { type: 'none' },
      });
      expect(blocks).toEqual([
        { recommendationId: '1', text: 'Rec: Rec A', afterMessageHash: hashMessage('Customer', 'x'), createdAtTurn: 1 },
        { recommendationId: '2', text: 'Rec: Rec B', afterMessageHash: hashMessage('Customer', 'y'), createdAtTurn: 2 },
      ]);
    });
  });

  describe('applySkillPrompt', () => {
    it('returns unmodified prompt if skillPrompt is empty', () => {
      const prompt: PromptMessageLike[] = [{ role: 'user', content: 'hello' }];
      expect(applySkillPrompt(prompt, undefined)).toBe(prompt);
      expect(applySkillPrompt(prompt, '')).toBe(prompt);
      expect(applySkillPrompt(prompt, '   ')).toBe(prompt);
    });

    it('appends skillPrompt to existing system prompt string content', () => {
      const prompt: PromptMessageLike[] = [
        { role: 'system', content: 'System instruction' },
        { role: 'user', content: 'hello' },
      ];
      const res = applySkillPrompt(prompt, 'Skill prompt');
      expect(res).toHaveLength(2);
      expect(res[0]!.content).toBe('System instruction\n\nSkill prompt');
    });

    it('appends skillPrompt to existing system prompt array content', () => {
      const prompt: PromptMessageLike[] = [
        { role: 'system', content: [{ type: 'text', text: 'System instruction' }] },
        { role: 'user', content: 'hello' },
      ];
      const res = applySkillPrompt(prompt, 'Skill prompt');
      expect(res).toHaveLength(2);
      expect(Array.isArray(res[0]!.content)).toBe(true);
      expect(res[0]!.content).toEqual([
        { type: 'text', text: 'System instruction' },
        { type: 'text', text: '\n\nSkill prompt' },
      ]);
    });

    it('skips appending if skillPrompt is already present', () => {
      const prompt: PromptMessageLike[] = [
        { role: 'system', content: 'System instruction\n\nSkill prompt' },
        { role: 'user', content: 'hello' },
      ];
      const res = applySkillPrompt(prompt, 'Skill prompt');
      expect(res).toBe(prompt);
    });

    it('prepends a new system prompt if absent', () => {
      const prompt: PromptMessageLike[] = [
        { role: 'user', content: 'hello' },
      ];
      const res = applySkillPrompt(prompt, 'Skill prompt');
      expect(res).toHaveLength(2);
      expect(res[0]).toEqual({
        role: 'system',
        content: [{ type: 'text', text: 'Skill prompt' }],
      });
      expect(res[1]).toEqual({ role: 'user', content: 'hello' });
    });
  });
});
