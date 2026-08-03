/**
 * Browser tests for ChangesRailRow (ticket #35, spec #18): the Changes rail
 * entry that links a footprint entry to its transcript provenance while
 * keeping "Open file" and "Open diff" reachable as separate explicit
 * actions. Provenance derivation itself (which occurrence "wins", the honest
 * "last" wording) is covered by `changes-provenance.test.ts`'s pure-function
 * tests; this file only asserts what requires real rendering: which actions
 * are present per entry kind, that they stay independent of each other and
 * of the row's primary click, that a Git-only entry (no transcript
 * provenance) degrades gracefully instead of exposing a dead affordance, and
 * that the row is keyboard-operable.
 *
 * The row itself renders as `role="button"` on a `div`, not a real
 * `<button>` — see `changes-rail-row.tsx`'s doc comment for why nesting the
 * hover-revealed action `<button>`s inside a real `<button>` row would be
 * invalid. `getRow()` below selects on `[role="button"]` rather than the
 * first `button` in the host so these tests keep asserting the row itself,
 * not whichever action button happens to render first in DOM order.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangesFootprintEntry } from '@renderer/features/conversations/acp/changes/acp-changes-footprint';
import { ChangesRailRow } from '@renderer/features/conversations/acp/changes/changes-rail-row';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function editedEntry(overrides: Partial<ChangesFootprintEntry> = {}): ChangesFootprintEntry {
  return {
    kind: 'edited',
    path: 'src/nested/a.ts',
    status: 'modified',
    additions: 3,
    deletions: 1,
    source: { turnId: 'turn-1', itemId: 'edit-item' },
    ...overrides,
  } as ChangesFootprintEntry;
}

function readEntry(overrides: Partial<ChangesFootprintEntry> = {}): ChangesFootprintEntry {
  return {
    kind: 'read',
    path: 'src/nested/b.ts',
    source: { turnId: 'turn-1', itemId: 'read-item' },
    ...overrides,
  } as ChangesFootprintEntry;
}

describe('ChangesRailRow', () => {
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

  async function renderRow(props: Partial<React.ComponentProps<typeof ChangesRailRow>>) {
    const onSelect = props.onSelect ?? vi.fn();
    const onOpenFile = props.onOpenFile ?? vi.fn();
    const onOpenDiff = 'onOpenDiff' in props ? props.onOpenDiff : vi.fn();
    await act(async () => {
      root.render(
        <ChangesRailRow
          entry={props.entry ?? editedEntry()}
          isSelected={props.isSelected ?? false}
          onSelect={onSelect}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
        />
      );
    });
    return { onSelect, onOpenFile, onOpenDiff };
  }

  function getRow(): HTMLElement {
    return host.querySelector<HTMLElement>('[role="button"]')!;
  }

  it('renders the filename and directory for the entry path', async () => {
    await renderRow({ entry: editedEntry({ path: 'src/nested/a.ts' }) });

    expect(host.textContent).toContain('a.ts');
    expect(host.textContent).toContain('src/nested');
  });

  it('renders the row as a div, never a real <button>, so the hover-revealed action buttons are not nested inside another button', async () => {
    await renderRow({});

    const row = getRow();
    expect(row.tagName).toBe('DIV');
    // The row must still be its own DOM node distinct from (and not an
    // ancestor confusion with) the action buttons — but action buttons *are*
    // expected descendants of the row (for layout); the point is the row
    // itself is not a <button>.
    expect(row.querySelectorAll('button').length).toBeGreaterThan(0);
  });

  it('calls onSelect when the row body is clicked', async () => {
    const { onSelect } = await renderRow({});

    const row = getRow();
    await act(async () => row.click());

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('calls onSelect on Enter or Space — keyboard activation for the non-native-button row', async () => {
    const { onSelect } = await renderRow({});

    const row = getRow();
    row.focus();
    await act(async () => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await act(async () => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });

    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('reflects isSelected via aria-current on the row, not the action buttons', async () => {
    await renderRow({ isSelected: true });

    const row = getRow();
    expect(row.getAttribute('aria-current')).toBe('true');
  });

  it('exposes an honest "jump to last edit" tooltip when the entry has provenance', async () => {
    await renderRow({ entry: editedEntry() });

    const row = getRow();
    expect(row.getAttribute('title')).toBe('src/nested/a.ts — Jump to last edit in transcript');
  });

  it('shows the history/jump indicator only when the entry has transcript provenance', async () => {
    await renderRow({ entry: editedEntry() });

    expect(host.querySelector('svg.lucide-history')).not.toBeNull();
  });

  it('falls back to the bare path tooltip for a Git-only entry with no transcript provenance', async () => {
    await renderRow({
      entry: editedEntry({ path: 'src/renamed.ts', status: 'renamed', source: null }),
    });

    const row = getRow();
    expect(row.getAttribute('title')).toBe('src/renamed.ts');
  });

  it('renders no history/jump indicator for a Git-only entry with no transcript provenance — no dead affordance', async () => {
    await renderRow({
      entry: editedEntry({ path: 'src/renamed.ts', status: 'renamed', source: null }),
    });

    expect(host.querySelector('svg.lucide-history')).toBeNull();
  });

  it('calls onOpenFile — and not onSelect — when the "Open file" action is used', async () => {
    const { onSelect, onOpenFile } = await renderRow({});

    const openFileButton = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Open a.ts in the editor"]'
    )!;
    await act(async () => openFileButton.click());

    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('calls onOpenDiff — and not onSelect or onOpenFile — for an edited entry\'s "Open diff" action', async () => {
    const { onSelect, onOpenFile, onOpenDiff } = await renderRow({ entry: editedEntry() });

    const openDiffButton = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Open diff for a.ts"]'
    )!;
    await act(async () => openDiffButton.click());

    expect(onOpenDiff).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it('never renders an "Open diff" action for a read entry — nothing to diff', async () => {
    await renderRow({ entry: readEntry() });

    expect(host.querySelector('button[aria-label^="Open diff"]')).toBeNull();
  });

  it('still renders "Open file" for a read entry even without an onOpenDiff handler', async () => {
    await renderRow({ entry: readEntry(), onOpenDiff: undefined });

    expect(host.querySelector('button[aria-label^="Open"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label^="Open diff"]')).toBeNull();
  });
});
