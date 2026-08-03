/**
 * Browser contract tests for ticket #37 (spec #18): "Preserve reading
 * position while new events stream." Real Chromium layout via
 * @vitest/browser-playwright, mirroring `chat-view-load-older.contract.test.tsx`
 * / `chat-view-scroll-to-item.contract.test.tsx`.
 *
 * The core claim under test — "a user scrolled away from the tail keeps
 * their exact viewport position while new content streams in below" — is
 * easy to assert with a boolean flag and hard to actually prove. Every test
 * here asserts a real row's `getBoundingClientRect()` before and after
 * streaming activity, not just `onAtBottomChange`'s reported value. The
 * companion "how many new events, and can I get back to exactly where I
 * was" bookkeeping is app-level (`AcpChatStore` in
 * apps/emdash-desktop — see `acp-chat-store.test.ts` and the pure
 * `state/reading-position.ts` this file's sibling `reading-position.test.ts`
 * covers); this file proves the underlying scroll/anchor behavior those
 * features depend on actually holds in a real DOM.
 */

import { DEFAULT_THEME } from '@core/theme';
import { describe, expect, it } from 'vitest';
import { createChatContext } from '@/chat-context';
import { createChatView } from '@/chat-view';
import type { ChatDiff } from '@/model';
import type { TranscriptTurn } from '@/model';
import { createChatState } from '@/state/chat-state';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve after two rAF ticks so Solid has committed a reactive update. */
const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/** Toggling a collapsible card animates height over ~200ms — settle past it. */
const settleCollapseAnimation = (): Promise<void> => new Promise((r) => setTimeout(r, 300));

/** Build `count` single-message turns with globally unique, numbered text. */
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

/** An in-progress (uncommitted) assistant turn with a single growing message. */
function streamingTurn(id: string, seq: number, text: string): TranscriptTurn {
  return {
    id,
    seq,
    initiator: 'agent',
    items: [{ kind: 'message', id: `${id}-msg`, seq: 0, role: 'assistant', text }],
  };
}

function mount(
  turns: TranscriptTurn[],
  opts: { width?: number; height?: number; onAtBottomChange?: (v: boolean) => void } = {}
) {
  const ctx = createChatContext({ theme: DEFAULT_THEME });
  const state = createChatState(ctx);
  state.transcript.history.seed(turns);

  const host = document.createElement('div');
  host.style.cssText = `position:fixed;top:0;left:0;width:${opts.width ?? 800}px;height:${opts.height ?? 400}px;`;
  document.body.appendChild(host);

  const view = createChatView({
    context: ctx,
    state,
    parent: host,
    onAtBottomChange: opts.onAtBottomChange,
  });

  return {
    host,
    view,
    state,
    dispose: () => {
      view.dispose();
      ctx.dispose();
      state.dispose();
      document.body.removeChild(host);
    },
  };
}

/** Find the row visible at a fixed point inside the scroll viewport. */
function rowAtPoint(host: HTMLElement, scrollEl: HTMLElement) {
  const scrollRect = scrollEl.getBoundingClientRect();
  const point = { x: scrollRect.left + 400, y: scrollRect.top + 20 };
  const row = document.elementFromPoint(point.x, point.y)?.closest('[data-index]');
  return row as HTMLElement | null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('reading position — holding a scrolled-away row stable while streaming', () => {
  it('holds a mid-transcript row in place while a single turn streams rapidly (fast streaming)', async () => {
    const atBottomEvents: boolean[] = [];
    const { host, state, dispose } = mount(makeLabeledTurns(200, 0, 'seed'), {
      onAtBottomChange: (v) => atBottomEvents.push(v),
    });
    await nextPaint();

    const scrollEl = host.querySelector('[data-chat-scroll]') as HTMLElement;
    expect(scrollEl).not.toBeNull();

    // Leave the tail: scroll to a mid-transcript position.
    scrollEl.scrollTop = Math.floor(scrollEl.scrollHeight * 0.4);
    await nextPaint();
    await nextPaint();
    expect(atBottomEvents.at(-1)).toBe(false);
    const markerIndex = atBottomEvents.length;

    const row = rowAtPoint(host, scrollEl);
    expect(row).not.toBeNull();
    const anchorText = row!.textContent ?? '';
    expect(anchorText).toMatch(/seed message number \d+ of 200/);
    const rectBefore = row!.getBoundingClientRect();

    // Fast streaming: many text deltas within the same active turn.
    let text = 'Streaming reply';
    for (let i = 0; i < 8; i++) {
      text += ` token-${i}`;
      state.transcript.activeTurn.set(streamingTurn('active-1', 200, text));
      await nextPaint();

      const stillThere = Array.from(host.querySelectorAll('[data-index]')).find(
        (el) => el.textContent === anchorText
      );
      expect(stillThere).toBeDefined();
      const rect = stillThere!.getBoundingClientRect();
      expect(Math.abs(rect.top - rectBefore.top)).toBeLessThan(2);
    }

    // The turn settles into committed history.
    state.transcript.activeTurn.commit();
    await nextPaint();
    await nextPaint();

    const afterCommit = Array.from(host.querySelectorAll('[data-index]')).find(
      (el) => el.textContent === anchorText
    );
    expect(afterCommit).toBeDefined();
    expect(Math.abs(afterCommit!.getBoundingClientRect().top - rectBefore.top)).toBeLessThan(2);

    // Streaming never forced the view back to the tail.
    expect(atBottomEvents.slice(markerIndex)).not.toContain(true);

    dispose();
  });

  it('holds position while multiple new turns commit one after another', async () => {
    const atBottomEvents: boolean[] = [];
    const { host, state, dispose } = mount(makeLabeledTurns(200, 0, 'seed'), {
      onAtBottomChange: (v) => atBottomEvents.push(v),
    });
    await nextPaint();

    const scrollEl = host.querySelector('[data-chat-scroll]') as HTMLElement;
    scrollEl.scrollTop = Math.floor(scrollEl.scrollHeight * 0.4);
    await nextPaint();
    await nextPaint();
    const markerIndex = atBottomEvents.length;

    const row = rowAtPoint(host, scrollEl);
    const anchorText = row!.textContent ?? '';
    const rectBefore = row!.getBoundingClientRect();

    const before = state.transcript.history.get().length;
    for (let turnIndex = 0; turnIndex < 3; turnIndex++) {
      state.transcript.activeTurn.set(
        streamingTurn(`active-${turnIndex}`, 200 + turnIndex, `New reply number ${turnIndex}`)
      );
      await nextPaint();
      state.transcript.activeTurn.commit();
      await nextPaint();
      await nextPaint();

      const stillThere = Array.from(host.querySelectorAll('[data-index]')).find(
        (el) => el.textContent === anchorText
      );
      expect(stillThere).toBeDefined();
      expect(Math.abs(stillThere!.getBoundingClientRect().top - rectBefore.top)).toBeLessThan(2);
    }

    expect(state.transcript.history.get().length).toBe(before + 3);
    expect(atBottomEvents.slice(markerIndex)).not.toContain(true);

    dispose();
  });
});

describe('reading position — stickToBottom is preserved', () => {
  it('stays pinned to the tail while streaming when the user has not scrolled away', async () => {
    const { host, state, dispose } = mount(makeLabeledTurns(15, 0, 'seed'));
    await nextPaint();

    const scrollEl = host.querySelector('[data-chat-scroll]') as HTMLElement;
    const atMax = () => scrollEl.scrollHeight - scrollEl.clientHeight;
    expect(Math.abs(scrollEl.scrollTop - atMax())).toBeLessThan(2);

    let text = 'Streaming reply';
    for (let i = 0; i < 6; i++) {
      text += ` token-${i}`;
      state.transcript.activeTurn.set(streamingTurn('active-1', 15, text));
      await nextPaint();
      // Still following the tail as the content (and canvas height) grows.
      expect(Math.abs(scrollEl.scrollTop - atMax())).toBeLessThan(2);
    }

    state.transcript.activeTurn.commit();
    await nextPaint();
    await nextPaint();
    expect(Math.abs(scrollEl.scrollTop - atMax())).toBeLessThan(2);

    dispose();
  });

  it('stops following when the user scrolls up mid-stream, and resumes once they scroll back to the bottom', async () => {
    const atBottomEvents: boolean[] = [];
    const { host, state, dispose } = mount(makeLabeledTurns(150, 0, 'seed'), {
      onAtBottomChange: (v) => atBottomEvents.push(v),
    });
    await nextPaint();

    const scrollEl = host.querySelector('[data-chat-scroll]') as HTMLElement;
    const atMax = () => scrollEl.scrollHeight - scrollEl.clientHeight;

    // Start streaming while still at the tail.
    state.transcript.activeTurn.set(streamingTurn('active-1', 150, 'Streaming reply'));
    await nextPaint();
    expect(Math.abs(scrollEl.scrollTop - atMax())).toBeLessThan(2);

    // Mid-stream: the user scrolls up to read history.
    scrollEl.scrollTop = Math.floor(scrollEl.scrollHeight * 0.3);
    await nextPaint();
    await nextPaint();
    expect(atBottomEvents.at(-1)).toBe(false);
    const leftTailIndex = atBottomEvents.length;

    const row = rowAtPoint(host, scrollEl);
    expect(row).not.toBeNull();
    const anchorText = row!.textContent ?? '';
    const rectBefore = row!.getBoundingClientRect();

    // More streaming arrives while the user is reading — position must hold.
    state.transcript.activeTurn.set(
      streamingTurn('active-1', 150, 'Streaming reply continues with more tokens appended')
    );
    await nextPaint();
    const stillThere = Array.from(host.querySelectorAll('[data-index]')).find(
      (el) => el.textContent === anchorText
    );
    expect(stillThere).toBeDefined();
    expect(Math.abs(stillThere!.getBoundingClientRect().top - rectBefore.top)).toBeLessThan(2);
    expect(atBottomEvents.slice(leftTailIndex)).not.toContain(true);

    // The user scrolls back down to the tail.
    scrollEl.scrollTop = scrollEl.scrollHeight;
    await nextPaint();
    await nextPaint();
    expect(atBottomEvents.at(-1)).toBe(true);

    // Tail-following resumes: further streaming keeps the view pinned to the bottom.
    state.transcript.activeTurn.set(
      streamingTurn(
        'active-1',
        150,
        'Streaming reply continues with more tokens appended and even more content now'
      )
    );
    await nextPaint();
    expect(Math.abs(scrollEl.scrollTop - atMax())).toBeLessThan(2);

    dispose();
  });
});

describe('reading position — does not corrupt or get corrupted by adjacent interactions', () => {
  it('holds an expanded diff row in place, with its expand state intact, while new content streams in', async () => {
    const oldText = Array.from({ length: 40 }, (_, i) => `old-line-${i}`).join('\n');
    const newText = oldText.replace('old-line-20', 'CHANGED-LINE');
    const diffItem: ChatDiff = {
      kind: 'diff',
      id: 'diff-1',
      path: 'src/large.ts',
      oldText,
      newText,
      status: 'done',
    };
    const diffTurn: TranscriptTurn = {
      id: 'diff-turn',
      seq: 0,
      initiator: 'agent',
      items: [{ ...diffItem, seq: 0 } as unknown as TranscriptTurn['items'][number]],
      outcome: { kind: 'done' },
    };
    const filler = makeLabeledTurns(60, 1, 'filler');
    const atBottomEvents: boolean[] = [];
    const { host, state, dispose } = mount([diffTurn, ...filler], {
      onAtBottomChange: (v) => atBottomEvents.push(v),
    });
    await nextPaint();

    const scrollEl = host.querySelector('[data-chat-scroll]') as HTMLElement;
    // Scroll all the way to the top to bring the diff card into view.
    scrollEl.scrollTop = 0;
    await nextPaint();
    await nextPaint();
    expect(atBottomEvents.at(-1)).toBe(false);
    const markerIndex = atBottomEvents.length;

    const row = host.querySelector('[data-unit-kind="diff"]') as HTMLElement;
    expect(row).not.toBeNull();
    const toggle = row.querySelector('[data-collapse-id]') as HTMLElement;
    expect(toggle).not.toBeNull();
    toggle.click();
    await nextPaint();
    await settleCollapseAnimation();

    const expandedToggle = row.querySelector('[data-collapse-id]') as HTMLElement;
    expect(expandedToggle.getAttribute('aria-expanded')).toBe('true');
    const rectBefore = row.getBoundingClientRect();

    // New content streams in at the tail while the user reviews the diff.
    state.transcript.activeTurn.set(streamingTurn('active-1', 61, 'A brand new agent turn'));
    await nextPaint();
    state.transcript.activeTurn.commit();
    await nextPaint();
    await nextPaint();

    const rowAfter = host.querySelector('[data-unit-kind="diff"]') as HTMLElement;
    expect(rowAfter).not.toBeNull();
    expect(Math.abs(rowAfter.getBoundingClientRect().top - rectBefore.top)).toBeLessThan(2);
    const toggleAfter = rowAfter.querySelector('[data-collapse-id]') as HTMLElement;
    expect(toggleAfter.getAttribute('aria-expanded')).toBe('true');
    expect(atBottomEvents.slice(markerIndex)).not.toContain(true);

    dispose();
  });

  it('holds position across a load-older prepend while new content also streams in at the tail', async () => {
    const atBottomEvents: boolean[] = [];
    const { host, view, state, dispose } = mount(makeLabeledTurns(150, 0, 'seed'), {
      onAtBottomChange: (v) => atBottomEvents.push(v),
    });
    await nextPaint();

    const scrollEl = host.querySelector('[data-chat-scroll]') as HTMLElement;
    scrollEl.scrollTop = Math.floor(scrollEl.scrollHeight * 0.4);
    await nextPaint();
    await nextPaint();
    const markerIndex = atBottomEvents.length;

    const row = rowAtPoint(host, scrollEl);
    const anchorText = row!.textContent ?? '';
    const rectBefore = row!.getBoundingClientRect();

    // Pagination: load an older page ahead of the current window.
    view.loadOlder(makeLabeledTurns(50, -50, 'older'));
    await nextPaint();
    await nextPaint();

    // Simultaneously, a new turn streams and commits at the tail.
    state.transcript.activeTurn.set(streamingTurn('active-1', 150, 'A new tail turn'));
    await nextPaint();
    state.transcript.activeTurn.commit();
    await nextPaint();
    await nextPaint();

    const matches = Array.from(host.querySelectorAll('[data-index]')).filter(
      (el) => el.textContent === anchorText
    );
    expect(matches).toHaveLength(1);
    expect(Math.abs(matches[0]!.getBoundingClientRect().top - rectBefore.top)).toBeLessThan(2);
    expect(atBottomEvents.slice(markerIndex)).not.toContain(true);

    // No duplicates, chronological order preserved across both operations.
    const committed = state.transcript.history.get();
    expect(new Set(committed.map((t) => t.id)).size).toBe(committed.length);
    for (let i = 1; i < committed.length; i++) {
      expect(committed[i].seq).toBeGreaterThan(committed[i - 1].seq);
    }

    dispose();
  });

  it('holds a mid-transcript row in place at a narrow (480px) layout while streaming', async () => {
    const atBottomEvents: boolean[] = [];
    const { host, state, dispose } = mount(makeLabeledTurns(150, 0, 'seed'), {
      width: 480,
      onAtBottomChange: (v) => atBottomEvents.push(v),
    });
    await nextPaint();

    const scrollEl = host.querySelector('[data-chat-scroll]') as HTMLElement;
    scrollEl.scrollTop = Math.floor(scrollEl.scrollHeight * 0.4);
    await nextPaint();
    await nextPaint();
    const markerIndex = atBottomEvents.length;

    const row = rowAtPoint(host, scrollEl);
    expect(row).not.toBeNull();
    const anchorText = row!.textContent ?? '';
    const rectBefore = row!.getBoundingClientRect();

    state.transcript.activeTurn.set(streamingTurn('active-1', 150, 'Streaming reply'));
    await nextPaint();
    state.transcript.activeTurn.commit();
    await nextPaint();
    await nextPaint();

    const stillThere = Array.from(host.querySelectorAll('[data-index]')).find(
      (el) => el.textContent === anchorText
    );
    expect(stillThere).toBeDefined();
    expect(Math.abs(stillThere!.getBoundingClientRect().top - rectBefore.top)).toBeLessThan(2);
    // No page-level horizontal overflow at the narrow breakpoint.
    expect(host.scrollWidth).toBeLessThanOrEqual(480 + 1);
    expect(atBottomEvents.slice(markerIndex)).not.toContain(true);

    dispose();
  });
});
