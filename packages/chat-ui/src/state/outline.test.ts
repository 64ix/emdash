/**
 * Unit tests for `deriveTranscriptOutline` — pure and DOM-free, so this runs
 * in the `node` Vitest project without any special environment setup (mirrors
 * `state/load-older-anchor.test.ts` / `state/flatten.test.ts`).
 */

import { describe, expect, it } from 'vitest';
import type { TranscriptItem, TranscriptTurn } from '@/model';
import { deriveTranscriptOutline } from './outline';
import type { PendingPrompt } from './session-state';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function userMessage(id: string, text: string, seq = 0): TranscriptItem {
  return { kind: 'message', id, seq, role: 'user', text };
}

function assistantMessage(id: string, text: string, seq = 1): TranscriptItem {
  return { kind: 'message', id, seq, role: 'assistant', text };
}

function readTool(id: string, title: string, seq = 1): TranscriptItem {
  return { kind: 'read-tool-call', id, seq, toolCallId: id, title, status: 'done' };
}

function thinking(id: string, text: string, seq = 1): TranscriptItem {
  return {
    kind: 'thinking',
    id,
    seq,
    segmentId: id,
    text,
    status: 'done',
    startedAt: 0,
  };
}

function exchangeTurn(opts: {
  id: string;
  seq: number;
  items: TranscriptItem[];
  outcome?: TranscriptTurn['outcome'];
}): TranscriptTurn {
  return {
    id: opts.id,
    seq: opts.seq,
    initiator: 'user',
    items: opts.items,
    outcome: opts.outcome ?? { kind: 'done' },
  };
}

function agentTurn(opts: {
  id: string;
  seq: number;
  items: TranscriptItem[];
  outcome?: TranscriptTurn['outcome'];
}): TranscriptTurn {
  return {
    id: opts.id,
    seq: opts.seq,
    initiator: 'agent',
    items: opts.items,
    outcome: opts.outcome ?? { kind: 'done' },
  };
}

// ── Committed turns ───────────────────────────────────────────────────────────

describe('deriveTranscriptOutline — committed turns', () => {
  it('splits a user-initiated turn into a prompt entry and a turn entry', () => {
    const turn = exchangeTurn({
      id: 'turn-1',
      seq: 0,
      items: [
        userMessage('msg-user-1', 'What does this function do?'),
        readTool('tool-1', 'Read src/index.ts'),
        assistantMessage('msg-assistant-1', 'It sums two numbers.'),
      ],
    });

    const entries = deriveTranscriptOutline([turn], null, 'done', null);

    expect(entries).toEqual([
      {
        itemId: 'msg-user-1',
        turnId: 'turn-1',
        role: 'prompt',
        preview: 'What does this function do?',
        status: 'completed',
      },
      {
        itemId: 'tool-1',
        turnId: 'turn-1',
        role: 'turn',
        preview: 'It sums two numbers.',
        status: 'completed',
      },
    ]);
  });

  it('anchors the turn entry on the first post-prompt item, not the assistant message', () => {
    const turn = exchangeTurn({
      id: 'turn-1',
      seq: 0,
      items: [
        userMessage('msg-user-1', 'Fix the bug'),
        thinking('think-1', 'Let me look at the stack trace'),
        readTool('tool-1', 'Read src/bug.ts'),
        assistantMessage('msg-assistant-1', 'Fixed the off-by-one error.'),
      ],
    });

    const entries = deriveTranscriptOutline([turn], null, 'done', null);
    const turnEntry = entries.find((e) => e.role === 'turn');

    // Jumping to the turn entry should land on the earliest post-prompt row
    // (the thinking block), not skip ahead to the assistant's final message.
    expect(turnEntry?.itemId).toBe('think-1');
    expect(turnEntry?.preview).toBe('Fixed the off-by-one error.');
  });

  it('omits the turn entry when the prompt has no response yet', () => {
    const turn = exchangeTurn({
      id: 'turn-1',
      seq: 0,
      items: [userMessage('msg-user-1', 'Hello?')],
      outcome: undefined,
    });

    const entries = deriveTranscriptOutline([turn], null, 'done', null);

    expect(entries).toEqual([
      {
        itemId: 'msg-user-1',
        turnId: 'turn-1',
        role: 'prompt',
        preview: 'Hello?',
        status: 'completed',
      },
    ]);
  });

  it('emits a single turn entry for agent-initiated turns (no leading prompt)', () => {
    const turn = agentTurn({
      id: 'turn-bg',
      seq: 0,
      items: [readTool('tool-bg', 'Read AGENTS.md'), assistantMessage('msg-bg', 'Context loaded.')],
    });

    const entries = deriveTranscriptOutline([turn], null, 'done', null);

    expect(entries).toEqual([
      {
        itemId: 'tool-bg',
        turnId: 'turn-bg',
        role: 'turn',
        preview: 'Context loaded.',
        status: 'completed',
      },
    ]);
  });

  it('falls back to the first item label when no assistant message is present', () => {
    const turn = exchangeTurn({
      id: 'turn-1',
      seq: 0,
      items: [userMessage('msg-user-1', 'List the files'), readTool('tool-1', 'Read src/')],
    });

    const entries = deriveTranscriptOutline([turn], null, 'done', null);

    expect(entries[1].preview).toBe('Read src/');
  });

  it.each([
    ['cancelled' as const, 'cancelled' as const],
    ['error' as const, 'error' as const],
    ['interrupted' as const, 'error' as const],
    ['done' as const, 'completed' as const],
  ])('maps outcome kind %s to status %s', (outcomeKind, expectedStatus) => {
    const turn = exchangeTurn({
      id: 'turn-1',
      seq: 0,
      items: [userMessage('msg-user-1', 'Run it'), assistantMessage('msg-assistant-1', 'Done.')],
      outcome: { kind: outcomeKind },
    });

    const entries = deriveTranscriptOutline([turn], null, 'done', null);

    expect(entries.every((e) => e.status === expectedStatus)).toBe(true);
  });

  it('treats a missing outcome (replayed history) as completed', () => {
    const turn = exchangeTurn({
      id: 'turn-1',
      seq: 0,
      items: [userMessage('msg-user-1', 'Hi'), assistantMessage('msg-assistant-1', 'Hello!')],
      outcome: undefined,
    });

    const entries = deriveTranscriptOutline([turn], null, 'done', null);

    expect(entries.every((e) => e.status === 'completed')).toBe(true);
  });

  it('bounds long preview text with an ellipsis and collapses whitespace', () => {
    const longText = 'word '.repeat(40).trim();
    const turn = exchangeTurn({
      id: 'turn-1',
      seq: 0,
      items: [userMessage('msg-user-1', `line one\nline two\n${longText}`)],
      outcome: undefined,
    });

    const entries = deriveTranscriptOutline([turn], null, 'done', null);

    expect(entries[0].preview.length).toBeLessThanOrEqual(80);
    expect(entries[0].preview.endsWith('…')).toBe(true);
    expect(entries[0].preview).not.toContain('\n');
  });

  it('preserves turn order across multiple committed turns', () => {
    const turnA = exchangeTurn({
      id: 'turn-a',
      seq: 0,
      items: [userMessage('a-user', 'first'), assistantMessage('a-assistant', 'first reply')],
    });
    const turnB = exchangeTurn({
      id: 'turn-b',
      seq: 1,
      items: [userMessage('b-user', 'second'), assistantMessage('b-assistant', 'second reply')],
    });

    const entries = deriveTranscriptOutline([turnA, turnB], null, 'done', null);

    expect(entries.map((e) => e.itemId)).toEqual([
      'a-user',
      'a-assistant',
      'b-user',
      'b-assistant',
    ]);
  });
});

// ── Active turn / pending prompt ─────────────────────────────────────────────

describe('deriveTranscriptOutline — active turn and pending prompt', () => {
  it('marks the active turn entries current while generating', () => {
    const active = exchangeTurn({
      id: 'turn-active',
      seq: 5,
      items: [userMessage('active-user', 'Add a test'), readTool('active-tool', 'Read tests/')],
    });

    const entries = deriveTranscriptOutline([], active, 'generating', null);

    expect(entries).toEqual([
      {
        itemId: 'active-user',
        turnId: 'turn-active',
        role: 'prompt',
        preview: 'Add a test',
        status: 'current',
      },
      {
        itemId: 'active-tool',
        turnId: 'turn-active',
        role: 'turn',
        preview: 'Read tests/',
        status: 'current',
      },
    ]);
  });

  it('reflects a mid-flight cancellation on the still-open active turn', () => {
    const active = exchangeTurn({
      id: 'turn-active',
      seq: 5,
      items: [userMessage('active-user', 'Stop'), readTool('active-tool', 'Read a.ts')],
    });

    const entries = deriveTranscriptOutline([], active, 'cancelled', null);

    expect(entries.every((e) => e.status === 'cancelled')).toBe(true);
  });

  it('adds a current prompt entry for a pending prompt with no activeTurn yet', () => {
    const pendingPrompt: PendingPrompt = { id: 'pending-1', text: 'Ping' };

    const entries = deriveTranscriptOutline([], null, 'done', pendingPrompt);

    expect(entries).toEqual([
      {
        itemId: 'pending-1',
        turnId: 'pending:pending-1:turn',
        role: 'prompt',
        preview: 'Ping',
        status: 'current',
      },
    ]);
  });

  it('prefers the activeTurn over a stale pendingPrompt once the agent acknowledges it', () => {
    const active = exchangeTurn({
      id: 'turn-active',
      seq: 5,
      items: [userMessage('pending-1', 'Ping')],
    });
    const pendingPrompt: PendingPrompt = { id: 'pending-1', text: 'Ping' };

    const entries = deriveTranscriptOutline([], active, 'generating', pendingPrompt);

    // Exactly one entry for the prompt — no duplicate from the stale pendingPrompt.
    expect(entries).toHaveLength(1);
    expect(entries[0].itemId).toBe('pending-1');
  });
});

// ── Pagination stability (no duplicates, no reordering) ──────────────────────

describe('deriveTranscriptOutline — pagination stability', () => {
  it('prepends older-page entries without disturbing already-derived entries', () => {
    const recent = [
      exchangeTurn({
        id: 'turn-10',
        seq: 10,
        items: [userMessage('u10', 'recent prompt'), assistantMessage('a10', 'recent reply')],
      }),
      exchangeTurn({
        id: 'turn-11',
        seq: 11,
        items: [userMessage('u11', 'newest prompt'), assistantMessage('a11', 'newest reply')],
      }),
    ];
    const before = deriveTranscriptOutline(recent, null, 'done', null);

    const olderPage = [
      exchangeTurn({
        id: 'turn-8',
        seq: 8,
        items: [userMessage('u8', 'older prompt'), assistantMessage('a8', 'older reply')],
      }),
      exchangeTurn({
        id: 'turn-9',
        seq: 9,
        items: [userMessage('u9', 'older prompt 2'), assistantMessage('a9', 'older reply 2')],
      }),
    ];
    const after = deriveTranscriptOutline([...olderPage, ...recent], null, 'done', null);

    // Every entry from the pre-load derivation reappears, unchanged, at the
    // same tail position — pagination only ever prepends.
    expect(after.slice(-before.length)).toEqual(before);

    // No duplicate itemIds anywhere in the extended outline.
    const itemIds = after.map((e) => e.itemId);
    expect(new Set(itemIds).size).toBe(itemIds.length);

    // New entries are ordered ascending by turn seq, at the front.
    expect(itemIds.slice(0, 4)).toEqual(['u8', 'a8', 'u9', 'a9']);
  });
});
