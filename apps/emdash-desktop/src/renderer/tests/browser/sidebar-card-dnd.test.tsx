/**
 * Browser-mode tests for spec #120, ticket #123 (drag-reorder of project
 * cards): the card header is the drag handle, the insertion indicator is
 * drawn between cards, the drop persists the new project order through the
 * store's existing `setProjectOrder` — the exact project-row behavior the
 * cards replaced (ticket #123 port) — and task rows inside a card never
 * start a drag.
 *
 * Mounts the real `SidebarCardList` (whole card UI, dnd-kit included) with
 * the surrounding stores/providers mocked — the harness pattern of
 * `sidebar-card-list.test.tsx` — and drives the sidebar store through a
 * MobX-observable double, so a drop's reorder write re-renders like the real
 * projection would. Drags are simulated with the pointer-event driver of
 * `sidebar-stage-group-dnd.test.tsx` / `board-dnd.test.tsx`, aimed at
 * re-measured (strategy-shifted) card rects.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { SidebarRow } from '@renderer/features/sidebar/stage-group-row-model';
import type { LinkedIssueRoles } from '@shared/core/linked-issue';

type MockTaskStatus = 'idle' | 'working' | 'awaiting-input' | 'error' | 'completed' | null;

type MockTaskStore = {
  state: string;
  data: {
    id: string;
    name: string;
    type: string;
    prs: unknown[];
    workflowStage?: string;
    boardRank?: string;
    linkedIssues?: LinkedIssueRoles;
    workspaceId?: string;
    createdAt?: string;
    updatedAt?: string;
    isPinned?: boolean;
    archivedAt?: string;
  };
  isBootstrapping: boolean;
  status: MockTaskStatus;
  updateBoardPosition: ReturnType<typeof vi.fn>;
};

type MockProject = {
  state: string;
  id: string;
  name: string;
  data: { id: string; name: string; type: string; connectionId?: string };
  errorCode?: string;
  phase?: string;
};

type MockSidebarStore = {
  rawSidebarRows: SidebarRow[];
  sidebarRows: SidebarRow[];
  orderedProjects: { id: string }[];
  expandedProjectIds: {
    has(id: string): boolean;
    add(id: string): void;
    delete(id: string): void;
    clear(): void;
  };
  collapsedStageGroupIdsByProject: Record<string, string[]>;
  hiddenTaskIdsByProject: Record<string, string[]>;
  visibleTaskIdsByProject: Record<string, string[]>;
  taskSortBy: string;
  isEmpty: boolean;
  setProjectOrder: ReturnType<typeof vi.fn>;
  toggleProjectExpanded(projectId: string): void;
  ensureProjectExpanded(projectId: string): void;
  toggleStageGroupCollapsed(projectId: string, stage: string): void;
  isStageGroupCollapsed(projectId: string, stage: string): boolean;
  visibleTaskIdsForProject(projectId: string): string[];
  headerFoldTaskIdsForProject(projectId: string): string[];
  hideTaskFromSidebar: ReturnType<typeof vi.fn>;
  showTaskInSidebar: ReturnType<typeof vi.fn>;
};

const managersByProject = new Map<string, Map<string, MockTaskStore>>();

const PROJECT_NAMES: Record<string, string> = { p1: 'Alpha', p2: 'Beta', p3: 'Gamma' };

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  captureTelemetry: vi.fn(),
  showModal: vi.fn(),
  confirmDeleteProject: vi.fn(),
  setProjectOrder: vi.fn(),
  toast: vi.fn(),
  taskGitWorktree: undefined as { branchName: string } | undefined,
  currentView: 'project' as string,
  taskParams: {} as Record<string, string>,
  projectParams: {} as Record<string, string>,
  boardParams: {} as Record<string, string>,
  getProjectStore: vi.fn(),
  projectViewKind: 'ready' as string,
  sshState: 'connected' as string | null,
  loadLocalData: vi.fn(),
  loadRemoteData: vi.fn(),
  sidebarStore: null as unknown as MockSidebarStore,
  interfaceSettings: {} as Record<string, boolean>,
  TaskGitDiffStats: vi.fn(() => null),
  PrBadge: vi.fn(() => null),
  RelativeTime: vi.fn(() => null),
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: mocks.navigate }),
  useWorkspaceSlots: () => ({ currentView: mocks.currentView }),
  useParams: (viewId: string) => {
    if (viewId === 'task') return { params: mocks.taskParams };
    if (viewId === 'project') return { params: mocks.projectParams };
    if (viewId === 'board') return { params: mocks.boardParams };
    return { params: {} };
  },
}));

vi.mock('@renderer/lib/stores/app-state', async () => {
  const { observable } = await import('mobx');
  const store = observable({
    rawSidebarRows: [] as SidebarRow[],
    orderedProjects: [] as { id: string }[],
    expandedProjectIds: observable.set<string>(),
    collapsedStageGroupIdsByProject: {} as Record<string, string[]>,
    hiddenTaskIdsByProject: {} as Record<string, string[]>,
    visibleTaskIdsByProject: {} as Record<string, string[]>,
    taskSortBy: 'created-at' as string,
    get isEmpty() {
      return this.orderedProjects.length === 0;
    },
    // The real store's `sidebarRows` is a computed over the persisted
    // project order; this double mirrors that: rows in, project order
    // preserved (collapsed-group filtering only — no groups here).
    get sidebarRows() {
      return this.rawSidebarRows;
    },
    setProjectOrder: mocks.setProjectOrder,
    toggleProjectExpanded(projectId: string) {
      if (this.expandedProjectIds.has(projectId)) {
        this.expandedProjectIds.delete(projectId);
      } else {
        this.expandedProjectIds.add(projectId);
      }
    },
    ensureProjectExpanded(projectId: string) {
      this.expandedProjectIds.add(projectId);
    },
    toggleStageGroupCollapsed(projectId: string, stage: string) {
      const current = this.collapsedStageGroupIdsByProject[projectId] ?? [];
      const next = current.includes(stage)
        ? current.filter((s) => s !== stage)
        : [...current, stage];
      this.collapsedStageGroupIdsByProject = {
        ...this.collapsedStageGroupIdsByProject,
        [projectId]: next,
      };
    },
    isStageGroupCollapsed(projectId: string, stage: string) {
      return (this.collapsedStageGroupIdsByProject[projectId] ?? []).includes(stage);
    },
    visibleTaskIdsForProject(projectId: string) {
      return this.visibleTaskIdsByProject[projectId] ?? [];
    },
    // Mirrors `SidebarStore.headerFoldTaskIdsForProject`: the task ids the
    // stream omits for the project — collapsed-group tasks of expanded
    // projects, every displayable task of collapsed projects.
    headerFoldTaskIdsForProject(projectId: string) {
      const collapsedStages = this.collapsedStageGroupIdsByProject[projectId] ?? [];
      if (collapsedStages.length === 0 && this.expandedProjectIds.has(projectId)) return [];
      const taskIds = this.rawSidebarRows
        .filter((row) => row.kind === 'task' && row.projectId === projectId)
        .map((row) => (row as { taskId: string }).taskId);
      if (!this.expandedProjectIds.has(projectId)) return taskIds;
      const visible = new Set(this.visibleTaskIdsByProject[projectId] ?? []);
      return taskIds.filter((id) => !visible.has(id));
    },
    hideTaskFromSidebar: vi.fn(),
    showTaskInSidebar: vi.fn(),
  });
  mocks.sidebarStore = store as unknown as MockSidebarStore;
  return {
    sidebarStore: store,
    appState: {
      sshConnections: {
        stateFor: () => mocks.sshState,
        connect: vi.fn(),
      },
    },
  };
});

vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectStore: mocks.getProjectStore,
  projectViewKind: () => mocks.projectViewKind,
  getGitRepositoryStore: () => ({
    localData: { load: mocks.loadLocalData },
    remoteData: { load: mocks.loadRemoteData },
  }),
  getProjectManagerStore: () => undefined,
  asMounted: () => undefined,
  firstMountedProjectId: () => undefined,
  mountedProjectData: () => null,
  getProjectSshConnectionId: () => undefined,
  projectDisplayName: () => undefined,
  unmountedMountErrorMessage: () => undefined,
  getProjectSettingsStore: () => undefined,
  getPrSyncStore: () => undefined,
  getProjectViewStore: () => undefined,
}));

vi.mock('@renderer/features/projects/hooks/use-confirm-delete-project', () => ({
  useConfirmDeleteProject: () => mocks.confirmDeleteProject,
}));

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useShowModal: () => mocks.showModal,
  showModal: vi.fn(),
}));

vi.mock('@renderer/features/tasks/stores/task-selectors', () => ({
  getTaskManagerStore: (projectId: string) => {
    const tasks = managersByProject.get(projectId);
    return tasks ? { tasks } : undefined;
  },
  getTaskStore: (projectId: string, taskId: string) =>
    managersByProject.get(projectId)?.get(taskId),
  taskAgentStatus: (store: MockTaskStore) => store.status,
  getTaskGitWorktreeStore: () => mocks.taskGitWorktree,
  getWorkspaceForTask: () => undefined,
  // The remaining exports are read by real modules in the `task-store`
  // import chain; never exercised here.
  getRegisteredTaskData: () => undefined,
  getTaskView: () => undefined,
  getEditorView: () => undefined,
  getDiffView: () => undefined,
  taskViewKind: () => 'ready',
  asProvisioned: () => undefined,
  getWorkspaceViewModel: () => undefined,
  getConversationsForTask: () => [],
  getTerminalsForTask: () => [],
  taskDisplayName: () => undefined,
  taskErrorMessage: () => undefined,
  projectMountErrorMessage: () => undefined,
}));

vi.mock('@renderer/features/tasks/stores/task-store', () => ({
  registeredTaskData: (store: { data: unknown }) => store.data,
  unregisteredTaskData: () => undefined,
  isRegistered: () => true,
  isUnregistered: () => false,
  isUnprovisioned: () => false,
  isProvisioned: () => true,
  createUnregisteredTask: () => undefined,
  createUnprovisionedTask: () => undefined,
}));

vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({ value: mocks.interfaceSettings }),
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
  toast: mocks.toast,
}));

vi.mock('@renderer/utils/telemetryClient', () => ({
  captureTelemetry: mocks.captureTelemetry,
}));

vi.mock('@renderer/features/tasks/components/task-git-diff-stats', () => ({
  TaskGitDiffStats: mocks.TaskGitDiffStats,
}));
vi.mock('@renderer/lib/components/pr-badge', () => ({
  PrBadge: mocks.PrBadge,
}));
vi.mock('@renderer/lib/ui/relative-time', () => ({
  RelativeTime: mocks.RelativeTime,
}));

import { SidebarCardList } from '@renderer/features/sidebar/sidebar-card-list';

function makeTask(
  id: string,
  status: MockTaskStatus,
  overrides: Partial<MockTaskStore['data']> = {}
): MockTaskStore {
  return {
    state: 'provisioned',
    data: {
      id,
      name: id,
      type: 'task',
      prs: [],
      workflowStage: 'idea',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      isPinned: false,
      ...overrides,
    },
    isBootstrapping: false,
    status,
    updateBoardPosition: vi.fn().mockResolvedValue(undefined),
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

function defaultProject(id: string): MockProject {
  return {
    state: 'mounted',
    id,
    name: PROJECT_NAMES[id] ?? id,
    data: { id, name: PROJECT_NAMES[id] ?? id, type: 'local' },
  };
}

/** Three collapsed projects: the drag-reorder baseline. */
function threeProjectRows(): SidebarRow[] {
  return [
    { kind: 'project', projectId: 'p1' },
    { kind: 'project', projectId: 'p2' },
    { kind: 'project', projectId: 'p3' },
  ];
}

const LAYOUT_CSS = `
  html, body, #card-dnd-host { margin: 0; height: 100%; }
  .flex { display: flex; }
  .flex-col { flex-direction: column; }
  .flex-1 { flex: 1 1 0%; min-height: 0; }
  .min-h-0 { min-height: 0; }
  .h-full { height: 100%; }
  .overflow-y-auto { overflow-y: auto; }
  .px-2 { padding-left: 0.5rem; padding-right: 0.5rem; }
  .pt-1 { padding-top: 0.25rem; }
  .pb-3 { padding-bottom: 0.75rem; }
  .space-y-2 > * + * { margin-top: 0.5rem; }
  .h-9 { height: 2.25rem; }
  .h-8 { height: 2rem; }
  .items-center { align-items: center; }
  .justify-between { justify-content: space-between; }
  .gap-2 { gap: 0.5rem; }
  .gap-1 { gap: 0.25rem; }
  .px-1 { padding-left: 0.25rem; padding-right: 0.25rem; }
  .pl-1 { padding-left: 0.25rem; }
  .py-1\\.5 { padding-top: 0.375rem; padding-bottom: 0.375rem; }
  .border-l-2 { border-left: 2px solid; }
  .pl-3 { padding-left: 0.75rem; }
  .pb-1\\.5 { padding-bottom: 0.375rem; }
  .mr-1\\.5 { margin-right: 0.375rem; }
  .ml-\\[18px\\] { margin-left: 18px; }
`;

let host: HTMLDivElement;
let root: Root;
let style: HTMLStyleElement;

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle(frames = 2) {
  for (let i = 0; i < frames; i++) await frame();
}

async function mount(node: React.ReactNode) {
  root.render(node);
  await settle();
}

function store(): MockSidebarStore {
  return mocks.sidebarStore;
}

/** One project card's outer box (the droppable node). */
function cardContainer(projectId: string): HTMLElement {
  const el = host.querySelector(`[data-sidebar-project-id="${projectId}"]`);
  if (!el) throw new Error(`no card for ${projectId}`);
  return el as HTMLElement;
}

/** The card header row: the Open-project button's `SidebarMenuRow` parent. */
function cardHeader(projectId: string): HTMLElement {
  const action = host.querySelector<HTMLElement>(
    `button[aria-label="Open project ${PROJECT_NAMES[projectId]}"]`
  );
  if (!action) throw new Error(`no header for ${projectId}`);
  return action.parentElement as HTMLElement;
}

/** The insertion indicator line, portaled to the body mid-drag. */
function insertionIndicator(): HTMLElement | null {
  return document.querySelector<HTMLElement>('div.bg-primary');
}

/** The drag overlay replica, portaled to the body mid-drag. */
function dragOverlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>('div.shadow-md');
}

function renderedCardOrder(): string[] {
  return Array.from(host.querySelectorAll('[data-sidebar-project-id]')).map(
    (el) => el.getAttribute('data-sidebar-project-id')!
  );
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

/**
 * Drag `from` onto `toCard`'s top or bottom half. dnd-kit's collision and
 * drop math works on layout rects (droppable measurement is
 * transform-agnostic; the sortable strategy only shifts the *visual*
 * positions), so the target is the card's layout rect measured once, before
 * the drag moves anything. `onHover` runs with the drag still active, after
 * the final move, for mid-drag assertions.
 */
async function dragCardTo(
  from: Element,
  toCard: () => HTMLElement,
  drop: 'top' | 'bottom',
  onHover?: () => void
) {
  const start = center(from);
  from.dispatchEvent(pointer('pointerdown', start.x, start.y));
  await settle();
  // Exceed the 6px activation constraint, then walk to the target in steps
  // so dnd-kit gets intermediate collision passes (like a real hand would).
  const r = toCard().getBoundingClientRect();
  const finalX = r.left + r.width / 2;
  const finalY = drop === 'top' ? r.top + r.height * 0.25 : r.top + r.height * 0.75;
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    const x = start.x + ((finalX - start.x) * i) / steps;
    const y = start.y + ((finalY - start.y) * i) / steps;
    document.dispatchEvent(pointer('pointermove', x, y));
    await settle(2);
  }
  await settle(6);
  onHover?.();
  document.dispatchEvent(pointer('pointerup', finalX, finalY));
  await settle();
}

/** Apply a drop's persisted order to the double, like the real projection. */
function applyProjectOrder(order: string[]) {
  const s = store();
  s.orderedProjects = order.map((id) => ({ id }));
  s.rawSidebarRows = order.map((id) => ({ kind: 'project', projectId: id }) as SidebarRow);
}

describe('SidebarCardList drag-reorder (spec #120, ticket #123)', () => {
  beforeEach(async () => {
    await page.viewport(400, 800);
    style = document.createElement('style');
    style.textContent = LAYOUT_CSS;
    document.head.appendChild(style);
    host = document.createElement('div');
    host.id = 'card-dnd-host';
    document.body.appendChild(host);
    root = createRoot(host);

    managersByProject.clear();
    mocks.navigate.mockClear();
    mocks.captureTelemetry.mockClear();
    mocks.confirmDeleteProject.mockClear();
    mocks.setProjectOrder.mockClear();
    mocks.toast.mockClear();
    mocks.taskGitWorktree = undefined;
    mocks.currentView = 'project';
    mocks.taskParams = {};
    mocks.projectParams = {};
    mocks.boardParams = {};
    mocks.projectViewKind = 'ready';
    mocks.sshState = 'connected';
    mocks.getProjectStore.mockImplementation((id: string) => defaultProject(id));
    mocks.interfaceSettings = {};
    mocks.TaskGitDiffStats.mockClear();
    mocks.PrBadge.mockClear();
    mocks.RelativeTime.mockClear();

    const s = store();
    s.rawSidebarRows = threeProjectRows();
    s.orderedProjects = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
    s.expandedProjectIds.clear();
    s.collapsedStageGroupIdsByProject = {};
    s.hiddenTaskIdsByProject = {};
    s.visibleTaskIdsByProject = {};
    s.taskSortBy = 'created-at';
  });

  afterEach(() => {
    root.unmount();
    host.remove();
    style.remove();
  });

  it('drags a card below another: the indicator shows between cards and the drop persists the reordered order', async () => {
    await mount(<SidebarCardList />);

    // Gamma's layout rect is stable during the drag (droppable measurement
    // ignores the sortable visual shift), so the mid-drag indicator must
    // sit at its layout bottom edge — in the gap between Gamma and the next
    // card, never over the card itself.
    const gammaLayout = cardContainer('p3').getBoundingClientRect();
    let indicatorTop: number | null = null;
    let overlayText: string | null = null;
    await dragCardTo(
      cardHeader('p1'),
      () => cardContainer('p3'),
      'bottom',
      () => {
        const indicator = insertionIndicator();
        expect(indicator).not.toBeNull();
        indicatorTop = indicator ? parseFloat(indicator.style.top) : null;
        // The overlay replica shows the dragged card's identity while the
        // source card dims in place (still in the host, opacity 0.4).
        overlayText = dragOverlay()?.textContent ?? null;
        expect(cardContainer('p1').style.opacity).toBe('0.4');
      }
    );
    expect(indicatorTop).not.toBeNull();
    expect(Math.abs(indicatorTop! - (gammaLayout.bottom - 1.5))).toBeLessThan(3);
    expect(overlayText).toContain('Alpha');

    // The drop wrote the same persisted order the old project rows wrote.
    expect(mocks.setProjectOrder).toHaveBeenCalledTimes(1);
    expect(mocks.setProjectOrder).toHaveBeenCalledWith(['p2', 'p3', 'p1']);
    // The drag itself never tripped the header's click-to-board navigation.
    expect(mocks.navigate).not.toHaveBeenCalled();

    // The store write re-renders the cards in the new order.
    applyProjectOrder(['p2', 'p3', 'p1']);
    await settle();
    expect(renderedCardOrder()).toEqual(['p2', 'p3', 'p1']);
  });

  it('drags a card above the first card and lands it at the front', async () => {
    await mount(<SidebarCardList />);

    // Gamma's header onto Alpha's top half: the front slot.
    await dragCardTo(cardHeader('p3'), () => cardContainer('p1'), 'top');

    expect(mocks.setProjectOrder).toHaveBeenCalledTimes(1);
    expect(mocks.setProjectOrder).toHaveBeenCalledWith(['p3', 'p1', 'p2']);

    applyProjectOrder(['p3', 'p1', 'p2']);
    await settle();
    expect(renderedCardOrder()).toEqual(['p3', 'p1', 'p2']);
  });

  it('draws the insertion indicator at the over card top edge for an above drop', async () => {
    await mount(<SidebarCardList />);

    const betaLayout = cardContainer('p2').getBoundingClientRect();
    let indicatorTop: number | null = null;
    await dragCardTo(
      cardHeader('p1'),
      () => cardContainer('p2'),
      'top',
      () => {
        const indicator = insertionIndicator();
        indicatorTop = indicator ? parseFloat(indicator.style.top) : null;
      }
    );
    expect(indicatorTop).not.toBeNull();
    expect(Math.abs(indicatorTop! - (betaLayout.top - 1.5))).toBeLessThan(3);
  });

  it('does not write an order when the drop resolves back to the card own slot', async () => {
    await mount(<SidebarCardList />);

    // Alpha dropped above Beta is exactly where Alpha already is: the same
    // arrayMove adjustment the old project rows applied cancels to a no-op.
    await dragCardTo(cardHeader('p1'), () => cardContainer('p2'), 'top');

    expect(mocks.setProjectOrder).not.toHaveBeenCalled();
    expect(renderedCardOrder()).toEqual(['p1', 'p2', 'p3']);
  });

  it('keeps the header click-to-board navigation working next to the drag handle', async () => {
    await mount(<SidebarCardList />);

    // dnd-kit's pointer sensor suppresses clicks on the document for ~50ms
    // after a real drag ends (the click that follows a drag release). The
    // drag tests above leave that window open; a user's click never lands
    // inside it, so wait it out before asserting the plain-click path.
    await new Promise((resolve) => setTimeout(resolve, 60));
    await settle();

    const action = host.querySelector<HTMLElement>('button[aria-label="Open project Alpha"]')!;
    action.click();
    await settle();

    expect(mocks.navigate).toHaveBeenCalledWith('board', { projectId: 'p1' });
    expect(mocks.setProjectOrder).not.toHaveBeenCalled();
  });

  it('a task drag never reorders projects, and the task row keeps its click-to-task', async () => {
    store().rawSidebarRows = [
      { kind: 'project', projectId: 'p1' },
      { kind: 'task', projectId: 'p1', taskId: 't1' },
      { kind: 'task', projectId: 'p1', taskId: 't2' },
      { kind: 'project', projectId: 'p2' },
    ];
    store().expandedProjectIds.add('p1');
    managersByProject.set(
      'p1',
      new Map([
        ['t1', makeTask('t1', 'idle')],
        ['t2', makeTask('t2', 'idle')],
      ])
    );
    await mount(<SidebarCardList />);

    const taskRow = host.querySelector('[data-sidebar-task-id="t1"]') as HTMLElement;
    expect(taskRow).not.toBeNull();

    // Task drags stay inside their own project: dragging onto another
    // project's card may resolve to the nearest own-project row, but the
    // project order is never touched.
    await dragCardTo(taskRow, () => cardContainer('p2'), 'bottom');
    expect(mocks.setProjectOrder).not.toHaveBeenCalled();

    // And the task row keeps its own click-to-task navigation. The drag
    // above leaves dnd-kit's ~50ms click-suppression window open (the click
    // that follows a drag release), so wait it out before the plain click.
    await new Promise((resolve) => setTimeout(resolve, 60));
    await settle();
    taskRow.querySelector('button')?.click();
    await settle();
    expect(mocks.navigate).toHaveBeenCalledWith('task', { projectId: 'p1', taskId: 't1' });
  });
});

/**
 * One expanded project with two Stage Groups — the task drag-reorder
 * baseline (spec #85 ticket #89, restored on the cards).
 */
function groupedProjectRows(): SidebarRow[] {
  return [
    { kind: 'project', projectId: 'p1' },
    { kind: 'stage-group', projectId: 'p1', stage: 'idea', label: 'Idea', count: 3 },
    { kind: 'task', projectId: 'p1', taskId: 'idea-1' },
    { kind: 'task', projectId: 'p1', taskId: 'idea-2' },
    { kind: 'task', projectId: 'p1', taskId: 'idea-3' },
    { kind: 'stage-group', projectId: 'p1', stage: 'spec', label: 'Spec', count: 2 },
    { kind: 'task', projectId: 'p1', taskId: 'spec-1' },
    { kind: 'task', projectId: 'p1', taskId: 'spec-2' },
  ];
}

function groupedManagers() {
  managersByProject.set(
    'p1',
    new Map([
      ['idea-1', makeTask('idea-1', 'idle', { workflowStage: 'idea', boardRank: 'a' })],
      ['idea-2', makeTask('idea-2', 'idle', { workflowStage: 'idea', boardRank: 'm' })],
      ['idea-3', makeTask('idea-3', 'idle', { workflowStage: 'idea', boardRank: 'z' })],
      ['spec-1', makeTask('spec-1', 'idle', { workflowStage: 'spec', boardRank: 'a' })],
      ['spec-2', makeTask('spec-2', 'idle', { workflowStage: 'spec', boardRank: 'm' })],
    ])
  );
}

/** The sortable task row wrapper (dnd-kit listeners + data-sidebar-task-id). */
function taskRow(taskId: string): HTMLElement {
  const el = host.querySelector<HTMLElement>(`[data-sidebar-task-id="${taskId}"]`);
  if (!el) throw new Error(`no rendered task row for ${taskId}`);
  return el;
}

/** Press on `from`, walk to the target in steps, hover a beat, release. */
async function dragTo(
  from: Element,
  toX: number,
  toY: number,
  hoverFrames = 6,
  onHover?: () => void
) {
  const start = center(from);
  from.dispatchEvent(pointer('pointerdown', start.x, start.y));
  await settle();
  // Exceed the 6px activation constraint, then walk to the target in steps so
  // dnd-kit gets intermediate collision passes (like a real hand would).
  document.dispatchEvent(pointer('pointermove', start.x + 10, start.y + 2));
  await settle();
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    const x = start.x + ((toX - start.x) * i) / steps;
    const y = start.y + ((toY - start.y) * i) / steps;
    document.dispatchEvent(pointer('pointermove', x, y));
    await settle(2);
  }
  await settle(hoverFrames);
  onHover?.();
  document.dispatchEvent(pointer('pointerup', toX, toY));
  await settle();
}

describe('SidebarCardList task drag & drop between Stage Groups (spec #85, ticket #89, restored on cards)', () => {
  beforeEach(async () => {
    await page.viewport(400, 800);
    style = document.createElement('style');
    style.textContent = LAYOUT_CSS;
    document.head.appendChild(style);
    host = document.createElement('div');
    host.id = 'card-dnd-host';
    document.body.appendChild(host);
    root = createRoot(host);

    managersByProject.clear();
    mocks.navigate.mockClear();
    mocks.captureTelemetry.mockClear();
    mocks.confirmDeleteProject.mockClear();
    mocks.setProjectOrder.mockClear();
    mocks.toast.mockClear();
    mocks.taskGitWorktree = undefined;
    mocks.currentView = 'project';
    mocks.taskParams = {};
    mocks.projectParams = {};
    mocks.boardParams = {};
    mocks.projectViewKind = 'ready';
    mocks.sshState = 'connected';
    mocks.getProjectStore.mockImplementation((id: string) => defaultProject(id));
    mocks.interfaceSettings = {};
    mocks.TaskGitDiffStats.mockClear();
    mocks.PrBadge.mockClear();
    mocks.RelativeTime.mockClear();

    const s = store();
    s.rawSidebarRows = groupedProjectRows();
    s.orderedProjects = [{ id: 'p1' }];
    s.expandedProjectIds.clear();
    s.expandedProjectIds.add('p1');
    s.collapsedStageGroupIdsByProject = {};
    s.hiddenTaskIdsByProject = {};
    s.visibleTaskIdsByProject = {};
    s.taskSortBy = 'created-at';
    groupedManagers();
  });

  afterEach(() => {
    root.unmount();
    host.remove();
    style.remove();
  });

  it('writes the stage and an interpolated rank when dragging between groups', async () => {
    await mount(<SidebarCardList />);

    // idea-2 (rank 'm') dropped above spec-1 (rank 'a'): the Spec group's
    // first slot — a rank strictly before spec-1's.
    const spec1Center = center(taskRow('spec-1'));
    await dragTo(taskRow('idea-2'), spec1Center.x, spec1Center.y - 5);

    const idea2 = managersByProject.get('p1')!.get('idea-2')!;
    expect(idea2.updateBoardPosition).toHaveBeenCalledTimes(1);
    const [stage, rank] = idea2.updateBoardPosition.mock.calls[0]!;
    expect(stage).toBe('spec');
    expect(rank).toBeTruthy();
    expect(rank < 'a').toBe(true);
  });

  it('reorders within a group by interpolating between the neighbours it lands between', async () => {
    await mount(<SidebarCardList />);

    // idea-3 (rank 'z') dropped above idea-2 (rank 'm'): a rank strictly
    // between idea-1's 'a' and idea-2's 'm'.
    const idea2Center = center(taskRow('idea-2'));
    await dragTo(taskRow('idea-3'), idea2Center.x, idea2Center.y - 5);

    const idea3 = managersByProject.get('p1')!.get('idea-3')!;
    expect(idea3.updateBoardPosition).toHaveBeenCalledTimes(1);
    const [stage, rank] = idea3.updateBoardPosition.mock.calls[0]!;
    expect(stage).toBe('idea');
    expect(rank > 'a' && rank < 'm').toBe(true);
  });

  it('leaves a task unranked when dropped at the end of a group', async () => {
    await mount(<SidebarCardList />);

    // idea-1 (rank 'a') dropped below idea-3, the group's last visible row:
    // an end-of-group drop — stage-only, no rank.
    const idea3Center = center(taskRow('idea-3'));
    await dragTo(taskRow('idea-1'), idea3Center.x, idea3Center.y + 5);

    const idea1 = managersByProject.get('p1')!.get('idea-1')!;
    expect(idea1.updateBoardPosition).toHaveBeenCalledTimes(1);
    expect(idea1.updateBoardPosition).toHaveBeenCalledWith('idea', null);
  });

  it('rejects a cross-stage drop a GitHub fact would overwrite, with the board gating feedback and no promise line', async () => {
    // spec-1 is held in Spec by an open Spec issue: the Idea group is a
    // destination the next sync pass would reassert over (ADR 0006).
    managersByProject.get('p1')!.set(
      'spec-1',
      makeTask('spec-1', 'idle', {
        workflowStage: 'spec',
        boardRank: 'a',
        linkedIssues: openSpecLink(),
      })
    );
    await mount(<SidebarCardList />);

    const idea1Center = center(taskRow('idea-1'));
    let indicatorSeen = false;
    await dragTo(taskRow('spec-1'), idea1Center.x, idea1Center.y - 5, 6, () => {
      indicatorSeen = insertionIndicator() !== null;
    });

    expect(indicatorSeen).toBe(false);
    const spec1 = managersByProject.get('p1')!.get('spec-1')!;
    expect(spec1.updateBoardPosition).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    const toastCall = mocks.toast.mock.calls[0]![0] as { title?: string };
    expect(toastCall.title).toBe('Stage move blocked');
  });
});
