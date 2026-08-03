/**
 * turn-status — shared four-value narrative status vocabulary for a
 * transcript turn, settled or still in flight.
 *
 * Both the transcript outline (`state/outline.ts`, ticket #34) and the
 * per-turn metadata footer (`state/turn-footer.ts`, ticket #38) need to
 * summarize "what a turn was" (active / successful / cancelled / failed).
 * This module is the single source of truth for that mapping so the two
 * summarizers can never disagree about the same turn — see the prior-work
 * note on ticket #38: "two competing summarisers that can disagree is the
 * failure mode to avoid."
 */

import type { TranscriptTurnOutcome } from '@/model';
import type { TurnStatus } from './transcript';

export type TurnNarrativeStatus = 'current' | 'completed' | 'error' | 'cancelled';

/**
 * Map a settled turn's outcome to the four-state narrative vocabulary.
 * `undefined` (a committed turn with no recorded outcome — e.g. replayed
 * history with no explicit end) is treated as `'completed'`: the turn is not
 * still running, and there is no cancellation/error signal to show instead.
 */
export function statusForOutcome(outcome: TranscriptTurnOutcome | undefined): TurnNarrativeStatus {
  if (!outcome || outcome.kind === 'done') return 'completed';
  if (outcome.kind === 'cancelled') return 'cancelled';
  // 'error' and 'interrupted' both represent an abnormal, non-user-cancelled
  // stop; the narrative only distinguishes explicit cancellation from failure.
  return 'error';
}

/** Map the live `TurnStatus` (see `state/transcript.ts`) for the active turn. */
export function activeStatus(turnStatus: TurnStatus): TurnNarrativeStatus {
  if (turnStatus === 'cancelled') return 'cancelled';
  if (turnStatus === 'done') return 'completed';
  return 'current';
}
