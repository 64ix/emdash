/**
 * Browser tests for TranscriptOutlinePanel (ticket #34, spec #18): rendering
 * and navigation for the presentational outline rail/drawer. Selection
 * semantics (which turns become entries, labels, statuses) are covered by
 * `deriveTranscriptOutline`'s own unit tests in `@emdash/chat-ui`; the
 * off-DOM virtualizer jump itself is covered by that package's
 * `chat-view-scroll-to-item.contract.test.tsx`. This file only asserts what
 * requires real rendering: entry content, wide/narrow layout, selection
 * highlighting, and focus behavior.
 */

import type { OutlineEntry } from '@emdash/chat-ui';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OUTLINE_NARROW_BREAKPOINT_PX,
  TranscriptOutlinePanel,
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

describe('TranscriptOutlinePanel', () => {
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

  async function renderPanel(props: Partial<React.ComponentProps<typeof TranscriptOutlinePanel>>) {
    const onSelect = props.onSelect ?? vi.fn();
    const onClose = props.onClose ?? vi.fn();
    await act(async () => {
      root.render(
        <TranscriptOutlinePanel
          entries={props.entries ?? ENTRIES}
          wide={props.wide ?? true}
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
    await renderPanel({});

    expect(host.textContent).toContain('Fix the flaky test');
    expect(host.textContent).toContain('Stabilized the retry loop.');
    expect(host.textContent).toContain('Now add a changelog entry');
    // Status is textual, not color-only (accessibility requirement).
    expect(host.querySelectorAll('nav button')).toHaveLength(3);
    const rows = Array.from(host.querySelectorAll('nav button'));
    expect(rows[0].textContent).toContain('Completed');
    expect(rows[2].textContent).toContain('In progress');
  });

  it('shows an empty-state message when there are no entries yet', async () => {
    await renderPanel({ entries: [] });

    expect(host.querySelectorAll('nav button')).toHaveLength(0);
    expect(host.textContent).toContain('Nothing to show yet.');
  });

  it('calls onSelect with the clicked entry', async () => {
    const { onSelect } = await renderPanel({});

    const rows = host.querySelectorAll<HTMLButtonElement>('nav button');
    await act(async () => rows[1].click());

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(ENTRIES[1]);
  });

  it('marks the selected entry as the current row without disturbing the others', async () => {
    await renderPanel({ selectedItemId: 'assistant-1' });

    const rows = host.querySelectorAll<HTMLButtonElement>('nav button');
    expect(rows[0].getAttribute('aria-current')).toBeNull();
    expect(rows[1].getAttribute('aria-current')).toBe('true');
    expect(rows[2].getAttribute('aria-current')).toBeNull();
  });

  it('renders as an in-flow rail when wide, reserving transcript width via layout, not overlay', async () => {
    await renderPanel({ wide: true });

    const panel = host.firstElementChild as HTMLElement;
    expect(panel.className).toContain('relative');
    expect(panel.className).not.toContain('absolute');
  });

  it('renders as an absolutely-positioned overlay drawer when narrow', async () => {
    await renderPanel({ wide: false });

    const panel = host.firstElementChild as HTMLElement;
    expect(panel.className).toContain('absolute');
    expect(panel.className).toContain('inset-y-0');
    expect(panel.className).toContain('right-0');
  });

  it('closes on Escape from within the panel', async () => {
    const { onClose } = await renderPanel({});

    const panel = host.firstElementChild as HTMLElement;
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    await act(async () => {
      panel.dispatchEvent(event);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves focus into the panel on mount and returns it to the trigger on close', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Show outline';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const returnFocusRef = { current: trigger };
    await renderPanel({ returnFocusRef });

    expect(document.activeElement).not.toBe(trigger);
    expect(host.contains(document.activeElement)).toBe(true);

    await act(async () => root.unmount());

    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

describe('OUTLINE_NARROW_BREAKPOINT_PX', () => {
  it('is a positive pixel threshold the host measures its own panel width against', () => {
    expect(OUTLINE_NARROW_BREAKPOINT_PX).toBeGreaterThan(0);
  });
});
