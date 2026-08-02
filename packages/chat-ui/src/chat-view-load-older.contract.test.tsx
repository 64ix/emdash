/**
 * Browser contract test for `ChatView.loadOlder()` — the wiring seam between
 * `ChatRoot`'s scroll-anchor capture/resolve (see `state/load-older-anchor.ts`,
 * unit-tested against synthetic geometry) and a real prepend against a real
 * virtualizer and DOM layout.
 *
 * `load-older-anchor.test.ts` proves the anchor math is correct given a
 * capture-before-prepend call order; `AcpHistoryPagination`'s tests prove the
 * coordinator only ever hands `loadOlder` deduplicated, chronologically
 * ordered turns. Neither proves `ChatRoot.doLoadOlder` actually calls capture
 * *before* mutating `chatState`, or that a real prepend against a live
 * virtualizer preserves the visible reading position on screen. This test
 * closes that seam with real DOM layout and Solid's reactive scheduler.
 */

import { DEFAULT_THEME } from '@core/theme';
import { describe, expect, it } from 'vitest';
import { createChatContext } from '@/chat-context';
import { createChatView } from '@/chat-view';
import type { TranscriptTurn } from '@/model';
import { createChatState } from '@/state/chat-state';

/** Resolve after two rAF ticks so Solid has committed a reactive update. */
const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/**
 * Build `count` single-message turns with globally unique, numbered text
 * (unlike `generateMockTranscript`'s small lorem-ipsum word pool, which can
 * legitimately repeat the same short line across two different turns in a
 * 150+ turn transcript — fatal for a test that identifies "the same row" by
 * matching rendered text). `seqStart` lets a later page's seqs sit strictly
 * below an earlier page's.
 */
function makeLabeledTurns(count: number, seqStart: number, label: string): TranscriptTurn[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${label}-turn-${i}`,
    seq: seqStart + i,
    initiator: i % 2 === 0 ? 'user' : 'agent',
    items: [
      {
        kind: 'message',
        id: `${label}-msg-${i}`,
        seq: 0,
        role: i % 2 === 0 ? 'user' : 'assistant',
        text: `${label} message number ${i} of ${count}`,
      },
    ],
    outcome: { kind: 'done' },
  }));
}

describe('ChatView.loadOlder', () => {
  it('preserves the visible reading position and prepends chronologically without duplicates', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const state = createChatState(ctx);
    const seeded = makeLabeledTurns(150, 0, 'seed');
    state.transcript.history.seed(seeded);

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:400px;';
    document.body.appendChild(host);

    const view = createChatView({ context: ctx, state, parent: host });
    await nextPaint();

    const scrollEl = host.querySelector('[data-chat-scroll]') as HTMLElement;
    expect(scrollEl).not.toBeNull();

    // Scroll to a mid-transcript position so there is content both above and
    // below the viewport — a load-older prepend must keep whatever is
    // currently at the top of the viewport visually anchored in place.
    scrollEl.scrollTop = Math.floor(scrollEl.scrollHeight * 0.4);
    await nextPaint();

    const scrollRect = scrollEl.getBoundingClientRect();
    // x=400/y=20 land inside the content column (padding-left excludes the
    // first ~60px) and clear of a partially-clipped row at the very top edge.
    const topPoint = { x: scrollRect.left + 400, y: scrollRect.top + 20 };
    const rowBefore = document.elementFromPoint(topPoint.x, topPoint.y)?.closest('[data-index]');
    expect(rowBefore).not.toBeNull();
    const anchorText = rowBefore!.textContent ?? '';
    expect(anchorText).toMatch(/seed message number \d+ of 150/);
    const anchorRectBefore = rowBefore!.getBoundingClientRect();

    const olderTurns = makeLabeledTurns(60, -60, 'older');
    view.loadOlder(olderTurns);
    await nextPaint();
    await nextPaint();

    // Chronological order + no duplicates: the committed history is exactly
    // the older page followed by the originally seeded window, once.
    const committed = state.transcript.history.get();
    expect(committed).toHaveLength(olderTurns.length + seeded.length);
    expect(committed.slice(0, olderTurns.length).map((t) => t.id)).toEqual(
      olderTurns.map((t) => t.id)
    );
    expect(new Set(committed.map((t) => t.id)).size).toBe(committed.length);
    for (let i = 1; i < committed.length; i++) {
      expect(committed[i].seq).toBeGreaterThan(committed[i - 1].seq);
    }

    // The same row that was visually at the top of the viewport before the
    // prepend must still be found — its text is unique across the whole
    // transcript — and still sit at (approximately) the same viewport
    // position: the load-older anchor did its job.
    const matches = Array.from(host.querySelectorAll('[data-index]')).filter(
      (el) => el.textContent === anchorText
    );
    expect(matches).toHaveLength(1);
    const anchorRectAfter = matches[0]!.getBoundingClientRect();
    expect(Math.abs(anchorRectAfter.top - anchorRectBefore.top)).toBeLessThan(2);

    view.dispose();
    ctx.dispose();
    state.dispose();
    document.body.removeChild(host);
  });
});
