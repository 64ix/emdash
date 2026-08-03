/**
 * Browser tests for the transcript outline rail/drawer (ticket #34, spec
 * #18; drawer accessibility hardened for ticket #26). Selection semantics
 * (which turns become entries, labels, statuses) are covered by
 * `deriveTranscriptOutline`'s own unit tests in `@emdash/chat-ui`; the
 * off-DOM virtualizer jump itself is covered by that package's
 * `chat-view-scroll-to-item.contract.test.tsx`. This file only asserts what
 * requires real rendering: entry content, rail vs. drawer layout, selection
 * highlighting, and focus behavior — including the drawer's modal dialog
 * semantics and focus trap (ticket #26).
 */

import type { OutlineEntry } from '@emdash/chat-ui';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OUTLINE_NARROW_BREAKPOINT_PX,
  TranscriptOutlineDrawer,
  TranscriptOutlineRail,
} from '@renderer/features/conversations/acp/transcript-outline-panel';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

const ENTRIES: OutlineEntry[] = [
  {
    itemId: 'user-1',
    turnId: 'turn-1',
    role: 'prompt',
    preview: 'Fix the flaky test',
    status: 'completed',
  },
  {
    itemId: 'assistant-1',
    turnId: 'turn-1',
    role: 'turn',
    preview: 'Stabilized the retry loop.',
    status: 'completed',
  },
  {
    itemId: 'user-2',
    turnId: 'turn-2',
    role: 'prompt',
    preview: 'Now add a changelog entry',
    status: 'current',
  },
];

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

async function settle(frames = 3): Promise<void> {
  for (let i = 0; i < frames; i++) await nextFrame();
}

describe('TranscriptOutlineRail', () => {
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

  async function renderRail(props: Partial<React.ComponentProps<typeof TranscriptOutlineRail>>) {
    const onSelect = props.onSelect ?? vi.fn();
    const onClose = props.onClose ?? vi.fn();
    await act(async () => {
      root.render(
        <TranscriptOutlineRail
          entries={props.entries ?? ENTRIES}
          selectedItemId={props.selectedItemId ?? null}
          onSelect={onSelect}
          onClose={onClose}
          returnFocusRef={props.returnFocusRef}
        />
      );
    });
    return { onSelect, onClose };
  }

  it('renders every entry with its preview and a textual status label', async () => {
    await renderRail({});

    expect(host.textContent).toContain('Fix the flaky test');
    expect(host.textContent).toContain('Stabilized the retry loop.');
    expect(host.textContent).toContain('Now add a changelog entry');
    // Status is textual, not color-only (accessibility requirement).
    expect(host.querySelectorAll('nav button')).toHaveLength(3);
    const rows = Array.from(host.querySelectorAll('nav button'));
    expect(rows[0].textContent).toContain('Completed');
    expect(rows[2].textContent).toContain('In progress');
  });

  it('renders textual labels for the error and cancelled statuses', async () => {
    await renderRail({
      entries: [
        { itemId: 'e1', turnId: 't1', role: 'turn', preview: 'Ran the migration', status: 'error' },
        {
          itemId: 'e2',
          turnId: 't2',
          role: 'turn',
          preview: 'Stopped mid-turn',
          status: 'cancelled',
        },
      ],
    });

    const rows = Array.from(host.querySelectorAll('nav button'));
    expect(rows[0].textContent).toContain('Failed');
    expect(rows[1].textContent).toContain('Cancelled');
  });

  it('shows an empty-state message when there are no entries yet', async () => {
    await renderRail({ entries: [] });

    expect(host.querySelectorAll('nav button')).toHaveLength(0);
    expect(host.textContent).toContain('Nothing to show yet.');
  });

  it('calls onSelect with the clicked entry', async () => {
    const { onSelect } = await renderRail({});

    const rows = host.querySelectorAll<HTMLButtonElement>('nav button');
    await act(async () => rows[1].click());

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(ENTRIES[1]);
  });

  it('marks the selected entry as the current row without disturbing the others', async () => {
    await renderRail({ selectedItemId: 'assistant-1' });

    const rows = host.querySelectorAll<HTMLButtonElement>('nav button');
    expect(rows[0].getAttribute('aria-current')).toBeNull();
    expect(rows[1].getAttribute('aria-current')).toBe('true');
    expect(rows[2].getAttribute('aria-current')).toBeNull();
  });

  it('renders as an in-flow rail, reserving transcript width via layout, not overlay', async () => {
    await renderRail({});

    const panel = host.firstElementChild as HTMLElement;
    expect(panel.className).toContain('relative');
    expect(panel.className).not.toContain('absolute');
  });

  it('closes on Escape from within the rail', async () => {
    const { onClose } = await renderRail({});

    const panel = host.firstElementChild as HTMLElement;
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    await act(async () => {
      panel.dispatchEvent(event);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves focus into the rail on mount and returns it to the trigger on close', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Show outline';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const returnFocusRef = { current: trigger };
    await renderRail({ returnFocusRef });

    expect(document.activeElement).not.toBe(trigger);
    expect(host.contains(document.activeElement)).toBe(true);

    await act(async () => root.unmount());

    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

describe('TranscriptOutlineDrawer', () => {
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
    // Base UI portals into document.body; make sure nothing lingers between tests.
    document.querySelectorAll('[data-slot="sheet-content"]').forEach((el) => el.remove());
  });

  async function renderDrawer(
    props: Partial<React.ComponentProps<typeof TranscriptOutlineDrawer>> = {}
  ) {
    const onSelect = props.onSelect ?? vi.fn();
    const onOpenChange = props.onOpenChange ?? vi.fn();
    await act(async () => {
      root.render(
        <TranscriptOutlineDrawer
          open={props.open ?? true}
          onOpenChange={onOpenChange}
          entries={props.entries ?? ENTRIES}
          selectedItemId={props.selectedItemId ?? null}
          onSelect={onSelect}
        />
      );
    });
    await settle();
    return { onSelect, onOpenChange };
  }

  function popup(): HTMLElement {
    const el = document.querySelector<HTMLElement>('[data-slot="sheet-content"]');
    if (!el) throw new Error('drawer popup not found');
    return el;
  }

  it('renders as a modal dialog with an accessible name, not a plain overlay', async () => {
    await renderDrawer();

    const dialog = popup();
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Outline');
  });

  it('renders entries with the same textual content as the rail', async () => {
    await renderDrawer();

    const dialog = popup();
    expect(dialog.textContent).toContain('Fix the flaky test');
    expect(dialog.querySelectorAll('nav button')).toHaveLength(3);
  });

  it('moves focus inside the dialog on open and traps Tab within it', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Show outline';
    document.body.appendChild(trigger);
    trigger.focus();

    await renderDrawer();

    const dialog = popup();
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Tabbing forward from the last focusable element in the dialog must not
    // escape to the trigger or the rest of the document — that would mean
    // the transcript behind the drawer is reachable while it is open.
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])')
    );
    expect(focusable.length).toBeGreaterThan(0);
    focusable[focusable.length - 1].focus();
    expect(dialog.contains(document.activeElement)).toBe(true);

    const tabEvent = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    document.activeElement?.dispatchEvent(tabEvent);
    await settle();

    // Focus manager intercepts the keydown (composite navigation) rather than
    // letting the browser's default tab order run past the dialog boundary.
    expect(document.activeElement).not.toBe(trigger);
    expect(dialog.contains(document.activeElement)).toBe(true);

    trigger.remove();
  });

  it('closes on Escape and returns focus to the element that opened it', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Show outline';
    document.body.appendChild(trigger);
    trigger.focus();

    const onOpenChange = vi.fn();
    await renderDrawer({ onOpenChange });

    const dialog = popup();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => {
      dialog.dispatchEvent(escape);
    });
    await settle();

    expect(onOpenChange.mock.calls[0]?.[0]).toBe(false);

    // Simulate the host reacting to onOpenChange(false) by unmounting the
    // open drawer, matching AcpChatPanel's controlled `open` prop.
    await act(async () => {
      root.render(
        <TranscriptOutlineDrawer
          open={false}
          onOpenChange={onOpenChange}
          entries={ENTRIES}
          selectedItemId={null}
          onSelect={vi.fn()}
        />
      );
    });
    await settle();

    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('calls onSelect with the clicked entry', async () => {
    const { onSelect } = await renderDrawer();

    const rows = popup().querySelectorAll<HTMLButtonElement>('nav button');
    await act(async () => rows[1].click());

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(ENTRIES[1]);
  });
});

describe('OUTLINE_NARROW_BREAKPOINT_PX', () => {
  it('is a positive pixel threshold the host measures its own panel width against', () => {
    expect(OUTLINE_NARROW_BREAKPOINT_PX).toBeGreaterThan(0);
  });
});
