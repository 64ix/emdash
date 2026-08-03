/**
 * Unit tests for `deriveTurnFooter` and its formatting helpers — pure and
 * DOM-free, runs in the `node` Vitest project (mirrors `state/outline.test.ts`).
 *
 * These pin the exact text a user sees for each settled-turn state (done /
 * cancelled / error / interrupted) and exercise the copy-text scoping rules,
 * per ticket #38's guardrail: "a narrative that can be wrong is worse than
 * none" — every expectation here is an exact string, not a shape check.
 */

import { describe, expect, it } from 'vitest';
import type { TranscriptItem, TranscriptTurn } from '@/model';
import {
  deriveTurnFooter,
  formatFooterContext,
  formatFooterCost,
  formatFooterDuration,
} from './turn-footer';

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

function turnWith(opts: {
  items: TranscriptItem[];
  outcome?: TranscriptTurn['outcome'];
}): TranscriptTurn {
  return {
    id: 'turn-1',
    seq: 0,
    initiator: 'user',
    items: opts.items,
    outcome: opts.outcome,
  };
}

// ── No outcome — no footer ────────────────────────────────────────────────────

describe('deriveTurnFooter — no recorded outcome', () => {
  it('returns null for a turn with no outcome (e.g. replayed history with no explicit end)', () => {
    const turn = turnWith({ items: [userMessage('u1', 'Hi')], outcome: undefined });
    expect(deriveTurnFooter(turn)).toBeNull();
  });
});

// ── Status label + status per outcome kind ───────────────────────────────────

describe('deriveTurnFooter — status label and coarse status', () => {
  it('done, no reason, with an assistant reply', () => {
    const turn = turnWith({
      items: [userMessage('u1', 'Sum 2 and 3'), assistantMessage('a1', 'The sum is 5.')],
      outcome: { kind: 'done' },
    });

    expect(deriveTurnFooter(turn)).toEqual({
      status: 'completed',
      statusLabel: 'Turn completed',
      copyText: 'Turn completed\n\nThe sum is 5.',
    });
  });

  it('done with a reason appends it in parens', () => {
    const turn = turnWith({
      items: [assistantMessage('a1', 'Done.')],
      outcome: { kind: 'done', reason: 'end_turn' },
    });

    expect(deriveTurnFooter(turn)?.statusLabel).toBe('Turn completed (end_turn)');
  });

  it('cancelled turn', () => {
    const turn = turnWith({
      items: [userMessage('u1', 'Stop'), readTool('t1', 'Read a.ts')],
      outcome: { kind: 'cancelled' },
    });

    const footer = deriveTurnFooter(turn);
    expect(footer?.status).toBe('cancelled');
    expect(footer?.statusLabel).toBe('Turn cancelled');
  });

  it('error turn with a reason', () => {
    const turn = turnWith({
      items: [userMessage('u1', 'Do the thing')],
      outcome: { kind: 'error', reason: 'prompt_failed' },
    });

    const footer = deriveTurnFooter(turn);
    expect(footer?.status).toBe('error');
    expect(footer?.statusLabel).toBe('Turn failed (prompt_failed)');
  });

  it('interrupted turn keeps a distinct label but the coarse "error" status', () => {
    const turn = turnWith({
      items: [userMessage('u1', 'Keep going')],
      outcome: { kind: 'interrupted', reason: 'process_closed' },
    });

    const footer = deriveTurnFooter(turn);
    expect(footer?.status).toBe('error');
    expect(footer?.statusLabel).toBe('Turn interrupted (process_closed)');
  });
});

// ── Copy text scoping ────────────────────────────────────────────────────────

describe('deriveTurnFooter — copy text scoping', () => {
  it('copy text is just the status line when the turn produced no assistant reply', () => {
    const turn = turnWith({
      items: [userMessage('u1', 'List files'), readTool('t1', 'Read src/')],
      outcome: { kind: 'done' },
    });

    expect(deriveTurnFooter(turn)?.copyText).toBe('Turn completed');
  });

  it('copy text uses the LAST assistant message when the turn has several', () => {
    const turn = turnWith({
      items: [
        userMessage('u1', 'Two-part answer'),
        assistantMessage('a1', 'First part.', 1),
        readTool('t1', 'Read b.ts', 2),
        assistantMessage('a2', 'Second, final part.', 3),
      ],
      outcome: { kind: 'done' },
    });

    expect(deriveTurnFooter(turn)?.copyText).toBe('Turn completed\n\nSecond, final part.');
  });

  it('treats a whitespace-only assistant message as no reply', () => {
    const turn = turnWith({
      items: [userMessage('u1', 'Hmm'), assistantMessage('a1', '   \n  ')],
      outcome: { kind: 'cancelled' },
    });

    expect(deriveTurnFooter(turn)?.copyText).toBe('Turn cancelled');
  });
});

// ── Never-invented fields ─────────────────────────────────────────────────────

describe('deriveTurnFooter — duration/context/cost are never invented', () => {
  it('omits durationMs, context, and cost for every outcome kind', () => {
    const outcomes: TranscriptTurn['outcome'][] = [
      { kind: 'done' },
      { kind: 'cancelled' },
      { kind: 'error' },
      { kind: 'interrupted' },
    ];

    for (const outcome of outcomes) {
      const footer = deriveTurnFooter(turnWith({ items: [assistantMessage('a1', 'x')], outcome }));
      expect(footer?.durationMs).toBeUndefined();
      expect(footer?.context).toBeUndefined();
      expect(footer?.cost).toBeUndefined();
    }
  });
});

// ── Formatting helpers (exercised directly — no current producer sets these) ─

describe('formatFooterDuration', () => {
  it('rounds sub-second durations to "under a second"', () => {
    expect(formatFooterDuration(0)).toBe('under a second');
    expect(formatFooterDuration(999)).toBe('under a second');
  });

  it('floors to whole seconds at/above 1000ms', () => {
    expect(formatFooterDuration(1000)).toBe('1s');
    expect(formatFooterDuration(12_400)).toBe('12s');
  });
});

describe('formatFooterContext', () => {
  it('renders a rounded percentage of the context window used', () => {
    expect(formatFooterContext({ contextUsed: 50_000, contextSize: 200_000 })).toBe('25% context');
  });

  it('treats a zero-size context window as 0% rather than dividing by zero', () => {
    expect(formatFooterContext({ contextUsed: 0, contextSize: 0 })).toBe('0% context');
  });
});

describe('formatFooterCost', () => {
  it('renders currency and a 4-decimal amount', () => {
    expect(formatFooterCost({ amount: 0.0123, currency: 'USD' })).toBe('USD 0.0123');
  });
});
