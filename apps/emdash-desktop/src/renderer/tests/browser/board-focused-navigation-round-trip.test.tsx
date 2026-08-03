/**
 * Ticket #50's own acceptance criterion: "The round trip (board -> open task
 * -> stage chip -> same focused board card) is covered by the project-shell
 * browser test." No project-shell browser test exists anywhere on this base
 * (`board-detail-panel.test.tsx` and `workflow-stage-chip.test.tsx` are the
 * closest precedent, and each only covers one *end* of the trip in
 * isolation: the chip's own `navigate()` call args, and `BoardMainPanel`'s
 * own resolution of an already-set `focusTaskId` param).
 *
 * This file closes that gap directly, without inventing a full project-shell
 * harness (sidebar + Workspace + every view's real components) that no unit
 * in this spec has built: it mounts the real `WorkflowStageChip`, clicks it,
 * and feeds the *exact* `navigate()` call it produces into a real
 * `BoardMainPanel` mount through one shared, minimal navigation double —
 * proving the two ends actually agree, not just that each behaves correctly
 * on its own.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GhostCard } from '@shared/core/issues/ghost-card';
import type { LinkedIssueRoles } from '@shared/core/linked-issue';
import type { PullRequest } from '@shared/core/pull-requests/pull-requests';

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
    prs?: PullRequest[];
  };
  conversationStats: Record<string, number>;
  updateBoardPosition: ReturnType<typeof vi.fn>;
  setPinned: ReturnType<typeof vi.fn>;
};

const managerTasks = new Map<string, MockStore>();

// The shared navigation double both the chip and the board read/write
// through — a real `navigate()` call from the chip mutates the same object
// `useParams('board')` reads back, so the round trip is genuinely wired
// rather than independently asserted at each end.
const mocks = vi.hoisted(() => ({
  boardParams: { projectId: 'p1' } as { projectId: string; focusTaskId?: string },
  navigate: vi.fn((viewId: string, params?: Record<string, unknown>) => {
    if (viewId === 'board' && params) {
      mocks.boardParams = { projectId: 'p1', ...params } as typeof mocks.boardParams;
    }
  }),
  getTaskStageAuthority: vi.fn(() =>
    Promise.resolve({ holdingPr: null, isCurrentStageGithubProven: false })
  ),
  provisionTask: vi.fn(() => Promise.resolve()),
  archiveTask: vi.fn(() => Promise.resolve()),
  getGhostCards: vi.fn(() => Promise.resolve<GhostCard[]>([])),
  captureTelemetry: vi.fn(),
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useParams: () => ({ params: mocks.boardParams }),
  useNavigate: () => ({ navigate: mocks.navigate }),
}));

vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectStore: () => ({}),
  projectDisplayName: () => 'Test project',
}));

vi.mock('@renderer/features/tasks/stores/task-selectors', () => ({
  getTaskManagerStore: () => ({
    tasks: managerTasks,
    provisionTask: mocks.provisionTask,
    archiveTask: mocks.archiveTask,
  }),
  taskAgentStatus: () => 'idle',
  getTaskStore: (_projectId: string, taskId: string) => managerTasks.get(taskId),
  getTaskGitWorktreeStore: () => undefined,
}));

vi.mock('@renderer/features/tasks/stores/task-store', () => ({
  registeredTaskData: (store: MockStore) => store.data,
  isRegistered: () => true,
}));

vi.mock('@renderer/lib/components/agent-status-indicator', () => ({
  AgentStatusIndicator: () => null,
}));

vi.mock('@renderer/lib/components/stacked-agent-logos', () => ({
  StackedAgentLogos: () => null,
}));

vi.mock('@renderer/utils/telemetryClient', () => ({
  captureTelemetry: (...args: unknown[]) => mocks.captureTelemetry(...args),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    issues: {
      getLinkSuggestions: vi.fn(() => Promise.resolve([])),
      getGhostCards: mocks.getGhostCards,
      adoptGhostCard: vi.fn(),
      rejectGhostCard: vi.fn(),
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
import { WorkflowStageChip } from '@renderer/features/tasks/workflow-stage-chip';

function makeStore(id: string, overrides: Partial<MockStore['data']> = {}): MockStore {
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
  };
}

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

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle(frames = 4) {
  for (let i = 0; i < frames; i++) await frame();
}

let host: HTMLDivElement;
let root: Root;
let style: HTMLStyleElement;

beforeEach(() => {
  style = document.createElement('style');
  style.textContent = LAYOUT_CSS;
  document.head.appendChild(style);
  host = document.createElement('div');
  host.id = 'board-host';
  document.body.appendChild(host);
  root = createRoot(host);
  mocks.boardParams = { projectId: 'p1' };
  mocks.navigate.mockClear();
  mocks.getTaskStageAuthority.mockImplementation(() =>
    Promise.resolve({ holdingPr: null, isCurrentStageGithubProven: false })
  );
  mocks.getGhostCards.mockImplementation(() => Promise.resolve([]));
});

afterEach(() => {
  root.unmount();
  host.remove();
  style.remove();
  managerTasks.clear();
  vi.clearAllMocks();
  mocks.boardParams = { projectId: 'p1' };
});

function panelHeading(): string | null {
  return host.querySelector('h2')?.textContent ?? null;
}

function cardEl(name: string): Element {
  const label = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === name)!;
  return label.parentElement!;
}

describe('Board focused-task navigation — round trip (ticket #50)', () => {
  it('carries the exact task the chip was clicked for into the board being focused, highlighted and scrolled to', async () => {
    const a = makeStore('card-a', { workflowStage: 'spec' });
    const b = makeStore('card-b');
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b);

    // Step 1: the task titlebar's Workflow Stage chip, mounted and clicked
    // exactly as it would be from the task view — a real `navigate()` call,
    // not a directly-injected param.
    root.render(<WorkflowStageChip projectId="p1" taskId="card-a" workflowStage="spec" />);
    await settle();
    (host.querySelector('button') as HTMLButtonElement).click();
    await settle();

    expect(mocks.navigate).toHaveBeenCalledWith('board', {
      projectId: 'p1',
      focusTaskId: 'card-a',
    });
    // What the chip actually produced is what the board below will consume —
    // no separate hand-set `focusTaskId`.
    expect(mocks.boardParams.focusTaskId).toBe('card-a');

    // Step 2: leaving the task view and arriving at the board (a fresh
    // mount, the same way `Workspace` swapping `MainPanel` components would
    // produce) reading that same navigation state back.
    root.unmount();
    root = createRoot(host);
    const scrollIntoViewSpy = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => {});

    root.render(<BoardMainPanel />);
    await settle();

    // Same focused board card the chip was clicked for — not just "a" card.
    expect(panelHeading()).toBe('card-a');
    expect((cardEl('card-a') as HTMLElement).className).toContain('border-primary');
    expect((cardEl('card-b') as HTMLElement).className).not.toContain('border-primary');
    expect(scrollIntoViewSpy).toHaveBeenCalled();

    scrollIntoViewSpy.mockRestore();
  });
});
