/**
 * Browser-mode tests for the Task Detail Panel: the shell's gestures
 * (CONTEXT.md, ticket #40 — open, switch, close, highlight, drag-with-panel-
 * open, disappearance) and its content (ticket #41 — vitals, typed links,
 * derived PR, stage authority). Panel *actions* (rename, pin, archive, the
 * hover arrow, "Open task", ghost mode — ticket #42) are out of scope here.
 *
 * Mounts the real BoardMainPanel in Chromium (real layout, real
 * getBoundingClientRect) with mocked stores and genuine PointerEvent/click
 * dispatch, following the pattern established by the board drag-and-drop
 * browser tests (`board-dnd.test.tsx`) — including mocking `@renderer/lib/ipc`
 * directly rather than the generic `electronAPI.invoke` stub, so
 * `tasks.getTaskStageAuthority` can return a distinct fixture per test.
 */
import { observable, runInAction } from 'mobx';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { LinkedIssueRoles } from '@shared/core/linked-issue';
import type { StageHoldingPr, TaskStageAuthority } from '@shared/core/tasks/tasks';

// ── Store mocks (mirrors board-dnd.test.tsx) ───────────────────────────────

type MockStore = {
  data: {
    id: string;
    name: string;
    status: string;
    type: string;
    createdAt?: string;
    workflowStage?: string;
    boardRank?: string;
    archivedAt?: string;
    linkedIssues?: LinkedIssueRoles;
  };
  conversationStats: Record<string, number>;
  updateBoardPosition: ReturnType<typeof vi.fn>;
};

const managerTasks = new Map<string, MockStore>();
/** Branch names by task id, read by the mocked `getTaskGitWorktreeStore` selector. */
const branchByTaskId = new Map<string, string>();

const DECLARATIVE_AUTHORITY: TaskStageAuthority = {
  holdingPr: null,
  isCurrentStageGithubProven: false,
};

// `vi.mock` factories are hoisted above all other top-level statements, so a
// mock a factory below needs to reference must itself be declared through
// `vi.hoisted` — a plain `const` here would still be in its temporal dead
// zone when the factory runs (mirrors the `mocks` pattern in
// board-sync-service.db.test.ts). Overridden per test via
// `.mockResolvedValueOnce` / `.mockImplementation`.
const mocks = vi.hoisted(() => ({
  getTaskStageAuthority: vi.fn(() =>
    Promise.resolve<TaskStageAuthority>({ holdingPr: null, isCurrentStageGithubProven: false })
  ),
}));

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
  getTaskGitWorktreeStore: (_projectId: string, taskId: string) => {
    const branchName = branchByTaskId.get(taskId);
    return branchName ? { branchName } : undefined;
  },
}));

vi.mock('@renderer/features/tasks/stores/task-store', () => ({
  registeredTaskData: (store: MockStore) => store.data,
}));

vi.mock('@renderer/lib/components/agent-status-indicator', () => ({
  AgentStatusIndicator: () => null,
}));

// BoardMainPanel pulls in BoardLinkSuggestions and GhostCards (real rpc calls
// on mount) plus TaskDetailPanel's own `tasks.getTaskStageAuthority` and
// `app.openExternal` calls — stub the whole `rpc` surface directly rather
// than relying on the generic `electronAPI.invoke` stub (board-dnd.test.tsx's
// pattern), so this file can hand back distinct stage-authority fixtures.
vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    issues: {
      getLinkSuggestions: vi.fn(() => Promise.resolve([])),
      getGhostCards: vi.fn(() => Promise.resolve([])),
      syncIssuesNow: vi.fn(() => Promise.resolve()),
    },
    tasks: {
      syncBoardStages: vi.fn(() => Promise.resolve()),
      getTaskStageAuthority: mocks.getTaskStageAuthority,
    },
    app: {
      openExternal: vi.fn(() => Promise.resolve()),
    },
  },
  events: {
    on: vi.fn(() => () => {}),
  },
}));

import { BoardMainPanel } from '@renderer/features/board/board-main-panel';

function makeStore(id: string, overrides: Partial<MockStore['data']> = {}): MockStore {
  return {
    data: {
      id,
      name: id,
      status: 'active',
      type: 'task',
      createdAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    },
    conversationStats: {},
    updateBoardPosition: vi.fn().mockResolvedValue(undefined),
  };
}

/** A store whose `data` is a mobx observable, so mutating it re-renders BoardMainPanel. */
function makeLiveStore(id: string, overrides: Partial<MockStore['data']> = {}) {
  const data = observable({
    id,
    name: id,
    status: 'active',
    type: 'task',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
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
    // `vi.clearAllMocks()` (afterEach, below) clears call history but not a
    // mock's implementation — reset the default here so a prior test's
    // `.mockResolvedValue` override (a persistent one, unlike `...Once`) can
    // never leak into the next test.
    mocks.getTaskStageAuthority.mockImplementation(() => Promise.resolve(DECLARATIVE_AUTHORITY));
  });

  afterEach(() => {
    root.unmount();
    host.remove();
    style.remove();
    managerTasks.clear();
    branchByTaskId.clear();
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

/** The open panel's full text content — used for simple presence/absence assertions. */
function panelText(): string {
  return host.querySelector('h2')?.parentElement?.parentElement?.textContent ?? '';
}

function panelSection(id: string): Element | null {
  return host.querySelector(`[data-panel-section="${id}"]`);
}

function stageSelect(): HTMLSelectElement {
  return host.querySelector('select[aria-label="Workflow stage"]') as HTMLSelectElement;
}

/** Simulates picking `value` from the stage `<select>` — a real DOM `change` event. */
function selectStage(value: string) {
  const select = stageSelect();
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function linkedIssueRoles(): string[] {
  return Array.from(host.querySelectorAll('[data-linked-issue-role]')).map(
    (el) => el.getAttribute('data-linked-issue-role') ?? ''
  );
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

describe('Task Detail Panel — vitals (ticket #41)', () => {
  setupDom();

  it('shows "Not provisioned yet" for a task with no branch yet', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();

    expect(panelText()).toContain('Not provisioned yet');
  });

  it('shows the branch name once the task has been provisioned', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    branchByTaskId.set('card-a', 'task/my-branch');
    await mount();

    click(cardEl('card-a'));
    await settle();

    expect(panelText()).toContain('task/my-branch');
    expect(panelText()).not.toContain('Not provisioned yet');
  });

  it('shows the total session count across providers', async () => {
    const a = makeStore('card-a');
    a.conversationStats = { claude: 2, codex: 1 };
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();

    expect(panelText()).toContain('3 sessions');
  });
});

describe('Task Detail Panel — typed links (ticket #41)', () => {
  setupDom();

  it('lists Origin and Spec, omitting the unset Map role, in Origin-Map-Spec order', async () => {
    const linkedIssues: LinkedIssueRoles = {
      version: '1',
      origin: {
        provider: 'github',
        url: 'https://github.com/acme/repo/issues/1',
        title: 'Origin issue',
        identifier: '#1',
      },
      spec: {
        provider: 'github',
        url: 'https://github.com/acme/repo/issues/3',
        title: 'Spec issue',
        identifier: '#3',
      },
    };
    const a = makeStore('card-a', { linkedIssues });
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();

    expect(linkedIssueRoles()).toEqual(['origin', 'spec']);
    expect(panelText()).toContain('Origin issue');
    expect(panelText()).toContain('Spec issue');
  });

  it('renders no Linked issues section for a purely local task with no links', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();

    expect(panelSection('linked-issues')).toBeNull();
  });
});

describe('Task Detail Panel — Spec-derived PR and stage authority (ticket #41)', () => {
  setupDom();

  it('renders no Pull request section when nothing references the Spec', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();
    await settle();

    expect(panelSection('pull-request')).toBeNull();
  });

  it('shows the Spec-derived PR, disables the stage selector, and names the holding fact', async () => {
    const pr: StageHoldingPr = {
      url: 'https://github.com/acme/repo/pull/9',
      title: 'Ship the feature',
      identifier: '#9',
      status: 'open',
      isDraft: false,
    };
    mocks.getTaskStageAuthority.mockResolvedValueOnce({
      holdingPr: pr,
      isCurrentStageGithubProven: true,
    });
    const a = makeStore('card-a', { workflowStage: 'review' });
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();
    await settle();

    expect(panelSection('pull-request')).not.toBeNull();
    expect(panelText()).toContain('Ship the feature');
    expect(stageSelect().disabled).toBe(true);
    expect(panelText()).toContain('#9');
  });

  it('offers only the declarative stages, and applies a stage change, when the stage is declarative', async () => {
    const a = makeStore('card-a', { workflowStage: 'idea' });
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();
    await settle();

    const select = stageSelect();
    expect(select.disabled).toBe(false);
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      '',
      'idea',
      'implementing',
      'triage',
    ]);

    selectStage('implementing');
    await settle();

    expect(a.updateBoardPosition).toHaveBeenCalledWith('implementing', null);
  });

  // exploring/spec are GitHub-provable stages the PR-only stage-authority RPC
  // doesn't cover; since a task can only reach either through the issue-derived
  // sync pass (never a manual choice — see DECLARATIVE_WORKFLOW_STAGES), the
  // panel must lock the selector using the linked Map/Spec issue itself rather
  // than let a manual write silently and permanently override the stage.
  it('locks the selector and names the linked Spec issue for a task sitting in Spec', async () => {
    const linkedIssues: LinkedIssueRoles = {
      version: '1',
      spec: {
        provider: 'github',
        url: 'https://github.com/acme/repo/issues/42',
        title: 'Spec issue',
        identifier: '#42',
      },
    };
    const a = makeStore('card-a', { workflowStage: 'spec', linkedIssues });
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();
    await settle();

    expect(stageSelect().disabled).toBe(true);
    expect(panelText()).toContain('Spec');
    expect(panelText()).toContain('#42');
  });
});
