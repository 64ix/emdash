import { page } from '@vitest/browser/context';
/**
 * Browser-mode tests for the Task Detail Panel shell (CONTEXT.md, ticket #40):
 * open, switch, close, highlight, drag-with-panel-open, and disappearance.
 *
 * Mounts the real BoardMainPanel in Chromium (real layout, real
 * getBoundingClientRect) with mocked stores and genuine PointerEvent/click
 * dispatch, following the pattern established by the board drag-and-drop
 * browser tests (`board-dnd.test.tsx`). Panel *content* (vitals, typed links,
 * derived PR, stage authority — ticket #41) and *actions* (rename, pin,
 * archive, the hover arrow, "Open task", ghost mode — ticket #42) are out of
 * scope here; only the shell's gestures are exercised.
 */
import { observable, runInAction } from 'mobx';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Store mocks (mirrors board-dnd.test.tsx) ───────────────────────────────

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
  getTaskStore: (_projectId: string, taskId: string) => managerTasks.get(taskId),
}));

vi.mock('@renderer/features/tasks/stores/task-store', () => ({
  registeredTaskData: (store: MockStore) => store.data,
}));

vi.mock('@renderer/lib/components/agent-status-indicator', () => ({
  AgentStatusIndicator: () => null,
}));

// BoardMainPanel (via TaskDetailPanel) transitively imports `rpc` from
// `@renderer/lib/ipc`, which reads `window.electronAPI` at module-eval time —
// present in the real Electron renderer, absent in this plain-Chromium
// browser-mode test. Stub it before dynamically importing BoardMainPanel: a
// static import would already have evaluated ipc.ts before any in-file
// statement could stub it.
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

/** A store whose `data` is a mobx observable, so mutating it re-renders BoardMainPanel. */
function makeLiveStore(id: string, overrides: Partial<MockStore['data']> = {}) {
  const data = observable({ id, name: id, status: 'active', type: 'task', ...overrides });
  return {
    data,
    conversationStats: {},
    updateBoardPosition: vi.fn().mockResolvedValue(undefined),
  } as unknown as MockStore & { data: typeof data };
}

// ── Layout CSS: same subset the board's geometry depends on (board-dnd.test.tsx) ──

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
  .min-h-0 { min-height: 0; }
`;

// ── Pointer-drag driver (mirrors board-dnd.test.tsx) ───────────────────────

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

/** Press on `from`, walk to the target in steps, hover a beat, release — a genuine drag. */
async function drag(from: Element, toX: number, toY: number, hoverFrames = 4) {
  const start = center(from);
  from.dispatchEvent(pointer('pointerdown', start.x, start.y));
  await settle();
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

/** A stationary click (no movement) — the gesture that opens/switches the panel. */
function click(el: Element) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

// ── Harness ─────────────────────────────────────────────────────────────────

let host: HTMLDivElement;
let root: Root;
let style: HTMLStyleElement;

function setupDom() {
  beforeEach(async () => {
    style = document.createElement('style');
    style.textContent = LAYOUT_CSS;
    document.head.appendChild(style);
    host = document.createElement('div');
    host.id = 'board-host';
    document.body.appendChild(host);
    root = createRoot(host);
    await page.viewport(1280, 800);
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

/** A card's sortable wrapper div, located by its name (a <span>, not a button —
 * the whole card is the click target since ticket #40). */
function cardEl(name: string): Element {
  const label = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === name)!;
  return label.parentElement!;
}

/** The open Task Detail Panel's heading text, or `null` when the panel is closed. */
function panelHeading(): string | null {
  return host.querySelector('h2')?.textContent ?? null;
}

function closeButton(): HTMLElement {
  return Array.from(host.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === 'Close task details'
  ) as HTMLElement;
}

describe('Task Detail Panel — open, switch, close', () => {
  setupDom();

  it('clicking a card opens the panel showing that task, with the board still visible', async () => {
    const a = makeStore('card-a');
    const b = makeStore('card-b');
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b);
    await mount();

    expect(panelHeading()).toBeNull();
    click(cardEl('card-a'));
    await settle();

    expect(panelHeading()).toBe('card-a');
    // The board (its horizontal scroller and the other card) stays visible.
    expect(host.querySelector('.overflow-x-auto')).not.toBeNull();
    expect(cardEl('card-b')).not.toBeUndefined();
  });

  it('clicking a different card switches the panel content', async () => {
    const a = makeStore('card-a');
    const b = makeStore('card-b');
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b);
    await mount();

    click(cardEl('card-a'));
    await settle();
    expect(panelHeading()).toBe('card-a');

    click(cardEl('card-b'));
    await settle();
    expect(panelHeading()).toBe('card-b');
  });

  it('re-clicking the shown card leaves it open and unchanged (no toggle)', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();
    expect(panelHeading()).toBe('card-a');

    click(cardEl('card-a'));
    await settle();
    expect(panelHeading()).toBe('card-a'); // still open, not closed
  });

  it('Escape closes the panel', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();
    expect(panelHeading()).toBe('card-a');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(panelHeading()).toBeNull();
  });

  it('the close (✕) button closes the panel', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();
    expect(panelHeading()).toBe('card-a');

    click(closeButton());
    await settle();
    expect(panelHeading()).toBeNull();
  });
});

describe('Task Detail Panel — card highlight', () => {
  setupDom();

  it('highlights the card backing the open panel, and only that card', async () => {
    const a = makeStore('card-a');
    const b = makeStore('card-b');
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b);
    await mount();

    click(cardEl('card-a'));
    await settle();

    expect((cardEl('card-a') as HTMLElement).className).toContain('border-primary');
    expect((cardEl('card-b') as HTMLElement).className).not.toContain('border-primary');
  });
});

describe('Task Detail Panel — drag-and-drop with the panel open', () => {
  setupDom();

  beforeEach(async () => {
    // Wide enough that every column is visible and nothing scrolls.
    await page.viewport(2200, 800);
  });

  it('dragging a card still moves it, and the drag itself does not change the open selection', async () => {
    const a = makeStore('card-a');
    const b = makeStore('card-b');
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b);
    await mount();

    // Open the panel on card-b, then drag the *other* card, card-a.
    click(cardEl('card-b'));
    await settle();
    expect(panelHeading()).toBe('card-b');

    const target = center(columnZone('Spec'));
    await drag(cardEl('card-a'), target.x, target.y);

    expect(a.updateBoardPosition).toHaveBeenCalledTimes(1);
    expect(a.updateBoardPosition).toHaveBeenCalledWith('spec', expect.any(String));
    // The drag must not have fired a click-select on the dragged card: a
    // genuine drag exceeds the activation constraint, and dnd-kit suppresses
    // the trailing click — the panel keeps showing what was open before.
    expect(panelHeading()).toBe('card-b');
  });
});

describe('Task Detail Panel — disappearance', () => {
  setupDom();

  it('closes the panel when the shown task is archived elsewhere', async () => {
    const a = makeLiveStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();
    expect(panelHeading()).toBe('card-a');

    runInAction(() => {
      a.data.archivedAt = '2026-01-01T00:00:00.000Z';
    });
    await settle();

    expect(panelHeading()).toBeNull();
  });
});

describe('Task Detail Panel — leaving and returning to the board', () => {
  setupDom();

  it('reopening the board (a fresh mount) starts with the panel closed', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();
    expect(panelHeading()).toBe('card-a');

    // Simulate leaving and returning to the board view: the ephemeral panel
    // state is local to BoardMainPanel, so a fresh mount starts clean —
    // unlike managerTasks (the task manager itself, which outlives navigation).
    root.unmount();
    root = createRoot(host);
    await mount();

    expect(panelHeading()).toBeNull();
  });
});
