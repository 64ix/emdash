/**
 * Unit tests for `captureReadWatermark` / `countNewTranscriptEvents` — pure
 * and DOM-free, so this runs in the `node` Vitest project without any special
 * environment setup (mirrors `state/load-older-anchor.test.ts` /
 * `state/outline.test.ts`).
 */

import { describe, expect, it } from 'vitest';
import type { TranscriptTurn } from '@/model';
import { captureReadWatermark, countNewTranscriptEvents } from './reading-position';

function turn(id: string, seq: number): TranscriptTurn {
  return {
    id,
    seq,
    initiator: seq % 2 === 0 ? 'user' : 'agent',
    items: [{ kind: 'message', id: `${id}-msg`, seq: 0, role: 'assistant', text: id }],
    outcome: { kind: 'done' },
  };
}

describe('captureReadWatermark', () => {
  it('records the last committed turn id and null when nothing is streaming', () => {
    const committed = [turn('a', 0), turn('b', 1)];
    expect(captureReadWatermark(committed, null)).toEqual({
      lastCommittedTurnId: 'b',
      activeTurnId: null,
    });
  });

  it('records null lastCommittedTurnId for an empty transcript', () => {
    expect(captureReadWatermark([], null)).toEqual({
      lastCommittedTurnId: null,
      activeTurnId: null,
    });
  });

  it('records the active turn id when one is streaming at capture time', () => {
    const committed = [turn('a', 0)];
    const active = turn('active-1', 1);
    expect(captureReadWatermark(committed, active)).toEqual({
      lastCommittedTurnId: 'a',
      activeTurnId: 'active-1',
    });
  });
});

describe('countNewTranscriptEvents', () => {
  it('is zero when nothing changed since the watermark', () => {
    const committed = [turn('a', 0), turn('b', 1)];
    const watermark = captureReadWatermark(committed, null);
    expect(countNewTranscriptEvents(watermark, committed, null)).toBe(0);
  });

  it('counts a single committed turn appended after the watermark', () => {
    const committed = [turn('a', 0), turn('b', 1)];
    const watermark = captureReadWatermark(committed, null);
    const withNewTurn = [...committed, turn('c', 2)];
    expect(countNewTranscriptEvents(watermark, withNewTurn, null)).toBe(1);
  });

  it('counts multiple committed turns appended after the watermark', () => {
    const committed = [turn('a', 0)];
    const watermark = captureReadWatermark(committed, null);
    const withNewTurns = [...committed, turn('b', 1), turn('c', 2), turn('d', 3)];
    expect(countNewTranscriptEvents(watermark, withNewTurns, null)).toBe(3);
  });

  it('does not double count a turn that was already streaming at capture time and later commits', () => {
    const committed = [turn('a', 0)];
    const active = turn('active-1', 1);
    const watermark = captureReadWatermark(committed, active);
    // Still streaming: not yet committed, same active id -> 0 new.
    expect(countNewTranscriptEvents(watermark, committed, active)).toBe(0);

    // Turn commits: moves from activeTurn into committedTurns with the same id.
    const afterCommit = [...committed, { ...active, outcome: { kind: 'done' as const } }];
    expect(countNewTranscriptEvents(watermark, afterCommit, null)).toBe(0);
  });

  it('does not inflate the count across repeated streaming deltas within the same active turn', () => {
    const committed = [turn('a', 0)];
    const watermark = captureReadWatermark(committed, null);
    const streaming1 = { ...turn('active-1', 1), items: [] };
    const streaming2 = { ...streaming1, items: [...streaming1.items] };
    const streaming3 = { ...streaming1, items: [...streaming1.items] };
    // Same active turn identity across three "deltas" -> always exactly 1 new,
    // never re-counted or accumulated per delta.
    expect(countNewTranscriptEvents(watermark, committed, streaming1)).toBe(1);
    expect(countNewTranscriptEvents(watermark, committed, streaming2)).toBe(1);
    expect(countNewTranscriptEvents(watermark, committed, streaming3)).toBe(1);
  });

  it('counts a new active turn plus a since-committed turn as two new events', () => {
    const committed = [turn('a', 0)];
    const watermark = captureReadWatermark(committed, null);
    const afterFirstTurn = [...committed, turn('b', 1)];
    const secondActive = turn('active-2', 2);
    expect(countNewTranscriptEvents(watermark, afterFirstTurn, secondActive)).toBe(2);
  });

  it('ignores turns prepended before the watermark baseline (pagination/load-older)', () => {
    const committed = [turn('a', 0), turn('b', 1)];
    const watermark = captureReadWatermark(committed, null);
    // Load-older prepends turns with lower seq ahead of the existing window.
    const withOlderPrepended = [turn('older-1', -2), turn('older-2', -1), ...committed];
    expect(countNewTranscriptEvents(watermark, withOlderPrepended, null)).toBe(0);
  });

  it('counts everything as new when the transcript is empty at capture time', () => {
    const watermark = captureReadWatermark([], null);
    const committed = [turn('a', 0), turn('b', 1)];
    expect(countNewTranscriptEvents(watermark, committed, null)).toBe(2);
  });

  it('falls back to counting every committed turn when the baseline turn is gone', () => {
    const watermark = { lastCommittedTurnId: 'missing', activeTurnId: null };
    const committed = [turn('a', 0), turn('b', 1)];
    expect(countNewTranscriptEvents(watermark, committed, null)).toBe(2);
  });
});
