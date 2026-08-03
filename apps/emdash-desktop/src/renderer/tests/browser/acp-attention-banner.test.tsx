/**
 * Browser tests for the sticky attention indicator (ticket #33, spec #18).
 *
 * Pins the ticket's own guardrails with real DOM rendering: the indicator
 * appears only when its focused item's target is genuinely offscreen (not
 * merely because the queue is non-empty), never steals focus or scroll on
 * its own, exposes a real count/traversal for multiple simultaneous items
 * without hiding lower-priority work, and its controls are reachable and
 * activatable by real keyboard input (Tab focus + Enter), not just a mouse
 * click.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { AttentionBanner } from '@renderer/features/conversations/acp/acp-attention-banner';
import type { AttentionItem } from '@renderer/features/conversations/acp/acp-attention-queue';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

const PERMISSION_ITEM: AttentionItem = {
  id: 'permission:req-1',
  kind: 'permission',
  summary: 'Execute a Shell Command',
  target: { kind: 'transcript', itemId: 'item-1' },
};

const ERROR_ITEM: AttentionItem = {
  id: 'error:turn:turn-1',
  kind: 'error',
  summary: 'Turn failed (prompt_failed)',
  target: { kind: 'transcript', itemId: 'item-2' },
};

const FAILED_SUBMISSION_ITEM: AttentionItem = {
  id: 'failed-submission:sub-1',
  kind: 'failed-submission',
  summary: 'Hello there',
  target: { kind: 'composer' },
};

describe('AttentionBanner', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function renderBanner(props: Partial<React.ComponentProps<typeof AttentionBanner>>) {
    const onNext = vi.fn<() => void>();
    const onPrevious = vi.fn<() => void>();
    const onActivate = vi.fn<(item: AttentionItem) => void>();
    await act(async () => {
      root.render(
        <AttentionBanner
          queue={props.queue ?? [PERMISSION_ITEM]}
          focusedItem={props.focusedItem === undefined ? PERMISSION_ITEM : props.focusedItem}
          atBottom={props.atBottom ?? false}
          onNext={onNext}
          onPrevious={onPrevious}
          onActivate={onActivate}
        />
      );
    });
    return { onNext, onPrevious, onActivate };
  }

  // ── Offscreen-gated visibility ────────────────────────────────────────────

  it('renders nothing when the queue is empty', async () => {
    await renderBanner({ queue: [], focusedItem: null });
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it('renders nothing for a transcript-anchored item once the transcript is at the tail (already visible)', async () => {
    await renderBanner({ queue: [PERMISSION_ITEM], focusedItem: PERMISSION_ITEM, atBottom: true });
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it('renders for a transcript-anchored item once the transcript is scrolled away from the tail (genuinely offscreen)', async () => {
    await renderBanner({ queue: [PERMISSION_ITEM], focusedItem: PERMISSION_ITEM, atBottom: false });
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    expect(host.textContent).toContain('Execute a Shell Command');
  });

  it('never renders for a composer-anchored (failed-submission) focused item, regardless of atBottom — the composer is never virtualized away', async () => {
    await renderBanner({
      queue: [FAILED_SUBMISSION_ITEM],
      focusedItem: FAILED_SUBMISSION_ITEM,
      atBottom: false,
    });
    expect(host.querySelector('[role="status"]')).toBeNull();

    await renderBanner({
      queue: [FAILED_SUBMISSION_ITEM],
      focusedItem: FAILED_SUBMISSION_ITEM,
      atBottom: true,
    });
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  // ── Never steals focus or scroll on its own ──────────────────────────────

  it('appearing (atBottom flipping to false) never moves DOM focus or invokes any handler on its own', async () => {
    const button = document.createElement('button');
    button.textContent = 'somewhere else';
    document.body.appendChild(button);
    button.focus();
    expect(document.activeElement).toBe(button);

    const { onNext, onPrevious, onActivate } = await renderBanner({
      queue: [PERMISSION_ITEM],
      focusedItem: PERMISSION_ITEM,
      atBottom: true,
    });
    expect(host.querySelector('[role="status"]')).toBeNull();

    // Transition to genuinely offscreen — the indicator now appears.
    await act(async () => {
      root.render(
        <AttentionBanner
          queue={[PERMISSION_ITEM]}
          focusedItem={PERMISSION_ITEM}
          atBottom={false}
          onNext={onNext}
          onPrevious={onPrevious}
          onActivate={onActivate}
        />
      );
    });
    expect(host.querySelector('[role="status"]')).not.toBeNull();

    // Appearing must not have moved focus or fired any callback by itself.
    expect(document.activeElement).toBe(button);
    expect(onNext).not.toHaveBeenCalled();
    expect(onPrevious).not.toHaveBeenCalled();
    expect(onActivate).not.toHaveBeenCalled();

    button.remove();
  });

  it('appearing while the user is actively typing in the composer never steals focus or the in-progress draft', async () => {
    // The banner is portalled as a sibling above the real composer inside
    // the same footer (see AcpChatPanel's `composerSlot`) — a plain
    // `<textarea>` reproduces the property under test (mounting/unmounting a
    // sibling row must not move focus or disturb an editable control's
    // value/selection) without needing the full store/ChatView.
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();
    await userEvent.type(textarea, 'still typing my message');
    expect(document.activeElement).toBe(textarea);

    const { onNext, onPrevious, onActivate } = await renderBanner({
      queue: [PERMISSION_ITEM],
      focusedItem: PERMISSION_ITEM,
      atBottom: true,
    });
    expect(host.querySelector('[role="status"]')).toBeNull();

    // A permission request arrives while the user keeps typing, and the
    // transcript is scrolled away — the banner now appears.
    await act(async () => {
      root.render(
        <AttentionBanner
          queue={[PERMISSION_ITEM]}
          focusedItem={PERMISSION_ITEM}
          atBottom={false}
          onNext={onNext}
          onPrevious={onPrevious}
          onActivate={onActivate}
        />
      );
    });
    expect(host.querySelector('[role="status"]')).not.toBeNull();

    // Neither focus nor the draft the user was mid-typing may be disturbed.
    expect(document.activeElement).toBe(textarea);
    expect(textarea.value).toBe('still typing my message');
    await userEvent.type(textarea, ' and more');
    expect(textarea.value).toBe('still typing my message and more');

    textarea.remove();
  });

  // ── Count + traversal without hiding lower-priority work ─────────────────

  it('shows a plain "needs your attention" label with no traversal controls for a single item', async () => {
    await renderBanner({ queue: [PERMISSION_ITEM], focusedItem: PERMISSION_ITEM });
    expect(host.textContent).toContain('Needs your attention');
    expect(host.textContent).not.toContain('of 1');
    expect(host.querySelector('[aria-label="Next item needing attention"]')).toBeNull();
    expect(host.querySelector('[aria-label="Previous item needing attention"]')).toBeNull();
  });

  it('exposes total count and position, plus traversal controls, for multiple simultaneous items', async () => {
    const queue = [PERMISSION_ITEM, ERROR_ITEM];
    const { onNext, onPrevious } = await renderBanner({ queue, focusedItem: ERROR_ITEM });

    expect(host.textContent).toContain('2 of 2');
    expect(host.textContent).toContain('Turn failed');

    const next = host.querySelector(
      '[aria-label="Next item needing attention"]'
    ) as HTMLButtonElement;
    const previous = host.querySelector(
      '[aria-label="Previous item needing attention"]'
    ) as HTMLButtonElement;
    expect(next).not.toBeNull();
    expect(previous).not.toBeNull();

    next.click();
    expect(onNext).toHaveBeenCalledTimes(1);
    previous.click();
    expect(onPrevious).toHaveBeenCalledTimes(1);
  });

  // ── Activation ────────────────────────────────────────────────────────────

  it('clicking the primary action activates the currently-focused item, not just the front of the queue', async () => {
    const queue = [PERMISSION_ITEM, ERROR_ITEM];
    const { onActivate } = await renderBanner({ queue, focusedItem: ERROR_ITEM });

    const action = host.querySelector('button:not([aria-label])') as HTMLButtonElement;
    expect(action.textContent).toBe('Jump to it');
    action.click();

    expect(onActivate).toHaveBeenCalledExactlyOnceWith(ERROR_ITEM);
  });

  it('activates via real keyboard input (focus + Enter), not just a mouse click', async () => {
    const { onActivate } = await renderBanner({
      queue: [PERMISSION_ITEM],
      focusedItem: PERMISSION_ITEM,
    });

    const action = host.querySelector('button:not([aria-label])') as HTMLButtonElement;
    action.focus();
    expect(document.activeElement).toBe(action);

    await userEvent.keyboard('{Enter}');

    expect(onActivate).toHaveBeenCalledExactlyOnceWith(PERMISSION_ITEM);
  });

  it('is announced to assistive technology as a polite status region', async () => {
    await renderBanner({ queue: [PERMISSION_ITEM], focusedItem: PERMISSION_ITEM });
    const status = host.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
  });
});
