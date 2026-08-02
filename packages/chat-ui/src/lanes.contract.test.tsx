/**
 * Browser contract tests for the prose/artifact lane layout (spec #18, ticket
 * #27). Real Chromium layout via @vitest/browser-playwright so the geometry
 * assertions (rendered widths, page-level overflow) reflect actual CSS, not
 * a JS approximation.
 */

import { DEFAULT_THEME } from '@core/theme';
import { describe, expect, it } from 'vitest';
import { createChatContext } from '@/chat-context';
import { createChatView } from '@/chat-view';
import type { ChatItem } from '@/model';
import type { TranscriptTurn } from '@/model';
import { createChatState } from '@/state/chat-state';

// ── Helpers ───────────────────────────────────────────────────────────────────

const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

const OLD_TS = `export function formatUser(user: User): string {
  return user.name;
}`;

const NEW_TS = `export function formatUser(user: User): string {
  if (!user.name) return user.email ?? 'Unknown user';
  return \`\${user.name} <\${user.email}>\`;
}`;

// ChatItem (chat-ui's presentation model) — 'diff' is a synthesized kind, not
// part of the raw ACP TranscriptItem union, so it is cast at the seam below.
// Mirrors the same pattern used by mock-transcript.ts and stories/_harness's
// ChatHost#toTurns.
const LANE_ITEMS: ChatItem[] = [
  {
    kind: 'message',
    id: 'u1',
    role: 'user',
    text: 'Update formatUser to fall back to the email address when the name is missing.',
  },
  {
    kind: 'diff',
    id: 'diff-1:src/format-user.ts',
    path: 'src/format-user.ts',
    oldText: OLD_TS,
    newText: NEW_TS,
    status: 'done',
  },
];

const LANE_TURNS: TranscriptTurn[] = [
  {
    id: 'turn-1',
    seq: 0,
    initiator: 'user',
    items: LANE_ITEMS.map((item, seq) => ({ ...item, seq })) as TranscriptTurn['items'],
  },
];

/** Representative breakpoints from the ticket's acceptance criteria. */
const BREAKPOINTS = [1440, 800, 480];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('prose/artifact lanes', () => {
  for (const width of BREAKPOINTS) {
    it(`widens the artifact (diff) row without page-level overflow at ${width}px`, async () => {
      const ctx = createChatContext({ theme: DEFAULT_THEME });
      const state = createChatState(ctx);
      state.transcript.history.seed(LANE_TURNS);

      const host = document.createElement('div');
      host.style.cssText = `position:fixed;top:0;left:0;width:${width}px;height:600px;`;
      document.body.appendChild(host);

      const view = createChatView({ context: ctx, state, parent: host });
      await nextPaint();
      await nextPaint();

      const scrollEl = host.querySelector('[data-chat-scroll]') as HTMLElement | null;
      expect(scrollEl).not.toBeNull();
      // No page-level horizontal overflow: the scroll container never needs
      // to scroll on the x-axis regardless of how wide the artifact lane grew.
      expect(scrollEl!.scrollWidth).toBeLessThanOrEqual(scrollEl!.clientWidth + 1);

      const proseRow = host.querySelector(
        '[data-lane="prose"][data-unit-kind="message"]'
      ) as HTMLElement | null;
      const artifactRow = host.querySelector(
        '[data-lane="artifact"][data-unit-kind="diff"]'
      ) as HTMLElement | null;
      expect(proseRow).not.toBeNull();
      expect(artifactRow).not.toBeNull();

      const proseRect = proseRow!.getBoundingClientRect();
      const artifactRect = artifactRow!.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();

      // Artifact never narrower than prose (grows only) and never wider than
      // the panel (bounded — "wide content scrolls only within its own
      // artifact surface").
      expect(artifactRect.width).toBeGreaterThanOrEqual(proseRect.width - 1);
      expect(artifactRect.width).toBeLessThanOrEqual(hostRect.width + 1);
      // The artifact row's box itself stays inside the host/panel bounds —
      // "breaking out" of the centered prose column must not escape the
      // scrollable viewport.
      expect(artifactRect.left).toBeGreaterThanOrEqual(hostRect.left - 1);
      expect(artifactRect.right).toBeLessThanOrEqual(hostRect.right + 1);

      if (width === 1440) {
        // Wide panel: the diff should visibly widen past the prose column.
        expect(artifactRect.width).toBeGreaterThan(proseRect.width + 50);
      }
      if (width === 480) {
        // No room to grow: both lanes render at (essentially) the same width.
        expect(Math.abs(artifactRect.width - proseRect.width)).toBeLessThan(2);
      }

      view.dispose();
      ctx.dispose();
      state.dispose();
      document.body.removeChild(host);
    });
  }

  it('keeps prose rows pixel-identical to the pre-lane geometry (left:0, full column width)', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const state = createChatState(ctx);
    state.transcript.history.seed(LANE_TURNS);

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:1440px;height:600px;';
    document.body.appendChild(host);

    const view = createChatView({ context: ctx, state, parent: host });
    await nextPaint();
    await nextPaint();

    const proseRow = host.querySelector(
      '[data-lane="prose"][data-unit-kind="message"]'
    ) as HTMLElement | null;
    const probe = host.querySelector('[data-chat-width-probe]') as HTMLElement | null;
    expect(proseRow).not.toBeNull();
    expect(probe).not.toBeNull();

    const proseRect = proseRow!.getBoundingClientRect();
    const probeRect = probe!.getBoundingClientRect();
    // Prose rows still span exactly the (unchanged) content column.
    expect(Math.abs(proseRect.left - probeRect.left)).toBeLessThan(1);
    expect(Math.abs(proseRect.width - probeRect.width)).toBeLessThan(1);

    view.dispose();
    ctx.dispose();
    state.dispose();
    document.body.removeChild(host);
  });
});
