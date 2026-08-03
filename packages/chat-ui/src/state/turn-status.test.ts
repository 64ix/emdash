/**
 * Unit tests for the shared turn-narrative status mapping — pure and
 * DOM-free, runs in the `node` Vitest project.
 *
 * `deriveTranscriptOutline` (state/outline.ts, ticket #34) and
 * `deriveTurnFooter` (state/turn-footer.ts, ticket #38) both delegate to
 * these two functions so they can never disagree about the same turn.
 */

import { describe, expect, it } from 'vitest';
import type { TranscriptTurnOutcome } from '@/model';
import { activeStatus, statusForOutcome } from './turn-status';

describe('statusForOutcome', () => {
  it.each([
    [undefined, 'completed'],
    [{ kind: 'done' } satisfies TranscriptTurnOutcome, 'completed'],
    [{ kind: 'done', reason: 'end_turn' } satisfies TranscriptTurnOutcome, 'completed'],
    [{ kind: 'cancelled' } satisfies TranscriptTurnOutcome, 'cancelled'],
    [{ kind: 'error' } satisfies TranscriptTurnOutcome, 'error'],
    [{ kind: 'error', reason: 'prompt_failed' } satisfies TranscriptTurnOutcome, 'error'],
    [{ kind: 'interrupted' } satisfies TranscriptTurnOutcome, 'error'],
  ] as const)('maps %o to %s', (outcome, expected) => {
    expect(statusForOutcome(outcome)).toBe(expected);
  });
});

describe('activeStatus', () => {
  it.each([
    ['generating', 'current'],
    ['done', 'completed'],
    ['cancelled', 'cancelled'],
  ] as const)('maps live turnStatus %s to %s', (turnStatus, expected) => {
    expect(activeStatus(turnStatus)).toBe(expected);
  });
});
