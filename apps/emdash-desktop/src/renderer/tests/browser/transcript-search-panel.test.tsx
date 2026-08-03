/**
 * Browser tests for the transcript search bar (ticket #36, spec #18).
 * Matching semantics (which fields are searched, ranking, redaction,
 * grapheme-safe snippets) are covered by `@emdash/chat-ui`'s own
 * `state/transcript-search.test.ts`; store wiring (debounce, jump-through-
 * scrollToTranscriptItem, staleness) is covered by `acp-chat-store.test.ts`.
 * This file only asserts what requires real rendering: input/count/nav
 * content, keyboard driving (Enter/Shift+Enter/Escape), focus behavior, the
 * "only loaded history" disclosure, and grapheme-safe, non-markup
 * highlighting.
 */

import type { TranscriptSearchResult } from '@emdash/chat-ui';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { TranscriptSearchBar } from '@renderer/features/conversations/acp/transcript-search-panel';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function makeResult(overrides: Partial<TranscriptSearchResult> = {}): TranscriptSearchResult {
  return {
    id: 'item-1',
    itemId: 'item-1',
    turnId: 'turn-1',
    kind: 'response',
    snippet: 'the quick brown fox',
    matchStart: 4,
    matchLength: 5,
    ...overrides,
  };
}

describe('TranscriptSearchBar', () => {
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

  function baseProps(): React.ComponentProps<typeof TranscriptSearchBar> {
    return {
      query: '',
      onQueryChange: vi.fn(),
      results: [],
      currentIndex: null,
      onNext: vi.fn(),
      onPrevious: vi.fn(),
      onSelectResult: vi.fn(),
      onClose: vi.fn(),
      historyExhausted: true,
      isLoadingOlderHistory: false,
      onLoadOlderHistory: vi.fn(),
    };
  }

  async function renderBar(overrides: Partial<React.ComponentProps<typeof TranscriptSearchBar>>) {
    const props = { ...baseProps(), ...overrides };
    await act(async () => {
      root.render(<TranscriptSearchBar {...props} />);
    });
    return props;
  }

  function input(): HTMLInputElement {
    return host.querySelector<HTMLInputElement>('[aria-label="Search transcript"]')!;
  }

  it('renders the search input and focuses it on mount', async () => {
    await renderBar({});
    expect(document.activeElement).toBe(input());
  });

  it('shows no count when the query is blank', async () => {
    await renderBar({ query: '' });
    expect(host.textContent).not.toContain('matches');
    expect(host.textContent).not.toContain('No matches');
  });

  it('shows "No matches" for a non-empty query with zero results', async () => {
    await renderBar({ query: 'nothing', results: [] });
    expect(host.textContent).toContain('No matches');
  });

  it('shows an unselected match count before any navigation', async () => {
    await renderBar({ query: 'fox', results: [makeResult(), makeResult({ id: 'item-2' })] });
    expect(host.textContent).toContain('2 matches');
  });

  it('shows "X of Y" once a result is selected', async () => {
    await renderBar({
      query: 'fox',
      results: [makeResult(), makeResult({ id: 'item-2' })],
      currentIndex: 1,
    });
    expect(host.textContent).toContain('2 of 2');
  });

  it('disables Previous/Next when there are no results', async () => {
    await renderBar({ query: 'nothing', results: [] });
    const prev = host.querySelector<HTMLButtonElement>('[aria-label="Previous match"]')!;
    const next = host.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!;
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(true);
  });

  it('Next/Previous buttons call onNext/onPrevious', async () => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    await renderBar({ query: 'fox', results: [makeResult()], onNext, onPrevious });

    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!.click()
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Previous match"]')!.click()
    );

    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrevious).toHaveBeenCalledTimes(1);
  });

  it('typing calls onQueryChange, and the controlled input reflects the latest query', async () => {
    // TranscriptSearchBar's `query` is a controlled prop (the store owns it,
    // debouncing the actual recompute) — a bare `vi.fn()` onQueryChange never
    // updates it, so React resets the DOM value after every keystroke. A tiny
    // stateful wrapper mirrors how the real host (AcpChatPanel/store) is
    // wired, so typing accumulates the way it does for a real user.
    const onQueryChange = vi.fn();
    function Controlled() {
      const [query, setQuery] = React.useState('');
      return (
        <TranscriptSearchBar
          {...baseProps()}
          query={query}
          onQueryChange={(value) => {
            setQuery(value);
            onQueryChange(value);
          }}
        />
      );
    }
    await act(async () => {
      root.render(<Controlled />);
    });

    await userEvent.type(input(), 'alpha');

    expect(onQueryChange).toHaveBeenLastCalledWith('alpha');
    expect(input().value).toBe('alpha');
  });

  it('Enter calls onNext, Shift+Enter calls onPrevious — real key driving', async () => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    await renderBar({ query: 'fox', results: [makeResult()], onNext, onPrevious });

    const el = input();
    await act(async () => {
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
    });
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrevious).not.toHaveBeenCalled();

    await act(async () => {
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    expect(onPrevious).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('Escape calls onClose', async () => {
    const onClose = vi.fn();
    await renderBar({ onClose });

    const el = input();
    await act(async () => {
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the trigger element on unmount', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Search';
    document.body.appendChild(trigger);
    trigger.focus();

    const returnFocusRef = { current: trigger };
    await renderBar({ returnFocusRef });
    expect(document.activeElement).toBe(input());

    await act(async () => root.unmount());
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('clicking the current-result row calls onSelectResult with it', async () => {
    const onSelectResult = vi.fn();
    const result = makeResult();
    await renderBar({ query: 'fox', results: [result], currentIndex: 0, onSelectResult });

    const row = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('quick')
    );
    expect(row).toBeDefined();
    await act(async () => row!.click());

    expect(onSelectResult).toHaveBeenCalledExactlyOnceWith(result);
  });

  it('highlights the match as a separate, non-markup <mark> element without splitting a surrogate pair', async () => {
    const emoji = '🎉'.repeat(3);
    const result = makeResult({
      snippet: `${emoji} MATCH tail`,
      matchStart: 4,
      matchLength: 5,
    });
    await renderBar({ query: 'match', results: [result], currentIndex: 0 });

    const mark = host.querySelector('mark');
    expect(mark).not.toBeNull();
    expect(mark!.textContent).toBe('MATCH');
    expect(mark!.previousSibling?.textContent).toBe(emoji + ' ');
    expect(mark!.nextSibling?.textContent).toBe(' tail');
    // Never rendered as HTML/markup — no injected element from the snippet text itself.
    expect(mark!.innerHTML).toBe('MATCH');
  });

  it('shows the current result kind label above the snippet', async () => {
    await renderBar({
      query: 'fox',
      results: [makeResult({ kind: 'tool-error' })],
      currentIndex: 0,
    });
    expect(host.textContent).toContain('Error');
  });

  it('shows the "only loaded history" disclosure and a load-older action when history is not exhausted', async () => {
    const onLoadOlderHistory = vi.fn();
    await renderBar({ historyExhausted: false, onLoadOlderHistory });

    expect(host.textContent).toContain('Only loaded history is searched.');
    const button = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Load older history')
    );
    expect(button).toBeDefined();

    await act(async () => button!.click());
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
  });

  it('hides the disclosure once history is exhausted', async () => {
    await renderBar({ historyExhausted: true });
    expect(host.textContent).not.toContain('Only loaded history is searched.');
  });

  it('disables the load-older action while a page is already loading', async () => {
    await renderBar({ historyExhausted: false, isLoadingOlderHistory: true });
    const button = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Load older history')
    )!;
    expect(button.disabled).toBe(true);
  });
});
