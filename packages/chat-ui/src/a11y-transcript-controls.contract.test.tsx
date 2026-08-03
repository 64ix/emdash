/**
 * Browser contract tests for ticket #26 (spec #18): keyboard and touch
 * accessibility of existing transcript controls. Real Chromium via
 * @vitest/browser-playwright, using `userEvent` for genuine keyboard input
 * (a synthetic `dispatchEvent(KeyboardEvent)` is untrusted and does not
 * trigger a native button's default Enter/Space activation — only real
 * input through the browser's own pipeline does).
 *
 * Covers representative file (file-op), diff, tool (execute), and resource
 * controls, plus the permission-awaiting state and the Stop control's
 * aria-disabled (not disabled) busy state. Prose/link keyboard coverage
 * lives in the app's `acp-chat-link-routing.test.tsx` (ticket #20); the
 * outline drawer's focus trap lives in the app's
 * `transcript-outline-panel.test.tsx` (ticket #34).
 */

import { DEFAULT_THEME } from '@core/theme';
import { describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { createChatContext } from '@/chat-context';
import { createChatView } from '@/chat-view';
import type { ChatCommands } from '@/commands';
import type { ChatItem, TranscriptTurn } from '@/model';
import { createChatState } from '@/state/chat-state';
import type { ChatState } from '@/state/chat-state';
import { planSpinner, streamWord, textShimmer } from '@styles/effects.css';

const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

async function settle(frames = 2): Promise<void> {
  for (let i = 0; i < frames; i++) await nextPaint();
}

function turnFor(items: ChatItem[]): TranscriptTurn[] {
  return [
    {
      id: 'turn-1',
      seq: 0,
      initiator: 'agent',
      items: items.map((item, seq) => ({ ...item, seq })) as TranscriptTurn['items'],
    },
  ];
}

function mount(
  turns: TranscriptTurn[],
  opts: { width?: number; commands?: ChatCommands } = {}
): { host: HTMLElement; state: ChatState; dispose: () => void } {
  const ctx = createChatContext({ theme: DEFAULT_THEME });
  const state = createChatState(ctx);
  state.transcript.history.seed(turns);

  const host = document.createElement('div');
  host.style.cssText = `position:fixed;top:0;left:0;width:${opts.width ?? 900}px;height:600px;`;
  document.body.appendChild(host);

  const view = createChatView({ context: ctx, state, parent: host, commands: opts.commands });

  return {
    host,
    state,
    dispose: () => {
      view.dispose();
      ctx.dispose();
      state.dispose();
      document.body.removeChild(host);
    },
  };
}

describe('diff header — file control', () => {
  it('opens the file via real keyboard activation (Tab + Enter), not just a click', async () => {
    const onOpenFile = vi.fn();
    const { host, dispose } = mount(
      turnFor([
        {
          kind: 'diff',
          id: 'diff-1',
          path: 'src/keyboard.ts',
          oldText: 'a',
          newText: 'b',
          status: 'done',
        },
      ]),
      { commands: { onOpenFile } }
    );
    await settle();

    const row = host.querySelector('[data-unit-kind="diff"]') as HTMLElement;
    const header = row.querySelector('button') as HTMLButtonElement;
    expect(header).not.toBeNull();
    // A real button — no explicit role attribute needed, no tabIndex shim.
    expect(header.tagName).toBe('BUTTON');

    header.focus();
    expect(document.activeElement).toBe(header);
    await userEvent.keyboard('{Enter}');
    await settle();

    expect(onOpenFile).toHaveBeenCalledWith({
      path: 'src/keyboard.ts',
      itemId: 'diff-1',
      source: 'diff',
    });

    dispose();
  });

  it('exposes the awaiting-permission state as text/aria, not color alone, and stays keyboard-reachable', async () => {
    const onOpenFile = vi.fn();
    const { host, dispose } = mount(
      turnFor([
        {
          kind: 'diff',
          id: 'diff-permission',
          path: 'src/perm.ts',
          oldText: 'a',
          newText: 'b',
          status: 'running',
          awaitingPermission: true,
        },
      ]),
      { commands: { onOpenFile } }
    );
    await settle();

    const row = host.querySelector('[data-unit-kind="diff"]') as HTMLElement;
    const header = row.querySelector('button') as HTMLButtonElement;
    const permissionIcon = row.querySelector('[aria-label="awaiting permission"]');
    expect(permissionIcon).not.toBeNull();
    expect(permissionIcon?.textContent === '').toBe(true); // icon-only — name comes from aria-label, not text

    header.focus();
    expect(document.activeElement).toBe(header);
    await userEvent.keyboard('{Enter}');
    await settle();
    expect(onOpenFile).toHaveBeenCalledTimes(1);

    dispose();
  });
});

describe('file-op row — file control', () => {
  it('opens a single file via real keyboard activation (Tab + Space)', async () => {
    const onOpenFile = vi.fn();
    const { host, dispose } = mount(
      turnFor([
        {
          kind: 'file-op',
          id: 'fop-1',
          op: 'read',
          status: 'done',
          ops: [{ path: 'src/single.ts' }],
        },
      ]),
      { commands: { onOpenFile } }
    );
    await settle();

    const row = host.querySelector('[data-unit-kind="file-op"]') as HTMLElement;
    const button = row.querySelector('button') as HTMLButtonElement;
    expect(button).not.toBeNull();

    button.focus();
    await userEvent.keyboard(' ');
    await settle();

    expect(onOpenFile).toHaveBeenCalledWith({
      path: 'src/single.ts',
      itemId: 'fop-1',
      source: 'file-op',
    });

    dispose();
  });

  it('toggles the multi-file collapsible header via keyboard and keeps focus on it — collapse control', async () => {
    const { host, dispose } = mount(
      turnFor([
        {
          kind: 'file-op',
          id: 'fop-multi',
          op: 'edit',
          status: 'done',
          ops: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
        },
      ])
    );
    await settle();

    const row = host.querySelector('[data-unit-kind="file-op"]') as HTMLElement;
    const header = row.querySelector('button[data-collapse-id]') as HTMLButtonElement;
    expect(header).not.toBeNull();
    expect(header.getAttribute('aria-expanded')).toBe('false');

    header.focus();
    await userEvent.keyboard('{Enter}');
    await settle();

    const headerAfter = row.querySelector('button[data-collapse-id]') as HTMLButtonElement;
    expect(headerAfter.getAttribute('aria-expanded')).toBe('true');
    // Toggling must not strand focus on the document body — the same node
    // (or an equivalent focusable header) stays reachable and focused.
    expect(document.activeElement).toBe(headerAfter);
    expect(row.textContent).toContain('a.ts');
    expect(row.textContent).toContain('b.ts');

    dispose();
  });
});

describe('execute card — tool control', () => {
  it('toggles the collapsible card header via keyboard (Space) and keeps it focused', async () => {
    const { host, dispose } = mount(
      turnFor([
        {
          kind: 'execute',
          id: 'exec-1',
          command: 'echo hello\necho world\necho again',
          status: 'done',
          startedAt: Date.now(),
        },
      ])
    );
    await settle();

    const row = host.querySelector('[data-unit-kind="execute"]') as HTMLElement;
    const header = row.querySelector('button[data-collapse-id]') as HTMLButtonElement;
    expect(header).not.toBeNull();
    expect(header.getAttribute('aria-expanded')).toBe('false');

    header.focus();
    await userEvent.keyboard(' ');
    await settle();

    const headerAfter = row.querySelector('button[data-collapse-id]') as HTMLButtonElement;
    expect(headerAfter.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(headerAfter);

    dispose();
  });
});

describe('resource-link row — resource control', () => {
  it('activates the workspace-file target via real keyboard input', async () => {
    const onActivateLink = vi.fn();
    const { host, dispose } = mount(
      turnFor([
        {
          kind: 'resource-link',
          id: 'rl-1',
          uri: 'docs/readme.md',
          name: 'readme.md',
          target: { kind: 'workspace-file', path: 'docs/readme.md' },
        },
      ]),
      { commands: { onActivateLink } }
    );
    await settle();

    const row = host.querySelector('[data-unit-kind="resource-link"]') as HTMLElement;
    const button = row.querySelector('button') as HTMLButtonElement;
    expect(button).not.toBeNull();

    button.focus();
    await userEvent.keyboard('{Enter}');
    await settle();

    expect(onActivateLink).toHaveBeenCalledWith({
      href: 'docs/readme.md',
      itemId: 'rl-1',
      source: 'resource-link',
    });

    dispose();
  });
});

describe('Stop control — message action (ticket #23 debt)', () => {
  function findStopButton(host: HTMLElement): HTMLButtonElement | null {
    return host.querySelector(
      'button[aria-label="Stop generating"], button[aria-label="Stopping…"]'
    ) as HTMLButtonElement | null;
  }

  it('uses aria-disabled (not the disabled attribute) while a Stop request is in flight, and stays focusable', async () => {
    const onStop = vi.fn();
    const { host, state, dispose } = mount(
      turnFor([{ kind: 'message', id: 'u1', role: 'user', text: 'go' }]),
      { commands: { onStop } }
    );
    await settle();

    // Put the transcript into "generating" for this message — Stop only
    // ever shows for the current (last committed user) message while an
    // active turn is generating.
    state.transcript.activeTurn.set(
      { id: 'turn-2', seq: 1, initiator: 'agent', items: [] },
      'generating'
    );
    await settle();

    let button = findStopButton(host);
    expect(button).not.toBeNull();
    expect(button!.hasAttribute('disabled')).toBe(false);

    button!.focus();
    await userEvent.keyboard('{Enter}');
    await settle();
    expect(onStop).toHaveBeenCalledTimes(1);

    // Host marks the cancellation in flight (AcpChatStore.stop()'s sequence).
    state.session.setStopPending(true);
    await settle();

    button = findStopButton(host);
    expect(button).not.toBeNull();
    expect(button!.getAttribute('aria-label')).toBe('Stopping…');
    expect(button!.getAttribute('aria-busy')).toBe('true');
    // aria-disabled, never the native `disabled` attribute: `disabled` would
    // drop the button from the tab order and the accessibility tree the
    // instant it activates, stranding keyboard focus (ticket #26 debt).
    expect(button!.getAttribute('aria-disabled')).toBe('true');
    expect(button!.hasAttribute('disabled')).toBe(false);

    // Still focusable and in the tab order — re-activating while pending
    // must not re-invoke onStop (single-flight, preserved from #23).
    button!.focus();
    expect(document.activeElement).toBe(button);
    await userEvent.keyboard('{Enter}');
    await settle();
    expect(onStop).toHaveBeenCalledTimes(1);

    dispose();
  });
});

describe('reduced motion — decorative status animations', () => {
  /**
   * Real Chromium via @vitest/browser-playwright cannot emulate
   * `prefers-reduced-motion` from this harness (no `page.emulateMedia`
   * equivalent is exposed), so this asserts the actual parsed stylesheet
   * rule rather than driving the media query end-to-end: for each
   * decorative animation class, a `@media (prefers-reduced-motion: reduce)`
   * rule exists that turns its animation off.
   */
  function findReducedMotionOverride(className: string): CSSStyleRule | null {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSMediaRule)) continue;
        if (!rule.media.mediaText.includes('prefers-reduced-motion')) continue;
        for (const inner of Array.from(rule.cssRules)) {
          if (inner instanceof CSSStyleRule && inner.selectorText.includes(className)) {
            return inner;
          }
        }
      }
    }
    return null;
  }

  it('turns off the running-state text shimmer', () => {
    const rule = findReducedMotionOverride(textShimmer);
    expect(rule).not.toBeNull();
    expect(rule!.style.animationName).toBe('none');
  });

  it('turns off the plan in-progress spinner', () => {
    const rule = findReducedMotionOverride(planSpinner);
    expect(rule).not.toBeNull();
    expect(rule!.style.animationName).toBe('none');
  });

  it('turns off the streamed-word fade-in', () => {
    const rule = findReducedMotionOverride(streamWord);
    expect(rule).not.toBeNull();
    expect(rule!.style.animationName).toBe('none');
  });
});
