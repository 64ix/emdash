/**
 * Browser-mode regression tests for the Feature Board drag-and-drop wiring.
 *
 * Mounts the real BoardMainPanel in Chromium (real layout, real
 * getBoundingClientRect) with mocked stores, injects the subset of utility
 * CSS the board's geometry depends on, and drives genuine PointerEvent
 * sequences.
 *
 * Regression coverage for two geometry bugs:
 * - autoscroll: with the board overflowing horizontally (it always does —
 *   8 fixed-width columns), dnd-kit's default 20%-of-container autoscroll
 *   band scrolled the board under the pointer mid-drag, so drops landed
 *   columns to the right of the one the user aimed at ("only every other
 *   column works"). Guarded by the narrow-viewport tests.
 * - same-column reorder: the drop-position midpoint heuristic compared the
 *   DragOverlay preview (shorter than the card) against the over card's
 *   rect, biasing the above/below decision upward so small downward drags
 *   silently failed to reorder. Guarded by the tight-overshoot reorder tests.
 */
import { observable, runInAction } from 'mobx';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { LinkedIssueRoles } from '@shared/core/linked-issue';
import { SHIPPED_FADE_WINDOW_MS } from '@shared/core/pull-requests/pr-workflow-derivation';
import type { PullRequest } from '@shared/core/pull-requests/pull-requests';

// ── Store mocks ───────────────────────────────────────────────────────────────

type MockStore = {
  data: {
    id: string;
    name: string;
    status: string;
    type: string;
    workflowStage?: string;
    boardRank?: string;
    archivedAt?: string;
    // Stage authority (ticket #48): the facts `authorityForTask` reads.
    linkedIssues?: LinkedIssueRoles;
    prs?: PullRequest[];
    workspaceId?: string;
  };
  conversationStats: Record<string, number>;
  updateBoardPosition: ReturnType<typeof vi.fn>;
};

const managerTasks = new Map<string, MockStore>();
const captureTelemetryMock = vi.fn();

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useParams: () => ({ params: { projectId: 'p1' } }),
  useNavigate: () => ({ navigate: vi.fn() }),
}));

vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectStore: () => ({}),
  projectDisplayName: () => 'Test project',
}));

vi.mock('@renderer/features/tasks/stores/task-selectors', () => ({
  getTaskManagerStore: () => ({ tasks: managerTasks }),
  taskAgentStatus: () => 'idle',
  // Statically imported by task-detail-panel.tsx even though these
  // drag-and-drop tests never click a card (drag suppresses the click, so
  // the panel never opens) — the mock still needs to shadow the real exports.
  getTaskStore: (_projectId: string, taskId: string) => managerTasks.get(taskId),
  getTaskGitWorktreeStore: () => undefined,
  // Ticket #68's Conversations section reads this to build its rows — always
  // stubbed here too, for the same reason as `getTaskStore` above.
  getConversationsForTask: () => undefined,
}));

vi.mock('@renderer/features/tasks/stores/task-store', () => ({
  registeredTaskData: (store: MockStore) => store.data,
  // Ticket #47's card now renders `TaskGitDiffStats`, which imports
  // `isRegistered` from this module even though these drag-and-drop tests
  // never surface diff stats (mock stores have no `workspaceGit`/`projectId`,
  // so it always resolves to "nothing to show") — the mock still needs to
  // shadow the real export so that import does not resolve to `undefined`.
  isRegistered: () => true,
}));

vi.mock('@renderer/lib/components/agent-status-indicator', () => ({
  AgentStatusIndicator: () => null,
}));

// `StackedAgentLogos` (ticket #47's card, provider/session context) reads
// agent metadata through `@tanstack/react-query` and, via `PluginIcon`'s
// theme lookup, transitively reaches the app-wide store graph
// (`ThemeProvider` -> pty -> `appState` -> `ProjectManagerStore` -> ... ->
// `open-file-in-file-editor.ts`) — none of it relevant to these drag tests,
// and each hop needs its own real (unmocked) module. Mocked away wholesale,
// the same way `AgentStatusIndicator` already is above.
vi.mock('@renderer/lib/components/stacked-agent-logos', () => ({
  StackedAgentLogos: () => null,
}));

// `ConversationAgentIcon` (ticket #68's Conversations section rows) reaches
// the exact same heavy theme/store chain as `StackedAgentLogos` above (via
// `AgentIcon` -> `PluginIcon` -> `useTheme`) — mocked away wholesale for the
// same reason.
vi.mock('@renderer/features/conversations/conversation-agent-icon', () => ({
  ConversationAgentIcon: () => null,
}));

// Stage authority (ticket #48): `board_move_blocked` is captured through this
// module — stub it directly rather than the real RPC/session-id round trip
// `captureTelemetry` performs, which this suite has no reason to exercise.
vi.mock('@renderer/utils/telemetryClient', () => ({
  captureTelemetry: (...args: unknown[]) => captureTelemetryMock(...args),
}));

// BoardMainPanel pulls in BoardLinkSuggestions and GhostCards, which call the
// real `rpc`/`events` singletons on mount (link suggestions, ghost cards,
// board/issue sync). This suite only exercises drag-and-drop geometry, so
// stub those calls directly rather than relying on the browser project's
// generic `electronAPI.invoke` stub — the real handlers return arrays these
// components `.map` over, which a one-size-fits-all IPC stub can't guess.
vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    issues: {
      getLinkSuggestions: vi.fn(() => Promise.resolve([])),
      getGhostCards: vi.fn(() => Promise.resolve([])),
      syncIssuesNow: vi.fn(() => Promise.resolve()),
    },
    tasks: {
      syncBoardStages: vi.fn(() => Promise.resolve()),
    },
  },
  events: {
    on: vi.fn(() => () => {}),
  },
}));

import { BoardMainPanel } from '@renderer/features/board/board-main-panel';

function makeStore(id: string, overrides: Partial<MockStore['data']> = {}): MockStore {
  return {
    data: { id, name: id, status: 'active', type: 'task', ...overrides },
    conversationStats: {},
    updateBoardPosition: vi.fn().mockResolvedValue(undefined),
  };
}

/** A merged PR, for a `shipped` task — `mergedAt` decides whether Shipped
 * Fade (ticket #51) currently hides the card it belongs to. */
function mergedPr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    url: 'https://github.com/acme/repo/pull/1',
    provider: 'github',
    repositoryUrl: 'https://github.com/acme/repo',
    baseRefName: 'main',
    baseRefOid: 'abc',
    headRepositoryUrl: 'https://github.com/acme/repo',
    headRefName: 'feature',
    headRefOid: 'def',
    identifier: '#1',
    title: 'Merged PR',
    description: null,
    status: 'merged',
    isDraft: false,
    additions: null,
    deletions: null,
    changedFiles: null,
    commitCount: null,
    mergeableStatus: null,
    mergeStateStatus: null,
    reviewDecision: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    mergedAt: new Date().toISOString(),
    author: null,
    labels: [],
    assignees: [],
    checks: [],
    ...overrides,
  };
}

/** An open GitHub Spec issue — governs Spec (ticket #48). */
function openSpecLink(): LinkedIssueRoles {
  return {
    version: '1',
    spec: {
      provider: 'github',
      url: 'https://github.com/acme/repo/issues/42',
      title: 'Spec issue',
      identifier: '#42',
      status: 'open',
    },
  };
}

// ── Layout CSS: just enough of the utility classes the board uses ─────────────

const LAYOUT_CSS = `
  html, body, #board-host { margin: 0; height: 100%; }
  .flex { display: flex; }
  .flex-col { flex-direction: column; }
  .flex-1 { flex: 1 1 0%; min-height: 0; }
  .h-full { height: 100%; }
  .w-56 { width: 14rem; }
  .w-14 { width: 3.5rem; }
  /* Collapsible empty columns (ticket #46): the collapsed width above is
     overridden while focus lands anywhere inside the column, matching the
     "focus-within:w-56" utility class the column applies. */
  .focus-within\\:w-56:focus-within { width: 14rem; }
  .shrink-0 { flex-shrink: 0; }
  .gap-2 { gap: 0.5rem; }
  .gap-3 { gap: 0.75rem; }
  .overflow-x-auto { overflow-x: auto; }
  .overflow-y-auto { overflow-y: auto; }
  .p-2 { padding: 0.5rem; }
  .px-2 { padding-left: 0.5rem; padding-right: 0.5rem; }
  .px-3 { padding-left: 0.75rem; padding-right: 0.75rem; }
  .px-4 { padding-left: 1rem; padding-right: 1rem; }
  .py-2 { padding-top: 0.5rem; padding-bottom: 0.5rem; }
  .pb-2 { padding-bottom: 0.5rem; }
  .pb-4 { padding-bottom: 1rem; }
  .pt-4 { padding-top: 1rem; }
  .border { border: 1px solid #ccc; }
`;

// ── Pointer-drag driver ───────────────────────────────────────────────────────

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle(frames = 4) {
  for (let i = 0; i < frames; i++) await frame();
}

function pointer(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1,
    pointerId: 1,
    isPrimary: true,
  });
}

function center(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Press on `from`, walk to the target in steps, hover a beat, release. */
async function drag(from: Element, toX: number, toY: number, hoverFrames = 4) {
  const start = center(from);
  from.dispatchEvent(pointer('pointerdown', start.x, start.y));
  await settle();
  // Exceed the 6px activation constraint, then walk to the target in steps so
  // dnd-kit gets intermediate collision passes (like a real hand would).
  const steps = 8;
  document.dispatchEvent(pointer('pointermove', start.x + 10, start.y + 2));
  await settle();
  for (let i = 1; i <= steps; i++) {
    const x = start.x + ((toX - start.x) * i) / steps;
    const y = start.y + ((toY - start.y) * i) / steps;
    document.dispatchEvent(pointer('pointermove', x, y));
    await settle(2);
  }
  await settle(hoverFrames);
  document.dispatchEvent(pointer('pointerup', toX, toY));
  await settle();
}

// ── Harness ───────────────────────────────────────────────────────────────────

const STAGE_LABELS: Record<string, string> = {
  idea: 'Idea',
  exploring: 'Exploring',
  spec: 'Spec',
  implementing: 'Implementing',
  review: 'Review',
  shipped: 'Shipped',
  triage: 'Triage',
};

let host: HTMLDivElement;
let root: Root;
let style: HTMLStyleElement;

function setupDom() {
  beforeEach(() => {
    style = document.createElement('style');
    style.textContent = LAYOUT_CSS;
    document.head.appendChild(style);
    host = document.createElement('div');
    host.id = 'board-host';
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    root.unmount();
    host.remove();
    style.remove();
    managerTasks.clear();
    vi.clearAllMocks();
  });
}

async function mount() {
  root.render(<BoardMainPanel />);
  await settle();
}

/** The column's own outer container — carries `aria-disabled`/`title` (ticket #48). */
function columnContainer(label: string): Element {
  const header = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === label)!;
  return header.parentElement!.parentElement!;
}

/** The column list container (droppable zone) for a given column label. */
function columnZone(label: string): Element {
  return columnContainer(label).lastElementChild!;
}

/** The whole column (header + droppable zone) for a given column label — used
 * to measure the collapse/expand width (ticket #46). */
function columnWrapper(label: string): HTMLElement {
  const header = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === label)!;
  return header.parentElement!.parentElement as HTMLElement;
}

/** The collapse/expand toggle button for a given (empty-only) column label. */
function columnToggle(label: string): HTMLButtonElement {
  return Array.from(host.querySelectorAll('button')).find((button) =>
    button.getAttribute('aria-label')?.endsWith(`${label} column`)
  ) as HTMLButtonElement;
}

function cardEl(name: string): Element {
  // The card name is a <span> (not a <button>): the whole card is the click
  // target since Task Detail Panel ticket #40, not just its name.
  const label = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === name)!;
  return label.parentElement!; // sortable wrapper div
}

describe('board drag-and-drop — every column, wide viewport', () => {
  setupDom();

  beforeEach(async () => {
    // Wide enough that all 8 columns are visible and nothing scrolls.
    await page.viewport(2200, 800);
  });

  for (const [stage, label] of Object.entries(STAGE_LABELS)) {
    it(`drops an unstaged card into the "${stage}" column`, async () => {
      const a = makeStore('card-a');
      const b = makeStore('card-b');
      managerTasks.set(a.data.id, a);
      managerTasks.set(b.data.id, b);
      await mount();

      const target = center(columnZone(label));
      await drag(cardEl('card-a'), target.x, target.y);

      expect(a.updateBoardPosition).toHaveBeenCalledTimes(1);
      expect(a.updateBoardPosition).toHaveBeenCalledWith(stage, expect.any(String));
    });
  }

  it('drops a staged card back into Unstaged (stage cleared)', async () => {
    const a = makeStore('card-a', { workflowStage: 'spec', boardRank: 'm' });
    const b = makeStore('card-b');
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b);
    await mount();

    const target = center(columnZone('Unstaged'));
    await drag(cardEl('card-a'), target.x, target.y);

    expect(a.updateBoardPosition).toHaveBeenCalledTimes(1);
    expect(a.updateBoardPosition).toHaveBeenCalledWith(null, expect.any(String));
  });
});

describe('board drag-and-drop — narrow viewport (autoscroll regressions)', () => {
  setupDom();

  beforeEach(async () => {
    // Narrow enough that the board overflows horizontally, like the app.
    await page.viewport(414, 896);
  });

  it('dropping on a fully visible column near the right edge stays on that column', async () => {
    // "Idea" is fully visible but sits inside what used to be the default 20%
    // autoscroll band: before the fix the board scrolled under the pointer
    // mid-hover and the drop landed on the next column over.
    const a = makeStore('card-a');
    const b = makeStore('card-b');
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b);
    await mount();

    const target = center(columnZone('Idea'));
    expect(target.x).toBeLessThan(window.innerWidth); // sanity: fully visible
    await drag(cardEl('card-a'), target.x, target.y, 30);

    expect(a.updateBoardPosition).toHaveBeenCalledTimes(1);
    expect(a.updateBoardPosition).toHaveBeenCalledWith('idea', expect.any(String));
  });

  it('dropping on a visible column with non-zero initial scrollLeft', async () => {
    const a = makeStore('card-a');
    const b = makeStore('card-b');
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b);
    await mount();

    // The user scrolled the board by two columns before dragging.
    const scroller = host.querySelector<HTMLElement>('.overflow-x-auto')!;
    scroller.scrollLeft = 472;
    await settle();

    // Exploring's live centre now sits in the middle-left of the viewport,
    // outside any autoscroll activation zone.
    const target = center(columnZone('Exploring'));
    expect(target.x).toBeGreaterThan(0);
    expect(target.x).toBeLessThan(window.innerWidth / 2);
    await drag(cardEl('card-a'), target.x, target.y);

    expect(a.updateBoardPosition).toHaveBeenCalledTimes(1);
    expect(a.updateBoardPosition).toHaveBeenCalledWith('exploring', expect.any(String));
  });
});

describe('board drag-and-drop — same-column reorder', () => {
  setupDom();

  beforeEach(async () => {
    await page.viewport(1280, 800);
  });

  /** Tight drag: barely past the target's centre — the biased-midpoint bug case. */
  async function tightDrag(from: Element, toX: number, toY: number) {
    const start = center(from);
    from.dispatchEvent(pointer('pointerdown', start.x, start.y));
    await settle();
    document.dispatchEvent(pointer('pointermove', start.x + 10, start.y + 2));
    await settle();
    document.dispatchEvent(pointer('pointermove', toX, toY));
    await settle(6);
    document.dispatchEvent(pointer('pointerup', toX, toY));
    await settle();
  }

  it('dragging the bottom card just above the top card lands above it', async () => {
    const top = makeStore('card-top', { workflowStage: 'spec', boardRank: 'a' });
    const bottom = makeStore('card-bottom', { workflowStage: 'spec', boardRank: 'm' });
    managerTasks.set(top.data.id, top);
    managerTasks.set(bottom.data.id, bottom);
    await mount();

    const topCenter = center(cardEl('card-top'));
    await tightDrag(cardEl('card-bottom'), topCenter.x, topCenter.y - 10);

    expect(bottom.updateBoardPosition).toHaveBeenCalledTimes(1);
    const [, rank] = bottom.updateBoardPosition.mock.calls[0]!;
    expect(rank < 'a').toBe(true); // must land ABOVE card-top
  });

  it('dragging the top card just below the bottom card lands below it', async () => {
    const top = makeStore('card-top', { workflowStage: 'spec', boardRank: 'a' });
    const bottom = makeStore('card-bottom', { workflowStage: 'spec', boardRank: 'm' });
    managerTasks.set(top.data.id, top);
    managerTasks.set(bottom.data.id, bottom);
    await mount();

    const bottomCenter = center(cardEl('card-bottom'));
    await tightDrag(cardEl('card-top'), bottomCenter.x, bottomCenter.y + 10);

    expect(top.updateBoardPosition).toHaveBeenCalledTimes(1);
    const [, rank] = top.updateBoardPosition.mock.calls[0]!;
    expect(rank > 'm').toBe(true); // must land BELOW card-bottom
  });

  it('dragging the first card past the last of three lands at the bottom', async () => {
    const a = makeStore('card-a', { workflowStage: 'spec', boardRank: 'a' });
    const b = makeStore('card-b', { workflowStage: 'spec', boardRank: 'm' });
    const c = makeStore('card-c', { workflowStage: 'spec', boardRank: 'x' });
    for (const s of [a, b, c]) managerTasks.set(s.data.id, s);
    await mount();

    const cCenter = center(cardEl('card-c'));
    await tightDrag(cardEl('card-a'), cCenter.x, cCenter.y + 10);

    expect(a.updateBoardPosition).toHaveBeenCalledTimes(1);
    const [, rank] = a.updateBoardPosition.mock.calls[0]!;
    expect(rank > 'x').toBe(true); // after card-c (arrayMove semantics)
  });

  it('dragging the last card up to the middle lands between the first two', async () => {
    const a = makeStore('card-a', { workflowStage: 'spec', boardRank: 'a' });
    const b = makeStore('card-b', { workflowStage: 'spec', boardRank: 'm' });
    const c = makeStore('card-c', { workflowStage: 'spec', boardRank: 'x' });
    for (const s of [a, b, c]) managerTasks.set(s.data.id, s);
    await mount();

    const bCenter = center(cardEl('card-b'));
    await tightDrag(cardEl('card-c'), bCenter.x, bCenter.y - 10);

    expect(c.updateBoardPosition).toHaveBeenCalledTimes(1);
    const [, rank] = c.updateBoardPosition.mock.calls[0]!;
    expect(rank > 'a').toBe(true); // between card-a…
    expect(rank < 'm').toBe(true); // …and card-b (arrayMove semantics)
  });
});

describe('board drag-and-drop — hitbox: column with a populated neighbour', () => {
  setupDom();

  beforeEach(async () => {
    await page.viewport(2200, 800);
  });

  it('dropping near the top of an empty column whose LEFT neighbour has a card lands in the hovered column', async () => {
    const a = makeStore('card-a');
    const x = makeStore('card-x', { workflowStage: 'idea', boardRank: 'm' });
    managerTasks.set(a.data.id, a);
    managerTasks.set(x.data.id, x);
    await mount();

    // Aim at the top card slot of the (empty) exploring column: same height as
    // the neighbouring card in idea, clearly inside exploring's zone.
    const zone = columnZone('Exploring');
    const zoneRect = zone.getBoundingClientRect();
    const neighbourY = center(cardEl('card-x')).y;
    await drag(cardEl('card-a'), zoneRect.left + zoneRect.width / 2, neighbourY);

    expect(a.updateBoardPosition).toHaveBeenCalledTimes(1);
    expect(a.updateBoardPosition).toHaveBeenCalledWith('exploring', expect.any(String));
  });

  it('dropping near the top of an empty column whose RIGHT neighbour has a card lands in the hovered column', async () => {
    const a = makeStore('card-a');
    const x = makeStore('card-x', { workflowStage: 'spec', boardRank: 'm' });
    managerTasks.set(a.data.id, a);
    managerTasks.set(x.data.id, x);
    await mount();

    const zone = columnZone('Exploring');
    const zoneRect = zone.getBoundingClientRect();
    const neighbourY = center(cardEl('card-x')).y;
    await drag(cardEl('card-a'), zoneRect.left + zoneRect.width / 2, neighbourY);

    expect(a.updateBoardPosition).toHaveBeenCalledTimes(1);
    expect(a.updateBoardPosition).toHaveBeenCalledWith('exploring', expect.any(String));
  });
});

describe('board drag-and-drop — symmetric swap trigger', () => {
  setupDom();

  beforeEach(async () => {
    await page.viewport(1280, 800);
  });

  /**
   * Walks the pointer toward the neighbouring card in 2px steps and returns
   * the offset (relative to that card's centre, negative = before reaching
   * it) at which its displacement transform first kicks in.
   */
  async function findSwapTrigger(direction: 'down' | 'up'): Promise<number> {
    const dragged = direction === 'down' ? 'card-top' : 'card-bottom';
    const other = direction === 'down' ? 'card-bottom' : 'card-top';
    const otherCenter = center(cardEl(other));
    const start = center(cardEl(dragged));
    cardEl(dragged).dispatchEvent(pointer('pointerdown', start.x, start.y));
    await settle();
    document.dispatchEvent(pointer('pointermove', start.x + 10, start.y));
    await settle();
    const dir = direction === 'down' ? 1 : -1;
    let trigger = Number.POSITIVE_INFINITY;
    for (let offset = -40; offset <= 40; offset += 2) {
      document.dispatchEvent(pointer('pointermove', otherCenter.x, otherCenter.y + dir * offset));
      await settle(2);
      const transform = (cardEl(other) as HTMLElement).style.transform;
      if (transform && !transform.includes('translate3d(0px, 0px, 0px)')) {
        trigger = offset;
        break;
      }
    }
    document.dispatchEvent(pointer('pointerup', otherCenter.x, otherCenter.y));
    await settle();
    return trigger;
  }

  it('the make-room animation triggers at the same distance dragging down as dragging up', async () => {
    // Regression: over-card detection used the DragOverlay rect (a preview
    // shorter than the card), biasing the trigger ~12px upward — the swap
    // animated ~24px later dragging down than up, felt as a teleport on drop.
    const mkCards = () => {
      managerTasks.clear();
      managerTasks.set(
        'card-top',
        makeStore('card-top', { workflowStage: 'spec', boardRank: 'a' })
      );
      managerTasks.set(
        'card-bottom',
        makeStore('card-bottom', { workflowStage: 'spec', boardRank: 'm' })
      );
    };

    mkCards();
    await mount();
    const down = await findSwapTrigger('down');

    root.unmount();
    root = createRoot(host);
    mkCards();
    await mount();
    const up = await findSwapTrigger('up');

    expect(Number.isFinite(down)).toBe(true);
    expect(Number.isFinite(up)).toBe(true);
    expect(Math.abs(down - up)).toBeLessThanOrEqual(4);
  });
});

describe('board drag-and-drop — no snap on fast drops', () => {
  setupDom();

  beforeEach(async () => {
    await page.viewport(1280, 800);
  });

  /** Store whose optimistic update re-renders the board, like the real TaskStore. */
  function makeLiveStore(id: string, overrides: Partial<MockStore['data']> = {}) {
    const data = observable({
      id,
      name: id,
      status: 'active',
      type: 'task',
      ...overrides,
    });
    const store = {
      data,
      conversationStats: {},
      updateBoardPosition: vi.fn((stage: string | null, rank: string) => {
        runInAction(() => {
          data.workflowStage = stage ?? undefined;
          data.boardRank = rank;
        });
        return Promise.resolve();
      }),
    };
    return store as unknown as MockStore & { data: typeof data };
  }

  it('dropping fast, mid make-room transition, animates the displaced card instead of snapping', async () => {
    // Regression: on a fast gesture the make-room transition is still
    // mid-flight at drop time; without a forced FLIP the displaced card
    // snapped the remaining distance (~65px in one frame).
    managerTasks.set('card-x', makeLiveStore('card-x', { workflowStage: 'spec', boardRank: 'm' }));
    managerTasks.set('card-a', makeLiveStore('card-a', { workflowStage: 'spec', boardRank: 'x' }));
    await mount();

    // Drag card-a above card-x and release almost immediately (~1 frame
    // after the make-room transition starts).
    const xc = center(cardEl('card-x'));
    const start = center(cardEl('card-a'));
    cardEl('card-a').dispatchEvent(pointer('pointerdown', start.x, start.y));
    await settle();
    document.dispatchEvent(pointer('pointermove', start.x + 10, start.y + 2));
    await settle();
    document.dispatchEvent(pointer('pointermove', xc.x, xc.y - 20));
    await settle(1);

    const samples: number[] = [Math.round(center(cardEl('card-x')).y)];
    document.dispatchEvent(pointer('pointerup', xc.x, xc.y - 20));
    for (let i = 0; i < 30; i++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      samples.push(Math.round(center(cardEl('card-x')).y));
    }

    const jumps = samples.slice(1).map((s, i) => Math.abs(s - samples[i]!));
    const totalMove = Math.abs(samples[samples.length - 1]! - samples[0]!);
    expect(totalMove).toBeGreaterThan(30); // the card did travel to its new slot
    expect(Math.max(...jumps)).toBeLessThan(25); // ...but never teleported
  });
});

describe('board drag-and-drop — cross-column ghost preview', () => {
  setupDom();

  beforeEach(async () => {
    await page.viewport(2200, 800);
  });

  it('renders the dragged card as a ghost inside the hovered foreign column mid-drag', async () => {
    const a = makeStore('card-a');
    const x = makeStore('card-x', { workflowStage: 'spec', boardRank: 'm' });
    managerTasks.set(a.data.id, a);
    managerTasks.set(x.data.id, x);
    await mount();

    const target = center(cardEl('card-x'));
    const start = center(cardEl('card-a'));
    cardEl('card-a').dispatchEvent(pointer('pointerdown', start.x, start.y));
    await settle();
    document.dispatchEvent(pointer('pointermove', start.x + 10, start.y + 2));
    await settle();
    document.dispatchEvent(pointer('pointermove', target.x, target.y - 20));
    await settle(6);

    // Mid-drag: the dragged card's (dimmed) element must live in the Spec
    // column's droppable zone, above card-x — the cross-column ghost.
    const specZone = columnZone('Spec');
    const ghost = cardEl('card-a');
    expect(specZone.contains(ghost)).toBe(true);
    // Each card's own name is its first <span> descendant (ticket #47 added
    // further spans to a card's body — agent state, artifact badge, provider
    // logos — so this reads only the title of each direct card child, not
    // every span in the zone).
    const names = Array.from(specZone.children).map(
      (card) => card.querySelector('span')?.textContent
    );
    expect(names).toEqual(['card-a', 'card-x']);
    // And it left its source column.
    expect(columnZone('Unstaged').contains(ghost)).toBe(false);

    // Releasing on the ghost's own slot persists the previewed position.
    document.dispatchEvent(pointer('pointerup', target.x, target.y - 20));
    await settle();
    expect(a.updateBoardPosition).toHaveBeenCalledTimes(1);
    expect(a.updateBoardPosition).toHaveBeenCalledWith('spec', expect.any(String));
    const [, rank] = a.updateBoardPosition.mock.calls[0]!;
    expect(rank < 'm').toBe(true); // above card-x, where the ghost sat
  });

  it('moves the ghost back when the drag returns to its source column', async () => {
    const a = makeStore('card-a');
    const x = makeStore('card-x', { workflowStage: 'spec', boardRank: 'm' });
    managerTasks.set(a.data.id, a);
    managerTasks.set(x.data.id, x);
    await mount();

    const specTarget = center(cardEl('card-x'));
    const start = center(cardEl('card-a'));
    cardEl('card-a').dispatchEvent(pointer('pointerdown', start.x, start.y));
    await settle();
    document.dispatchEvent(pointer('pointermove', start.x + 10, start.y + 2));
    await settle();
    document.dispatchEvent(pointer('pointermove', specTarget.x, specTarget.y));
    await settle(6);
    expect(columnZone('Spec').contains(cardEl('card-a'))).toBe(true);

    // Wander back home before releasing.
    document.dispatchEvent(pointer('pointermove', start.x, start.y));
    await settle(6);
    expect(columnZone('Unstaged').contains(cardEl('card-a'))).toBe(true);

    document.dispatchEvent(pointer('pointerup', start.x, start.y));
    await settle();
    expect(a.updateBoardPosition).not.toHaveBeenCalled(); // back to square one: no write
  });
});

// ── Collapsible empty columns (ticket #46) ─────────────────────────────────
//
// Collapse is opt-in per column via a header toggle, defaulted to expanded —
// every test above never touches it, so the drag geometry, autoscroll,
// same-column reorder, and cross-column preview behaviour those tests guard
// is provably unaffected by this feature existing at all. These tests cover
// the feature itself: a collapsed empty column is narrower, stays a valid
// pointer AND keyboard drop target, and expands for the duration of a drag
// or focus interaction that reaches it.

describe('board columns — collapsed empty columns (pointer)', () => {
  setupDom();

  beforeEach(async () => {
    await page.viewport(2200, 800);
  });

  it('a collapsed empty column renders narrower than an expanded one', async () => {
    const a = makeStore('card-a');
    const b = makeStore('card-b');
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b);
    await mount();

    const expandedWidth = columnWrapper('Idea').getBoundingClientRect().width;
    expect(expandedWidth).toBeGreaterThan(150);

    columnToggle('Idea').click();
    await settle();

    expect(columnWrapper('Idea').getBoundingClientRect().width).toBeLessThan(100);
  });

  it('never offers the toggle on a column that has cards', async () => {
    const a = makeStore('card-a', { workflowStage: 'spec', boardRank: 'm' });
    managerTasks.set(a.data.id, a);
    await mount();

    expect(columnToggle('Spec')).toBeUndefined();
  });

  it('expands for the duration of a drag hovering it, and still accepts the drop', async () => {
    const a = makeStore('card-a');
    const b = makeStore('card-b');
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b);
    await mount();

    columnToggle('Idea').click();
    await settle();
    expect(columnWrapper('Idea').getBoundingClientRect().width).toBeLessThan(100);

    const target = center(columnZone('Idea'));
    const start = center(cardEl('card-a'));
    cardEl('card-a').dispatchEvent(pointer('pointerdown', start.x, start.y));
    await settle();
    document.dispatchEvent(pointer('pointermove', start.x + 10, start.y + 2));
    await settle();
    document.dispatchEvent(pointer('pointermove', target.x, target.y));
    await settle(6);

    // Still mid-drag: the previously-collapsed column has expanded back to
    // its full width, so aiming the drop stays exactly as easy as any other.
    expect(columnWrapper('Idea').getBoundingClientRect().width).toBeGreaterThan(150);

    document.dispatchEvent(pointer('pointerup', target.x, target.y));
    await settle();

    expect(a.updateBoardPosition).toHaveBeenCalledTimes(1);
    expect(a.updateBoardPosition).toHaveBeenCalledWith('idea', expect.any(String));
  });

  it('collapses back once the drag moves on to another column, while still empty', async () => {
    const a = makeStore('card-a');
    const x = makeStore('card-x', { workflowStage: 'spec', boardRank: 'm' });
    managerTasks.set(a.data.id, a);
    managerTasks.set(x.data.id, x);
    await mount();

    columnToggle('Idea').click();
    await settle();

    const ideaTarget = center(columnZone('Idea'));
    const start = center(cardEl('card-a'));
    cardEl('card-a').dispatchEvent(pointer('pointerdown', start.x, start.y));
    await settle();
    document.dispatchEvent(pointer('pointermove', start.x + 10, start.y + 2));
    await settle();
    document.dispatchEvent(pointer('pointermove', ideaTarget.x, ideaTarget.y));
    await settle(6);
    expect(columnWrapper('Idea').getBoundingClientRect().width).toBeGreaterThan(150);

    // Wander over to Spec (already populated) without dropping.
    const specTarget = center(cardEl('card-x'));
    document.dispatchEvent(pointer('pointermove', specTarget.x, specTarget.y));
    await settle(6);
    expect(columnWrapper('Idea').getBoundingClientRect().width).toBeLessThan(100);

    document.dispatchEvent(pointer('pointerup', specTarget.x, specTarget.y));
    await settle();
  });
});

describe('board drag-and-drop — GitHub-authoritative cards (ticket #48)', () => {
  setupDom();

  beforeEach(async () => {
    await page.viewport(2200, 800);
  });

  it('keeps a GitHub-authoritative card reorderable within its own column', async () => {
    const top = makeStore('card-top', {
      workflowStage: 'spec',
      boardRank: 'a',
      linkedIssues: openSpecLink(),
    });
    const bottom = makeStore('card-bottom', {
      workflowStage: 'spec',
      boardRank: 'm',
      linkedIssues: openSpecLink(),
    });
    managerTasks.set(top.data.id, top);
    managerTasks.set(bottom.data.id, bottom);
    await mount();

    const topCenter = center(cardEl('card-top'));
    await drag(cardEl('card-bottom'), topCenter.x, topCenter.y - 10);

    expect(bottom.updateBoardPosition).toHaveBeenCalledTimes(1);
    const [stage, rank] = bottom.updateBoardPosition.mock.calls[0]!;
    expect(stage).toBe('spec');
    expect(rank < 'a').toBe(true); // still lands above card-top
  });

  it('disables a cross-stage destination the next sync pass would overwrite (Idea)', async () => {
    const a = makeStore('card-a', { workflowStage: 'spec', linkedIssues: openSpecLink() });
    managerTasks.set(a.data.id, a);
    await mount();

    const target = center(columnZone('Idea'));
    await drag(cardEl('card-a'), target.x, target.y);

    expect(a.updateBoardPosition).not.toHaveBeenCalled();
    expect(captureTelemetryMock).toHaveBeenCalledWith(
      'board_move_blocked',
      expect.objectContaining({
        from_stage: 'spec',
        attempted_stage: 'idea',
        governing_fact: 'open-spec',
      })
    );
  });

  it('allows a cross-stage destination the governing fact would not contest (Implementing)', async () => {
    const a = makeStore('card-a', { workflowStage: 'spec', linkedIssues: openSpecLink() });
    managerTasks.set(a.data.id, a);
    await mount();

    const target = center(columnZone('Implementing'));
    await drag(cardEl('card-a'), target.x, target.y);

    expect(a.updateBoardPosition).toHaveBeenCalledTimes(1);
    expect(a.updateBoardPosition).toHaveBeenCalledWith('implementing', expect.any(String));
  });

  it('allows Triage as an escape valve even for a GitHub-authoritative card', async () => {
    const a = makeStore('card-a', { workflowStage: 'spec', linkedIssues: openSpecLink() });
    managerTasks.set(a.data.id, a);
    await mount();

    const target = center(columnZone('Triage'));
    await drag(cardEl('card-a'), target.x, target.y);

    expect(a.updateBoardPosition).toHaveBeenCalledTimes(1);
    expect(a.updateBoardPosition).toHaveBeenCalledWith('triage', expect.any(String));
  });

  it('disables Review for an open-PR-governed card, with no Triage-style escape needed to see the block', async () => {
    const openPr: PullRequest = {
      url: 'https://github.com/acme/repo/pull/77',
      provider: 'github',
      repositoryUrl: 'https://github.com/acme/repo',
      baseRefName: 'main',
      baseRefOid: 'abc',
      headRepositoryUrl: 'https://github.com/acme/repo',
      headRefName: 'task/branch',
      headRefOid: 'def',
      identifier: '#77',
      title: 'Implement the spec',
      // References the Spec issue (#42, from `openSpecLink()`) by number —
      // `getTaskGitWorktreeStore` is mocked to return no branch name in this
      // suite, so the description reference is the only match path available.
      description: 'Closes #42',
      status: 'open',
      isDraft: false,
      additions: null,
      deletions: null,
      changedFiles: null,
      commitCount: null,
      mergeableStatus: null,
      mergeStateStatus: null,
      reviewDecision: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      mergedAt: null,
      author: null,
      labels: [],
      assignees: [],
      checks: [],
    };
    const a = makeStore('card-a', {
      workflowStage: 'review',
      linkedIssues: openSpecLink(),
      prs: [openPr],
    });
    managerTasks.set(a.data.id, a);
    await mount();

    const target = center(columnZone('Shipped'));
    await drag(cardEl('card-a'), target.x, target.y);

    expect(a.updateBoardPosition).not.toHaveBeenCalled();
    expect(captureTelemetryMock).toHaveBeenCalledWith(
      'board_move_blocked',
      expect.objectContaining({
        from_stage: 'review',
        attempted_stage: 'shipped',
        governing_fact: 'open-pr',
      })
    );

    // Triage is still the escape valve even for a PR-governed card.
    captureTelemetryMock.mockClear();
    const triageTarget = center(columnZone('Triage'));
    await drag(cardEl('card-a'), triageTarget.x, triageTarget.y);
    expect(a.updateBoardPosition).toHaveBeenCalledTimes(1);
    expect(a.updateBoardPosition).toHaveBeenCalledWith('triage', expect.any(String));
  });

  it('renders an accessible explanation naming the governing fact while hovering a disabled destination', async () => {
    const a = makeStore('card-a', { workflowStage: 'spec', linkedIssues: openSpecLink() });
    managerTasks.set(a.data.id, a);
    await mount();

    const target = center(columnZone('Idea'));
    const start = center(cardEl('card-a'));
    cardEl('card-a').dispatchEvent(pointer('pointerdown', start.x, start.y));
    await settle();
    document.dispatchEvent(pointer('pointermove', start.x + 10, start.y + 2));
    await settle();
    document.dispatchEvent(pointer('pointermove', target.x, target.y));
    await settle(6);

    const ideaColumn = columnContainer('Idea');
    expect(ideaColumn.getAttribute('aria-disabled')).toBe('true');
    expect(ideaColumn.getAttribute('title')).toContain('Spec');
    expect(ideaColumn.getAttribute('title')).toContain('#42');

    const status = host.querySelector('[data-board-status]');
    expect(status?.textContent).toContain('Spec');
    expect(status?.textContent).toContain('#42');

    // The card never visually enters the disabled column.
    expect(columnZone('Idea').contains(cardEl('card-a'))).toBe(false);

    document.dispatchEvent(pointer('pointerup', target.x, target.y));
    await settle();
    expect(a.updateBoardPosition).not.toHaveBeenCalled();
  });

  it('does not restrict any destination for a task in Exploring whose linked Map issue is closed (false-authority regression, #56)', async () => {
    const a = makeStore('card-a', {
      workflowStage: 'exploring',
      linkedIssues: {
        version: '1',
        map: {
          provider: 'github',
          url: 'https://github.com/acme/repo/issues/11',
          title: 'Map issue',
          identifier: '#11',
          status: 'closed',
        },
      },
    });
    managerTasks.set(a.data.id, a);
    await mount();

    const target = center(columnZone('Idea'));
    await drag(cardEl('card-a'), target.x, target.y);

    expect(a.updateBoardPosition).toHaveBeenCalledTimes(1);
    expect(a.updateBoardPosition).toHaveBeenCalledWith('idea', expect.any(String));
  });
});

// Integration-review regression (tickets #45 x #51): `computeDropRank`'s
// hidden-card collision guard was built for a card an explicit board filter
// hides, but the "true" (unfiltered) per-column set it reads
// (`trueRawByColumn` in board-main-panel.tsx) was originally built from
// `isBoardDisplayable`, which itself already excludes a Shipped-Faded task —
// so a card Shipped Fade hides was invisible to the collision guard too, not
// just to the board. This suite proves the guard now also covers that case.
describe('board drag-and-drop — Shipped Fade rank-collision guard (tickets #45/#51 integration)', () => {
  setupDom();

  beforeEach(async () => {
    await page.viewport(2200, 800);
  });

  it("never lands a drop on a Shipped-Faded card's own rank, even though that card never renders", async () => {
    const fadedMergedAt = new Date(Date.now() - SHIPPED_FADE_WINDOW_MS - 1000).toISOString();
    // Stored order in `shipped`: '4' < '5' (faded, hidden) < '6' < 'z'.
    // `prs: []` on the visible cards mirrors the real `Task` domain type
    // (always an array, never `undefined`) — `isTaskShippedFaded` iterates it
    // unconditionally for any `shipped`-stage card.
    const shipA = makeStore('ship-a', { workflowStage: 'shipped', boardRank: '4', prs: [] });
    const shipHidden = makeStore('ship-hidden', {
      workflowStage: 'shipped',
      boardRank: '5',
      prs: [
        mergedPr({
          url: 'https://github.com/acme/repo/pull/5',
          identifier: '#5',
          mergedAt: fadedMergedAt,
        }),
      ],
    });
    const shipC = makeStore('ship-c', { workflowStage: 'shipped', boardRank: '6', prs: [] });
    const mover = makeStore('ship-mover', { workflowStage: 'shipped', boardRank: 'z', prs: [] });
    for (const s of [shipA, shipHidden, shipC, mover]) managerTasks.set(s.data.id, s);
    await mount();

    // The faded card never renders — the visible Shipped column is
    // [ship-a(4), ship-c(6), ship-mover(z)].
    const hiddenLabel = Array.from(host.querySelectorAll('span')).find(
      (s) => s.textContent === 'ship-hidden'
    );
    expect(hiddenLabel).toBeUndefined();

    // Drag the bottom card up to land between the two visible neighbours —
    // exactly the naive midpoint the hidden card's own rank ('5') occupies.
    const target = center(cardEl('ship-c'));
    await drag(cardEl('ship-mover'), target.x, target.y - 10);

    expect(mover.updateBoardPosition).toHaveBeenCalledTimes(1);
    const [stage, rank] = mover.updateBoardPosition.mock.calls[0]!;
    expect(stage).toBe('shipped');
    expect(rank > '4').toBe(true);
    expect(rank < '6').toBe(true);
    // The regression: without true-order plumbing that also covers Shipped
    // Fade (not just explicit board filters), this would be exactly '5' —
    // the hidden card's own already-in-use Board Rank.
    expect(rank).not.toBe('5');
  });
});

describe('board columns — collapsed empty columns (keyboard focus)', () => {
  setupDom();

  beforeEach(async () => {
    await page.viewport(2200, 800);
  });

  it('expands while focus is inside the collapsed drop zone, and collapses again on blur', async () => {
    const a = makeStore('card-a');
    const b = makeStore('card-b');
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b);
    await mount();

    columnToggle('Idea').click();
    await settle();
    expect(columnWrapper('Idea').getBoundingClientRect().width).toBeLessThan(100);

    const dropZone = columnZone('Idea') as HTMLElement;
    dropZone.focus();
    await settle();
    expect(document.activeElement).toBe(dropZone);
    expect(columnWrapper('Idea').getBoundingClientRect().width).toBeGreaterThan(150);

    dropZone.blur();
    await settle();
    expect(columnWrapper('Idea').getBoundingClientRect().width).toBeLessThan(100);
  });

  it('also expands while the collapse toggle button itself has focus', async () => {
    const a = makeStore('card-a');
    const b = makeStore('card-b');
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b);
    await mount();

    columnToggle('Idea').click();
    await settle();
    expect(columnWrapper('Idea').getBoundingClientRect().width).toBeLessThan(100);

    columnToggle('Idea').focus();
    await settle();
    expect(columnWrapper('Idea').getBoundingClientRect().width).toBeGreaterThan(150);

    columnToggle('Idea').blur();
    await settle();
    expect(columnWrapper('Idea').getBoundingClientRect().width).toBeLessThan(100);
  });
});

// ── Exception groups: Unstaged and Triage (ticket #46) ─────────────────────

describe('board columns — Unstaged and Triage exception groups', () => {
  setupDom();

  beforeEach(async () => {
    await page.viewport(2200, 800);
  });

  it("labels Triage with warning semantics that don't rely on colour alone", async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    const triageGroup = Array.from(host.querySelectorAll('[role="group"]')).find((el) =>
      el.getAttribute('aria-label')?.startsWith('Triage')
    )!;
    expect(triageGroup.getAttribute('aria-label')).toMatch(/warning/i);
    // Paired with a visible icon — never colour alone.
    expect(triageGroup.querySelector('svg')).not.toBeNull();
  });

  it('labels Unstaged as an exception group outside the delivery pipeline', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    const unstagedGroup = Array.from(host.querySelectorAll('[role="group"]')).find((el) =>
      el.getAttribute('aria-label')?.startsWith('Unstaged')
    )!;
    expect(unstagedGroup.getAttribute('aria-label')).toMatch(/exception/i);
  });

  it('visually separates Unstaged and Triage from the pipeline with a divider on each side', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    const row = host.querySelector('.overflow-x-auto')!;
    const children = Array.from(row.children);
    const groups = children.filter((el) => el.getAttribute('role') === 'group');
    const dividers = children.filter((el) => el.getAttribute('aria-hidden') === 'true');

    expect(groups).toHaveLength(8); // every column still renders, none dropped
    expect(dividers).toHaveLength(2); // Unstaged | pipeline, and pipeline | Triage

    // Triage never sits directly beside Shipped: a divider always separates
    // them, so Triage is never read as the stage that follows Shipped.
    const shippedIndex = children.indexOf(columnWrapper('Shipped'));
    const triageIndex = children.indexOf(columnWrapper('Triage'));
    expect(triageIndex).toBe(shippedIndex + 2);
  });
});

// ── Keyboard-driven drag (ticket #52) ──────────────────────────────────────
//
// There is no `KeyboardSensor` anywhere in this repo before this ticket — no
// keyboard-driven drag existed at all. Each card's body keeps selecting on
// Enter/Space exactly as before (ticket #40); its dedicated "Move" handle (a
// sibling `<button>`, never nested inside one) is the sole keyboard-drag
// activator, located here by its accessible name. `onDragOver`/`onDragEnd`
// are unchanged and sensor-agnostic, so every assertion below exercises the
// exact same handlers the pointer-drag suites above already cover — this
// only drives them through a different sensor.

/** A card's "Move" handle (ticket #52), the sole keyboard-drag activator. */
function moveHandleFor(name: string): HTMLButtonElement {
  return host.querySelector(`button[aria-label="Move ${name}"]`) as HTMLButtonElement;
}

function keydown(target: Element | Document, code: string) {
  target.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
}

/** dnd-kit's `KeyboardSensor` schedules its own document-level keydown
 * listener one tick after activation (a `setTimeout(fn, 0)` inside its own
 * `attach()`) — settling a macrotask, not just animation frames, before the
 * first subsequent key avoids a race where that listener isn't attached yet. */
async function afterKeyboardPickup() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await settle();
}

describe('board drag-and-drop — keyboard-driven (ticket #52)', () => {
  setupDom();

  beforeEach(async () => {
    await page.viewport(2200, 800);
  });

  it('picks up a card with its Move handle (Space) and drops it into the adjacent column with the arrow keys', async () => {
    const a = makeStore('card-a');
    const b = makeStore('card-b');
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b);
    await mount();

    const handle = moveHandleFor('card-a');
    handle.focus();
    keydown(handle, 'Space');
    await afterKeyboardPickup();

    // Nudge right, toward Idea, until the cross-column preview shows the
    // card actually inside Idea's zone (mirrors the pointer-drag "ghost
    // preview" assertion above) — robust to however many steps dnd-kit's own
    // coordinate getter takes to get there.
    let enteredIdea = false;
    for (let i = 0; i < 5 && !enteredIdea; i++) {
      keydown(document, 'ArrowRight');
      await settle();
      enteredIdea = columnZone('Idea').contains(cardEl('card-a'));
    }
    expect(enteredIdea).toBe(true);

    keydown(document, 'Space');
    await settle();

    expect(a.updateBoardPosition).toHaveBeenCalledTimes(1);
    expect(a.updateBoardPosition).toHaveBeenCalledWith('idea', expect.any(String));
  });

  it('Escape cancels a keyboard pick-up without persisting anything', async () => {
    const a = makeStore('card-a');
    const b = makeStore('card-b');
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b);
    await mount();

    const handle = moveHandleFor('card-a');
    handle.focus();
    keydown(handle, 'Space');
    await afterKeyboardPickup();

    keydown(document, 'ArrowRight');
    await settle();
    keydown(document, 'Escape');
    await settle();

    expect(a.updateBoardPosition).not.toHaveBeenCalled();
    // The card falls back to its original column once cancelled.
    expect(columnZone('Unstaged').contains(cardEl('card-a'))).toBe(true);
  });

  it('reorders within the same column using the arrow keys (Enter to drop), matching pointer reorder semantics', async () => {
    const top = makeStore('card-top', { workflowStage: 'spec', boardRank: 'a' });
    const bottom = makeStore('card-bottom', { workflowStage: 'spec', boardRank: 'm' });
    managerTasks.set(top.data.id, top);
    managerTasks.set(bottom.data.id, bottom);
    await mount();

    const handle = moveHandleFor('card-bottom');
    handle.focus();
    keydown(handle, 'Enter'); // Enter picks up too (defaultKeyboardCodes.start)
    await afterKeyboardPickup();

    // Nudge up until card-top's own make-room transform shows it has been
    // displaced (the same signal the pointer "symmetric swap trigger" suite
    // above reads) — same-column reordering is a pure CSS-transform preview
    // until drop, so DOM order itself never changes mid-drag; this is the
    // correct mid-drag observable, not sortable-list DOM order.
    let displaced = false;
    for (let i = 0; i < 5 && !displaced; i++) {
      keydown(document, 'ArrowUp');
      await settle(2);
      const transform = (cardEl('card-top') as HTMLElement).style.transform;
      displaced = Boolean(transform) && !transform.includes('translate3d(0px, 0px, 0px)');
    }
    expect(displaced).toBe(true);

    keydown(document, 'Enter'); // Enter drops too (defaultKeyboardCodes.end)
    await settle();

    expect(bottom.updateBoardPosition).toHaveBeenCalledTimes(1);
    const [stage, rank] = bottom.updateBoardPosition.mock.calls[0]!;
    expect(stage).toBe('spec');
    expect(rank < 'a').toBe(true); // lands above card-top
  });

  it("refuses a keyboard-driven drop into a GitHub-authoritative-blocked destination — ticket #48's blocked-destination explanation, now reachable by keyboard", async () => {
    const a = makeStore('card-a', { workflowStage: 'spec', linkedIssues: openSpecLink() });
    managerTasks.set(a.data.id, a);
    await mount();

    const handle = moveHandleFor('card-a');
    handle.focus();
    keydown(handle, 'Space');
    await afterKeyboardPickup();

    // Nudge left, toward Idea (a destination `open-spec` forbids — mirrors
    // the pointer-driven "disables a cross-stage destination" test above),
    // until the column itself reports the blocked state.
    let blocked = false;
    for (let i = 0; i < 5 && !blocked; i++) {
      keydown(document, 'ArrowLeft');
      await settle();
      blocked = columnContainer('Idea').getAttribute('aria-disabled') === 'true';
    }
    expect(blocked).toBe(true);
    // The same accessible explanation a pointer drag renders — reachable by
    // keyboard now, exactly what this ticket owns.
    expect(columnContainer('Idea').getAttribute('title')).toContain('Spec');
    expect(host.querySelector('[data-board-status]')?.textContent).toContain('Spec');

    keydown(document, 'Space');
    await settle();

    expect(a.updateBoardPosition).not.toHaveBeenCalled();
    expect(captureTelemetryMock).toHaveBeenCalledWith(
      'board_move_blocked',
      expect.objectContaining({
        from_stage: 'spec',
        attempted_stage: 'idea',
        governing_fact: 'open-spec',
      })
    );
  });

  it('does not activate a keyboard drag when Enter/Space is pressed on the card body itself — selection keeps that key, unchanged since ticket #40', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    (cardEl('card-a') as HTMLElement).focus();
    keydown(cardEl('card-a'), 'Space');
    await afterKeyboardPickup();
    keydown(document, 'ArrowRight');
    await settle();

    // No keyboard drag ever started from the card body: the card never left
    // Unstaged, and nothing was ever persisted.
    expect(columnZone('Unstaged').contains(cardEl('card-a'))).toBe(true);
    expect(a.updateBoardPosition).not.toHaveBeenCalled();
  });

  it('expands a collapsed empty column so a keyboard drag can actually reach it, and still accepts the drop — the same `isDragHovered` state ticket #46 built for pointer', async () => {
    // Regression test: dnd-kit's own `sortableKeyboardCoordinates` ranks
    // candidate drop targets by corner-to-corner distance to the active
    // card's rect. A collapsed empty column (ticket #46) renders as a very
    // narrow, full-board-height sliver — verified experimentally that this
    // geometry defeats that ranking: arrow-key navigation skipped straight
    // over a *collapsed* Idea into Exploring every time, even though the
    // exact same navigation correctly landed on Idea when it was merely
    // empty but not collapsed (see the cross-column test above). The board
    // now force-expands every collapsible empty column for the duration of
    // a keyboard-activated drag specifically to keep this reachable.
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    columnToggle('Idea').click();
    await settle();
    expect(columnWrapper('Idea').getBoundingClientRect().width).toBeLessThan(100);

    const handle = moveHandleFor('card-a');
    handle.focus();
    keydown(handle, 'Space');
    await afterKeyboardPickup();

    // Expanded immediately: the fix forces every collapsible empty column
    // open for the duration of any keyboard drag, not just once hovered.
    expect(columnWrapper('Idea').getBoundingClientRect().width).toBeGreaterThan(150);

    keydown(document, 'ArrowRight');
    await settle();
    expect(columnZone('Idea').contains(cardEl('card-a'))).toBe(true);

    keydown(document, 'Space');
    await settle();

    expect(a.updateBoardPosition).toHaveBeenCalledTimes(1);
    expect(a.updateBoardPosition).toHaveBeenCalledWith('idea', expect.any(String));
  });

  it('collapses back once a keyboard drag that never entered it ends, matching the pointer-drag contract', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    columnToggle('Idea').click();
    await settle();
    expect(columnWrapper('Idea').getBoundingClientRect().width).toBeLessThan(100);

    const handle = moveHandleFor('card-a');
    handle.focus();
    keydown(handle, 'Space');
    await afterKeyboardPickup();
    expect(columnWrapper('Idea').getBoundingClientRect().width).toBeGreaterThan(150);

    keydown(document, 'Escape');
    await settle();

    expect(a.updateBoardPosition).not.toHaveBeenCalled();
    // Idea is still empty (the drag was cancelled), so it is collapsible
    // again once the keyboard drag that forced it open has ended.
    expect(columnWrapper('Idea').getBoundingClientRect().width).toBeLessThan(100);
  });
});

// ── Focus traversal and semantic labels (ticket #52) ───────────────────────

describe('board — focus traversal between columns, cards and board controls (ticket #52)', () => {
  setupDom();

  beforeEach(async () => {
    await page.viewport(2200, 800);
  });

  it('every interactive board control this ticket touches is a real, independently focusable, accessibly-named target', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    // Column control (ticket #46, unchanged) — collapsible empty column toggle.
    const toggle = columnToggle('Idea')!;
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute('aria-label')).toBe('Collapse Idea column');

    // Card body (ticket #40) — still its own focus stop, still selects on Enter/Space.
    const card = cardEl('card-a') as HTMLElement;
    card.focus();
    expect(document.activeElement).toBe(card);

    // The card's "Move" handle (ticket #52) — a distinct focus stop from the
    // card body itself, never nested inside another button.
    const handle = moveHandleFor('card-a');
    handle.focus();
    expect(document.activeElement).toBe(handle);
    expect(handle.getAttribute('aria-label')).toBe('Move card-a');
    expect(handle.tagName).toBe('BUTTON');

    // The hover-open arrow (ticket #42) — another distinct focus stop.
    const openButton = host.querySelector(`button[aria-label="Open card-a"]`) as HTMLElement;
    openButton.focus();
    expect(document.activeElement).toBe(openButton);
  });

  it("a card's accessible position names its 1-based rank and the column's total, and stays correct after a card is added", async () => {
    const a = makeStore('card-a', { workflowStage: 'spec', boardRank: 'a' });
    const b = makeStore('card-b', { workflowStage: 'spec', boardRank: 'm' });
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b);
    await mount();

    const cardA = cardEl('card-a');
    const cardB = cardEl('card-b');
    expect(cardA.getAttribute('aria-posinset')).toBe('1');
    expect(cardA.getAttribute('aria-setsize')).toBe('2');
    expect(cardB.getAttribute('aria-posinset')).toBe('2');
    expect(cardB.getAttribute('aria-setsize')).toBe('2');
  });

  it("a keyboard drag's screen-reader announcement names the task and the destination Workflow Stage, never a raw id", async () => {
    // `id` deliberately differs from `name` here — only checking the
    // announcement text contains the *name*, not the id, proves this reads
    // the real task rather than dnd-kit's own id-keyed default text.
    const a = makeStore('task-internal-id-7', { name: 'Refactor the diff viewer' });
    managerTasks.set(a.data.id, a);
    await mount();

    const handle = moveHandleFor('Refactor the diff viewer');
    handle.focus();
    keydown(handle, 'Space');
    await afterKeyboardPickup();
    keydown(document, 'ArrowRight');
    await settle();

    // dnd-kit's own built-in drag-announcement live region (distinct from
    // this board's own `data-board-status` region, which uses `aria-live`
    // "polite" rather than the default "assertive").
    const liveRegion = host.querySelector('[aria-live="assertive"]');
    expect(liveRegion?.textContent).toContain('Refactor the diff viewer');
    expect(liveRegion?.textContent).not.toContain('task-internal-id-7');
    expect(liveRegion?.textContent).toContain('Idea');
  });
});
