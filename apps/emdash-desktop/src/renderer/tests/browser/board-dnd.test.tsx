import { page } from '@vitest/browser/context';
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
  };
  conversationStats: Record<string, number>;
  updateBoardPosition: ReturnType<typeof vi.fn>;
};

const managerTasks = new Map<string, MockStore>();

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
  // the panel never opens) — the mock still needs to shadow the real export.
  getTaskStore: (_projectId: string, taskId: string) => managerTasks.get(taskId),
}));

vi.mock('@renderer/features/tasks/stores/task-store', () => ({
  registeredTaskData: (store: MockStore) => store.data,
}));

vi.mock('@renderer/lib/components/agent-status-indicator', () => ({
  AgentStatusIndicator: () => null,
}));

// BoardMainPanel transitively imports `rpc` from `@renderer/lib/ipc`, which
// reads `window.electronAPI` at module-eval time — present in the real
// Electron renderer, absent in this plain-Chromium browser-mode test. Stub it
// before dynamically importing BoardMainPanel: a static import would already
// have evaluated ipc.ts before any in-file statement could stub it.
vi.stubGlobal('electronAPI', {
  invoke: vi.fn(() => Promise.resolve([])),
  eventSend: vi.fn(),
  eventOn: () => () => {},
});
const { BoardMainPanel } = await import('@renderer/features/board/board-main-panel');

function makeStore(id: string, overrides: Partial<MockStore['data']> = {}): MockStore {
  return {
    data: { id, name: id, status: 'active', type: 'task', ...overrides },
    conversationStats: {},
    updateBoardPosition: vi.fn().mockResolvedValue(undefined),
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

/** The column list container (droppable zone) for a given column label. */
function columnZone(label: string): Element {
  const header = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === label)!;
  const column = header.parentElement!.parentElement!;
  return column.lastElementChild!;
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
    const names = Array.from(specZone.querySelectorAll('span')).map((b) => b.textContent);
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
