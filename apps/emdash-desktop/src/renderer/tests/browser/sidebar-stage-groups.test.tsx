/**
 * Browser-mode tests for spec #85, ticket #87 (Stage Group visibility:
 * Shipped Fade and Hidden Tasks):
 *
 * - the Shipped Stage Group header discloses the fade window (reusing the
 *   board's disclosure text) while other groups do not;
 * - the project view's task row carries the Hidden Task badge with a
 *   "Show in sidebar" action, and its context menu offers "Hide from
 *   sidebar" for any task and "Show in sidebar" for a hidden one.
 *
 * Mounts the real `SidebarStageGroupItem` and `TaskRow` with the surrounding
 * providers and presentational children stubbed out, following the harness
 * pattern of `sidebar-project-row.test.tsx`.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import {
  SHIPPED_FADE_DISCLOSURE,
  SHIPPED_FADE_WINDOW_DAYS,
} from '@renderer/features/board/board-columns';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  showModal: vi.fn(),
  provisionTask: vi.fn(),
  archiveTask: vi.fn(),
  restoreTask: vi.fn(),
  setPinned: vi.fn(),
  deleteTasks: vi.fn(),
  taskAgentStatus: 'idle' as string | null,
  hiddenByTaskId: new Map<string, boolean>(),
  hideTaskFromSidebar: vi.fn(),
  showTaskInSidebar: vi.fn(),
  isStageGroupCollapsed: vi.fn(() => false),
  toggleStageGroupCollapsed: vi.fn(),
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  sidebarStore: {
    isTaskHidden: (projectId: string, taskId: string) => mocks.hiddenByTaskId.get(taskId) ?? false,
    hideTaskFromSidebar: mocks.hideTaskFromSidebar,
    showTaskInSidebar: mocks.showTaskInSidebar,
    isStageGroupCollapsed: mocks.isStageGroupCollapsed,
    toggleStageGroupCollapsed: mocks.toggleStageGroupCollapsed,
  },
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: mocks.navigate }),
  useParams: () => ({ params: {} }),
  useWorkspaceSlots: () => ({ currentView: 'project' }),
}));

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useShowModal: () => mocks.showModal,
}));

vi.mock('@renderer/features/tasks/stores/task-selectors', () => ({
  getTaskManagerStore: () => ({
    provisionTask: mocks.provisionTask,
    archiveTask: mocks.archiveTask,
    restoreTask: mocks.restoreTask,
    deleteTasks: mocks.deleteTasks,
  }),
  getTaskGitWorktreeStore: () => undefined,
  taskAgentStatus: () => mocks.taskAgentStatus,
}));

vi.mock('@renderer/features/tasks/stores/task-store', () => ({
  registeredTaskData: (store: { data: unknown }) => store.data,
}));

// Presentational children of TaskRow — separately covered, not under test here.
vi.mock('@renderer/features/tasks/components/task-git-diff-stats', () => ({
  TaskGitDiffStats: () => null,
}));
vi.mock('@renderer/lib/components/stacked-agent-logos', () => ({
  StackedAgentLogos: () => null,
}));
vi.mock('@renderer/lib/components/agent-status-indicator', () => ({
  AgentStatusIndicator: () => null,
}));
vi.mock('@renderer/lib/components/pr-badge', () => ({
  PrBadge: () => null,
}));
vi.mock('@renderer/lib/ui/checkbox', () => ({
  Checkbox: ({ onCheckedChange }: { onCheckedChange?: (checked: boolean) => void }) => (
    <button type="button" onClick={() => onCheckedChange?.(true)} aria-label="Select task" />
  ),
}));
vi.mock('@renderer/lib/ui/relative-time', () => ({
  RelativeTime: () => null,
}));

import { TaskRow } from '@renderer/features/projects/components/task-view/task-row';
import { SidebarStageGroupItem } from '@renderer/features/sidebar/stage-group-item';

const TASK = {
  id: 't1',
  projectId: 'p1',
  name: 'Task one',
  status: 'todo' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  statusChangedAt: '2026-01-01T00:00:00.000Z',
  isPinned: false,
  prs: [],
  conversations: {},
  type: 'task' as const,
};

function taskStore() {
  return {
    state: 'provisioned',
    data: { ...TASK },
    setPinned: mocks.setPinned,
    conversationStats: {},
  };
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

/** Opens a base-ui context menu by dispatching a native `contextmenu` on the trigger. */
function openContextMenu(trigger: HTMLElement) {
  trigger.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
  );
  return settle(3);
}

function menuContent(): HTMLElement | null {
  return document.querySelector('[data-slot="context-menu-content"]');
}

describe('SidebarStageGroupItem Shipped Fade disclosure (spec #85, ticket #87)', () => {
  beforeEach(async () => {
    await page.viewport(400, 400);
    host = document.createElement('div');
    host.id = 'stage-group-host';
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.isStageGroupCollapsed.mockClear().mockReturnValue(false);
  });

  afterEach(() => {
    root.unmount();
    host.remove();
  });

  it('discloses the fade window on the Shipped group header only', async () => {
    await mount(
      <div>
        <SidebarStageGroupItem projectId="p1" stage="shipped" label="Shipped" count={3} />
        <SidebarStageGroupItem projectId="p1" stage="spec" label="Spec" count={2} />
      </div>
    );

    // The header's labelled action carries `"<label>, <count> tasks…"` as its
    // aria-label; the disclosure caption sits in the same row (its parent).
    const shippedAction = host.querySelector('[aria-label^="Shipped, 3 tasks"]');
    const specAction = host.querySelector('[aria-label^="Spec, 2 tasks"]');
    expect(shippedAction).not.toBeNull();
    expect(specAction).not.toBeNull();

    const shippedRow = shippedAction!.closest('div');
    expect(shippedRow?.textContent).toContain(`hides after ${SHIPPED_FADE_WINDOW_DAYS}d`);
    const caption = shippedRow?.querySelector('[title]');
    expect(caption?.getAttribute('title')).toBe(SHIPPED_FADE_DISCLOSURE);
    expect(shippedAction!.getAttribute('aria-label')).toContain(SHIPPED_FADE_DISCLOSURE);

    const specRow = specAction!.closest('div');
    expect(specRow?.textContent).not.toContain('hides after');
    expect(specAction!.getAttribute('aria-label')).not.toContain(SHIPPED_FADE_DISCLOSURE);
  });
});

describe('TaskRow Hidden Task badge and actions (spec #85, ticket #87)', () => {
  beforeEach(async () => {
    await page.viewport(800, 400);
    host = document.createElement('div');
    host.id = 'task-row-host';
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.hiddenByTaskId.clear();
    mocks.hideTaskFromSidebar.mockClear();
    mocks.showTaskInSidebar.mockClear();
    mocks.taskAgentStatus = 'idle';
  });

  afterEach(() => {
    root.unmount();
    host.remove();
  });

  it('shows the Hidden badge with a Show in sidebar action for a hidden task', async () => {
    mocks.hiddenByTaskId.set('t1', true);
    mocks.navigate.mockClear();
    await mount(
      <div>
        <TaskRow task={taskStore() as never} isSelected={false} onToggleSelect={() => {}} />
      </div>
    );

    const badge = host.querySelector('button[aria-label="Show in sidebar"]') as HTMLElement | null;
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain('Hidden');

    badge?.click();
    expect(mocks.showTaskInSidebar).toHaveBeenCalledWith('p1', 't1');
    expect(mocks.hideTaskFromSidebar).not.toHaveBeenCalled();
    // The badge sits inside the row's own clickable button — the click must
    // not bubble into the row's navigate action.
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('shows no badge for a visible task', async () => {
    await mount(
      <div>
        <TaskRow task={taskStore() as never} isSelected={false} onToggleSelect={() => {}} />
      </div>
    );

    expect(host.querySelector('button[aria-label="Show in sidebar"]')).toBeNull();
  });

  it('offers "Hide from sidebar" in the context menu for any task', async () => {
    await mount(
      <div>
        <TaskRow task={taskStore() as never} isSelected={false} onToggleSelect={() => {}} />
      </div>
    );

    const rowButton = host.querySelector('button[class*="group"]') as HTMLElement;
    await openContextMenu(rowButton);
    const content = menuContent();
    expect(content?.textContent).toContain('Hide from sidebar');

    const item = Array.from(
      content?.querySelectorAll('[data-slot="context-menu-item"]') ?? []
    ).find((el) => el.textContent?.includes('Hide from sidebar')) as HTMLElement | undefined;
    item?.click();
    expect(mocks.hideTaskFromSidebar).toHaveBeenCalledWith('p1', 't1');
  });

  it('offers "Show in sidebar" in the context menu for a hidden task', async () => {
    mocks.hiddenByTaskId.set('t1', true);
    await mount(
      <div>
        <TaskRow task={taskStore() as never} isSelected={false} onToggleSelect={() => {}} />
      </div>
    );

    const rowButton = host.querySelector('button[class*="group"]') as HTMLElement;
    await openContextMenu(rowButton);
    const content = menuContent();
    expect(content?.textContent).toContain('Show in sidebar');
    expect(content?.textContent).not.toContain('Hide from sidebar');

    const item = Array.from(
      content?.querySelectorAll('[data-slot="context-menu-item"]') ?? []
    ).find((el) => el.textContent?.includes('Show in sidebar')) as HTMLElement | undefined;
    item?.click();
    expect(mocks.showTaskInSidebar).toHaveBeenCalledWith('p1', 't1');
  });
});
