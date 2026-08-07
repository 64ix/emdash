import type { Result } from '@emdash/shared';
/**
 * Browser-mode tests for the Task Detail Panel: the shell's gestures
 * (CONTEXT.md, ticket #40 — open, switch, close, highlight, drag-with-panel-
 * open, disappearance), its content (ticket #41 — vitals, typed links,
 * derived PR, stage authority; ticket #100 — the dedicated "Pull request"
 * section with its assign/unassign controls), and its actions (ticket #42 —
 * the hover arrow, the "Open task" button, and the ghost adopt-then-switch
 * path). Rename/pin/archive reuse pre-existing RPCs already covered where they
 * live, so this file does not re-test them (ticket #42's own criterion).
 *
 * Mounts the real BoardMainPanel in Chromium (real layout, real
 * getBoundingClientRect) with mocked stores and genuine PointerEvent/click
 * dispatch, following the pattern established by the board drag-and-drop
 * browser tests (`board-dnd.test.tsx`) — including mocking `@renderer/lib/ipc`
 * directly rather than the generic `electronAPI.invoke` stub, so
 * `tasks.getTaskStageAuthority` can return a distinct fixture per test.
 *
 * Ticket #100's "Pull request" section renders the real `PrSelector` (the
 * same picker the create-task flow uses), so the harness mounts a
 * `QueryClientProvider` and stubs `rpc.pullRequests` the way the picker's own
 * test file does.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable, runInAction } from 'mobx';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { modalStore } from '@renderer/lib/modal/modal-store';
import type { GhostCard } from '@shared/core/issues/ghost-card';
import type { LinkedIssueRoles } from '@shared/core/linked-issue';
import { SHIPPED_FADE_WINDOW_MS } from '@shared/core/pull-requests/pr-workflow-derivation';
import type { PullRequest } from '@shared/core/pull-requests/pull-requests';
import type {
  CreateTaskError,
  CreateTaskSuccess,
  Task,
  TaskStageAuthority,
} from '@shared/core/tasks/tasks';

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
    isPinned?: boolean;
    linkedIssues?: LinkedIssueRoles;
    // Ticket #49: threads a task's own provisioned-workspace presence
    // through to the stage explanation (`hasWorkspace`), same as
    // `board-main-panel.tsx`'s own `authorityForTask` already does for drag.
    workspaceId?: string;
    // Ticket #49: `TaskGitDiffStats` (the panel's working-tree-changes row)
    // falls back to this cached snapshot for a task with no live
    // `GitWorktreeStore` mounted — same shape `board-card-hierarchy.test.tsx`
    // already exercises for the card.
    workspaceGit?: { linesAdded: number; linesDeleted: number };
    // Ticket #50: `board-filters.ts`'s `matchesSearchQuery` reads this
    // unconditionally (unlike `authorityForTask`'s defensive `task.prs ??
    // []`) — defaulted to `[]` by `makeStore`/`makeLiveStore` below so the
    // focused-task navigation suite's search-filter interaction never trips
    // it for a mock task that otherwise has no reason to carry any PRs.
    prs?: PullRequest[];
    // Ticket #100: the task's Assigned PR (CONTEXT.md "Assigned PR") — the
    // panel's PR section derives through `resolveTaskPr`, so this field
    // drives the "assigned wins" behavior.
    assignedPr?: PullRequest;
  };
  conversationStats: Record<string, number>;
  updateBoardPosition: ReturnType<typeof vi.fn>;
  setPinned: ReturnType<typeof vi.fn>;
  // Ticket #100: the panel's assign/unassign control delegates here; the
  // store method itself (optimistic update + `tasks.setTaskAssignedPr` RPC,
  // rollback on failure) is covered by task-store.test.ts.
  setAssignedPr: ReturnType<typeof vi.fn>;
  // `openTaskView`'s own provision-then-navigate check
  // (`board-main-panel.tsx`): `state === 'unprovisioned' && phase === 'idle'`.
  // Defaulted to `'provisioned'`/`null` by `makeStore` below — most tests
  // exercise an already-provisioned task; the "never-provisioned" round trip
  // sets these explicitly.
  state?: 'unregistered' | 'unprovisioned' | 'provisioned';
  phase?: string | null;
};

const managerTasks = new Map<string, MockStore>();
/** Branch names by task id, read by the mocked `getTaskGitWorktreeStore` selector. */
const branchByTaskId = new Map<string, string>();

// ── Conversations section fixtures (ticket #68) ────────────────────────────

type MockConversation = {
  data: {
    id: string;
    providerId: string;
    title: string;
    type?: 'acp' | 'pty';
    lastInteractedAt: string | null;
  };
  indicatorStatus: string | null;
};

function makeConversation(
  overrides: Partial<MockConversation['data']> = {},
  indicatorStatus: string | null = null
): MockConversation {
  return {
    data: {
      id: 'conv-1',
      providerId: 'claude',
      title: 'claude (1)',
      type: 'acp',
      lastInteractedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    },
    indicatorStatus,
  };
}

type MockConversationManager = {
  // A real MobX observable map — plain-Map mutations wouldn't be seen by the
  // panel's `observer`-wrapped components, so "created/deleted while open"
  // tests below would never re-render (see `board-focused-navigation-round-
  // trip.test.tsx`'s `makeLiveStore` for the same reasoning applied to a task).
  conversations: ReturnType<typeof observable.map<string, MockConversation>>;
  renameConversation: ReturnType<typeof vi.fn>;
  deleteConversation: ReturnType<typeof vi.fn>;
};

function makeConversationManager(conversations: MockConversation[] = []): MockConversationManager {
  return {
    conversations: observable.map(conversations.map((c) => [c.data.id, c])),
    renameConversation: vi.fn().mockResolvedValue(undefined),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
  };
}

/** Conversation managers by task id, read by the mocked `getConversationsForTask` selector. */
const conversationManagersByTaskId = new Map<string, MockConversationManager>();

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
//
// `navigate` (ticket #42) is shared across every `useNavigate()` call site
// (BoardCard's hover arrow, BoardMainPanel's own handler, the panel's "Open
// task" button) so a single stable mock can assert on whichever call fires.
const mocks = vi.hoisted(() => ({
  getTaskStageAuthority: vi.fn(() =>
    Promise.resolve<TaskStageAuthority>({ holdingPr: null, isCurrentStageGithubProven: false })
  ),
  navigate: vi.fn(),
  provisionTask: vi.fn(() => Promise.resolve()),
  archiveTask: vi.fn(() => Promise.resolve()),
  getGhostCards: vi.fn(() => Promise.resolve<GhostCard[]>([])),
  adoptGhostCard:
    vi.fn<
      (
        projectId: string,
        ghostCard: GhostCard
      ) => Promise<Result<CreateTaskSuccess, CreateTaskError>>
    >(),
  rejectGhostCard: vi.fn(() => Promise.resolve()),
  // Ticket #49: `board_inspector_opened` telemetry — stubbed directly
  // (mirrors `board-dnd.test.tsx`'s `board_move_blocked` stub) rather than
  // exercising the real RPC/session-id round trip these tests have no
  // reason to cover.
  captureTelemetry: vi.fn(),
  // Ticket #50: the task titlebar's Workflow Stage chip carries this back to
  // the board via `useParams('board')`. A mutable field (not a fixed
  // literal) so individual tests can drive it, mirroring how
  // `sidebar-project-row.test.tsx` makes its own mocked params configurable.
  focusTaskId: undefined as string | undefined,
  // Ticket #100: the project's PR-capable repository URL, read by the
  // panel's mocked `getGitRepositoryStore` selector to feed the assign
  // picker. `''` by default (project not mounted) so the picker's queries
  // stay disabled outside the picker tests.
  pullRequestRepositoryUrl: '' as string,
  // Ticket #100: the project's synced PRs served to the picker's
  // `listPullRequests` query, and the sync RPC result.
  listPullRequests: vi.fn(() =>
    Promise.resolve({ success: true, data: { prs: [] as PullRequest[] } })
  ),
  syncPullRequests: vi.fn(() => Promise.resolve({ success: true })),
  setTaskAssignedPr: vi.fn((_taskId: string, _prUrl: string | null) => Promise.resolve()),
  openExternal: vi.fn(() => Promise.resolve()),
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useParams: () => ({ params: { projectId: 'p1', focusTaskId: mocks.focusTaskId } }),
  useNavigate: () => ({ navigate: mocks.navigate }),
}));

vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectStore: () => ({}),
  projectDisplayName: () => 'Test project',
  // Ticket #100: the panel's assign picker reads the project's PR-capable
  // repository URL through this selector; `''` disables its queries.
  getGitRepositoryStore: () => ({ pullRequestRepositoryUrl: mocks.pullRequestRepositoryUrl }),
}));

vi.mock('@renderer/features/tasks/stores/task-selectors', () => ({
  getTaskManagerStore: () => ({
    tasks: managerTasks,
    provisionTask: mocks.provisionTask,
    archiveTask: mocks.archiveTask,
  }),
  taskAgentStatus: () => 'idle',
  getTaskStore: (_projectId: string, taskId: string) => managerTasks.get(taskId),
  getTaskGitWorktreeStore: (_projectId: string, taskId: string) => {
    const branchName = branchByTaskId.get(taskId);
    return branchName ? { branchName } : undefined;
  },
  // Ticket #68's Conversations section reads this to build its rows — the
  // same per-task conversation manager registry `taskAgentStatus` already
  // reads through in the real app.
  getConversationsForTask: (taskId: string) => conversationManagersByTaskId.get(taskId),
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

// `StackedAgentLogos` (ticket #47's card, provider/session context) reads
// agent metadata through `@tanstack/react-query` and, via `PluginIcon`'s
// theme lookup, transitively reaches the app-wide store graph
// (`ThemeProvider` -> pty -> `appState` -> `ProjectManagerStore` -> ... ->
// `open-file-in-file-editor.ts`) — none of it relevant to these tests, and
// each hop needs its own real (unmocked) module. Mocked away wholesale, the
// same way `AgentStatusIndicator` already is above.
vi.mock('@renderer/lib/components/stacked-agent-logos', () => ({
  StackedAgentLogos: () => null,
}));

// `ConversationAgentIcon` (ticket #68's Conversations section rows) reaches
// the same heavy theme/store chain `StackedAgentLogos` above is mocked away
// for — rendered here as a queryable marker (rather than `null`, like
// `board-card-hierarchy.test.tsx`'s own `StackedAgentLogos` mock) so the
// row-rendering tests below can assert the panel actually asked it to show
// the right provider and transport.
vi.mock('@renderer/features/conversations/conversation-agent-icon', () => ({
  ConversationAgentIcon: ({ providerId, isAcp }: { providerId: string; isAcp: boolean }) => (
    <span data-mock="conversation-icon" data-provider-id={providerId} data-is-acp={String(isAcp)} />
  ),
}));

// Ticket #49: `board_inspector_opened` — stub the whole client the same way
// `board-dnd.test.tsx` stubs it for `board_move_blocked`.
vi.mock('@renderer/utils/telemetryClient', () => ({
  captureTelemetry: (...args: unknown[]) => mocks.captureTelemetry(...args),
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
      getGhostCards: mocks.getGhostCards,
      adoptGhostCard: mocks.adoptGhostCard,
      rejectGhostCard: mocks.rejectGhostCard,
      syncIssuesNow: vi.fn(() => Promise.resolve()),
    },
    tasks: {
      syncBoardStages: vi.fn(() => Promise.resolve()),
      getTaskStageAuthority: mocks.getTaskStageAuthority,
      // Ticket #100: the panel's assign/unassign persistence RPC.
      setTaskAssignedPr: mocks.setTaskAssignedPr,
    },
    pullRequests: {
      // Ticket #100: the assign picker (`PrSelector`) lists and syncs the
      // project's PRs through these — same surface its own tests stub.
      listPullRequests: mocks.listPullRequests,
      syncPullRequests: mocks.syncPullRequests,
      getPullRequestsForTask: vi.fn(() => Promise.resolve({ success: true, data: { prs: [] } })),
    },
    app: {
      openExternal: mocks.openExternal,
    },
  },
  events: {
    on: vi.fn(() => () => {}),
  },
}));

import { BoardMainPanel } from '@renderer/features/board/board-main-panel';

// Ticket #100: shared query client for the assign picker's react-query hooks
// (`retry: false` so a stubbed-down RPC error never spins a retry loop).
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function makeStore(
  id: string,
  overrides: Partial<MockStore['data']> = {},
  storeOverrides: Pick<MockStore, 'state' | 'phase'> = { state: 'provisioned', phase: null }
): MockStore {
  return {
    data: {
      id,
      name: id,
      status: 'active',
      type: 'task',
      createdAt: '2026-01-01T00:00:00.000Z',
      prs: [],
      ...overrides,
    },
    conversationStats: {},
    updateBoardPosition: vi.fn().mockResolvedValue(undefined),
    setPinned: vi.fn().mockResolvedValue(undefined),
    setAssignedPr: vi.fn().mockResolvedValue(undefined),
    ...storeOverrides,
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
    prs: [] as PullRequest[],
    ...overrides,
  });
  return {
    data,
    conversationStats: {},
    updateBoardPosition: vi.fn().mockResolvedValue(undefined),
    setAssignedPr: vi.fn().mockResolvedValue(undefined),
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
    // mock's implementation — reset the defaults here so a prior test's
    // `.mockResolvedValue` override (a persistent one, unlike `...Once`) can
    // never leak into the next test.
    mocks.getTaskStageAuthority.mockImplementation(() => Promise.resolve(DECLARATIVE_AUTHORITY));
    mocks.provisionTask.mockImplementation(() => Promise.resolve());
    mocks.archiveTask.mockImplementation(() => Promise.resolve());
    mocks.getGhostCards.mockImplementation(() => Promise.resolve([]));
    mocks.adoptGhostCard.mockReset();
    mocks.rejectGhostCard.mockImplementation(() => Promise.resolve());
    mocks.focusTaskId = undefined;
    mocks.pullRequestRepositoryUrl = '';
    mocks.listPullRequests.mockImplementation(() =>
      Promise.resolve({ success: true, data: { prs: [] as PullRequest[] } })
    );
    mocks.syncPullRequests.mockImplementation(() => Promise.resolve({ success: true }));
    mocks.setTaskAssignedPr.mockImplementation(() => Promise.resolve());
    mocks.openExternal.mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    root.unmount();
    host.remove();
    style.remove();
    managerTasks.clear();
    branchByTaskId.clear();
    conversationManagersByTaskId.clear();
    vi.clearAllMocks();
    mocks.focusTaskId = undefined;
    mocks.pullRequestRepositoryUrl = '';
    queryClient.clear();
  });
}

async function mount() {
  // Ticket #100: the panel's assign picker (`PrSelector`) runs its PR list
  // through @tanstack/react-query, so the harness provides a client — the
  // same wrapper the picker's own test file uses.
  root.render(
    <QueryClientProvider client={queryClient}>
      <BoardMainPanel />
    </QueryClientProvider>
  );
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

/** The collapse/expand toggle button for a given (empty-only) column label
 * (ticket #46, mirrors `board-dnd.test.tsx`'s `columnToggle`). */
function columnToggle(label: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll('button')).find((button) =>
    button.getAttribute('aria-label')?.endsWith(`${label} column`)
  ) as HTMLButtonElement | undefined;
}

/** Card name spans (`line-clamp-2`, ticket #47), in DOM order, for a column —
 * used to assert Board Rank/ordering is untouched by opening/closing the panel. */
function cardNamesInColumn(label: string): string[] {
  return Array.from(columnZone(label).querySelectorAll('span.line-clamp-2')).map(
    (el) => el.textContent ?? ''
  );
}

/** The open panel's full text content — used for simple presence/absence assertions. */
function panelText(): string {
  return host.querySelector('h2')?.parentElement?.parentElement?.textContent ?? '';
}

function panelSection(id: string): Element | null {
  return host.querySelector(`[data-panel-section="${id}"]`);
}

/** A Conversations section row (ticket #68), by conversation id. */
function conversationRow(conversationId: string): HTMLElement {
  return host.querySelector(`[data-conversation-row="${conversationId}"]`) as HTMLElement;
}

/** Every rendered Conversations section row, in DOM order. */
function conversationRowIds(): string[] {
  return Array.from(host.querySelectorAll('[data-conversation-row]')).map(
    (el) => el.getAttribute('data-conversation-row') ?? ''
  );
}

/** A row's own management-action icon button (ticket #68), scoped to that
 * row so same-named buttons on other rows never collide. */
function conversationRowActionButton(
  conversationId: string,
  label: 'Rename conversation' | 'Delete conversation' | 'Export transcript'
): HTMLElement {
  const row = conversationRow(conversationId).parentElement as HTMLElement;
  return row.querySelector(`button[aria-label="${label}"]`) as HTMLElement;
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

/** The task's PR row within the dedicated "Pull request" section (ticket
 * #100), or `null` when the section isn't rendered. */
function taskPrRow(): Element | null {
  return host.querySelector('[data-task-pr-row]');
}

/** The section's assign picker trigger button (the reused `PrSelector`). */
function assignPrPickerTrigger(): HTMLElement | null {
  return host.querySelector(
    '[data-panel-section="pull-request"] button[data-slot="combobox-trigger"]'
  );
}

/** A card's hover-revealed direct-navigation arrow (ticket #42). */
function hoverArrowFor(taskName: string): HTMLElement {
  return host.querySelector(`button[aria-label="Open ${taskName}"]`) as HTMLElement;
}

/** The panel's "Open task" button (ticket #42). */
function openTaskButton(): HTMLElement {
  return Array.from(host.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Open task')
  ) as HTMLElement;
}

/** The panel's Rename/Pin/Unpin/Archive header buttons (ticket #42). */
function panelHeaderButton(label: 'Rename task' | 'Pin task' | 'Unpin task' | 'Archive task') {
  return host.querySelector(`button[aria-label="${label}"]`) as HTMLElement;
}

/** A Ghost Card's root element on the board, located by its stable id (ticket #9). */
function ghostCardEl(id: string): Element {
  return host.querySelector(`[data-ghost-card="${CSS.escape(id)}"]`)!;
}

/** The panel's own Adopt/Reject buttons in ghost mode (ticket #42). */
function panelGhostActionButton(label: 'Adopt' | 'Reject'): HTMLElement {
  return Array.from(host.querySelectorAll('button')).find(
    (b) => b.textContent === label
  ) as HTMLElement;
}

function makeGhostCard(overrides: Partial<GhostCard['issue']> = {}): GhostCard {
  const url = overrides.url ?? 'https://github.com/acme/repo/issues/5';
  return {
    id: url,
    issue: {
      provider: 'github',
      url,
      title: 'A candidate idea',
      identifier: '#5',
      description: 'Some body text',
      ...overrides,
    },
  };
}

function makeCreatedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'new-task',
    projectId: 'p1',
    name: 'A candidate idea',
    status: 'todo',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    statusChangedAt: '2026-01-01T00:00:00.000Z',
    isPinned: false,
    prs: [],
    conversations: {},
    type: 'task',
    workflowStage: 'idea',
    ...overrides,
  };
}

/** A full synced PR fixture (ticket #100), defaulted to an open PR on `task/branch`. */
function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    url: 'https://github.com/acme/repo/pull/1',
    provider: 'github',
    // Normalized repository URL — the shape `pull_requests.repository_url`
    // actually stores (no `.git`), which is what the Spec-reference matcher
    // compares against.
    repositoryUrl: 'https://github.com/acme/repo',
    baseRefName: 'main',
    baseRefOid: 'b'.repeat(40),
    headRepositoryUrl: 'https://github.com/acme/repo.git',
    headRefName: 'task/branch',
    headRefOid: 'h'.repeat(40),
    identifier: '#1',
    title: 'Example PR',
    description: null,
    status: 'open',
    isDraft: false,
    additions: null,
    deletions: null,
    changedFiles: null,
    commitCount: null,
    mergeableStatus: 'UNKNOWN',
    mergeStateStatus: 'UNKNOWN',
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

  it('clicking the card\'s "Move" handle (ticket #52) does not select it — that handle owns keyboard drag pick-up only, never selection', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    const moveHandle = host.querySelector(`button[aria-label="Move card-a"]`) as HTMLElement;
    click(moveHandle);
    await settle();

    // A stationary click never reaches dnd-kit's pointer-drag activation
    // constraint either, so this exercises the same click-bubbling contract
    // a real "press and release without moving" mouse gesture would: the
    // handle's own `onClick` stops propagation, so the card's `onClick` (the
    // thing that opens the panel) never fires.
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

  // Ticket #68: the session-count line moved out of Vitals entirely — it now
  // labels the Conversations section header (covered below), not a second,
  // redundant line here. This assertion is the deliberate edit the spec
  // calls out, not a regression.
  it('no longer shows a session-count line in Vitals', async () => {
    const a = makeStore('card-a');
    a.conversationStats = { claude: 2, codex: 1 };
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();

    expect(panelText()).not.toContain('sessions');
    expect(panelText()).not.toContain('session');
  });
});

// Ticket #68: the Conversations section. Reads from the mocked
// `getConversationsForTask` selector (`conversationManagersByTaskId`) — the
// same per-task conversation manager registry the task-level status dot
// already reads through `taskAgentStatus`, never a new RPC. Rename/delete/
// export delegate to the manager and modal paths already covered where they
// live (the module's own test file, `SidebarConversationsList`'s own
// coverage) — these tests only assert the row wires to them.
describe('Task Detail Panel — Conversations section (ticket #68)', () => {
  setupDom();

  it('shows an explicit empty state for a task with no conversations, not a hidden section', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();

    expect(panelSection('conversations')).not.toBeNull();
    expect(panelText()).toContain('Conversations (0)');
    expect(panelText()).toContain('No conversations yet');
  });

  it('renders one row per conversation with provider icon, title, status and last-active time, and labels the header with the count', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    conversationManagersByTaskId.set(
      'card-a',
      makeConversationManager([
        makeConversation({
          id: 'conv-1',
          providerId: 'claude',
          title: 'Spec writing',
          type: 'acp',
        }),
        makeConversation(
          { id: 'conv-2', providerId: 'codex', title: 'codex (1)', type: 'pty' },
          'working'
        ),
      ])
    );
    await mount();

    click(cardEl('card-a'));
    await settle();

    expect(panelText()).toContain('Conversations (2)');
    expect(conversationRowIds()).toEqual(['conv-1', 'conv-2']);

    const icon1 = conversationRow('conv-1').querySelector('[data-mock="conversation-icon"]')!;
    expect(icon1.getAttribute('data-provider-id')).toBe('claude');
    expect(icon1.getAttribute('data-is-acp')).toBe('true');
    expect(conversationRow('conv-1').textContent).toContain('Spec writing');

    const icon2 = conversationRow('conv-2').querySelector('[data-mock="conversation-icon"]')!;
    expect(icon2.getAttribute('data-provider-id')).toBe('codex');
    expect(icon2.getAttribute('data-is-acp')).toBe('false');
    // A conversation with a live indicator status shows it (`AgentStatusIndicator`
    // is mocked to `null`, so its presence is asserted structurally: no
    // `RelativeTime` rendered for that row instead).
    expect(conversationRow('conv-2').parentElement?.querySelector('time')).toBeNull();
  });

  it('falls back to the default provider title for display the same way the sidebar does', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    conversationManagersByTaskId.set(
      'card-a',
      makeConversationManager([
        makeConversation({ id: 'conv-1', providerId: 'claude', title: 'claude (1)' }),
      ])
    );
    await mount();

    click(cardEl('card-a'));
    await settle();

    // `formatConversationTitleForDisplay` is real (unmocked) here — the panel
    // must produce the exact same capitalized "Claude (1)" the sidebar shows.
    expect(conversationRow('conv-1').textContent).toContain('Claude (1)');
  });

  it('clicking a row navigates to the task view with that conversation as the focused conversation', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    conversationManagersByTaskId.set(
      'card-a',
      makeConversationManager([makeConversation({ id: 'conv-1' })])
    );
    await mount();

    click(cardEl('card-a'));
    await settle();

    click(conversationRow('conv-1'));
    await settle();

    expect(mocks.navigate).toHaveBeenCalledWith('task', {
      projectId: 'p1',
      taskId: 'card-a',
      focusConversationId: 'conv-1',
    });
  });

  it('clicking a row on a never-provisioned task provisions the workspace first, then still navigates to the requested conversation', async () => {
    const a = makeStore('card-a', {}, { state: 'unprovisioned', phase: 'idle' });
    managerTasks.set(a.data.id, a);
    conversationManagersByTaskId.set(
      'card-a',
      makeConversationManager([makeConversation({ id: 'conv-1' })])
    );
    await mount();

    click(cardEl('card-a'));
    await settle();

    click(conversationRow('conv-1'));
    await settle();

    // Same `openTaskView` helper the "Open task" button and the card's hover
    // arrow already share (`board-main-panel.tsx`): provisioning fires ahead
    // of navigation, never in place of it.
    expect(mocks.provisionTask).toHaveBeenCalledWith('card-a');
    expect(mocks.navigate).toHaveBeenCalledWith('task', {
      projectId: 'p1',
      taskId: 'card-a',
      focusConversationId: 'conv-1',
    });
  });

  it('a keyboard Enter on a row activates it, same as a click', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    conversationManagersByTaskId.set(
      'card-a',
      makeConversationManager([makeConversation({ id: 'conv-1' })])
    );
    await mount();

    click(cardEl('card-a'));
    await settle();

    conversationRow('conv-1').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    await settle();

    expect(mocks.navigate).toHaveBeenCalledWith('task', {
      projectId: 'p1',
      taskId: 'card-a',
      focusConversationId: 'conv-1',
    });
  });

  it('a keyboard Space on a row activates it too', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    conversationManagersByTaskId.set(
      'card-a',
      makeConversationManager([makeConversation({ id: 'conv-1' })])
    );
    await mount();

    click(cardEl('card-a'));
    await settle();

    conversationRow('conv-1').dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    );
    await settle();

    expect(mocks.navigate).toHaveBeenCalledWith('task', {
      projectId: 'p1',
      taskId: 'card-a',
      focusConversationId: 'conv-1',
    });
  });

  it('Escape still closes the panel while a conversation row is focused', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    conversationManagersByTaskId.set(
      'card-a',
      makeConversationManager([makeConversation({ id: 'conv-1' })])
    );
    await mount();

    click(cardEl('card-a'));
    await settle();
    expect(panelHeading()).toBe('card-a');

    conversationRow('conv-1').focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();

    expect(panelHeading()).toBeNull();
  });

  it('renames a conversation through the conversation manager, on Enter', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    const manager = makeConversationManager([
      makeConversation({ id: 'conv-1', title: 'Original title' }),
    ]);
    conversationManagersByTaskId.set('card-a', manager);
    await mount();

    click(cardEl('card-a'));
    await settle();

    click(conversationRowActionButton('conv-1', 'Rename conversation'));
    await settle(6);

    const input = conversationRow('conv-1').parentElement!.querySelector(
      'input'
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    input.value = 'New title';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();

    expect(manager.renameConversation).toHaveBeenCalledWith('conv-1', 'New title');
  });

  it('deletes a conversation through the confirm-action modal, and the row disappears', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    const manager = makeConversationManager([makeConversation({ id: 'conv-1' })]);
    conversationManagersByTaskId.set('card-a', manager);
    await mount();

    click(cardEl('card-a'));
    await settle();
    expect(conversationRowIds()).toEqual(['conv-1']);

    click(conversationRowActionButton('conv-1', 'Delete conversation'));
    await settle();

    expect(modalStore.activeModalId).toBe('confirmActionModal');
    expect(modalStore.activeModalArgs).toMatchObject({ variant: 'destructive' });

    // No `ModalHost` is mounted in this harness (mirrors the existing "Rename
    // opens the rename modal" test above) — invoking the captured
    // `onSuccess` directly simulates the user confirming in the real dialog.
    (modalStore.activeModalArgs!.onSuccess as () => void)();
    runInAction(() => manager.conversations.delete('conv-1'));
    await settle();

    expect(manager.deleteConversation).toHaveBeenCalledWith('conv-1');
    expect(conversationRowIds()).toEqual([]);
  });

  it('offers transcript export for an ACP conversation, but not for a legacy (pty) one', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    conversationManagersByTaskId.set(
      'card-a',
      makeConversationManager([
        makeConversation({ id: 'conv-acp', type: 'acp' }),
        makeConversation({ id: 'conv-pty', type: 'pty' }),
      ])
    );
    await mount();

    click(cardEl('card-a'));
    await settle();

    expect(conversationRowActionButton('conv-acp', 'Export transcript')).toBeTruthy();
    expect(conversationRowActionButton('conv-pty', 'Export transcript')).toBeFalsy();
  });

  it('the section reflects a conversation created while the panel is open', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    const manager = makeConversationManager([makeConversation({ id: 'conv-1' })]);
    conversationManagersByTaskId.set('card-a', manager);
    await mount();

    click(cardEl('card-a'));
    await settle();
    expect(conversationRowIds()).toEqual(['conv-1']);

    runInAction(() => manager.conversations.set('conv-2', makeConversation({ id: 'conv-2' })));
    await settle();

    expect(conversationRowIds().sort()).toEqual(['conv-1', 'conv-2']);
  });

  it('does not render the Conversations section in ghost mode', async () => {
    const ghostCard = makeGhostCard();
    mocks.getGhostCards.mockImplementation(() => Promise.resolve([ghostCard]));
    await mount();
    await settle();

    click(ghostCardEl(ghostCard.id));
    await settle();

    expect(panelHeading()).toBe(ghostCard.issue.title);
    expect(panelSection('conversations')).toBeNull();
  });

  it('opening the panel provisions nothing, on a task with conversations or without', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    conversationManagersByTaskId.set(
      'card-a',
      makeConversationManager([makeConversation({ id: 'conv-1' })])
    );
    await mount();

    click(cardEl('card-a'));
    await settle();

    expect(mocks.provisionTask).not.toHaveBeenCalled();
    expect(mocks.archiveTask).not.toHaveBeenCalled();
  });
});

// Ticket #49: branch + working-tree changes, and agent/conversation state —
// both reuse the same read-only primitives the card already renders
// (`TaskGitDiffStats`, `StackedAgentLogos`) rather than a new derivation, and
// neither ever provisions or mutates the task to display them.
describe('Task Detail Panel — branch, working-tree changes and agent/conversation state (ticket #49)', () => {
  setupDom();

  it('shows working-tree diff stats from the cached workspace snapshot, without provisioning anything', async () => {
    const a = makeStore('card-a', { workspaceGit: { linesAdded: 5, linesDeleted: 2 } });
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();

    expect(panelText()).toContain('+5');
    expect(panelText()).toContain('-2');
    expect(mocks.provisionTask).not.toHaveBeenCalled();
    expect(mocks.archiveTask).not.toHaveBeenCalled();
  });

  it('shows no diff stats for a task with no cached or live working-tree data', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();

    expect(panelText()).not.toContain('+0');
    expect(panelText()).not.toContain('-0');
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

  it('renders no Delivery chain section for a purely local task with no links or PR', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();

    expect(panelSection('delivery-chain')).toBeNull();
  });
});

describe('Task Detail Panel — Spec-derived PR and stage authority (ticket #41)', () => {
  setupDom();

  // Ticket #100: Origin/Map/Spec live in the "Delivery chain" section, and
  // the task's PR (assigned, else derived) moved into its own dedicated
  // "Pull request" section — so a task with linked issues but no PR shows
  // the chain (its typed links) and no PR section at all.
  it('shows no PR section when nothing is assigned and no PR derives, while the delivery chain keeps its links', async () => {
    const linkedIssues: LinkedIssueRoles = {
      version: '1',
      origin: {
        provider: 'github',
        url: 'https://github.com/acme/repo/issues/1',
        title: 'Origin issue',
        identifier: '#1',
      },
    };
    const a = makeStore('card-a', { linkedIssues });
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();
    await settle();

    expect(panelSection('delivery-chain')).not.toBeNull();
    expect(linkedIssueRoles()).toEqual(['origin']);
    expect(panelSection('pull-request')).toBeNull();
    expect(taskPrRow()).toBeNull();
  });

  // Ticket #100: the PR row now derives from the task's own payload through
  // the shared `resolveTaskPr` helper (the stage-authority RPC only feeds the
  // stage explanation below) — a Spec-referencing PR on the task's synced set
  // shows up even though nothing is assigned.
  it('shows the Spec-referencing PR in the Pull request section, disables the stage selector, and names the holding fact', async () => {
    const spec: LinkedIssueRoles['spec'] = {
      provider: 'github',
      url: 'https://github.com/acme/repo/issues/9',
      title: 'Spec issue',
      identifier: '#9',
    };
    const pr: PullRequest = makePr({
      url: 'https://github.com/acme/repo/pull/9',
      title: 'Ship the feature',
      identifier: '#9',
      status: 'open',
      description: 'Closes #9',
      // Not the task's branch: only the Spec reference can match it.
      headRefName: 'feat/ship-it',
    });
    mocks.getTaskStageAuthority.mockResolvedValueOnce({
      holdingPr: pr,
      isCurrentStageGithubProven: true,
    });
    const a = makeStore('card-a', {
      workflowStage: 'review',
      linkedIssues: { version: '1', spec },
      prs: [pr],
    });
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();
    await settle();

    expect(panelSection('pull-request')).not.toBeNull();
    expect(taskPrRow()).not.toBeNull();
    expect(panelText()).toContain('Ship the feature');
    expect(panelText()).toContain('#9');
    expect(stageSelect().disabled).toBe(true);
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
  // doesn't cover. The board's drag-and-drop can still move a card into either
  // column regardless of its linked issues (ticket #48/#56), so the panel only
  // locks the selector when the linked Map/Spec issue is the same fact the
  // issue-derived sync pass would have read as open — a closed or absent link
  // must never let the panel assert an authority it can't substantiate.
  it('locks the selector and names the linked Spec issue for a task sitting in Spec with an open Spec issue', async () => {
    const linkedIssues: LinkedIssueRoles = {
      version: '1',
      spec: {
        provider: 'github',
        url: 'https://github.com/acme/repo/issues/42',
        title: 'Spec issue',
        identifier: '#42',
        status: 'open',
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

  // Ticket #48: a closed Spec issue with no merged PR is not a "no authority"
  // fact — it is exactly the contradiction the next issues-sync pass would
  // sweep into Triage, so the panel locks the selector on that fact instead
  // of falsely offering a manual choice the sync would overwrite.
  it('locks the selector on the Triage contradiction for a task sitting in Spec whose linked Spec issue closed without a merged PR', async () => {
    const linkedIssues: LinkedIssueRoles = {
      version: '1',
      spec: {
        provider: 'github',
        url: 'https://github.com/acme/repo/issues/42',
        title: 'Spec issue',
        identifier: '#42',
        status: 'closed',
      },
    };
    const a = makeStore('card-a', { workflowStage: 'spec', linkedIssues });
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();
    await settle();

    expect(stageSelect().disabled).toBe(true);
    expect(panelText()).not.toContain('Held in Spec');
    expect(panelText()).toContain('Triage');
    expect(panelText()).toContain('#42');
    // The linked issue is still listed in the Delivery chain section (ticket
    // #41's content) regardless of which stage-authority claim it backs.
    expect(linkedIssueRoles()).toEqual(['spec']);
  });
});

// Ticket #100: the dedicated "Pull request" section (CONTEXT.md "Assigned
// PR"). Always rendered when a PR exists — assigned or derived, even with no
// linked issues; shows status, number and title with an external link; and
// assigns through the reused `PrSelector` picker over the project's synced
// PRs. The picker itself (its own search/status filter/error states) is
// covered by `pr-selector.test.ts` — these tests only pin the panel's
// wiring: that the section renders, that the row opens the PR, and that
// picking/unassigning reaches the store's `setAssignedPr` (which persists
// via `tasks.setTaskAssignedPr`).
describe('Task Detail Panel — Pull request section (ticket #100)', () => {
  setupDom();

  it('renders the PR row with status, number and title for a branch-matched PR, even with no linked issues', async () => {
    const pr = makePr({
      url: 'https://github.com/acme/repo/pull/7',
      identifier: '#7',
      title: 'A purely branch-matched PR',
      status: 'merged',
    });
    const a = makeStore('card-a', { prs: [pr] });
    branchByTaskId.set('card-a', 'task/branch');
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();

    const row = taskPrRow();
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('#7');
    expect(row!.textContent).toContain('A purely branch-matched PR');
    // Status icon: the row leads with the merged-status icon (`StatusIcon`,
    // the same component the Changes panel and the picker use).
    expect(row!.querySelector('svg')).not.toBeNull();
    expect(panelSection('delivery-chain')).toBeNull(); // no links, no chain
  });

  it('clicking the PR row opens the PR in the external browser', async () => {
    const pr = makePr({ url: 'https://github.com/acme/repo/pull/7', title: 'Open me' });
    const a = makeStore('card-a', { prs: [pr] });
    branchByTaskId.set('card-a', 'task/branch');
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();

    const link = taskPrRow()!.querySelector('button') as HTMLElement;
    click(link);
    await settle();

    expect(mocks.openExternal).toHaveBeenCalledWith('https://github.com/acme/repo/pull/7');
  });

  it('shows no Pull request section at all when nothing is assigned and nothing derives', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();

    expect(panelSection('pull-request')).toBeNull();
  });

  it('shows the assigned PR instead of the derived one, with an unassign action that reverts to derivation', async () => {
    const derived = makePr({
      url: 'https://github.com/acme/repo/pull/3',
      identifier: '#3',
      title: 'Derived branch PR',
    });
    const assigned = makePr({
      url: 'https://github.com/acme/repo/pull/99',
      identifier: '#99',
      title: 'User-assigned PR',
      headRefName: 'some-other-branch',
    });
    // Live store with a faithful `setAssignedPr` (the real store method's
    // optimistic payload update + persistence RPC): the unassign gesture must
    // visibly revert the row to the derived PR and persist null.
    const a = makeLiveStore('card-a', { prs: [derived, assigned], assignedPr: assigned });
    a.setAssignedPr.mockImplementation((pr: PullRequest | null) => {
      runInAction(() => {
        a.data.assignedPr = pr ?? undefined;
      });
      void mocks.setTaskAssignedPr('card-a', pr?.url ?? null);
    });
    branchByTaskId.set('card-a', 'task/branch');
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();

    expect(taskPrRow()!.textContent).toContain('#99');
    expect(taskPrRow()!.textContent).toContain('User-assigned PR');
    expect(panelText()).not.toContain('Derived branch PR');

    // Unassign action is present only while a PR is assigned.
    const unassign = host.querySelector(
      'button[aria-label="Unassign pull request"]'
    ) as HTMLElement;
    expect(unassign).not.toBeNull();
    click(unassign);
    await settle();

    expect(a.setAssignedPr).toHaveBeenCalledWith(null);
    expect(taskPrRow()!.textContent).toContain('#3');
    expect(mocks.setTaskAssignedPr).toHaveBeenCalledWith('card-a', null);
  });

  it('assigns a PR from the project picker, persisting through the setTaskAssignedPr RPC', async () => {
    const listed = makePr({
      url: 'https://github.com/acme/repo/pull/11',
      identifier: '#11',
      title: 'PR from the project',
      headRefName: 'other/branch',
    });
    mocks.pullRequestRepositoryUrl = 'https://github.com/acme/repo';
    mocks.listPullRequests.mockImplementation(() =>
      Promise.resolve({ success: true, data: { prs: [listed] } })
    );
    // The section needs a PR to render at all, so the task starts with a
    // derived PR — the picker then lists the project's synced PRs (which can
    // be a *different* PR than the derived one). The store mock mirrors the
    // real `TaskStore.setAssignedPr` (optimistic payload update + the
    // `tasks.setTaskAssignedPr` persistence RPC).
    const derived = makePr({ identifier: '#2', title: 'Derived PR' });
    const a = makeStore('card-a', { prs: [derived] });
    a.setAssignedPr.mockImplementation((pr: PullRequest | null) => {
      void mocks.setTaskAssignedPr('card-a', pr?.url ?? null);
    });
    branchByTaskId.set('card-a', 'task/branch');
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();
    expect(panelSection('pull-request')).not.toBeNull();

    const trigger = assignPrPickerTrigger()!;
    expect(trigger).not.toBeNull();
    click(trigger);
    await settle(6);

    const item = document.body.querySelector('[data-slot="combobox-item"]') as HTMLElement;
    expect(item).not.toBeNull();
    click(item);
    await settle(6);

    expect(a.setAssignedPr).toHaveBeenCalledWith(listed);
    expect(mocks.setTaskAssignedPr).toHaveBeenCalledWith('card-a', listed.url);
  });

  it('reflects an assignment landing on the payload while the panel is open (assigned wins live)', async () => {
    const derived = makePr({
      url: 'https://github.com/acme/repo/pull/3',
      identifier: '#3',
      title: 'Derived branch PR',
    });
    const assigned = makePr({
      url: 'https://github.com/acme/repo/pull/99',
      identifier: '#99',
      title: 'User-assigned PR',
      headRefName: 'some-other-branch',
    });
    const a = makeLiveStore('card-a', { prs: [derived, assigned] });
    branchByTaskId.set('card-a', 'task/branch');
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();
    expect(taskPrRow()!.textContent).toContain('#3');

    runInAction(() => {
      a.data.assignedPr = assigned;
    });
    await settle();

    expect(taskPrRow()!.textContent).toContain('#99');
    expect(host.querySelector('button[aria-label="Unassign pull request"]')).not.toBeNull();
  });
});

// Ticket #49: the stage explanation now always names *something* — a
// governing GitHub fact (already covered above), the workspace fact behind a
// runtime-derived Implementing, or an explicitly-labelled manual placement —
// so "no explanation" never reads as "nothing to say about this".
describe('Task Detail Panel — Workflow Stage explanation: manual and workspace labelling (ticket #49)', () => {
  setupDom();

  it('labels a manual placement as manual when no GitHub or workspace fact backs it', async () => {
    const a = makeStore('card-a', { workflowStage: 'idea' });
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();
    await settle();

    expect(stageSelect().disabled).toBe(false);
    expect(panelText()).toContain('Manual placement');
  });

  it('names the provisioned workspace behind a runtime-derived Implementing', async () => {
    const a = makeStore('card-a', { workflowStage: 'implementing', workspaceId: 'workspace-1' });
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();
    await settle();

    expect(stageSelect().disabled).toBe(false);
    expect(panelText()).toContain('Implementing');
    expect(panelText()).toContain('workspace');
  });

  it('labels Implementing manual instead when there is no provisioned workspace yet', async () => {
    const a = makeStore('card-a', { workflowStage: 'implementing' });
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();
    await settle();

    expect(panelText()).toContain('Manual placement');
  });

  it('shows no stage explanation at all for an Unstaged task with no fact either', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();
    await settle();

    expect(panelSection('workflow-stage')).not.toBeNull();
    expect(panelText()).not.toContain('Manual placement');
  });
});

describe('Task Detail Panel — direct navigation (ticket #42)', () => {
  setupDom();

  it('the hover arrow on a card navigates straight to the full task view', async () => {
    const a = makeStore('card-a');
    const b = makeStore('card-b');
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b);
    await mount();

    click(hoverArrowFor('card-a'));
    await settle();

    expect(mocks.navigate).toHaveBeenCalledWith('task', { projectId: 'p1', taskId: 'card-a' });
    // It must not fight the card's click-to-open-panel gesture: the arrow's
    // own click handler stops it from bubbling into a card selection.
    expect(panelHeading()).toBeNull();
  });

  it('the hover arrow does not select the card it navigates away from', async () => {
    const a = makeStore('card-a');
    const b = makeStore('card-b');
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b);
    await mount();

    // Open the panel on a different card first, then use card-a's arrow.
    click(cardEl('card-b'));
    await settle();
    expect(panelHeading()).toBe('card-b');

    click(hoverArrowFor('card-a'));
    await settle();

    expect(mocks.navigate).toHaveBeenCalledWith('task', { projectId: 'p1', taskId: 'card-a' });
    expect(panelHeading()).toBe('card-b');
  });

  it('the panel\'s "Open task" button navigates straight to the full task view', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();
    expect(panelHeading()).toBe('card-a');

    click(openTaskButton());
    await settle();

    expect(mocks.navigate).toHaveBeenCalledWith('task', { projectId: 'p1', taskId: 'card-a' });
  });

  // A synthetic (untrusted) KeyboardEvent never makes a real browser invoke a
  // focused button's default Enter/Space activation the way trusted user
  // input does (the same limitation board-dnd.test.tsx's drag tests document
  // for synthetic PointerEvents never producing a native trailing click) — so
  // this cannot assert `navigate` fires from a dispatched keydown alone. What
  // it does prove: the keydown must not bubble past the arrow into the card's
  // own onKeyDown and (re)select a different card than the one shown.
  it('a keyboard Enter on the focused hover arrow does not bubble into (re)selecting the card', async () => {
    const a = makeStore('card-a');
    const b = makeStore('card-b');
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b);
    await mount();

    click(cardEl('card-b'));
    await settle();
    expect(panelHeading()).toBe('card-b');

    hoverArrowFor('card-a').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    await settle();

    expect(panelHeading()).toBe('card-b');
  });
});

describe('Task Detail Panel — ghost mode (ticket #42)', () => {
  setupDom();

  it("clicking a Ghost Card opens the panel in ghost mode with the issue's title, body and URL", async () => {
    const ghostCard = makeGhostCard();
    mocks.getGhostCards.mockImplementation(() => Promise.resolve([ghostCard]));
    await mount();
    await settle();

    click(ghostCardEl(ghostCard.id));
    await settle();

    expect(panelHeading()).toBe(ghostCard.issue.title);
    expect(panelText()).toContain(ghostCard.issue.title);
    expect(panelText()).toContain(ghostCard.issue.description);
    expect(panelText()).toContain(ghostCard.issue.url);
    // Ghost mode has no task sections — there is no task yet.
    expect(panelSection('vitals')).toBeNull();
  });

  it('a keyboard Enter on a focused Ghost Card also opens ghost mode', async () => {
    const ghostCard = makeGhostCard();
    mocks.getGhostCards.mockImplementation(() => Promise.resolve([ghostCard]));
    await mount();
    await settle();

    const el = ghostCardEl(ghostCard.id) as HTMLElement;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();

    expect(panelHeading()).toBe(ghostCard.issue.title);
  });

  it('re-clicking a different real task card switches the panel away from ghost mode', async () => {
    const ghostCard = makeGhostCard();
    mocks.getGhostCards.mockImplementation(() => Promise.resolve([ghostCard]));
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();
    await settle();

    click(ghostCardEl(ghostCard.id));
    await settle();
    expect(panelHeading()).toBe(ghostCard.issue.title);

    click(cardEl('card-a'));
    await settle();

    expect(panelHeading()).toBe('card-a');
    expect(panelSection('vitals')).not.toBeNull();
  });

  it('Reject reuses the existing ghost-card action and closes the panel', async () => {
    const ghostCard = makeGhostCard();
    mocks.getGhostCards.mockImplementation(() => Promise.resolve([ghostCard]));
    await mount();
    await settle();

    click(ghostCardEl(ghostCard.id));
    await settle();
    expect(panelHeading()).toBe(ghostCard.issue.title);

    click(panelGhostActionButton('Reject'));
    await settle();

    expect(mocks.rejectGhostCard).toHaveBeenCalledWith('p1', ghostCard);
    expect(panelHeading()).toBeNull();
  });

  it('Adopt creates the task and the panel switches to it', async () => {
    const ghostCard = makeGhostCard();
    mocks.getGhostCards.mockImplementation(() => Promise.resolve([ghostCard]));
    const createdTask = makeCreatedTask({ id: 'new-task', name: ghostCard.issue.title });
    mocks.adoptGhostCard.mockResolvedValueOnce({ success: true, data: { task: createdTask } });
    // Mirrors the real app: by the time the panel renders the new task, the
    // task manager has already learned about it (via the `task:created`
    // event this same RPC triggers main-side) — simulated here by seeding
    // the store the mocked `getTaskStore` reads from.
    managerTasks.set(createdTask.id, makeStore(createdTask.id, { name: createdTask.name }));
    await mount();
    await settle();

    click(ghostCardEl(ghostCard.id));
    await settle();
    expect(panelHeading()).toBe(ghostCard.issue.title);

    click(panelGhostActionButton('Adopt'));
    await settle();
    await settle();

    expect(mocks.adoptGhostCard).toHaveBeenCalledWith('p1', ghostCard);
    expect(panelHeading()).toBe(createdTask.name);
    // Switched to real-task mode, not still showing ghost details.
    expect(panelSection('vitals')).not.toBeNull();
  });

  // Same nested-interactive seam as the card's hover arrow: the ghost card's
  // own Adopt/Reject buttons stop a *click* from bubbling into the card's
  // onClick (opening/reselecting ghost mode), but a keydown still bubbles
  // unless stopped too — Enter/Space on Adopt/Reject must not also (re)select
  // the ghost card underneath them.
  it("a keyboard Enter on the Ghost Card's own Adopt button does not bubble into (re)selecting it", async () => {
    const ghostCard = makeGhostCard();
    mocks.getGhostCards.mockImplementation(() => Promise.resolve([ghostCard]));
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();
    await settle();

    click(cardEl('card-a'));
    await settle();
    expect(panelHeading()).toBe('card-a');

    const adoptButton = Array.from(ghostCardEl(ghostCard.id).querySelectorAll('button')).find(
      (b) => b.textContent === 'Adopt'
    ) as HTMLElement;
    adoptButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();

    expect(panelHeading()).toBe('card-a');
  });
});

// The RPCs these delegate to (rename, setPinned, archiveTask) are already
// covered where they live (ticket #42's own criterion) — these tests only
// pin the panel's own wiring: that its buttons call the right delegate with
// the right task id, the one thing this ticket actually adds.
describe('Task Detail Panel — management actions (ticket #42)', () => {
  setupDom();

  afterEach(() => {
    modalStore.closeModal();
  });

  it('Rename opens the rename modal for the shown task', async () => {
    const a = makeStore('card-a', { name: 'Original name' });
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('Original name'));
    await settle();

    click(panelHeaderButton('Rename task'));
    await settle();

    expect(modalStore.activeModalId).toBe('renameTaskModal');
    expect(modalStore.activeModalArgs).toMatchObject({
      projectId: 'p1',
      taskId: 'card-a',
      currentName: 'Original name',
    });
  });

  it("Pin toggles the task's pinned state via the store", async () => {
    const a = makeStore('card-a', { isPinned: false });
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();

    expect(panelHeaderButton('Pin task')).toBeTruthy();
    click(panelHeaderButton('Pin task'));
    await settle();

    expect(a.setPinned).toHaveBeenCalledWith(true);
  });

  it('Unpin toggles an already-pinned task back off via the store', async () => {
    const a = makeStore('card-a', { isPinned: true });
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();

    expect(panelHeaderButton('Unpin task')).toBeTruthy();
    click(panelHeaderButton('Unpin task'));
    await settle();

    expect(a.setPinned).toHaveBeenCalledWith(false);
  });

  it('Archive calls the existing archive RPC for the shown task', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();

    click(panelHeaderButton('Archive task'));
    await settle();

    expect(mocks.archiveTask).toHaveBeenCalledWith('card-a');
  });
});

// Ticket #49: keyboard and pointer selection must be indistinguishable —
// both land on the exact same handler (`BoardMainPanel`'s `handleSelectTask`),
// so a card's own `onKeyDown` (Enter/Space -> select, inherited from spec
// #12/ticket #40) is exercised here directly rather than only through a
// pointer click, the way every describe block above this one does it.
describe('Task Detail Panel — selection: keyboard and pointer are identical (ticket #49)', () => {
  setupDom();

  it('a keyboard Enter on the card itself opens the panel exactly like a pointer click', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    expect(panelHeading()).toBeNull();
    (cardEl('card-a') as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    await settle();

    expect(panelHeading()).toBe('card-a');
    expect((cardEl('card-a') as HTMLElement).className).toContain('border-primary');
  });

  it('a keyboard Space on the card itself opens the panel too', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    (cardEl('card-a') as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    );
    await settle();

    expect(panelHeading()).toBe('card-a');
  });

  it('a keyboard Enter on a different card switches the panel, same as a pointer click would', async () => {
    const a = makeStore('card-a');
    const b = makeStore('card-b');
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b);
    await mount();

    click(cardEl('card-a'));
    await settle();
    expect(panelHeading()).toBe('card-a');

    (cardEl('card-b') as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    await settle();

    expect(panelHeading()).toBe('card-b');
  });
});

// Ticket #49's hard safety criterion: browsing the board never provisions,
// archives, or otherwise mutates a task. Selecting a card is a read-only
// view-state change (which task the inspector shows) — this is the mutation
// seam itself: the exact calls a provision/archive/write would go through.
describe('Task Detail Panel — selection never mutates a task (safety, ticket #49)', () => {
  setupDom();

  it('selecting a card via pointer calls no provision, archive, or board-position write', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();

    expect(panelHeading()).toBe('card-a');
    expect(mocks.provisionTask).not.toHaveBeenCalled();
    expect(mocks.archiveTask).not.toHaveBeenCalled();
    expect(a.updateBoardPosition).not.toHaveBeenCalled();
  });

  it('selecting a card via keyboard calls no provision, archive, or board-position write either', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    (cardEl('card-a') as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    await settle();

    expect(panelHeading()).toBe('card-a');
    expect(mocks.provisionTask).not.toHaveBeenCalled();
    expect(mocks.archiveTask).not.toHaveBeenCalled();
    expect(a.updateBoardPosition).not.toHaveBeenCalled();
  });

  it('switching between cards and closing the panel still calls no provision, archive, or write', async () => {
    const a = makeStore('card-a');
    const b = makeStore('card-b');
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b);
    await mount();

    click(cardEl('card-a'));
    await settle();
    click(cardEl('card-b'));
    await settle();
    click(closeButton());
    await settle();

    expect(mocks.provisionTask).not.toHaveBeenCalled();
    expect(mocks.archiveTask).not.toHaveBeenCalled();
    expect(a.updateBoardPosition).not.toHaveBeenCalled();
    expect(b.updateBoardPosition).not.toHaveBeenCalled();
  });
});

// Ticket #49: closing the inspector preserves scroll, column state and card
// ordering — the panel is ephemeral, board-owned view state (CONTEXT.md
// "Task Detail Panel") that must never reset anything else the board itself
// owns just because it closed.
describe('Task Detail Panel — closing preserves board state (ticket #49)', () => {
  setupDom();

  beforeEach(async () => {
    // Wide enough that every column is visible and nothing scrolls off by
    // itself, mirroring `board-dnd.test.tsx`'s wide-viewport drag suites.
    await page.viewport(2200, 800);
  });

  it('preserves a collapsed empty column across open and close', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    // "card-a" has no Workflow Stage, so it lands in Unstaged — every
    // pipeline column (e.g. Spec) starts empty and collapsible.
    const toggle = columnToggle('Spec')!;
    expect(toggle).toBeTruthy();
    toggle.click();
    await settle();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    click(cardEl('card-a'));
    await settle();
    expect(panelHeading()).toBe('card-a');

    click(closeButton());
    await settle();
    expect(panelHeading()).toBeNull();

    expect(columnToggle('Spec')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('preserves the board scroll position across open and close', async () => {
    // Narrow enough that the board actually overflows horizontally (the wide
    // 2200px viewport above fits every column with nothing to scroll) —
    // mirrors `board-dnd.test.tsx`'s own narrow-viewport scroll suite.
    await page.viewport(414, 896);
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    const scroller = host.querySelector<HTMLElement>('.overflow-x-auto')!;
    scroller.scrollLeft = 200;
    await settle();

    click(cardEl('card-a'));
    await settle();
    click(closeButton());
    await settle();

    expect(scroller.scrollLeft).toBe(200);
  });

  it('preserves card ordering (Board Rank) across open and close, with no write triggered', async () => {
    const a = makeStore('card-a', { workflowStage: 'idea', boardRank: 'b' });
    const b = makeStore('card-b', { workflowStage: 'idea', boardRank: 'a' });
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b);
    await mount();

    const orderBefore = cardNamesInColumn('Idea');
    expect(orderBefore).toEqual(['card-b', 'card-a']); // 'a' sorts before 'b'

    click(cardEl('card-a'));
    await settle();
    click(closeButton());
    await settle();

    expect(cardNamesInColumn('Idea')).toEqual(orderBefore);
    expect(a.updateBoardPosition).not.toHaveBeenCalled();
    expect(b.updateBoardPosition).not.toHaveBeenCalled();
  });
});

// Ticket #49: telemetry distinguishes the inspector opening, with no
// sensitive task content (no task name, issue title, or branch) — mirrors
// `board_opened`'s minimal `{ source }` payload.
describe('Task Detail Panel — board_inspector_opened telemetry (ticket #49)', () => {
  setupDom();

  it('captures board_inspector_opened for a task, with no task content in the payload', async () => {
    const a = makeStore('card-a', { name: 'Sensitive task name' });
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('Sensitive task name'));
    await settle();

    expect(mocks.captureTelemetry).toHaveBeenCalledWith('board_inspector_opened', {
      target_kind: 'task',
      project_id: 'p1',
    });
    const call = mocks.captureTelemetry.mock.calls.find((c) => c[0] === 'board_inspector_opened');
    expect(JSON.stringify(call)).not.toContain('Sensitive task name');
  });

  it('does not re-fire when re-clicking the already-open card (no-op re-select)', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    click(cardEl('card-a'));
    await settle();
    click(cardEl('card-a'));
    await settle();

    const calls = mocks.captureTelemetry.mock.calls.filter(
      (c) => c[0] === 'board_inspector_opened'
    );
    expect(calls).toHaveLength(1);
  });

  it('fires again when switching to a different card', async () => {
    const a = makeStore('card-a');
    const b = makeStore('card-b');
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b);
    await mount();

    click(cardEl('card-a'));
    await settle();
    click(cardEl('card-b'));
    await settle();

    const calls = mocks.captureTelemetry.mock.calls.filter(
      (c) => c[0] === 'board_inspector_opened'
    );
    expect(calls).toHaveLength(2);
  });

  it('captures board_inspector_opened with target_kind "ghost" for a Ghost Card', async () => {
    const ghostCard = makeGhostCard();
    mocks.getGhostCards.mockImplementation(() => Promise.resolve([ghostCard]));
    await mount();
    await settle();

    click(ghostCardEl(ghostCard.id));
    await settle();

    expect(mocks.captureTelemetry).toHaveBeenCalledWith('board_inspector_opened', {
      target_kind: 'ghost',
      project_id: 'p1',
    });
  });
});

// Ticket #50: focused-task navigation. The task titlebar's Workflow Stage
// chip (`task-titlebar.test.tsx`) carries an optional `focusTaskId` back to
// this board via `useParams('board')`. Resolved against exactly the
// active-task set the board itself already renders (`storeById`, which
// already excludes archived and Shipped-Faded tasks), reusing
// `handleSelectTask` (ticket #49) — the one existing selection path — so a
// focused arrival opens the inspector and highlights the card exactly like a
// manual click would, and scrolls it into view. An id that never resolves
// there (invalid, archived, or simply absent) is a silent no-op: the board
// renders normally, nothing is selected, and nothing throws.
describe('Board — focused-task navigation (ticket #50)', () => {
  setupDom();

  /** Whether a card with this name is currently rendered — safe for the
   * "does not exist at all" cases, unlike `cardEl`, which throws on a miss. */
  function cardExists(name: string): boolean {
    return Array.from(host.querySelectorAll('span')).some((s) => s.textContent === name);
  }

  it('opens the inspector and highlights the focused card on arrival', async () => {
    const a = makeStore('card-a');
    const b = makeStore('card-b');
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b);
    mocks.focusTaskId = 'card-a';
    await mount();

    expect(panelHeading()).toBe('card-a');
    expect((cardEl('card-a') as HTMLElement).className).toContain('border-primary');
    expect((cardEl('card-b') as HTMLElement).className).not.toContain('border-primary');
  });

  it('scrolls the focused card into view on arrival', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    mocks.focusTaskId = 'card-a';
    const scrollIntoViewSpy = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => {});

    await mount();

    expect(scrollIntoViewSpy).toHaveBeenCalled();
    scrollIntoViewSpy.mockRestore();
  });

  it('fails safely for a focusTaskId that does not resolve to any task (invalid)', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    mocks.focusTaskId = 'does-not-exist';

    await mount();

    expect(panelHeading()).toBeNull();
    expect(cardExists('card-a')).toBe(true); // the board still renders normally
  });

  it('fails safely for an archived task id', async () => {
    const a = makeStore('card-a', { archivedAt: '2026-01-01T00:00:00.000Z' });
    managerTasks.set(a.data.id, a);
    mocks.focusTaskId = 'card-a';

    await mount();

    expect(panelHeading()).toBeNull();
  });

  // A Shipped-Faded task (CONTEXT.md "Shipped Fade") is neither invalid nor
  // archived — it is a real, valid task whose PR merged long enough ago that
  // `isBoardDisplayable` (the same predicate `storeById` is built from) hides
  // it from the board's own columns. Resolution must fail exactly as safely
  // here as for an archived id: no throw, no stale/impossible selection, the
  // rest of the board renders normally.
  it('fails safely for a Shipped-Faded task id (real, non-archived, but hidden by the fade window)', async () => {
    const oldMergedAt = new Date(Date.now() - (SHIPPED_FADE_WINDOW_MS + 1000)).toISOString();
    const a = makeStore('card-a', {
      workflowStage: 'shipped',
      prs: [
        {
          url: 'https://github.com/acme/repo/pull/1',
          title: 'Ship it',
          identifier: '#1',
          status: 'merged',
          isDraft: false,
          mergedAt: oldMergedAt,
        } as PullRequest,
      ],
    });
    managerTasks.set(a.data.id, a);
    mocks.focusTaskId = 'card-a';

    await mount();

    expect(panelHeading()).toBeNull();
    expect(cardExists('card-a')).toBe(false); // faded out of the board, same as before navigation
  });

  it('renders normally with nothing selected when no focusTaskId is present', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);

    await mount();

    expect(panelHeading()).toBeNull();
    expect(cardExists('card-a')).toBe(true);
  });

  it('does not re-select or re-scroll on a later, unrelated re-render carrying the same focusTaskId', async () => {
    const a = makeStore('card-a');
    const b = makeLiveStore('card-b');
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b as unknown as MockStore);
    mocks.focusTaskId = 'card-a';
    await mount();
    expect(panelHeading()).toBe('card-a');

    // A manual click elsewhere, then some unrelated re-render, must not fight
    // the user's own new selection just because `focusTaskId` is still the
    // same string it always was. `workflowStage` is read directly by
    // `BoardMainPanel`'s own render loop (bucketing cards into columns), so
    // mutating it — unlike a field only a child component reads — genuinely
    // forces `BoardMainPanel` itself to re-render, the same way the
    // "disappearance" suite above forces one via `archivedAt`.
    click(cardEl('card-b'));
    await settle();
    expect(panelHeading()).toBe('card-b');

    runInAction(() => {
      b.data.workflowStage = 'idea';
    });
    await settle();

    expect(panelHeading()).toBe('card-b');
  });

  // The board's own filters (search, Needs Attention, compact filters) are
  // local `useState`, reset to empty on every mount — and every existing
  // navigation path that sets `focusTaskId` (the titlebar's Workflow Stage
  // chip) lands on `board` through a genuine fresh mount (`Workspace` swaps
  // `MainPanel` components on view change), so "a focused task the board's
  // own filters currently hide" cannot actually arise today: there is no
  // way to reach this component with both a `focusTaskId` and a non-default
  // `filters` value already in place. The `setFilters(EMPTY_BOARD_FILTERS)`
  // safety net in `board-main-panel.tsx` exists for defense-in-depth against
  // a future navigation change that stops remounting the board, and is
  // verified by code review (its condition is exactly the same
  // `taskPassesBoardFilters` predicate `board-filters.test.ts` already
  // covers exhaustively) rather than by a test here: reproducing "already
  // mounted with active filters" would require the mocked `useParams` to be
  // genuinely reactive the way the real MobX-backed one is (this suite's
  // `BoardMainPanel` is `observer`-wrapped, which bails out of a bare
  // `root.render()` repeat when its props -- there are none -- haven't
  // changed), which is disproportionate machinery for a path that cannot
  // occur through any registered navigation entry point today.
});
