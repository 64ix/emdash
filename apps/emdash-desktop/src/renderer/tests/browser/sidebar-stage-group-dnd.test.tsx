/**
 * Browser-mode tests for spec #85, ticket #89 (drag & drop tasks between
 * Stage Groups):
 *
 * - dragging a task between groups changes its stage and writes the board's
 *   interpolated Board Rank through `updateBoardPosition`, and the row lands
 *   in the target group;
 * - dropping below a group's last visible row is an end-of-group drop —
 *   stage-only, unranked;
 * - dropping between Unstaged rows clears the stage and places by rank;
 * - a cross-stage drop a governing GitHub fact would overwrite is rejected
 *   with the board's gating feedback (toast), and the insertion indicator
 *   never promises it;
 * - Stage Group headers are not draggable; the stale
 *   manual task-order write never fires.
 *
 * Mounts the real `SidebarVirtualList` (dnd-kit + react-virtual, same
 * harness pattern as `sidebar-project-row.test.tsx` and the drag driver of
 * `board-dnd.test.tsx`) with `SidebarProjectItem`/`SidebarTaskItem` stubbed
 * out — the drag targets are the sortable row wrappers themselves, so the
 * gesture is fully real.
 */
import { observable } from 'mobx';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { SidebarRow } from '@renderer/features/sidebar/stage-group-row-model';
import type { LinkedIssueRoles } from '@shared/core/linked-issue';

type MockStore = {
  data: {
    id: string;
    name: string;
    type: string;
    status: string;
    workflowStage?: string;
    boardRank?: string;
    prs: unknown[];
    linkedIssues?: LinkedIssueRoles;
    workspaceId?: string;
  };
  updateBoardPosition: ReturnType<typeof vi.fn>;
};

const storesById = new Map<string, MockStore>();
const managersByProject = new Map<string, Map<string, MockStore>>();

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  captureTelemetry: vi.fn(),
  toast: vi.fn(),
  ensureProjectExpanded: vi.fn(),
  setProjectOrder: vi.fn(),
  setTaskOrder: vi.fn(),
  toggleStageGroupCollapsed: vi.fn(),
  isStageGroupCollapsed: vi.fn(() => false),
  sidebarRows: [] as SidebarRow[],
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: mocks.navigate }),
  useWorkspaceSlots: () => ({ currentView: 'project' }),
  useParams: () => ({ params: {} }),
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  sidebarStore: {
    get sidebarRows() {
      return mocks.sidebarRows;
    },
    hiddenTaskIdsByProject: {},
    expandedProjectIds: { has: () => true },
    ensureProjectExpanded: mocks.ensureProjectExpanded,
    orderedProjects: [],
    setProjectOrder: mocks.setProjectOrder,
    setTaskOrder: mocks.setTaskOrder,
    toggleStageGroupCollapsed: mocks.toggleStageGroupCollapsed,
    isStageGroupCollapsed: mocks.isStageGroupCollapsed,
  },
}));

vi.mock('@renderer/features/tasks/stores/task-selectors', () => ({
  getTaskManagerStore: (projectId: string) => {
    const tasks = managersByProject.get(projectId);
    return tasks ? { tasks } : undefined;
  },
  getTaskStore: (_projectId: string, taskId: string) => storesById.get(taskId),
  getTaskGitWorktreeStore: () => undefined,
  taskAgentStatus: () => 'idle',
}));

vi.mock('@renderer/features/tasks/stores/task-store', () => ({
  registeredTaskData: (store: MockStore) => store.data,
}));

vi.mock('@renderer/utils/telemetryClient', () => ({
  captureTelemetry: mocks.captureTelemetry,
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
  toast: mocks.toast,
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

function makeStore(id: string, overrides: Partial<MockStore['data']> = {}): MockStore {
  return {
    data: { id, name: id, type: 'task', status: 'idle', prs: [], ...overrides },
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

const LAYOUT_CSS = `
  html, body, #sidebar-host { margin: 0; height: 100%; }
  .flex { display: flex; }
  .flex-col { flex-direction: column; }
  .flex-1 { flex: 1 1 0%; min-height: 0; }
  .min-h-0 { min-height: 0; }
  .h-full { height: 100%; }
  .overflow-y-auto { overflow-y: auto; }
  .px-3 { padding-left: 0.75rem; padding-right: 0.75rem; }
  .pt-1 { padding-top: 0.25rem; }
  .pb-3 { padding-bottom: 0.75rem; }
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

/** The sortable row wrapper (dnd-kit listeners) around a stubbed task row. */
function taskRow(taskId: string): HTMLElement {
  const stub = Array.from(host.querySelectorAll<HTMLElement>('[data-row="task"]')).find(
    (el) => el.textContent === `task:p1:${taskId}`
  );
  if (!stub) throw new Error(`no rendered row for task ${taskId}`);
  return stub.parentElement as HTMLElement;
}

/** A Stage Group header row (real `SidebarStageGroupItem`, never sortable). */
function groupHeader(label: string): HTMLElement {
  const action = host.querySelector(`[aria-label^="${label},"]`);
  if (!action) throw new Error(`no group header for ${label}`);
  return action.closest('div') as HTMLElement;
}

/** The insertion indicator line, portaled to the body mid-drag. */
function insertionIndicator(): HTMLElement | null {
  return document.querySelector<HTMLElement>('div.bg-primary');
}

/** Press on `from`, walk to the target in steps, hover a beat, release. */
async function dragTo(from: Element, toX: number, toY: number, hoverFrames = 6) {
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
  document.dispatchEvent(pointer('pointerup', toX, toY));
  await settle();
}

/** One expanded project: Unstaged rows, then Idea and Spec Stage Groups. */
function defaultRows(): SidebarRow[] {
  return [
    { kind: 'project', projectId: 'p1' },
    { kind: 'task', projectId: 'p1', taskId: 'u1' },
    { kind: 'task', projectId: 'p1', taskId: 'u2' },
    { kind: 'stage-group', projectId: 'p1', stage: 'idea', label: 'Idea', count: 3 },
    { kind: 'task', projectId: 'p1', taskId: 'idea-1' },
    { kind: 'task', projectId: 'p1', taskId: 'idea-2' },
    { kind: 'task', projectId: 'p1', taskId: 'idea-3' },
    { kind: 'stage-group', projectId: 'p1', stage: 'spec', label: 'Spec', count: 2 },
    { kind: 'task', projectId: 'p1', taskId: 'spec-1' },
    { kind: 'task', projectId: 'p1', taskId: 'spec-2' },
  ];
}

function defaultStores() {
  storesById.set('u1', makeStore('u1'));
  storesById.set('u2', makeStore('u2', { boardRank: 'a' }));
  storesById.set('idea-1', makeStore('idea-1', { workflowStage: 'idea', boardRank: 'a' }));
  storesById.set('idea-2', makeStore('idea-2', { workflowStage: 'idea', boardRank: 'm' }));
  storesById.set('idea-3', makeStore('idea-3', { workflowStage: 'idea', boardRank: 'z' }));
  storesById.set('spec-1', makeStore('spec-1', { workflowStage: 'spec', boardRank: 'a' }));
  storesById.set('spec-2', makeStore('spec-2', { workflowStage: 'spec', boardRank: 'm' }));
  managersByProject.set('p1', storesById);
}

describe('sidebar drag & drop between Stage Groups (spec #85, ticket #89)', () => {
  beforeEach(async () => {
    await page.viewport(400, 800);
    style = document.createElement('style');
    style.textContent = LAYOUT_CSS;
    document.head.appendChild(style);
    host = document.createElement('div');
    host.id = 'sidebar-host';
    document.body.appendChild(host);
    root = createRoot(host);

    storesById.clear();
    managersByProject.clear();
    mocks.navigate.mockClear();
    mocks.captureTelemetry.mockClear();
    mocks.toast.mockClear();
    mocks.ensureProjectExpanded.mockClear();
    mocks.setProjectOrder.mockClear();
    mocks.setTaskOrder.mockClear();
    mocks.isStageGroupCollapsed.mockClear().mockReturnValue(false);
    // Observable so the real `observer` virtual list re-renders when a test
    // applies a drop's write to the rows (like the store projection would).
    mocks.sidebarRows = observable.array(defaultRows()) as unknown as SidebarRow[];
    defaultStores();
  });

  afterEach(() => {
    root.unmount();
    host.remove();
    style.remove();
  });

  it('writes the stage and an interpolated rank when dragging between groups, and the row lands in the target group', async () => {
    await mount();

    // idea-2 (rank 'm') dropped above spec-1 (rank 'a'): the Spec group's
    // first slot — a rank strictly before spec-1's.
    const spec1Center = center(taskRow('spec-1'));
    await dragTo(taskRow('idea-2'), spec1Center.x, spec1Center.y - 5);

    expect(storesById.get('idea-2')!.updateBoardPosition).toHaveBeenCalledTimes(1);
    const [stage, rank] = storesById.get('idea-2')!.updateBoardPosition.mock.calls[0]!;
    expect(stage).toBe('spec');
    expect(rank).toBeTruthy();
    expect(rank < 'a').toBe(true);

    // The stale manual task-order write is gone: grouped-mode drags never
    // touch the inert `taskOrderByProject`.
    expect(mocks.setTaskOrder).not.toHaveBeenCalled();

    // The row lands in the target group: apply the write the way the real
    // projection does (the store re-groups from the observable task data —
    // sidebar-store.test.ts covers that seam) and the rendered list follows.
    (mocks.sidebarRows as unknown as { replace(rows: SidebarRow[]): void }).replace([
      { kind: 'project', projectId: 'p1' },
      { kind: 'task', projectId: 'p1', taskId: 'u1' },
      { kind: 'task', projectId: 'p1', taskId: 'u2' },
      { kind: 'stage-group', projectId: 'p1', stage: 'idea', label: 'Idea', count: 2 },
      { kind: 'task', projectId: 'p1', taskId: 'idea-1' },
      { kind: 'task', projectId: 'p1', taskId: 'idea-3' },
      { kind: 'stage-group', projectId: 'p1', stage: 'spec', label: 'Spec', count: 3 },
      { kind: 'task', projectId: 'p1', taskId: 'idea-2' },
      { kind: 'task', projectId: 'p1', taskId: 'spec-1' },
      { kind: 'task', projectId: 'p1', taskId: 'spec-2' },
    ]);
    await settle();
    const taskOrder = Array.from(host.querySelectorAll<HTMLElement>('[data-row="task"]')).map(
      (el) => el.textContent
    );
    expect(taskOrder).toEqual([
      'task:p1:u1',
      'task:p1:u2',
      'task:p1:idea-1',
      'task:p1:idea-3',
      'task:p1:idea-2',
      'task:p1:spec-1',
      'task:p1:spec-2',
    ]);
  });

  it('reorders within a group by interpolating between the neighbours it lands between', async () => {
    await mount();

    // idea-3 (rank 'z') dropped above idea-2 (rank 'm'): a rank strictly
    // between idea-1's 'a' and idea-2's 'm'.
    const idea2Center = center(taskRow('idea-2'));
    await dragTo(taskRow('idea-3'), idea2Center.x, idea2Center.y - 5);

    expect(storesById.get('idea-3')!.updateBoardPosition).toHaveBeenCalledTimes(1);
    const [stage, rank] = storesById.get('idea-3')!.updateBoardPosition.mock.calls[0]!;
    expect(stage).toBe('idea');
    expect(rank > 'a' && rank < 'm').toBe(true);
  });

  it('leaves a task unranked when dropped at the end of a group', async () => {
    await mount();

    // idea-1 (rank 'a') dropped below idea-3, the group's last visible row:
    // an end-of-group drop — stage-only, no rank.
    const idea3Center = center(taskRow('idea-3'));
    await dragTo(taskRow('idea-1'), idea3Center.x, idea3Center.y + 5);

    expect(storesById.get('idea-1')!.updateBoardPosition).toHaveBeenCalledTimes(1);
    expect(storesById.get('idea-1')!.updateBoardPosition).toHaveBeenCalledWith('idea', null);
  });

  it('clears the stage and places by rank when dropping between Unstaged rows', async () => {
    await mount();

    // idea-1 dropped above u2 (the only ranked Unstaged row): stage cleared,
    // rank strictly before u2's 'a'.
    const u2Center = center(taskRow('u2'));
    await dragTo(taskRow('idea-1'), u2Center.x, u2Center.y - 5);

    expect(storesById.get('idea-1')!.updateBoardPosition).toHaveBeenCalledTimes(1);
    const [stage, rank] = storesById.get('idea-1')!.updateBoardPosition.mock.calls[0]!;
    expect(stage).toBeNull();
    expect(rank).toBeTruthy();
    expect(rank < 'a').toBe(true);
  });

  it('rejects a cross-stage drop a GitHub fact would overwrite, with the board gating feedback and no promise line', async () => {
    // spec-1 is held in Spec by an open Spec issue: the Idea group is a
    // destination the next sync pass would reassert over (ADR 0006).
    storesById.set(
      'spec-1',
      makeStore('spec-1', {
        workflowStage: 'spec',
        boardRank: 'a',
        linkedIssues: openSpecLink(),
      })
    );
    await mount();

    const idea1Center = center(taskRow('idea-1'));
    const start = center(taskRow('spec-1'));
    taskRow('spec-1').dispatchEvent(pointer('pointerdown', start.x, start.y));
    await settle();
    document.dispatchEvent(pointer('pointermove', start.x + 10, start.y + 2));
    await settle();
    document.dispatchEvent(pointer('pointermove', idea1Center.x, idea1Center.y - 5));
    await settle(6);

    // The drag is genuinely active (the DragOverlay adds an 8th task stub)
    // but the insertion indicator never promises the blocked drop — the
    // board's "no ghost in the disabled column" rule.
    expect(document.querySelectorAll('[data-row="task"]').length).toBe(8);
    expect(insertionIndicator()).toBeNull();

    document.dispatchEvent(pointer('pointerup', idea1Center.x, idea1Center.y - 5));
    await settle();

    expect(storesById.get('spec-1')!.updateBoardPosition).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Stage move blocked',
        variant: 'destructive',
        description: expect.stringContaining('linked Spec issue'),
      })
    );
  });

  it('keeps a GitHub-authoritative task reorderable within its own group', async () => {
    // Same-group drops never change the stage, so nothing contests them —
    // exactly like the board's same-column reorder.
    storesById.set(
      'spec-1',
      makeStore('spec-1', {
        workflowStage: 'spec',
        boardRank: 'a',
        linkedIssues: openSpecLink(),
      })
    );
    await mount();

    // spec-1 dropped above spec-2: still a write, still in 'spec'.
    const spec2Center = center(taskRow('spec-2'));
    await dragTo(taskRow('spec-1'), spec2Center.x, spec2Center.y - 5);

    expect(storesById.get('spec-1')!.updateBoardPosition).toHaveBeenCalledTimes(1);
    expect(storesById.get('spec-1')!.updateBoardPosition).toHaveBeenCalledWith(
      'spec',
      expect.any(String)
    );
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('never duplicates a hidden task rank when interpolating between visible neighbours', async () => {
    // A task hidden from the sidebar holds exactly the rank the visible
    // neighbours' midpoint would produce ('5' between '4' and '6'): the
    // write must fall back to the true neighbour — the board's `trueEntries`
    // guard (ticket #45) — instead of duplicating the hidden card's rank
    // (which would break rankBetween's ordering guard on a later drop).
    storesById.set('v4', makeStore('v4', { workflowStage: 'idea', boardRank: '4' }));
    storesById.set('v6', makeStore('v6', { workflowStage: 'idea', boardRank: '6' }));
    storesById.set('drag-1', makeStore('drag-1', { workflowStage: 'idea', boardRank: 'z' }));
    // In the manager map (the "true" column set) but not in the rows (the
    // visible set) — exactly how a Hidden Task looks to the drop math.
    storesById.set('hidden-5', makeStore('hidden-5', { workflowStage: 'idea', boardRank: '5' }));
    (mocks.sidebarRows as unknown as { replace(rows: SidebarRow[]): void }).replace([
      { kind: 'project', projectId: 'p1' },
      { kind: 'stage-group', projectId: 'p1', stage: 'idea', label: 'Idea', count: 3 },
      { kind: 'task', projectId: 'p1', taskId: 'v4' },
      { kind: 'task', projectId: 'p1', taskId: 'v6' },
      { kind: 'task', projectId: 'p1', taskId: 'drag-1' },
    ]);
    await mount();

    // drag-1 (rank 'z') dropped above v6 ('6'): between v4's '4' and v6's
    // '6', whose naive midpoint is '5' — hidden-5's rank. The write must
    // land strictly between '4' and hidden-5's '5' instead.
    const v6Center = center(taskRow('v6'));
    await dragTo(taskRow('drag-1'), v6Center.x, v6Center.y - 5);

    expect(storesById.get('drag-1')!.updateBoardPosition).toHaveBeenCalledTimes(1);
    const [stage, rank] = storesById.get('drag-1')!.updateBoardPosition.mock.calls[0]!;
    expect(stage).toBe('idea');
    expect(rank).toBeTruthy();
    expect(rank > '4' && rank < '5').toBe(true);
  });

  it('does not let Stage Group headers start a drag', async () => {
    await mount();

    // A full gesture from the Idea header onto a task row: nothing may
    // happen — no drag starts (no overlay, no indicator), no write, no
    // feedback.
    const idea1Center = center(taskRow('idea-1'));
    await dragTo(groupHeader('Idea'), idea1Center.x, idea1Center.y);
    expect(storesById.get('idea-1')!.updateBoardPosition).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(insertionIndicator()).toBeNull();
    // The host renders 7 task stubs; a drag overlay would add an 8th.
    expect(document.querySelectorAll('[data-row="task"]').length).toBe(7);
  });
});
