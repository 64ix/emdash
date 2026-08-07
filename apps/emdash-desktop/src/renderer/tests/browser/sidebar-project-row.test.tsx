/**
 * Browser-mode tests for the sidebar's project row: it is the canonical
 * entry point to a project's Feature Board — clicking it navigates to the
 * board (there is no dedicated Board row under the project anymore) — and it
 * carries the project's Needs Attention count, the same count the board's
 * own Needs Attention filter uses (Hidden Tasks excluded).
 *
 * Mounts the real `SidebarVirtualList` (dnd-kit + react-virtual, same
 * harness pattern as `board-dnd.test.tsx`) with the real `SidebarProjectItem`
 * and `SidebarTaskItem` stubbed out — this suite exercises the project row's
 * own affordances and its effect on the surrounding row model, not the task
 * row's (separately covered) behavior.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { SidebarRow } from '@renderer/features/sidebar/stage-group-row-model';

type MockTaskStatus = 'idle' | 'working' | 'awaiting-input' | 'error' | 'completed' | null;

type MockTaskStore = {
  data: {
    id: string;
    type: string;
    archivedAt?: string;
    workflowStage?: string;
    prs: unknown[];
  };
  status: MockTaskStatus;
};

const managersByProject = new Map<string, Map<string, MockTaskStore>>();

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  captureTelemetry: vi.fn(),
  ensureProjectExpanded: vi.fn(),
  currentView: 'project' as string,
  boardProjectId: undefined as string | undefined,
  sidebarRows: [] as SidebarRow[],
  hiddenTaskIdsByProject: {} as Record<string, string[]>,
  getProjectStore: vi.fn(),
  loadLocalData: vi.fn(),
  loadRemoteData: vi.fn(),
  showCreateTaskModal: vi.fn(),
  confirmDeleteProject: vi.fn(),
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: mocks.navigate }),
  useWorkspaceSlots: () => ({ currentView: mocks.currentView }),
  useParams: (viewId: string) => {
    if (viewId === 'board') return { params: { projectId: mocks.boardProjectId } };
    return { params: {} };
  },
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    sshConnections: {
      stateFor: () => 'connected',
    },
  },
  sidebarStore: {
    get sidebarRows() {
      return mocks.sidebarRows;
    },
    get hiddenTaskIdsByProject() {
      return mocks.hiddenTaskIdsByProject;
    },
    expandedProjectIds: { has: () => true },
    ensureProjectExpanded: mocks.ensureProjectExpanded,
    orderedProjects: [],
    setProjectOrder: vi.fn(),
    setTaskOrder: vi.fn(),
  },
}));

vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectStore: mocks.getProjectStore,
  projectViewKind: () => 'ready',
  getGitRepositoryStore: () => ({
    localData: { load: mocks.loadLocalData },
    remoteData: { load: mocks.loadRemoteData },
  }),
  // The remaining exports are read by the real `task-store` import chain;
  // never exercised here.
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
  useShowModal: () => mocks.showCreateTaskModal,
  // Imported by real modules in the `task-store` chain (see `getTaskView`
  // stub below); never called here.
  showModal: vi.fn(),
}));

vi.mock('@renderer/features/tasks/stores/task-selectors', () => ({
  getTaskManagerStore: (projectId: string) => {
    const tasks = managersByProject.get(projectId);
    return tasks ? { tasks } : undefined;
  },
  // `taskNeedsAttention` (via `board-attention.ts`) reads agent status off
  // the store; the real implementation needs full conversation stores.
  taskAgentStatus: (store: MockTaskStore) => store.status,
  // The remaining exports are read by the real `task-store` import chain
  // (conversation/workspace view models); never exercised here.
  getTaskStore: () => undefined,
  getRegisteredTaskData: () => undefined,
  getTaskView: () => undefined,
  getEditorView: () => undefined,
  getDiffView: () => undefined,
  getTaskGitWorktreeStore: () => undefined,
  taskViewKind: () => 'ready',
  asProvisioned: () => undefined,
  getWorkspaceForTask: () => undefined,
  getWorkspaceViewModel: () => undefined,
  getConversationsForTask: () => [],
  getTerminalsForTask: () => [],
  taskDisplayName: () => undefined,
  taskErrorMessage: () => undefined,
  projectMountErrorMessage: () => undefined,
}));

vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({ value: {} }),
}));

vi.mock('@renderer/utils/telemetryClient', () => ({
  captureTelemetry: mocks.captureTelemetry,
}));

vi.mock('@renderer/features/sidebar/task-item', () => ({
  SidebarTaskItem: ({ projectId, taskId }: { projectId: string; taskId: string }) => (
    <div data-row="task">{`task:${projectId}:${taskId}`}</div>
  ),
}));

import { SidebarVirtualList } from '@renderer/features/sidebar/sidebar-virtual-list';

function makeTask(
  id: string,
  status: MockTaskStatus,
  overrides: Partial<MockTaskStore['data']> = {}
): MockTaskStore {
  return {
    data: { id, type: 'task', prs: [], ...overrides },
    status,
  };
}

const LAYOUT_CSS = `
  html, body, #sidebar-host { margin: 0; height: 100%; }
  .flex { display: flex; }
  .flex-col { flex-direction: column; }
  .flex-1 { flex: 1 1 0%; min-height: 0; }
  .min-h-0 { min-height: 0; }
  .h-full { height: 100%; }
  .overflow-y-auto { overflow-y: auto; }
`;

let host: HTMLDivElement;
let root: Root;
let style: HTMLStyleElement;

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle(frames = 2) {
  for (let i = 0; i < frames; i++) await frame();
}

async function mount() {
  root.render(
    <div className="flex h-full flex-col">
      <SidebarVirtualList />
    </div>
  );
  await settle();
}

function projectButton(): HTMLButtonElement {
  return host.querySelector('button[aria-label^="Open project"]') as HTMLButtonElement;
}

/** The project row is the button's `SidebarMenuRow` ancestor (`data-active`). */
function projectRow(): HTMLElement | null {
  return projectButton()?.closest('[data-active]') ?? null;
}

/** Row kinds in rendered (document) order, mixing the real project row with the stubbed task rows. */
function renderedRowKinds(): string[] {
  const els = Array.from(
    host.querySelectorAll<HTMLElement>('button[aria-label^="Open project"], [data-row="task"]')
  );
  return els.map((el) => (el.matches('button') ? 'project' : 'task'));
}

describe('sidebar project row: board entry point', () => {
  beforeEach(async () => {
    await page.viewport(400, 800);
    style = document.createElement('style');
    style.textContent = LAYOUT_CSS;
    document.head.appendChild(style);
    host = document.createElement('div');
    host.id = 'sidebar-host';
    document.body.appendChild(host);
    root = createRoot(host);

    managersByProject.clear();
    mocks.navigate.mockClear();
    mocks.captureTelemetry.mockClear();
    mocks.ensureProjectExpanded.mockClear();
    mocks.currentView = 'project';
    mocks.boardProjectId = undefined;
    mocks.hiddenTaskIdsByProject = {};
    mocks.sidebarRows = [
      { kind: 'project', projectId: 'p1' },
      { kind: 'task', projectId: 'p1', taskId: 't1' },
      { kind: 'task', projectId: 'p1', taskId: 't2' },
    ];
    mocks.getProjectStore.mockReturnValue({
      state: 'mounted',
      id: 'p1',
      name: 'Project One',
      data: { id: 'p1', name: 'Project One', type: 'local' },
    });
  });

  afterEach(() => {
    root.unmount();
    host.remove();
    style.remove();
  });

  it('renders the project row followed by task rows, with no Board row beneath the project', async () => {
    await mount();
    expect(renderedRowKinds()).toEqual(['project', 'task', 'task']);
    expect(host.querySelector('button[aria-label="Open Feature Board"]')).toBeNull();
  });

  it('is inactive while the project view is open', async () => {
    mocks.currentView = 'project';
    await mount();
    expect(projectButton().closest('[data-active="true"]')).toBeNull();
  });

  it('shows an active state, and expands its project, when its board is the open view', async () => {
    mocks.currentView = 'board';
    mocks.boardProjectId = 'p1';
    await mount();
    expect(projectRow()?.getAttribute('data-active')).toBe('true');
    expect(mocks.ensureProjectExpanded).toHaveBeenCalledWith('p1');
  });

  it('does not activate when the open board belongs to a different project', async () => {
    mocks.currentView = 'board';
    mocks.boardProjectId = 'some-other-project';
    await mount();
    expect(projectButton().closest('[data-active="true"]')).toBeNull();
  });

  it('navigates to the project board and records the sidebar entry source on click', async () => {
    await mount();
    projectButton().click();
    expect(mocks.navigate).toHaveBeenCalledWith('board', { projectId: 'p1' });
    expect(mocks.captureTelemetry).toHaveBeenCalledWith('board_opened', {
      source: 'sidebar',
      project_id: 'p1',
    });
  });

  it('surfaces an attention count for displayable tasks needing attention', async () => {
    managersByProject.set(
      'p1',
      new Map([
        ['t1', makeTask('t1', 'awaiting-input')],
        ['t2', makeTask('t2', 'working')],
        // Archived: excluded from `isBoardDisplayable`, so its 'error' status
        // must not inflate the count.
        ['t3', makeTask('t3', 'error', { archivedAt: '2026-01-01T00:00:00.000Z' })],
      ])
    );
    await mount();
    const badge = host.querySelector('[aria-label$="need attention"]');
    expect(badge?.textContent).toBe('1');
  });

  it('hides the attention badge when nothing needs attention', async () => {
    managersByProject.set('p1', new Map([['t1', makeTask('t1', 'idle')]]));
    await mount();
    expect(host.querySelector('[aria-label$="need attention"]')).toBeNull();
  });

  it('excludes hidden tasks from the attention count (spec #85, ticket #87)', async () => {
    managersByProject.set(
      'p1',
      new Map([
        ['t1', makeTask('t1', 'awaiting-input')],
        ['t2', makeTask('t2', 'awaiting-input')],
      ])
    );
    // t2 is a Hidden Task — sidebar-only view state, so it must not inflate
    // the badge even though the board would count it.
    mocks.hiddenTaskIdsByProject = { p1: ['t2'] };
    await mount();
    const badge = host.querySelector('[aria-label$="need attention"]');
    expect(badge?.textContent).toBe('1');
  });
});
