/**
 * Browser-mode tests for the sidebar's Board row (ticket #43): row ordering
 * in the sidebar's ordered row model, active-state parity with the board
 * view, the attention count, and the click-to-navigate + telemetry-source
 * affordance.
 *
 * Mounts the real `SidebarVirtualList` (dnd-kit + react-virtual, same
 * harness pattern as `board-dnd.test.tsx`) with `SidebarProjectItem` and
 * `SidebarTaskItem` stubbed out — this suite exercises the new Board row and
 * its effect on the surrounding row model, not those components' own
 * (separately covered) behavior.
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

vi.mock('@renderer/features/tasks/stores/task-selectors', () => ({
  getTaskManagerStore: (projectId: string) => {
    const tasks = managersByProject.get(projectId);
    return tasks ? { tasks } : undefined;
  },
  taskAgentStatus: (store: MockTaskStore) => store.status,
  getTaskStore: () => undefined,
}));

vi.mock('@renderer/features/tasks/stores/task-store', () => ({
  registeredTaskData: (store: MockTaskStore) => store.data,
}));

vi.mock('@renderer/utils/telemetryClient', () => ({
  captureTelemetry: mocks.captureTelemetry,
}));

vi.mock('@renderer/features/sidebar/project-item', () => ({
  SidebarProjectItem: ({ projectId }: { projectId: string }) => (
    <div data-row="project">{`project:${projectId}`}</div>
  ),
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

function boardButton(): HTMLButtonElement {
  return host.querySelector('button[aria-label="Open Feature Board"]') as HTMLButtonElement;
}

/** Row kinds in rendered (document) order, mixing the real Board row with the stubbed rows. */
function renderedRowKinds(): string[] {
  const els = Array.from(
    host.querySelectorAll<HTMLElement>('[data-row], [aria-label="Open Feature Board"]')
  );
  return els.map((el) => el.getAttribute('data-row') ?? 'board');
}

describe('sidebar Board row (ticket #43)', () => {
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
      { kind: 'board', projectId: 'p1' },
      { kind: 'task', projectId: 'p1', taskId: 't1' },
      { kind: 'task', projectId: 'p1', taskId: 't2' },
    ];
  });

  afterEach(() => {
    root.unmount();
    host.remove();
    style.remove();
  });

  it('places the Board row before task rows, right after its project row', async () => {
    await mount();
    expect(renderedRowKinds()).toEqual(['project', 'board', 'task', 'task']);
  });

  it('is inactive while the project view is open', async () => {
    mocks.currentView = 'project';
    await mount();
    expect(boardButton().parentElement?.getAttribute('data-active')).toBeNull();
  });

  it('shows an active state, and expands its project, when its board is the open view', async () => {
    mocks.currentView = 'board';
    mocks.boardProjectId = 'p1';
    await mount();
    expect(boardButton().parentElement?.getAttribute('data-active')).toBe('true');
    expect(mocks.ensureProjectExpanded).toHaveBeenCalledWith('p1');
  });

  it('does not activate when the open board belongs to a different project', async () => {
    mocks.currentView = 'board';
    mocks.boardProjectId = 'some-other-project';
    await mount();
    expect(boardButton().parentElement?.getAttribute('data-active')).toBeNull();
  });

  it('navigates to the project board and records the sidebar entry source on click', async () => {
    await mount();
    boardButton().click();
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
