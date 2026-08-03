/**
 * Browser contract tests for the turn narrative + compact metadata footer
 * (ticket #38, spec #18).
 *
 * Runs the full pipeline — TranscriptTurn -> flatten -> deriveTurnFooter ->
 * turnOutcomeUnitDef.Render — in real Chromium DOM, so this exercises the
 * seam between the pure derivation (pinned exactly in turn-footer.test.ts)
 * and the actual rendered row: does the footer appear for every settled
 * outcome, does it coexist with (never replace) the turn's own operations,
 * does streaming-to-settled transition produce it exactly once, does Copy
 * grab the derived text, and is keyboard expansion of a large grouped turn
 * unaffected by the new footer row.
 */

import { DEFAULT_THEME } from '@core/theme';
import { describe, expect, it, vi } from 'vitest';
import { createChatContext } from '@/chat-context';
import { createChatView } from '@/chat-view';
import type { ToolNode, TranscriptTurn } from '@/model';
import { createChatState } from '@/state/chat-state';
import { textShimmer } from '@styles/effects.css';

const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

async function waitFor<T>(fn: () => T | null, frames = 10): Promise<T | null> {
  for (let i = 0; i < frames; i++) {
    const value = fn();
    if (value) return value;
    await nextPaint();
  }
  return null;
}

function mount() {
  const ctx = createChatContext({ theme: DEFAULT_THEME });
  const state = createChatState(ctx);

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
  document.body.appendChild(host);

  const view = createChatView({ context: ctx, state, parent: host });

  return {
    state,
    host,
    dispose: () => {
      view.dispose();
      ctx.dispose();
      state.dispose();
      document.body.removeChild(host);
    },
  };
}

function turnWith(
  items: TranscriptTurn['items'],
  outcome?: TranscriptTurn['outcome']
): TranscriptTurn {
  return {
    id: 'turn-1',
    seq: 0,
    initiator: 'user',
    items,
    ...(outcome ? { outcome } : {}),
  };
}

function userMessage(id: string, text: string): TranscriptTurn['items'][number] {
  return { kind: 'message', id, seq: 0, role: 'user', text };
}

function assistantMessage(id: string, text: string, seq = 1): TranscriptTurn['items'][number] {
  return { kind: 'message', id, seq, role: 'assistant', text };
}

function readTool(id: string, seq: number, path: string): ToolNode {
  return {
    kind: 'read-tool-call',
    id,
    seq,
    toolCallId: id,
    title: `Read ${path}`,
    status: 'done',
    path,
  };
}

function toolGroup(id: string, seq: number, children: ToolNode[]): ToolNode {
  return {
    kind: 'tool-group',
    id,
    seq,
    label: 'read batch',
    groupKind: 'read-batch',
    status: 'done',
    children,
  };
}

// ── Settled outcomes ──────────────────────────────────────────────────────────

describe('turn footer — distinct summaries per settled outcome', () => {
  it.each([
    ['done' as const, 'Turn completed'],
    ['cancelled' as const, 'Turn cancelled'],
    ['error' as const, 'Turn failed'],
    ['interrupted' as const, 'Turn interrupted'],
  ])('renders the exact status label for a %s turn', async (kind, expectedLabel) => {
    const { state, host, dispose } = mount();
    state.transcript.history.seed([
      turnWith([userMessage('u1', 'Do it'), assistantMessage('a1', 'Ok.')], { kind }),
    ]);
    await nextPaint();

    expect(host.textContent).toContain(expectedLabel);
    dispose();
  });

  it('a committed turn with no recorded outcome renders no footer at all', async () => {
    const { state, host, dispose } = mount();
    state.transcript.history.seed([turnWith([userMessage('u1', 'Hi')])]);
    await nextPaint();

    expect(host.textContent).not.toContain('Turn completed');
    expect(host.textContent).not.toContain('Turn cancelled');
    expect(host.textContent).not.toContain('Turn failed');
    dispose();
  });
});

// ── Narrative preserves chronological content (never hides an operation) ────

describe('turn footer — narrative grouping never hides an operation', () => {
  it('the footer is appended after every prior row, not a replacement for them', async () => {
    const { state, host, dispose } = mount();
    state.transcript.history.seed([
      turnWith(
        [
          userMessage('u1', 'Investigate the bug'),
          readTool('t1', 1, 'src/a.ts'),
          readTool('t2', 2, 'src/b.ts'),
          assistantMessage('a1', 'Found it in src/a.ts.', 3),
        ],
        { kind: 'done' }
      ),
    ]);
    await nextPaint();

    // FileOpRow shows the verb and basename in separate text nodes (no path
    // directory, no separating space) — see file-op/FileOperation.tsx.
    expect(host.textContent).toContain('Investigate the bug');
    expect(host.textContent).toContain('Reada.ts');
    expect(host.textContent).toContain('Readb.ts');
    expect(host.textContent).toContain('Found it in src/a.ts.');
    expect(host.textContent).toContain('Turn completed');
    dispose();
  });
});

// ── Streaming transitions ────────────────────────────────────────────────────

describe('turn footer — streaming transitions', () => {
  it('shows no footer while the turn is active, then exactly one footer once it settles', async () => {
    const { state, host, dispose } = mount();

    state.transcript.activeTurn.set(
      turnWith([userMessage('u1', 'Add a test'), readTool('t1', 1, 'tests/a.test.ts')]),
      'generating'
    );
    await nextPaint();

    expect(host.textContent).not.toContain('Turn completed');

    state.transcript.activeTurn.commit('done');
    await nextPaint();

    const matches = host.textContent?.match(/Turn completed/g) ?? [];
    expect(matches).toHaveLength(1);
    dispose();
  });

  it('a cancelled turn (Stop mid-turn) settles into a distinct cancelled footer', async () => {
    const { state, host, dispose } = mount();

    state.transcript.activeTurn.set(
      turnWith([userMessage('u1', 'Run the whole suite'), readTool('t1', 1, 'tests/')]),
      'generating'
    );
    await nextPaint();
    expect(host.textContent).not.toContain('Turn cancelled');

    state.transcript.activeTurn.commit('cancelled');
    await nextPaint();

    expect(host.textContent).toContain('Turn cancelled');
    expect(host.textContent).not.toContain('Turn completed');
    dispose();
  });
});

// ── Copy action ───────────────────────────────────────────────────────────────

describe('turn footer — copy action', () => {
  it('Copy places exactly the derived turn summary on the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const { state, host, dispose } = mount();
    state.transcript.history.seed([
      turnWith([userMessage('u1', 'Sum 2 and 3'), assistantMessage('a1', 'The sum is 5.')], {
        kind: 'done',
      }),
    ]);
    await nextPaint();

    // Selected by its exact aria-label — the assistant message's own inline
    // Copy button (a different, pre-existing action) also renders "Copy" text.
    const copyButton = await waitFor(
      () => host.querySelector('[aria-label="Copy turn"]') as HTMLButtonElement | null
    );
    expect(copyButton).not.toBeNull();
    copyButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(writeText).toHaveBeenCalledWith('Turn completed\n\nThe sum is 5.');
    dispose();
  });
});

// ── Reduced motion ────────────────────────────────────────────────────────────

describe('turn footer — reduced motion', () => {
  it('never applies the continuous text-shimmer treatment to the footer row', async () => {
    const { state, host, dispose } = mount();
    state.transcript.history.seed([
      turnWith([userMessage('u1', 'Hi'), assistantMessage('a1', 'Hello!')], { kind: 'done' }),
    ]);
    await nextPaint();

    expect(host.querySelectorAll(`.${textShimmer}`)).toHaveLength(0);
    dispose();
  });
});

// ── Large grouped turns + keyboard expansion ─────────────────────────────────

describe('turn footer — large grouped turns and keyboard expansion', () => {
  it('a collapsed tool group keeps its preview and the footer visible together', async () => {
    const { state, host, dispose } = mount();
    const children = Array.from({ length: 20 }, (_, i) =>
      readTool(`child-${i}`, i, `src/f${i}.ts`)
    );
    state.transcript.history.seed([
      turnWith(
        [
          userMessage('u1', 'Read the whole module'),
          toolGroup('group-1', 1, children),
          assistantMessage('a1', 'Reviewed all 20 files.', 2),
        ],
        { kind: 'done' }
      ),
    ]);
    await nextPaint();

    const header = await waitFor(
      () => host.querySelector('[data-collapse-id="group-1"]') as HTMLElement | null
    );
    expect(header).not.toBeNull();
    expect(header!.getAttribute('aria-expanded')).toBe('false');
    // Collapsed preview still shows at least the first child (ticket #38:
    // collapsed groups retain a meaningful preview of completed work).
    expect(host.textContent).toContain('f0.ts');
    // The footer for the completed turn coexists with the collapsed group.
    expect(host.textContent).toContain('Turn completed');

    dispose();
  });

  it('Enter expands a collapsed tool group (keyboard equivalent of click), and the footer stays put', async () => {
    const { state, host, dispose } = mount();
    const children = Array.from({ length: 5 }, (_, i) => readTool(`child-${i}`, i, `src/f${i}.ts`));
    state.transcript.history.seed([
      turnWith(
        [
          userMessage('u1', 'Read five files'),
          toolGroup('group-2', 1, children),
          assistantMessage('a1', 'Read them all.', 2),
        ],
        { kind: 'done' }
      ),
    ]);
    await nextPaint();

    const header = await waitFor(
      () => host.querySelector('[data-collapse-id="group-2"]') as HTMLElement | null
    );
    expect(header).not.toBeNull();
    expect(header!.getAttribute('tabIndex') ?? header!.tabIndex.toString()).not.toBe('-1');

    header!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    await nextPaint();

    expect(header!.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('f4.ts');
    expect(host.textContent).toContain('Turn completed');

    dispose();
  });
});
