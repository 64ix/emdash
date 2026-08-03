/**
 * Pure decision logic for ticket #37 (spec #18): "Preserve reading position
 * while new events stream." DOM-free, so it runs in the `node` Vitest project
 * without any special environment setup (mirrors `state/load-older-anchor.ts`
 * / `state/outline.ts`).
 *
 * `ChatRoot.tsx` already keeps a reading position *stable on screen* while the
 * user is scrolled away from the tail — `ScrollMode`'s `'anchor'` variant
 * holds an item's edge at a fixed viewport offset, and streaming content
 * never reclassifies that intent back to `'tail'` (only a real user scroll
 * gesture does, in `readPhase`). This module answers the companion question a
 * "reading position" feature needs on top of that: **how many new events
 * arrived while the user was away from the tail**, so a host can show an
 * unobtrusive count and a way to visit the newest content without losing that
 * position.
 *
 * The seam: `captureReadWatermark` freezes a baseline the moment the host
 * observes the user leaving tail mode (`ChatRoot`'s `onAtBottomChange(false)`
 * — see `ChatRoot.tsx`'s `emitAtBottom`, which only fires on a genuine
 * true/false transition, never redundantly). `countNewTranscriptEvents` then
 * compares that frozen baseline against the *current* transcript on every
 * subsequent read. The count is turn-identity based, not item- or
 * character-count based, so:
 *
 *   - fast streaming (many text deltas within the same active turn) does not
 *     inflate the count — the in-progress turn contributes at most 1 until it
 *     settles, and settling into `committedTurns` does not add a second 1;
 *   - `history.prepend()` (pagination / "load older") never contributes to
 *     the count — prepended turns sort *before* the watermark's baseline
 *     turn, so they are never counted as "after" it;
 *   - row expansion/collapse and tab switching never touch this module's
 *     inputs at all, so they cannot corrupt the baseline.
 */

import type { TranscriptTurn } from '@/model';

/**
 * A frozen "I've seen everything up to here" baseline, captured the moment
 * the user leaves tail mode. `lastCommittedTurnId` is `null` when the
 * transcript had no committed turns yet at capture time (everything
 * subsequently committed counts as new). `activeTurnId` is the turn id of
 * whatever was mid-stream at capture time (or `null` if nothing was
 * streaming) — used only for identity comparison, never re-read after
 * capture.
 */
export type ReadWatermark = {
  readonly lastCommittedTurnId: string | null;
  readonly activeTurnId: string | null;
};

/** Capture the current transcript position as a new baseline. */
export function captureReadWatermark(
  committedTurns: readonly TranscriptTurn[],
  activeTurn: TranscriptTurn | null
): ReadWatermark {
  return {
    lastCommittedTurnId: committedTurns[committedTurns.length - 1]?.id ?? null,
    activeTurnId: activeTurn?.id ?? null,
  };
}

/**
 * Count transcript turns that are new relative to `watermark`: committed
 * turns strictly after the *later* of the watermark's baseline committed turn
 * and the watermark's in-progress active turn (once that turn settles into
 * `committedTurns`, it is found there instead and must not be counted a
 * second time), plus one more if a *different* active turn is streaming now.
 *
 * Falls back to counting every committed turn as new when the baseline
 * committed turn can no longer be found at all (e.g. a full transcript
 * reset/re-seed raced the watermark) — safer to overcount than to silently
 * hide real content.
 */
export function countNewTranscriptEvents(
  watermark: ReadWatermark,
  committedTurns: readonly TranscriptTurn[],
  activeTurn: TranscriptTurn | null
): number {
  const lastCommittedIdx =
    watermark.lastCommittedTurnId === null
      ? -1
      : committedTurns.findIndex((turn) => turn.id === watermark.lastCommittedTurnId);

  let newCommittedCount: number;
  if (watermark.lastCommittedTurnId !== null && lastCommittedIdx === -1) {
    newCommittedCount = committedTurns.length;
  } else {
    // The watermark's in-progress active turn may have since committed —
    // find it in its new home so it is excluded from "new" (it was already
    // known, just not yet settled, at capture time).
    const settledActiveIdx =
      watermark.activeTurnId === null
        ? -1
        : committedTurns.findIndex((turn) => turn.id === watermark.activeTurnId);
    const baselineIdx = Math.max(lastCommittedIdx, settledActiveIdx);
    newCommittedCount = committedTurns.length - 1 - baselineIdx;
  }

  const hasNewActiveTurn = activeTurn !== null && activeTurn.id !== watermark.activeTurnId;
  return newCommittedCount + (hasNewActiveTurn ? 1 : 0);
}
