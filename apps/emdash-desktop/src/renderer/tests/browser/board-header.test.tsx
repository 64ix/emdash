/**
 * Browser-mode tests for the Feature Board workspace header (ticket #45):
 * project scope, task creation from the header and from eligible columns,
 * search over task names and Linked Issue/Pull Request display identifiers,
 * the Needs Attention filter, compact filters, active-filter chips, and the
 * mutation-seam guarantee that filtering never calls into persistence.
 *
 * Mounts the real BoardMainPanel in Chromium with mocked stores and RPC
 * boundaries, following the pattern established by `board-dnd.test.tsx` and
 * `board-detail-panel.test.tsx` — including asserting task-creation intent
 * against the real `modalStore` singleton rather than mounting the heavy
 * CreateTaskModal itself (mirrors that file's "management actions" suite).
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { modalStore } from '@renderer/lib/modal/modal-store';
import type { LinkedIssueRoles } from '@shared/core/linked-issue';
import type { PullRequest, PullRequestStatus } from '@shared/core/pull-requests/pull-requests';

// ── Store mocks (mirrors board-detail-panel.test.tsx) ──────────────────────

type MockStore = {
  data: {
    id: string;
    name: string;
    status: string;
    type: string;
    workflowStage?: string;
    boardRank?: string;
    archivedAt?: string;
    linkedIssues?: LinkedIssueRoles;
    prs: PullRequest[];
  };
  agentStatus: 'idle' | 'working' | 'awaiting-input' | 'error' | 'completed' | null;
  conversationStats: Record<string, number>;
  updateBoardPosition: ReturnType<typeof vi.fn>;
};

const managerTasks = new Map<string, MockStore>();

const mocks = vi.hoisted(() => ({
  captureTelemetry: vi.fn(),
  // Ticket #52's narrow-window header suite overrides this per test to a
  // deliberately long project name; every other test keeps the short default.
  projectDisplayName: vi.fn(() => 'Acme Project'),
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useParams: () => ({ params: { projectId: 'p1' } }),
  useNavigate: () => ({ navigate: vi.fn() }),
}));

vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectStore: () => ({}),
  projectDisplayName: mocks.projectDisplayName,
}));

vi.mock('@renderer/features/tasks/stores/task-selectors', () => ({
  getTaskManagerStore: () => ({ tasks: managerTasks }),
  taskAgentStatus: (store: MockStore) => store.agentStatus,
  getTaskStore: (_projectId: string, taskId: string) => managerTasks.get(taskId),
  getTaskGitWorktreeStore: () => undefined,
}));

vi.mock('@renderer/features/tasks/stores/task-store', () => ({
  registeredTaskData: (store: MockStore) => store.data,
  // Ticket #47's card now renders `TaskGitDiffStats`, which imports
  // `isRegistered` from this module — the mock still needs to shadow the
  // real export so that import does not resolve to `undefined`.
  isRegistered: () => true,
}));

vi.mock('@renderer/lib/components/agent-status-indicator', () => ({
  AgentStatusIndicator: () => null,
}));

// `StackedAgentLogos` transitively reaches the app-wide store graph via
// `PluginIcon`'s theme lookup (ThemeProvider -> pty -> appState -> ... ->
// `task-manager.ts`/`acp-chat-store.ts`, which import real exports —
// `asProvisioned` among them — this suite's `task-selectors` mock above
// doesn't shadow. Mocked away like `board-dnd.test.tsx` does; this suite has
// no reason to load theming, PTY, or the full store graph.
vi.mock('@renderer/lib/components/stacked-agent-logos', () => ({
  StackedAgentLogos: () => null,
}));

vi.mock('@renderer/utils/telemetryClient', () => ({
  captureTelemetry: mocks.captureTelemetry,
}));

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

function makePr(overrides: Partial<PullRequest> & { status: PullRequestStatus }): PullRequest {
  return {
    url: 'https://github.com/acme/repo/pull/1',
    provider: 'github',
    repositoryUrl: 'https://github.com/acme/repo',
    baseRefName: 'main',
    baseRefOid: 'base',
    headRepositoryUrl: 'https://github.com/acme/repo',
    headRefName: 'feature',
    headRefOid: 'head',
    identifier: '#1',
    title: 'Test PR',
    description: null,
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
    ...overrides,
  };
}

function makeStore(id: string, overrides: Partial<MockStore['data']> = {}): MockStore {
  return {
    data: {
      id,
      name: id,
      status: 'active',
      type: 'task',
      prs: [],
      ...overrides,
    },
    agentStatus: null,
    conversationStats: {},
    updateBoardPosition: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Layout CSS (mirrors board-detail-panel.test.tsx) ────────────────────────

const LAYOUT_CSS = `
  html, body, #board-host { margin: 0; height: 100%; }
  .flex { display: flex; }
  .flex-col { flex-direction: column; }
  .flex-1 { flex: 1 1 0%; min-height: 0; }
  .flex-wrap { flex-wrap: wrap; }
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
  /* Narrow-window header adaptation (ticket #52): real flex geometry for the
     project-name group's shrink/truncate behaviour, so the "New task" primary
     action test below exercises actual layout rather than an unstyled DOM. */
  .items-center { align-items: center; }
  .items-baseline { align-items: baseline; }
  .justify-between { justify-content: space-between; }
  .min-w-0 { min-width: 0; }
  .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

// ── Harness ─────────────────────────────────────────────────────────────────

let host: HTMLDivElement;
let root: Root;
let style: HTMLStyleElement;

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle(frames = 4) {
  for (let i = 0; i < frames; i++) await frame();
}

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
  mocks.captureTelemetry.mockClear();
  // A persistent override (`mockReturnValue`, unlike `...Once`) must never
  // leak into the next test — `vi.clearAllMocks()` isn't called in this file,
  // so this resets the default explicitly (mirrors board-detail-panel.test.tsx's
  // own reset of its persistent per-test overrides).
  mocks.projectDisplayName.mockReturnValue('Acme Project');
  modalStore.closeModal();
});

async function mount() {
  root.render(<BoardMainPanel />);
  await settle();
}

/** A card's root element, located by its task name (a <span>, unique per test); `null` when not rendered. */
function cardEl(name: string): Element | null {
  const span = Array.from(document.querySelectorAll('span')).find((s) => s.textContent === name);
  return span?.parentElement ?? null;
}

function click(el: Element | null) {
  expect(el).not.toBeNull();
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/** Sets a controlled `<input>`'s value through React's synthetic event system.
 * Setting `.value` directly (then dispatching a plain 'input' event) is
 * swallowed by React's value-tracker, which sees no apparent change since the
 * same patched setter updated the tracker too — the native setter bypasses it. */
function typeIntoSearch(value: string) {
  const input = searchInput();
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set;
  nativeSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function newTaskButton(): HTMLElement {
  return Array.from(document.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('New task')
  ) as HTMLElement;
}

function columnCreateButton(stageLabel: string): HTMLElement | null {
  return document.querySelector(`button[aria-label="New task in ${stageLabel}"]`);
}

function searchInput(): HTMLInputElement {
  return document.querySelector(
    'input[aria-label="Search tasks, Linked Issues, and Pull Requests"]'
  ) as HTMLInputElement;
}

function needsAttentionToggle(): HTMLElement {
  return document.querySelector('[aria-label="Filter to tasks needing attention"]') as HTMLElement;
}

function filtersTrigger(): HTMLElement {
  return Array.from(document.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Filters')
  ) as HTMLElement;
}

function filterCheckbox(label: string): HTMLElement | null {
  return document.querySelector(`[aria-label="${label}"]`);
}

/** Active filter chips row's visible text — used for simple presence/absence assertions. */
function activeFiltersText(): string {
  return document.querySelector('[aria-label="Active filters"]')?.textContent ?? '';
}

function clearAllButton(): HTMLElement | null {
  return Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent === 'Clear all'
  ) as HTMLElement | null;
}

function chipRemoveButton(label: string): HTMLElement | null {
  // `label` can contain characters (quotes) invalid inside a CSS attribute
  // selector — match by attribute value directly instead of building a selector string.
  return (
    (Array.from(document.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === `Remove filter: ${label}`
    ) as HTMLElement | undefined) ?? null
  );
}

// ── Header: project scope + task creation ──────────────────────────────────

describe('Board header — project scope and task creation (ticket #45)', () => {
  it('shows the Feature board title and the project name prominently', async () => {
    await mount();
    expect(document.querySelector('h1')?.textContent).toBe('Feature board');
    expect(document.body.textContent).toContain('Acme Project');
  });

  it('the header "New task" button opens the existing Create Task flow with no initial stage', async () => {
    await mount();
    click(newTaskButton());

    expect(modalStore.activeModalId).toBe('taskModal');
    expect(modalStore.activeModalArgs).toMatchObject({ projectId: 'p1' });
    expect(modalStore.activeModalArgs?.initialWorkflowStage).toBeUndefined();
  });

  it('offers a creation action only on Unstaged, Idea, and Implementing columns', async () => {
    await mount();
    expect(columnCreateButton('Unstaged')).not.toBeNull();
    expect(columnCreateButton('Idea')).not.toBeNull();
    expect(columnCreateButton('Implementing')).not.toBeNull();
    expect(columnCreateButton('Exploring')).toBeNull();
    expect(columnCreateButton('Spec')).toBeNull();
    expect(columnCreateButton('Review')).toBeNull();
    expect(columnCreateButton('Shipped')).toBeNull();
    expect(columnCreateButton('Triage')).toBeNull();
  });

  it("creating from the Idea column carries Idea as the new task's initial manual placement", async () => {
    await mount();
    click(columnCreateButton('Idea'));

    expect(modalStore.activeModalId).toBe('taskModal');
    expect(modalStore.activeModalArgs).toMatchObject({
      projectId: 'p1',
      initialWorkflowStage: 'idea',
    });
  });

  it('creating from the Unstaged column carries no Workflow Stage (the Unstaged default)', async () => {
    await mount();
    click(columnCreateButton('Unstaged'));

    expect(modalStore.activeModalArgs).toMatchObject({ projectId: 'p1' });
    expect(modalStore.activeModalArgs?.initialWorkflowStage).toBeUndefined();
  });
});

// ── Narrow-window adaptation (ticket #52) ───────────────────────────────────
//
// The header's project-name group is the one part of the header row without
// `flex-wrap` protection (the search/filter row below it already wraps). A
// real project name has no natural line-break opportunity for the browser to
// wrap on (no spaces or hyphens — a single camelCase/slug token, as many real
// repo and project names are) — at the app's actual minimum supported window
// width (700px — `minWidth` in `src/main/app/window.ts`), an unbreakable long
// name must not force the row wider and push "New task" (the primary action)
// out of the visible viewport.
const UNBREAKABLE_LONG_PROJECT_NAME =
  'SuperLongUnbreakableProjectNameWithNoSpacesOrHyphensForOverflowTesting';

describe('Board header — narrow-window adaptation (ticket #52)', () => {
  it('keeps "New task" within the visible viewport at the app\'s minimum supported width, even with an unbreakable long project name', async () => {
    mocks.projectDisplayName.mockReturnValue(UNBREAKABLE_LONG_PROJECT_NAME);
    await page.viewport(700, 500);
    await mount();

    const button = newTaskButton();
    const rect = button.getBoundingClientRect();
    expect(rect.right).toBeLessThanOrEqual(700);
    expect(rect.width).toBeGreaterThan(0); // genuinely laid out, not collapsed to nothing
  });

  it('still shows the full "Feature board" title text at that width, unaffected by a long project name', async () => {
    mocks.projectDisplayName.mockReturnValue(UNBREAKABLE_LONG_PROJECT_NAME);
    await page.viewport(700, 500);
    await mount();

    expect(document.querySelector('h1')?.textContent).toBe('Feature board');
  });
});

// ── Search ───────────────────────────────────────────────────────────────────

describe('Board header — search (ticket #45)', () => {
  it('matches task names, case-insensitively', async () => {
    managerTasks.set('a', makeStore('a', { name: 'Refactor the diff viewer' }));
    managerTasks.set('b', makeStore('b', { name: 'Unrelated task' }));
    await mount();

    typeIntoSearch('DIFF');
    await settle();

    expect(cardEl('Refactor the diff viewer')).not.toBeNull();
    expect(cardEl('Unrelated task')).toBeNull();
  });

  it("matches a Linked Issue's display identifier", async () => {
    const linkedIssues: LinkedIssueRoles = {
      version: '1',
      spec: {
        provider: 'github',
        url: 'https://github.com/acme/repo/issues/42',
        title: 'Spec issue',
        identifier: '#42',
      },
    };
    managerTasks.set('a', makeStore('a', { name: 'Task with spec link', linkedIssues }));
    managerTasks.set('b', makeStore('b', { name: 'Task without any link' }));
    await mount();

    typeIntoSearch('#42');
    await settle();

    expect(cardEl('Task with spec link')).not.toBeNull();
    expect(cardEl('Task without any link')).toBeNull();
  });

  it("matches a Pull Request's display identifier", async () => {
    managerTasks.set(
      'a',
      makeStore('a', { name: 'Task with PR', prs: [makePr({ status: 'open', identifier: '#99' })] })
    );
    managerTasks.set('b', makeStore('b', { name: 'Task without PR' }));
    await mount();

    typeIntoSearch('#99');
    await settle();

    expect(cardEl('Task with PR')).not.toBeNull();
    expect(cardEl('Task without PR')).toBeNull();
  });

  it('shows a clearable active "Search" chip while a query is set', async () => {
    managerTasks.set('a', makeStore('a', { name: 'Refactor the diff viewer' }));
    await mount();

    expect(activeFiltersText()).toBe('');

    typeIntoSearch('diff');
    await settle();

    expect(activeFiltersText()).toContain('Search: "diff"');
    click(chipRemoveButton('Search: "diff"'));
    await settle();

    expect(activeFiltersText()).toBe('');
    expect(searchInput().value).toBe('');
    expect(cardEl('Refactor the diff viewer')).not.toBeNull();
  });
});

// ── Needs Attention ───────────────────────────────────────────────────────────

describe('Board header — Needs Attention (ticket #45)', () => {
  it('surfaces only Awaiting Input, Error, and Completed tasks when active', async () => {
    managerTasks.set('a', {
      ...makeStore('a', { name: 'Awaiting task' }),
      agentStatus: 'awaiting-input',
    });
    managerTasks.set('b', { ...makeStore('b', { name: 'Working task' }), agentStatus: 'working' });
    managerTasks.set('c', { ...makeStore('c', { name: 'Idle task' }), agentStatus: null });
    await mount();

    expect(cardEl('Awaiting task')).not.toBeNull();
    expect(cardEl('Working task')).not.toBeNull();
    expect(cardEl('Idle task')).not.toBeNull();

    click(needsAttentionToggle());
    await settle();

    expect(cardEl('Awaiting task')).not.toBeNull();
    expect(cardEl('Working task')).toBeNull();
    expect(cardEl('Idle task')).toBeNull();
  });

  it('records board_needs_attention_filtered telemetry with no task content when toggled', async () => {
    await mount();

    click(needsAttentionToggle());
    await settle();
    expect(mocks.captureTelemetry).toHaveBeenCalledWith('board_needs_attention_filtered', {
      active: true,
    });

    click(needsAttentionToggle());
    await settle();
    expect(mocks.captureTelemetry).toHaveBeenCalledWith('board_needs_attention_filtered', {
      active: false,
    });
  });

  it('shows a clearable active "Needs Attention" chip while active', async () => {
    await mount();
    click(needsAttentionToggle());
    await settle();

    expect(activeFiltersText()).toContain('Needs Attention');
    click(chipRemoveButton('Needs Attention'));
    await settle();

    expect(activeFiltersText()).toBe('');
  });
});

// ── Compact filters ──────────────────────────────────────────────────────────

describe('Board header — compact filters (ticket #45)', () => {
  it('a Pull Request state filter narrows to the matching bucket, with a clearable chip', async () => {
    managerTasks.set(
      'a',
      makeStore('a', { name: 'Open PR task', prs: [makePr({ status: 'open' })] })
    );
    managerTasks.set('b', makeStore('b', { name: 'No PR task' }));
    await mount();

    click(filtersTrigger());
    await settle();
    click(filterCheckbox('Open PR'));
    await settle();

    expect(cardEl('Open PR task')).not.toBeNull();
    expect(cardEl('No PR task')).toBeNull();
    expect(activeFiltersText()).toContain('Open PR');

    click(chipRemoveButton('Open PR'));
    await settle();

    expect(cardEl('No PR task')).not.toBeNull();
  });

  it('a Linked Issue presence filter narrows to the matching bucket', async () => {
    const linkedIssues: LinkedIssueRoles = {
      version: '1',
      origin: {
        provider: 'github',
        url: 'https://github.com/acme/repo/issues/1',
        title: 'Origin issue',
        identifier: '#1',
      },
    };
    managerTasks.set('a', makeStore('a', { name: 'Linked task', linkedIssues }));
    managerTasks.set('b', makeStore('b', { name: 'Unlinked task' }));
    await mount();

    click(filtersTrigger());
    await settle();
    click(filterCheckbox('Has Linked Issue'));
    await settle();

    expect(cardEl('Linked task')).not.toBeNull();
    expect(cardEl('Unlinked task')).toBeNull();
  });

  it('a Workflow Stage filter narrows to the selected column(s)', async () => {
    managerTasks.set('a', makeStore('a', { name: 'Idea task', workflowStage: 'idea' }));
    managerTasks.set(
      'b',
      makeStore('b', { name: 'Implementing task', workflowStage: 'implementing' })
    );
    await mount();

    click(filtersTrigger());
    await settle();
    click(filterCheckbox('Idea'));
    await settle();

    expect(cardEl('Idea task')).not.toBeNull();
    expect(cardEl('Implementing task')).toBeNull();
  });

  it('an Agent State filter narrows to the selected state(s)', async () => {
    managerTasks.set('a', { ...makeStore('a', { name: 'Error task' }), agentStatus: 'error' });
    managerTasks.set('b', { ...makeStore('b', { name: 'Working task' }), agentStatus: 'working' });
    await mount();

    click(filtersTrigger());
    await settle();
    click(filterCheckbox('Error'));
    await settle();

    expect(cardEl('Error task')).not.toBeNull();
    expect(cardEl('Working task')).toBeNull();
  });

  it('"Clear all" removes every active filter at once', async () => {
    managerTasks.set('a', makeStore('a', { name: 'Some task' }));
    await mount();

    typeIntoSearch('nomatch');
    await settle();
    click(needsAttentionToggle());
    await settle();
    expect(cardEl('Some task')).toBeNull();

    click(clearAllButton());
    await settle();

    expect(activeFiltersText()).toBe('');
    expect(cardEl('Some task')).not.toBeNull();
  });
});

// ── Mutation seam: filtering never persists anything ────────────────────────

describe('Board header — filtering never mutates persistence (ticket #45)', () => {
  it('never calls updateBoardPosition on any store while searching, toggling Needs Attention, or applying compact filters', async () => {
    const a = {
      ...makeStore('a', { name: 'Card A', workflowStage: 'idea' }),
      agentStatus: 'error' as const,
    };
    const b = makeStore('b', { name: 'Card B', prs: [makePr({ status: 'merged' })] });
    managerTasks.set('a', a);
    managerTasks.set('b', b);
    await mount();

    typeIntoSearch('Card');
    await settle();

    click(needsAttentionToggle());
    await settle();
    click(needsAttentionToggle());
    await settle();

    click(filtersTrigger());
    await settle();
    click(filterCheckbox('Error'));
    await settle();
    click(filterCheckbox('Merged PR'));
    await settle();

    click(clearAllButton());
    await settle();

    expect(a.updateBoardPosition).not.toHaveBeenCalled();
    expect(b.updateBoardPosition).not.toHaveBeenCalled();
  });
});

// ── Drop-rank interpolation with a hidden interior card ─────────────────────
//
// Regression coverage (ticket #45): filtering is applied where `rawByColumn`
// is built (board-main-panel.tsx), so every downstream drag computation only
// ever sees already-filtered cards. An earlier design filtered only at
// render time while drop-position math still read the *unfiltered* column —
// dropping between two visible cards with a hidden card between them would
// have interpolated against the wrong neighbor (or the hidden card's own
// slot). These tests drive a real pointer-drag (mirrors board-dnd.test.tsx's
// harness) to prove the drop rank is computed strictly between the two
// *visible* neighbors' own stored ranks, and that the hidden interior card's
// position is never read from or written to.

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
async function drag(from: Element, toX: number, toY: number, hoverFrames = 6) {
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

describe('Board header — drop-rank interpolation skips a hidden interior card (ticket #45)', () => {
  /** Idle-only Agent State filter: hides only `hideMe` (status 'error'),
   * leaving `keepA`/`keepC`/`dragged` (all idle) visible — unlike a search
   * query, this doesn't also hide the dragged card by its own name. */
  async function hideOnlyHideMe() {
    click(filtersTrigger());
    await settle();
    click(filterCheckbox('Idle'));
    await settle();
  }

  it('interpolates the drop rank strictly between the two visible neighbors, never touching the hidden card between them', async () => {
    // Idea column, unfiltered order: keep-a ('D') < hide-me ('H') < keep-c ('n').
    // Filtering to Idle-only hides only "hide-me" (agentStatus 'error'):
    // keep-a and keep-c become adjacent in the *displayed* list even though a
    // real card sits between their stored ranks.
    const keepA = makeStore('keep-a', { name: 'Keep A', workflowStage: 'idea', boardRank: 'D' });
    const hideMe = {
      ...makeStore('hide-me', { name: 'Hide me', workflowStage: 'idea', boardRank: 'H' }),
      agentStatus: 'error' as const,
    };
    const keepC = makeStore('keep-c', { name: 'Keep C', workflowStage: 'idea', boardRank: 'n' });
    // The dragged card starts in a different column (Unstaged) so the drop is
    // unambiguously a cross-column insert into Idea, not a same-column reorder.
    const dragged = makeStore('dragged', { name: 'Dragged card' });
    managerTasks.set('keep-a', keepA);
    managerTasks.set('hide-me', hideMe);
    managerTasks.set('keep-c', keepC);
    managerTasks.set('dragged', dragged);
    await mount();

    await hideOnlyHideMe();
    expect(cardEl('Hide me')).toBeNull();
    expect(cardEl('Keep A')).not.toBeNull();
    expect(cardEl('Keep C')).not.toBeNull();
    expect(cardEl('Dragged card')).not.toBeNull();

    // Drop just above Keep C's (visible) card — i.e. the only slot between
    // the two now-adjacent visible cards.
    const target = center(cardEl('Keep C')!);
    await drag(cardEl('Dragged card')!, target.x, target.y - 8);

    expect(dragged.updateBoardPosition).toHaveBeenCalledTimes(1);
    // rankBetween('D', 'n') — the two *visible* neighbors' own stored ranks —
    // not anything derived from "hide-me"'s rank ('H') or list position.
    expect(dragged.updateBoardPosition).toHaveBeenCalledWith('idea', 'V');
    // The hidden card is never read from or written to by this drop.
    expect(hideMe.updateBoardPosition).not.toHaveBeenCalled();
    expect(keepA.updateBoardPosition).not.toHaveBeenCalled();
    expect(keepC.updateBoardPosition).not.toHaveBeenCalled();
  });

  it('clearing the filter afterwards reveals the hidden card with its stored rank untouched', async () => {
    const keepA = makeStore('keep-a', { name: 'Keep A', workflowStage: 'idea', boardRank: 'D' });
    const hideMe = {
      ...makeStore('hide-me', { name: 'Hide me', workflowStage: 'idea', boardRank: 'H' }),
      agentStatus: 'error' as const,
    };
    const keepC = makeStore('keep-c', { name: 'Keep C', workflowStage: 'idea', boardRank: 'n' });
    const dragged = makeStore('dragged', { name: 'Dragged card' });
    managerTasks.set('keep-a', keepA);
    managerTasks.set('hide-me', hideMe);
    managerTasks.set('keep-c', keepC);
    managerTasks.set('dragged', dragged);
    await mount();

    await hideOnlyHideMe();
    const target = center(cardEl('Keep C')!);
    await drag(cardEl('Dragged card')!, target.x, target.y - 8);
    expect(dragged.updateBoardPosition).toHaveBeenCalledTimes(1);

    // dnd-kit's PointerSensor installs a document-level, capture-phase click
    // swallower for the duration of any recognized drag (to eat the stray
    // native `click` a real mouse/touch release can produce after a drag) and
    // only detaches it 50ms later via its own internal `setTimeout` — see
    // `PointerSensor.handleStart`/`detach` in `@dnd-kit/core`. A `settle()`
    // (a handful of animation frames) is not reliably longer than that timer,
    // so a click dispatched too soon after `drag()` — on *any* element, not
    // just the dragged card — is silently swallowed before it ever reaches
    // this button's own React handler. Wait past that window before the next
    // click in a test that chains "drag" then "click something" (an ordering
    // `board-dnd.test.tsx` deliberately avoids by never clicking after a drag).
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Only one filter category is active (Agent State: Idle), so the chip
    // row shows its own remove button rather than "Clear all" (which only
    // appears once there is more than one chip) — clear it directly.
    click(chipRemoveButton('Idle'));
    await settle();

    // The hidden card reappears, its own boardRank field never rewritten by
    // the drop above (this test's mock stores never mutate `data.boardRank`
    // on `updateBoardPosition` calls, so its absence here already proves the
    // filter never touched it; this re-asserts it's visible again post-clear).
    expect(cardEl('Hide me')).not.toBeNull();
    expect(hideMe.updateBoardPosition).not.toHaveBeenCalled();
  });

  it('never reproduces the hidden card as a duplicate Board Rank, even when the visible gap is minimal', async () => {
    // Stored ranks '4' < '5' < '6' — an adjacent-digit gap where naive
    // interpolation between only the *visible* neighbours collides exactly:
    // `rankBetween('4', '6') === '5'`, the hidden card's own rank. The 'D'/'H'/'n'
    // case above doesn't exercise this because its gap is wide enough that the
    // midpoint misses 'H' by construction; this one is built so it wouldn't.
    const keepA = makeStore('keep-a', { name: 'Keep A', workflowStage: 'idea', boardRank: '4' });
    const hideMe = {
      ...makeStore('hide-me', { name: 'Hide me', workflowStage: 'idea', boardRank: '5' }),
      agentStatus: 'error' as const,
    };
    const keepC = makeStore('keep-c', { name: 'Keep C', workflowStage: 'idea', boardRank: '6' });
    const dragged = makeStore('dragged', { name: 'Dragged card' });
    managerTasks.set('keep-a', keepA);
    managerTasks.set('hide-me', hideMe);
    managerTasks.set('keep-c', keepC);
    managerTasks.set('dragged', dragged);
    await mount();

    await hideOnlyHideMe();
    expect(cardEl('Hide me')).toBeNull();

    const target = center(cardEl('Keep C')!);
    await drag(cardEl('Dragged card')!, target.x, target.y - 8);

    expect(dragged.updateBoardPosition).toHaveBeenCalledTimes(1);
    const [stage, rank] = dragged.updateBoardPosition.mock.calls[0]!;
    expect(stage).toBe('idea');
    // Strictly between the two visible neighbours' stored ranks...
    expect(rank > '4').toBe(true);
    expect(rank < '6').toBe(true);
    // ...but never equal to the hidden card's own rank sitting between them.
    expect(rank).not.toBe('5');
  });
});
