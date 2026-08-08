/**
 * Browser-mode tests for spec #120, ticket #122 (Sidebar project cards UI).
 *
 * Mounts the real `SidebarCardList` (project cards + Stage Group headers +
 * real task rows) with the surrounding stores/providers mocked — the harness
 * pattern of `sidebar-project-row.test.tsx` — and drives the sidebar store
 * through a small MobX-observable double, so chevron and group-collapse
 * interactions re-render like the real app.
 *
 * Covers the ticket's acceptance criteria: card header contents (chip, name,
 * aggregate signal, attention chip, count badge, chevron), header click →
 * Feature Board vs. chevron → expand/collapse (never both), the project-hued
 * rail with nested Stage Groups and task rows, per-group collapse, the
 * collapsed-project header aggregates seam (ticket #121 review), active
 * states, SSH dot, missing-path warning and the empty state. Task rows keep
 * their own affordances: leading status dot language, pinned hue dot +
 * project name, and the jade active treatment.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { projectHue } from '@renderer/features/sidebar/project-card-model';
import type { SidebarRow } from '@renderer/features/sidebar/stage-group-row-model';

type MockTaskStatus = 'idle' | 'working' | 'awaiting-input' | 'error' | 'completed' | null;

type MockTaskStore = {
  state: string;
  data: {
    id: string;
    name: string;
    type: string;
    prs: unknown[];
    workflowStage?: string;
    createdAt?: string;
    updatedAt?: string;
    isPinned?: boolean;
    archivedAt?: string;
  };
  isBootstrapping: boolean;
  status: MockTaskStatus;
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
  toggleProjectExpanded(projectId: string): void;
  ensureProjectExpanded(projectId: string): void;
  toggleStageGroupCollapsed(projectId: string, stage: string): void;
  isStageGroupCollapsed(projectId: string, stage: string): boolean;
  visibleTaskIdsForProject(projectId: string): string[];
  hideTaskFromSidebar: ReturnType<typeof vi.fn>;
  showTaskInSidebar: ReturnType<typeof vi.fn>;
};

const managersByProject = new Map<string, Map<string, MockTaskStore>>();

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  captureTelemetry: vi.fn(),
  showModal: vi.fn(),
  confirmDeleteProject: vi.fn(),
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
    // collapse state (buildStageGroupedRows omits collapsed-group task
    // rows); this double mirrors that: raw rows in, collapsed groups
    // filtered out.
    get sidebarRows() {
      const collapsed = new Set<string>();
      for (const [pid, stages] of Object.entries(this.collapsedStageGroupIdsByProject)) {
        for (const stage of stages) collapsed.add(`${pid}:${stage}`);
      }
      const out: SidebarRow[] = [];
      let currentGroup: string | null = null;
      for (const row of this.rawSidebarRows) {
        if (row.kind === 'project') {
          currentGroup = null;
        } else if (row.kind === 'stage-group') {
          currentGroup = `${row.projectId}:${row.stage}`;
        } else if (currentGroup !== null && collapsed.has(currentGroup)) {
          continue;
        }
        out.push(row);
      }
      return out;
    },
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
  getTaskGitWorktreeStore: () => undefined,
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
  useToast: () => ({ toast: vi.fn() }),
  toast: vi.fn(),
}));

vi.mock('@renderer/utils/telemetryClient', () => ({
  captureTelemetry: mocks.captureTelemetry,
}));

// Presentational children of the task row — spied here so the
// settings-gated trailing metadata (showLeftSidebar*, spec #120 US12) can be
// asserted to mount and unmount with its settings.
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
import { SidebarTaskItem } from '@renderer/features/sidebar/task-item';

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
  };
}

function defaultProject(overrides: Partial<MockProject> = {}): MockProject {
  return {
    state: 'mounted',
    id: 'p1',
    name: 'Project One',
    data: { id: 'p1', name: 'Project One', type: 'local' },
    ...overrides,
  };
}

/** One expanded project: an Idea Stage Group (t1) and a Spec group (t2). */
function expandedProjectRows(): SidebarRow[] {
  return [
    { kind: 'project', projectId: 'p1' },
    { kind: 'stage-group', projectId: 'p1', stage: 'idea', label: 'Idea', count: 1 },
    { kind: 'task', projectId: 'p1', taskId: 't1' },
    { kind: 'stage-group', projectId: 'p1', stage: 'spec', label: 'Spec', count: 1 },
    { kind: 'task', projectId: 'p1', taskId: 't2' },
  ];
}

let host: HTMLDivElement;
let root: Root;

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

/** The card header row (`SidebarMenuRow` div, data-active carries the state). */
function cardHeader(): HTMLElement | null {
  return host.querySelector('[data-sidebar-project-id="p1"] [data-active]') as HTMLElement | null;
}

function projectAction(): HTMLButtonElement {
  return host.querySelector('button[aria-label^="Open project"]') as HTMLButtonElement;
}

function rail(): HTMLElement | null {
  return host.querySelector('div.border-l-2') as HTMLElement | null;
}

function groupAction(label: string): HTMLElement | null {
  return host.querySelector(`[aria-label^="${label},"]`);
}

describe('SidebarCardList (spec #120, ticket #122)', () => {
  beforeEach(async () => {
    await page.viewport(400, 800);
    host = document.createElement('div');
    host.id = 'card-list-host';
    document.body.appendChild(host);
    root = createRoot(host);

    managersByProject.clear();
    mocks.navigate.mockClear();
    mocks.captureTelemetry.mockClear();
    mocks.confirmDeleteProject.mockClear();
    mocks.currentView = 'project';
    mocks.taskParams = {};
    mocks.projectParams = {};
    mocks.boardParams = {};
    mocks.projectViewKind = 'ready';
    mocks.sshState = 'connected';
    mocks.getProjectStore.mockReturnValue(defaultProject());
    mocks.interfaceSettings = {};
    mocks.TaskGitDiffStats.mockClear();
    mocks.PrBadge.mockClear();
    mocks.RelativeTime.mockClear();

    const s = store();
    s.rawSidebarRows = [];
    s.orderedProjects = [{ id: 'p1' }];
    s.expandedProjectIds.clear();
    s.collapsedStageGroupIdsByProject = {};
    s.hiddenTaskIdsByProject = {};
    s.visibleTaskIdsByProject = {};
    s.taskSortBy = 'created-at';
  });

  afterEach(() => {
    root.unmount();
    host.remove();
  });

  it('renders one bordered card per project with chip, name and chevron', async () => {
    store().rawSidebarRows = [{ kind: 'project', projectId: 'p1' }];
    await mount(<SidebarCardList />);

    const container = host.querySelector('[data-sidebar-project-id="p1"]');
    expect(container).not.toBeNull();
    expect(container?.className).toContain('border');
    // Identity chip: initial on the project hue.
    expect(container?.querySelector('span[style*="background-color"]')?.textContent).toBe('P');
    expect(projectAction()?.textContent).toContain('Project One');
    expect(host.querySelector('button[aria-label="Expand Project One"]')).not.toBeNull();
  });

  it('collapsed project header shows aggregate signal, attention chip and task count from the store refs seam', async () => {
    // Collapsed project: the stream carries only the project row; the
    // header aggregates come from the caller-supplied visible task refs
    // (ticket #121 review — the wiring this ticket owes).
    store().rawSidebarRows = [{ kind: 'project', projectId: 'p1' }];
    store().visibleTaskIdsByProject = { p1: ['t1', 't2'] };
    managersByProject.set(
      'p1',
      new Map([
        ['t1', makeTask('t1', 'error')],
        ['t2', makeTask('t2', 'awaiting-input')],
      ])
    );
    await mount(<SidebarCardList />);

    // Aggregate signal: error outranks awaiting-input.
    expect(host.querySelector('[aria-label="Error"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Needs input"]')).toBeNull();
    // Attention chip counts both tasks (error + awaiting-input).
    const attention = host.querySelector('[aria-label$="need attention"]');
    expect(attention?.textContent).toBe('2');
    // Task count badge from the refs.
    const count = host.querySelector('[aria-label="2 tasks"]');
    expect(count?.textContent).toBe('2');
  });

  it('opens the Feature Board on header click, with no expand toggle', async () => {
    store().rawSidebarRows = [{ kind: 'project', projectId: 'p1' }];
    await mount(<SidebarCardList />);

    projectAction().click();
    await settle();
    expect(mocks.navigate).toHaveBeenCalledWith('board', { projectId: 'p1' });
    expect(mocks.captureTelemetry).toHaveBeenCalledWith('board_opened', {
      source: 'sidebar',
      project_id: 'p1',
    });
    expect(store().expandedProjectIds.has('p1')).toBe(false);
  });

  it('chevron expands and collapses the card without navigating', async () => {
    store().rawSidebarRows = [{ kind: 'project', projectId: 'p1' }];
    await mount(<SidebarCardList />);

    const chevron = host.querySelector('button[aria-label="Expand Project One"]') as HTMLElement;
    chevron.click();
    await settle();
    expect(store().expandedProjectIds.has('p1')).toBe(true);
    expect(mocks.navigate).not.toHaveBeenCalled();
    // Re-rendered: chevron now reads collapse, card body appeared.
    expect(host.querySelector('button[aria-label="Collapse Project One"]')).not.toBeNull();
    expect(rail()).not.toBeNull();

    (host.querySelector('button[aria-label="Collapse Project One"]') as HTMLElement).click();
    await settle();
    expect(store().expandedProjectIds.has('p1')).toBe(false);
    expect(rail()).toBeNull();
  });

  it('nests Stage Groups and task rows under the project-hued rail when expanded', async () => {
    store().rawSidebarRows = expandedProjectRows();
    store().expandedProjectIds.add('p1');
    managersByProject.set(
      'p1',
      new Map([
        ['t1', makeTask('t1', 'idle')],
        ['t2', makeTask('t2', 'idle')],
      ])
    );
    await mount(<SidebarCardList />);

    // The rail carries the project hue.
    expect(rail()?.getAttribute('style')).toContain('color-mix');
    // Stage Group headers keep label + count.
    expect(groupAction('Idea')).not.toBeNull();
    expect(groupAction('Spec')).not.toBeNull();
    // Task rows render nested under the rail.
    expect(host.querySelector('button[aria-label="Open task t1"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Open task t2"]')).not.toBeNull();
  });

  it('collapses a Stage Group on its header click, hiding only its tasks', async () => {
    store().rawSidebarRows = expandedProjectRows();
    store().expandedProjectIds.add('p1');
    managersByProject.set(
      'p1',
      new Map([
        ['t1', makeTask('t1', 'idle')],
        ['t2', makeTask('t2', 'idle')],
      ])
    );
    await mount(<SidebarCardList />);

    groupAction('Idea')!.click();
    await settle();
    expect(store().collapsedStageGroupIdsByProject['p1']).toEqual(['idea']);
    // The group header stays, its task row is gone; the other group is intact.
    expect(groupAction('Idea')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Open task t1"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Open task t2"]')).not.toBeNull();

    // Toggling again restores the row.
    groupAction('Idea')!.click();
    await settle();
    expect(host.querySelector('button[aria-label="Open task t1"]')).not.toBeNull();
  });

  it('shows the Shipped disclosure caption on the Shipped group', async () => {
    store().rawSidebarRows = [
      { kind: 'project', projectId: 'p1' },
      { kind: 'stage-group', projectId: 'p1', stage: 'shipped', label: 'Shipped', count: 1 },
      { kind: 'task', projectId: 'p1', taskId: 't1' },
    ];
    store().expandedProjectIds.add('p1');
    managersByProject.set('p1', new Map([['t1', makeTask('t1', 'idle')]]));
    await mount(<SidebarCardList />);

    const action = groupAction('Shipped');
    expect(action?.getAttribute('aria-label')).toContain('Shipped cards are hidden');
    expect(action?.closest('div')?.textContent).toContain('hides after');
  });

  it('keeps the card active (jade) while its board is the open view', async () => {
    store().rawSidebarRows = [{ kind: 'project', projectId: 'p1' }];
    mocks.currentView = 'board';
    mocks.boardParams = { projectId: 'p1' };
    await mount(<SidebarCardList />);

    expect(cardHeader()?.getAttribute('data-active')).toBe('true');
    expect(cardHeader()?.getAttribute('style')).toContain('var(--jade-9)');

    // A different project's board leaves this card inactive. The keyed
    // remount forces a fresh render (the observer memo would otherwise skip
    // it: the params mock is not observable state).
    mocks.boardParams = { projectId: 'other' };
    await mount(<SidebarCardList key="other" />);
    expect(cardHeader()?.getAttribute('data-active')).toBeUndefined();
  });

  it('keeps the SSH connection dot on the header', async () => {
    store().rawSidebarRows = [{ kind: 'project', projectId: 'p1' }];
    mocks.getProjectStore.mockReturnValue(
      defaultProject({ data: { id: 'p1', name: 'Project One', type: 'ssh', connectionId: 'c1' } })
    );
    mocks.sshState = 'disconnected';
    await mount(<SidebarCardList />);

    expect(host.querySelector('[aria-label="Connection disconnected"]')).not.toBeNull();
    // No missing-path warning for an SSH project.
    expect(host.querySelector('svg.lucide-triangle-alert')).toBeNull();
  });

  it('keeps the missing-path warning on the header', async () => {
    store().rawSidebarRows = [{ kind: 'project', projectId: 'p1' }];
    mocks.projectViewKind = 'path_not_found';
    await mount(<SidebarCardList />);

    expect(host.querySelector('svg.lucide-triangle-alert')).not.toBeNull();
  });

  it('renders the helpful empty state when there are no projects', async () => {
    store().orderedProjects = [];
    await mount(<SidebarCardList />);

    expect(host.textContent).toContain('No projects yet — use the + button to add one.');
  });
});

describe('SidebarTaskItem inside cards (spec #120, ticket #122)', () => {
  beforeEach(async () => {
    await page.viewport(400, 400);
    host = document.createElement('div');
    host.id = 'task-row-host';
    document.body.appendChild(host);
    root = createRoot(host);

    managersByProject.clear();
    managersByProject.set('p1', new Map([['t1', makeTask('t1', 'idle')]]));
    mocks.navigate.mockClear();
    mocks.currentView = 'project';
    mocks.taskParams = {};
    mocks.getProjectStore.mockReturnValue(defaultProject());
    mocks.interfaceSettings = {};
    mocks.TaskGitDiffStats.mockClear();
    mocks.PrBadge.mockClear();
    mocks.RelativeTime.mockClear();
  });

  afterEach(() => {
    root.unmount();
    host.remove();
  });

  it('leads each task row with the status dot language (spinner / amber / red / green)', async () => {
    const statuses: Array<[MockTaskStatus, string]> = [
      ['working', 'Working'],
      ['awaiting-input', 'Needs input'],
      ['error', 'Error'],
      ['completed', 'Done'],
    ];
    for (const [status, label] of statuses) {
      managersByProject.set('p1', new Map([['t1', makeTask('t1', status)]]));
      await mount(<SidebarTaskItem key={status} projectId="p1" taskId="t1" rowVariant="card" />);
      expect(host.querySelector(`[aria-label="${label}"]`), `status ${status}`).not.toBeNull();
    }
  });

  it('shows no dot for an idle task', async () => {
    await mount(<SidebarTaskItem projectId="p1" taskId="t1" rowVariant="card" />);
    expect(host.querySelector('[aria-label="Working"]')).toBeNull();
    expect(host.querySelector('[aria-label="Needs input"]')).toBeNull();
    expect(host.querySelector('[aria-label="Error"]')).toBeNull();
    expect(host.querySelector('[aria-label="Done"]')).toBeNull();
  });

  it('gates the trailing metadata by the showLeftSidebar* settings (spec #120 US12)', async () => {
    // A task with an open PR, so the PR badge would render when enabled.
    managersByProject.set(
      'p1',
      new Map([
        [
          't1',
          makeTask('t1', 'idle', {
            prs: [{ status: 'open', createdAt: '2026-01-02T00:00:00.000Z' }],
          }),
        ],
      ])
    );

    mocks.interfaceSettings = {
      showLeftSidebarLineChanges: false,
      showLeftSidebarPrStatus: false,
      showLeftSidebarTimestamps: false,
    };
    await mount(<SidebarTaskItem projectId="p1" taskId="t1" rowVariant="card" />);
    expect(mocks.TaskGitDiffStats).not.toHaveBeenCalled();
    expect(mocks.PrBadge).not.toHaveBeenCalled();
    expect(mocks.RelativeTime).not.toHaveBeenCalled();

    mocks.interfaceSettings = {
      showLeftSidebarLineChanges: true,
      showLeftSidebarPrStatus: true,
      showLeftSidebarTimestamps: true,
    };
    await mount(<SidebarTaskItem key="all-on" projectId="p1" taskId="t1" rowVariant="card" />);
    expect(mocks.TaskGitDiffStats).toHaveBeenCalled();
    expect(mocks.PrBadge).toHaveBeenCalled();
    expect(mocks.RelativeTime).toHaveBeenCalled();
  });

  it('pinned rows keep the project hue dot and project name', async () => {
    await mount(<SidebarTaskItem projectId="p1" taskId="t1" rowVariant="pinned" />);
    const dot = host.querySelector('span[style*="background-color"]');
    expect(dot?.getAttribute('style')).toContain(projectHue('p1').dot);
    expect(host.textContent).toContain('Project One');
  });

  it('paints the active task row jade', async () => {
    mocks.currentView = 'task';
    mocks.taskParams = { projectId: 'p1', taskId: 't1' };
    await mount(<SidebarTaskItem projectId="p1" taskId="t1" rowVariant="card" />);
    const row = host.querySelector('[data-active="true"]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute('style')).toContain('var(--jade-9)');
    expect(row?.textContent).toContain('t1');
    const name = Array.from(row?.querySelectorAll('span') ?? []).find((el) =>
      el.className.includes('text-[var(--jade-11)]')
    );
    expect(name).not.toBeNull();
  });
});
