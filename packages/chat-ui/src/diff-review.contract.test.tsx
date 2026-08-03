/**
 * Browser contract tests for the diff card's review surface (spec #18,
 * ticket #28). Real Chromium layout via @vitest/browser-playwright so DOM
 * assertions (rendered text, click delegation, clipboard, command wiring)
 * reflect the actual component tree, not a JS approximation.
 *
 * All diff-shaping arithmetic (which lines are hidden, exact counts, the
 * expanded-cap boundary) is pinned in diff-lines.test.ts (pure, node
 * project). This file only asserts rendering and interaction: does the
 * truncation banner appear, does the toggle reveal more content, does Copy
 * grab the full patch, does Open full diff fire the host command.
 */

import { DEFAULT_THEME } from '@core/theme';
import { describe, expect, it, vi } from 'vitest';
import { createChatContext } from '@/chat-context';
import { createChatView } from '@/chat-view';
import type { ChatCommands } from '@/commands';
import type { ChatDiff, ChatItem } from '@/model';
import type { TranscriptTurn } from '@/model';
import { createChatState } from '@/state/chat-state';

const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/**
 * Toggling a collapsible card animates its height over ~200ms
 * (create-height-tween.ts's default `durationMs`). While *shrinking*, the
 * card intentionally keeps rendering its expanded content until the tween
 * settles (UnitRow's `collapsing()` display-state lag), so a toggle-then-
 * assert must wait past the animation, not just a couple of paints.
 */
const settleCollapseAnimation = (): Promise<void> => new Promise((r) => setTimeout(r, 300));

function turnFor(item: ChatDiff): TranscriptTurn[] {
  return [
    {
      id: 'turn-1',
      seq: 0,
      initiator: 'agent',
      items: [{ ...item, seq: 0 } as unknown as TranscriptTurn['items'][number]],
    },
  ];
}

function mount(
  turns: TranscriptTurn[],
  opts: { width?: number; commands?: ChatCommands } = {}
): { host: HTMLElement; dispose: () => void } {
  const ctx = createChatContext({ theme: DEFAULT_THEME });
  const state = createChatState(ctx);
  state.transcript.history.seed(turns);

  const host = document.createElement('div');
  host.style.cssText = `position:fixed;top:0;left:0;width:${opts.width ?? 900}px;height:600px;`;
  document.body.appendChild(host);

  const view = createChatView({ context: ctx, state, parent: host, commands: opts.commands });

  return {
    host,
    dispose: () => {
      view.dispose();
      ctx.dispose();
      state.dispose();
      document.body.removeChild(host);
    },
  };
}

function linesOf(n: number, prefix: string): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join('\n');
}

describe('diff card — review states', () => {
  it('a small diff (fits the collapsed window) shows no truncation banner or toggle', async () => {
    const { host, dispose } = mount(
      turnFor({
        kind: 'diff',
        id: 'diff-small',
        path: 'src/small.ts',
        oldText: 'const a = 1;',
        newText: 'const a = 2;',
        status: 'done',
      })
    );
    await nextPaint();
    await nextPaint();

    const row = host.querySelector('[data-unit-kind="diff"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain('const a = 2;');
    expect(row.textContent).not.toMatch(/hidden/);
    expect(row.querySelector('[data-collapse-id]')).toBeNull();
    // Copy + Open full diff are still available even without truncation.
    expect(row.textContent).toContain('Open full diff');

    dispose();
  });

  it('a large diff reports the hidden-line count and expands to reveal more on toggle', async () => {
    const oldText = linesOf(40, 'old-line-');
    const newText = linesOf(40, 'old-line-').replace('old-line-20', 'CHANGED-LINE');
    const { host, dispose } = mount(
      turnFor({
        kind: 'diff',
        id: 'diff-large',
        path: 'src/large.ts',
        oldText,
        newText,
        status: 'done',
      })
    );
    await nextPaint();
    await nextPaint();

    const row = host.querySelector('[data-unit-kind="diff"]') as HTMLElement;
    expect(row).not.toBeNull();
    // Collapsed: truncation summary present, and most of the file is not rendered.
    expect(row.textContent).toMatch(/\d+ lines? hidden/);
    expect(row.textContent).not.toContain('old-line-39');

    const toggle = row.querySelector('[data-collapse-id]') as HTMLElement;
    expect(toggle).not.toBeNull();
    expect(toggle.textContent).toBe('Show more');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    toggle.click();
    await nextPaint();
    await nextPaint();

    const expandedToggle = row.querySelector('[data-collapse-id]') as HTMLElement;
    expect(expandedToggle.textContent).toBe('Show less');
    expect(expandedToggle.getAttribute('aria-expanded')).toBe('true');
    // Expanding reveals content well past the 8-line collapsed window.
    expect(row.textContent).toContain('old-line-39');

    expandedToggle.click();
    await settleCollapseAnimation();

    const collapsedAgain = row.querySelector('[data-collapse-id]') as HTMLElement;
    expect(collapsedAgain.textContent).toBe('Show more');
    expect(row.textContent).not.toContain('old-line-39');

    dispose();
  });

  it('Copy always returns the full patch, even while the preview is truncated', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const oldText = linesOf(30, 'l');
    const newText = linesOf(30, 'l').replace('l15', 'REPLACED');
    const { host, dispose } = mount(
      turnFor({
        kind: 'diff',
        id: 'diff-copy',
        path: 'src/copy.ts',
        oldText,
        newText,
        status: 'done',
      })
    );
    await nextPaint();
    await nextPaint();

    const row = host.querySelector('[data-unit-kind="diff"]') as HTMLElement;
    const copyButton = Array.from(row.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Copy diff')
    ) as HTMLElement;
    expect(copyButton).toBeTruthy();

    copyButton.click();
    await nextPaint();

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]![0] as string;
    // The visible (collapsed) preview never reaches the last line — Copy must.
    expect(row.textContent).not.toContain('l29');
    expect(copied).toContain('l29');
    expect(copied).toContain('-l15');
    expect(copied).toContain('+REPLACED');

    dispose();
  });

  it('"Open full diff" calls the host onOpenDiff command with the item path', async () => {
    const onOpenDiff = vi.fn();
    const { host, dispose } = mount(
      turnFor({
        kind: 'diff',
        id: 'diff-open:src/open-me.ts',
        path: 'src/open-me.ts',
        oldText: 'a',
        newText: 'b',
        status: 'done',
      }),
      { commands: { onOpenDiff } }
    );
    await nextPaint();
    await nextPaint();

    const row = host.querySelector('[data-unit-kind="diff"]') as HTMLElement;
    const openButton = Array.from(row.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Open full diff')
    ) as HTMLElement;
    expect(openButton).toBeTruthy();

    openButton.click();

    expect(onOpenDiff).toHaveBeenCalledWith({
      path: 'src/open-me.ts',
      itemId: 'diff-open:src/open-me.ts',
      source: 'diff',
    });

    dispose();
  });

  it('a loading diff (running, no content yet) renders only the header — no body, no footer', async () => {
    const { host, dispose } = mount(
      turnFor({
        kind: 'diff',
        id: 'diff-loading',
        path: 'src/loading.ts',
        oldText: null,
        newText: '',
        status: 'running',
      })
    );
    await nextPaint();
    await nextPaint();

    const row = host.querySelector('[data-unit-kind="diff"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain('loading.ts');
    // No diff body card at all yet (distinct from streaming/content/empty/
    // binary, which all render a body below the header): the card is exactly
    // header height, with no footer affordances or collapse control.
    expect(row.getBoundingClientRect().height).toBeLessThan(40);
    expect(row.textContent).not.toContain('Open full diff');
    expect(row.textContent).not.toContain('Copy diff');
    expect(row.querySelector('[data-collapse-id]')).toBeNull();

    dispose();
  });

  it('a streaming diff shows partial content without a footer', async () => {
    const { host, dispose } = mount(
      turnFor({
        kind: 'diff',
        id: 'diff-streaming',
        path: 'src/streaming.ts',
        oldText: 'old',
        newText: 'new content so far',
        status: 'running',
      })
    );
    await nextPaint();
    await nextPaint();

    const row = host.querySelector('[data-unit-kind="diff"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain('new content so far');
    expect(row.textContent).not.toContain('Open full diff');
    expect(row.textContent).not.toContain('Copy diff');
    expect(row.querySelector('[data-collapse-id]')).toBeNull();

    dispose();
  });

  it('a failed diff shows a distinct, labeled error affordance', async () => {
    const { host, dispose } = mount(
      turnFor({
        kind: 'diff',
        id: 'diff-failed',
        path: 'src/failed.ts',
        oldText: 'old',
        newText: 'new',
        status: 'error',
        error: 'Patch failed because the old text no longer matched',
      })
    );
    await nextPaint();
    await nextPaint();

    const row = host.querySelector('[data-unit-kind="diff"]') as HTMLElement;
    const errorIcon = row.querySelector('[aria-label="error"]') as HTMLElement;
    expect(errorIcon).not.toBeNull();
    expect(errorIcon.getAttribute('title')).toBe(
      'Patch failed because the old text no longer matched'
    );

    dispose();
  });

  it('an empty diff (no line-level changes) shows a distinct message, not a blank box', async () => {
    const { host, dispose } = mount(
      turnFor({
        kind: 'diff',
        id: 'diff-empty',
        path: 'src/unchanged.ts',
        oldText: 'same content',
        newText: 'same content',
        status: 'done',
      })
    );
    await nextPaint();
    await nextPaint();

    const row = host.querySelector('[data-unit-kind="diff"]') as HTMLElement;
    expect(row.textContent).toContain('No changes to preview.');
    expect(row.querySelector('[data-collapse-id]')).toBeNull();

    dispose();
  });

  it('a binary/unsupported diff shows a distinct message instead of a line diff', async () => {
    const { host, dispose } = mount(
      turnFor({
        kind: 'diff',
        id: 'diff-binary',
        path: 'src/image.png',
        oldText: null,
        newText: `\x89PNG${String.fromCharCode(0)}\x00\x00IHDR`,
        status: 'done',
      })
    );
    await nextPaint();
    await nextPaint();

    const row = host.querySelector('[data-unit-kind="diff"]') as HTMLElement;
    expect(row.textContent).toContain('Binary content — open the full diff to review it.');

    dispose();
  });

  it('renders and stays reviewable in a narrow chat panel', async () => {
    const oldText = linesOf(20, 'l');
    const newText = linesOf(20, 'l').replace('l10', 'CHANGED');
    const { host, dispose } = mount(
      turnFor({
        kind: 'diff',
        id: 'diff-narrow',
        path: 'src/narrow.ts',
        oldText,
        newText,
        status: 'done',
      }),
      { width: 420 }
    );
    await nextPaint();
    await nextPaint();

    const row = host.querySelector('[data-unit-kind="diff"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).toMatch(/lines? hidden/);

    const scrollEl = host.querySelector('[data-chat-scroll]') as HTMLElement;
    expect(scrollEl.scrollWidth).toBeLessThanOrEqual(scrollEl.clientWidth + 1);

    dispose();
  });
});

describe('diff card — expand/collapse preserves reading position', () => {
  it('does not reset scroll to the top when toggling a diff mid-transcript', async () => {
    const filler: ChatItem[] = Array.from({ length: 40 }, (_, i) => ({
      kind: 'message' as const,
      id: `filler-${i}`,
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `Filler message number ${i} to give the transcript real scroll height.`,
    }));

    const oldText = linesOf(50, 'l');
    const newText = linesOf(50, 'l').replace('l25', 'CHANGED');
    const diffItem: ChatItem = {
      kind: 'diff',
      id: 'diff-midway',
      path: 'src/midway.ts',
      oldText,
      newText,
      status: 'done',
    };

    const items = [...filler.slice(0, 20), diffItem, ...filler.slice(20)];
    const turns: TranscriptTurn[] = [
      {
        id: 'turn-1',
        seq: 0,
        initiator: 'agent',
        items: items.map((item, seq) => ({ ...item, seq })) as TranscriptTurn['items'],
      },
    ];

    const { host, dispose } = mount(turns, { width: 900 });
    await nextPaint();
    await nextPaint();

    const scrollEl = host.querySelector('[data-chat-scroll]') as HTMLElement;
    const row = host.querySelector('[data-unit-kind="diff"]') as HTMLElement;
    expect(row).not.toBeNull();

    // Scroll so the diff card sits inside the viewport, then note its
    // position relative to the viewport before toggling.
    row.scrollIntoView({ block: 'center' });
    await nextPaint();
    const beforeRect = row.getBoundingClientRect();

    const toggle = row.querySelector('[data-collapse-id]') as HTMLElement;
    expect(toggle).not.toBeNull();
    toggle.click();
    await nextPaint();
    await nextPaint();
    await nextPaint();

    const afterRect = row.getBoundingClientRect();
    // The row's top edge stays anchored (within a few px) across the
    // collapse/expand height change — the reader's position is preserved,
    // not reset to the top of the transcript.
    expect(Math.abs(afterRect.top - beforeRect.top)).toBeLessThan(4);
    expect(scrollEl.scrollTop).toBeGreaterThan(0);

    dispose();
  });
});
