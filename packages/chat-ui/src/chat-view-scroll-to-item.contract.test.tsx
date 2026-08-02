/**
 * Browser contract test for `ChatView.scrollToItem()` jumping to a row that
 * is off-DOM (outside the virtualizer's current overscan window) at call
 * time — the seam ticket #34 (spec #18, "Navigate turns through a transcript
 * outline") relies on for outline entry selection instead of any manual
 * `scrollTop` write. `chat-view.contract.test.tsx` already covers
 * `scrollToTop`/`scrollToBottom`; `scrollToItem` itself had no contract
 * coverage before this ticket even though the seam pre-dates it (see
 * `ChatRoot.tsx`'s `doScrollToItem`).
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
 * `scrollToItem`'s off-DOM path writes an initial scrollTop and then, one
 * rAF later, a corrected scrollTop once real (not estimated) row heights are
 * available — so the visible range can take a couple of extra frames to
 * settle compared to `scrollToTop`/`scrollToBottom`'s single write. Poll
 * instead of a fixed frame count.
 */
async function waitForText(host: HTMLElement, text: string, frames = 20): Promise<Element | null> {
  for (let i = 0; i < frames; i++) {
    // Row wrappers can carry extra chrome (e.g. an assistant message's
    // "Copy" affordance, or a visually-hidden accessible-name duplicate), so
    // match by substring rather than exact equality.
    const match = Array.from(host.querySelectorAll('[data-index]')).find((el) =>
      (el.textContent ?? '').includes(text)
    );
    if (match) return match;
    await nextPaint();
  }
  return null;
}

/** Build `count` single-message turns with globally unique, numbered text. */
function makeLabeledTurns(count: number): TranscriptTurn[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `turn-${i}`,
    seq: i,
    initiator: i % 2 === 0 ? 'user' : 'agent',
    items: [
      {
        kind: 'message',
        id: `msg-${i}`,
        seq: 0,
        role: i % 2 === 0 ? 'user' : 'assistant',
        text: `message number ${i} of ${count}`,
      },
    ],
    outcome: { kind: 'done' },
  }));
}

describe('ChatView.scrollToItem', () => {
  it('jumps to a row far outside the current overscan window and renders it at the top', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const state = createChatState(ctx);
    const turns = makeLabeledTurns(300);
    state.transcript.history.seed(turns);

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:400px;';
    document.body.appendChild(host);

    // stickToBottom defaults on, so the view opens scrolled near the tail —
    // the early rows below are guaranteed to be off-DOM at this point.
    const view = createChatView({ context: ctx, state, parent: host });
    await nextPaint();

    const scrollEl = host.querySelector('[data-chat-scroll]') as HTMLElement;
    expect(scrollEl).not.toBeNull();
    expect(scrollEl.scrollTop).toBeGreaterThan(0);

    const targetText = 'message number 5 of 300';
    expect(
      Array.from(host.querySelectorAll('[data-index]')).some((el) =>
        (el.textContent ?? '').includes(targetText)
      )
    ).toBe(false);

    view.scrollToItem('msg-5');
    const rendered = await waitForText(host, targetText);
    expect(rendered).not.toBeNull();

    const scrollRect = scrollEl.getBoundingClientRect();
    const rowRect = rendered!.getBoundingClientRect();
    // Default align is 'start': the row should now sit at (approximately) the
    // top of the viewport, not merely somewhere within the rendered range.
    expect(Math.abs(rowRect.top - scrollRect.top)).toBeLessThan(40);

    view.dispose();
    ctx.dispose();
    state.dispose();
    document.body.removeChild(host);
  });

  it('jumps to an off-DOM row above a live-streaming active turn without disturbing it', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const state = createChatState(ctx);
    const turns = makeLabeledTurns(200);
    state.transcript.history.seed(turns);
    state.transcript.activeTurn.set({
      id: 'active-turn',
      seq: 200,
      initiator: 'user',
      items: [
        { kind: 'message', id: 'active-user', seq: 0, role: 'user', text: 'active prompt' },
        {
          kind: 'message',
          id: 'active-assistant',
          seq: 1,
          role: 'assistant',
          text: 'streaming reply…',
          streaming: true,
        },
      ],
    });

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:400px;';
    document.body.appendChild(host);

    const view = createChatView({ context: ctx, state, parent: host });
    await nextPaint();

    view.scrollToItem('msg-10');
    const targetText = 'message number 10 of 200';
    const rendered = await waitForText(host, targetText);
    expect(rendered).not.toBeNull();

    // The active turn's data is untouched by the jump — the streaming
    // message is merely off-DOM (virtualized away) at the new scroll
    // position, not lost. Scrolling back to the tail brings it back.
    expect(state.transcript.state.activeTurnSnapshot?.items.map((item) => item.id)).toEqual([
      'active-user',
      'active-assistant',
    ]);
    view.scrollToBottom();
    const streamingRow = await waitForText(host, 'streaming reply…');
    expect(streamingRow).not.toBeNull();

    view.dispose();
    ctx.dispose();
    state.dispose();
    document.body.removeChild(host);
  });
});
