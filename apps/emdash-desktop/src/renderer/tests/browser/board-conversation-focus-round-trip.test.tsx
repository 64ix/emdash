/**
 * Ticket #68's own "click-to-landing round trip" (Testing Decisions, Seam 3).
 * Prior art: `board-focused-navigation-round-trip.test.tsx` (ticket #50),
 * which mounts one end (`WorkflowStageChip`), captures the *exact* `navigate()`
 * call it produces, and feeds it into the other end (`BoardMainPanel`) through
 * a shared navigation double — proving the two ends actually agree, not just
 * that each behaves correctly in isolation.
 *
 * This file closes the same gap for ticket #68's conversation row: it mounts
 * the real `BoardMainPanel` (with a real Conversations section row) and clicks
 * it, capturing the exact `navigate('task', { ..., focusConversationId })`
 * call the row produces via the shared `onOpenConversation` handler — then
 * feeds that *same* captured id into a real `WorkspaceViewModel` (ticket #67's
 * `resolveFocusedConversation`, the exact method `main-panel.tsx`'s
 * `ReadyTaskMainPanel` calls once the task view is ready) and asserts the
 * conversation tab actually ends up active. No full project-shell harness is
 * built (mirrors the ticket #50 file's own reasoning) — `WorkspaceViewModel`
 * is constructed directly, exactly as `workspace-view-model.test.ts`'s own
 * `openConversation`/`resolveFocusedConversation` suites already do, and both
 * halves share the *same* `conversationRegistry` singleton, so there is only
 * one source of conversation data in this test, not two independently seeded
 * copies that could quietly disagree.
 */
import { makeObservable, observable } from 'mobx';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { conversationRegistry } from '@renderer/features/conversations/stores/conversation-registry';
import { releaseConversationSessionManager } from '@renderer/features/conversations/stores/conversation-session-manager';
import { terminalRegistry } from '@renderer/features/tasks/stores/terminal-registry';
import type { Conversation } from '@shared/core/conversations/conversations';
import type { GhostCard } from '@shared/core/issues/ghost-card';
import type { LinkedIssueRoles } from '@shared/core/linked-issue';
import type { PullRequest } from '@shared/core/pull-requests/pull-requests';
import type { Task, TaskStageAuthority } from '@shared/core/tasks/tasks';

// `ConversationManagerStore`'s real implementation constructs a `PtySession`
// per conversation (`pty-session.ts` -> `pty.ts` -> `open-external-link.tsx`
// -> `appState` -> the entire project/task store graph) purely to support
// the legacy terminal transport — none of it relevant to a test whose one
// conversation is ACP-typed. A minimal, observable-map-backed stand-in
// (matching exactly the fields `WorkspaceViewModel.openConversation` /
// `resolveFocusedConversation` and the panel's row derivation read: `data`
// and `indicatorStatus`) keeps `conversationRegistry` (real, unmocked below)
// as the *one* shared source of truth both halves of this round trip read
// from, without pulling in the PTY/app-state graph to do it.
vi.mock('@renderer/features/conversations/conversation-manager', () => {
  class ConversationStore {
    data: Conversation;
    status: string;
    seen: boolean;

    constructor(conversation: Conversation) {
      this.data = conversation;
      this.status = conversation.agentStatus ?? 'idle';
      this.seen = conversation.agentStatusSeen ?? true;
      makeObservable(this, { data: observable, status: observable, seen: observable });
    }

    get indicatorStatus(): string | null {
      if (this.status === 'working') return 'working';
      if (this.seen) return null;
      return this.status;
    }
  }

  class ConversationManagerStore {
    conversations = observable.map<string, ConversationStore>();

    constructor(_projectId: string, _taskId: string, preloaded: Conversation[] = []) {
      for (const conversation of preloaded) {
        this.conversations.set(conversation.id, new ConversationStore(conversation));
      }
    }

    async renameConversation(): Promise<void> {}
    async deleteConversation(): Promise<void> {}
    dispose(): void {}
  }

  return { ConversationStore, ConversationManagerStore };
});

// `WorkspaceViewModel`'s own module graph (ticket #67's `openConversation` /
// `resolveFocusedConversation`) needs these stubbed away exactly as
// `workspace-view-model.test.ts` already does — none of it is DOM-dependent
// under the real Chromium environment this file runs in, but the ACP/chat-ui
// chain and the tab-bar item renderers are still irrelevant weight for a test
// that only calls `resolveFocusedConversation` directly, never renders a tab bar.
vi.mock('@renderer/features/conversations/conversation-title-utils', () => ({
  formatConversationTitleForDisplay: (_providerId: unknown, title: unknown) =>
    (title as string) ?? 'Conversation',
}));
vi.mock('@renderer/features/conversations/acp/acp-chat-store', () => ({
  AcpChatStore: class {
    conversationId = '';
    dispose() {}
    bootstrap() {}
  },
}));
vi.mock('@renderer/features/conversations/acp/acp-chat-panel', () => ({
  AcpChatPanel: () => null,
}));
// The legacy PTY conversation panel, the browser pane, the terminal pane and
// the file editor each transitively reach the app-wide store graph (PTY /
// `EditorProvider` -> ... -> `appState` -> `ProjectManagerStore` ->
// `TaskManagerStore` -> the command palette -> the view/modal registries,
// which register *every* view and modal in the app) — `task-tab-registry.tsx`
// statically imports all five tab providers regardless of which kind is
// actually opened. This test's one conversation is ACP-typed, so it never
// opens any of these four kinds; only the real `acpChatTabProvider` needs to
// function. Mocked away wholesale, the same reasoning as `AcpChatPanel` above.
function stubTabProvider(kind: string) {
  return {
    kind,
    mount: 'single',
    resourceKey: () => '',
    onBeforeOpen: () => null,
    initialize: () => ({ dispose: () => {} }),
    dispose: () => {},
    commands: {},
    TabBarItem: () => null,
    TabBarItemDragPreview: () => null,
    TabContent: () => null,
  };
}
vi.mock('@renderer/features/conversations/conversation-tab-provider', () => ({
  conversationTabProvider: stubTabProvider('conversation'),
}));
vi.mock('@renderer/features/browser/browser-tab-provider', () => ({
  browserTabProvider: stubTabProvider('browser'),
}));
vi.mock('@renderer/features/tasks/terminals/terminal-tab-provider', () => ({
  terminalTabProvider: stubTabProvider('terminal'),
}));
vi.mock('@renderer/features/tasks/editor/file-tab-provider', () => ({
  fileTabProvider: stubTabProvider('file'),
}));
vi.mock('@renderer/features/tasks/diff-view/diff-tab-provider', () => ({
  diffTabProvider: stubTabProvider('diff'),
}));
vi.mock('@renderer/utils/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

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

// Shared navigation double (mirrors `board-focused-navigation-round-trip.test.tsx`):
// a real `navigate()` call from the panel's conversation row is captured here
// verbatim, then fed into the `WorkspaceViewModel` side below.
const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  getTaskStageAuthority: vi.fn(() =>
    Promise.resolve<TaskStageAuthority>({ holdingPr: null, isCurrentStageGithubProven: false })
  ),
  provisionTask: vi.fn(() => Promise.resolve()),
  getGhostCards: vi.fn(() => Promise.resolve<GhostCard[]>([])),
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useParams: () => ({ params: { projectId: 'p1' } }),
  useNavigate: () => ({ navigate: mocks.navigate }),
}));

vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectStore: () => ({}),
  projectDisplayName: () => 'Test project',
  // `task-manager.ts` (reached transitively through `WorkspaceViewModel`'s
  // real store graph) imports these two for real. Never actually invoked
  // here — this test never calls a `TaskManagerStore` method — so an inert
  // stub is enough.
  getProjectManagerStore: () => ({ projects: new Map() }),
  getProjectSshConnectionId: () => undefined,
  // Ticket #100: the Task Detail Panel's assign picker reads the project's
  // PR-capable repository URL through this selector; undefined here means
  // the picker's queries stay disabled.
  getGitRepositoryStore: () => undefined,
}));

// `WorkspaceViewModel`'s own module graph reaches several more of this
// module's exports transitively (`getTaskView`, `asProvisioned`,
// `getWorkspaceForTask`, …, none of them exercised by this test — inert stubs
// keep the mocked module's export surface complete without pulling in the
// real task/project store graph a full `TaskManagerStore` would require.
vi.mock('@renderer/features/tasks/stores/task-selectors', () => ({
  getTaskManagerStore: () => ({ tasks: managerTasks, provisionTask: mocks.provisionTask }),
  taskAgentStatus: () => 'idle',
  getTaskStore: (_projectId: string, taskId: string) => managerTasks.get(taskId),
  getTaskGitWorktreeStore: () => undefined,
  // The real, shared registry — the same one the `WorkspaceViewModel` half of
  // this test reads from, so there is exactly one source of conversation data.
  getConversationsForTask: (taskId: string) => conversationRegistry.get(taskId),
  getRegisteredTaskData: () => undefined,
  getTaskView: () => undefined,
  getEditorView: () => undefined,
  getDiffView: () => undefined,
  taskViewKind: () => 'missing',
  asProvisioned: () => undefined,
  getWorkspaceForTask: () => undefined,
  getWorkspaceViewModel: () => undefined,
  getTerminalsForTask: () => undefined,
  taskDisplayName: () => undefined,
  taskErrorMessage: () => undefined,
  projectMountErrorMessage: () => 'Failed to open project',
}));

vi.mock('@renderer/features/tasks/stores/task-store', () => ({
  registeredTaskData: (store: MockStore) => store.data,
  unregisteredTaskData: () => undefined,
  isRegistered: () => true,
  isUnregistered: () => false,
  isUnprovisioned: () => false,
  isProvisioned: () => false,
  createUnregisteredTask: () => undefined,
  createUnprovisionedTask: () => undefined,
}));

vi.mock('@renderer/lib/components/agent-status-indicator', () => ({
  AgentStatusIndicator: () => null,
}));

vi.mock('@renderer/lib/components/stacked-agent-logos', () => ({
  StackedAgentLogos: () => null,
}));

vi.mock('@renderer/features/conversations/conversation-agent-icon', () => ({
  ConversationAgentIcon: () => null,
}));

vi.mock('@renderer/utils/telemetryClient', () => ({
  captureTelemetry: vi.fn(),
}));

// Merges the board-side RPC surface (`board-focused-navigation-round-trip.test.tsx`)
// with the WorkspaceViewModel-side surface (`workspace-view-model.test.ts`) —
// both halves of this round trip share this one mocked module.
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
    ssh: {
      getConnections: async () => [],
      getConnectionState: async () => ({}),
      getHealthStates: async () => ({}),
    },
    viewState: {
      save: vi.fn(),
    },
    conversations: {
      markConversationSeen: vi.fn().mockResolvedValue(undefined),
    },
    gitRepository: {
      getDefaultBranch: vi
        .fn()
        .mockResolvedValue({ success: true, data: { defaultBranch: 'main' } }),
      resolveProviderRepository: vi.fn().mockResolvedValue({ success: false }),
    },
    workspace: {
      gitWorktree: {},
      fileTree: {
        openProjection: vi.fn().mockResolvedValue({
          success: true,
          data: { subscriptionId: 'sub-1', version: 1, scopes: [{ scopeId: null, entries: [] }] },
        }),
        registerDir: vi.fn().mockResolvedValue({ success: true, data: { version: 2 } }),
        revealPath: vi.fn().mockResolvedValue({ success: true, data: { version: 4 } }),
        closeProjection: vi.fn().mockResolvedValue({ success: true, data: undefined }),
      },
    },
  },
  events: {
    on: vi.fn(() => () => {}),
  },
}));

import { BoardMainPanel } from '@renderer/features/board/board-main-panel';
import type { TaskStore } from '@renderer/features/tasks/stores/task-store';
import { WorkspaceViewModel } from '@renderer/features/tasks/stores/workspace-view-model';

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

function makeTaskData(overrides: Partial<Task> = {}): Task {
  return {
    id: 'card-a',
    projectId: 'p1',
    name: 'card-a',
    status: 'todo',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    statusChangedAt: '2026-01-01T00:00:00.000Z',
    isPinned: false,
    prs: [],
    conversations: {},
    type: 'task',
    ...overrides,
  };
}

function conversationTabIds(viewModel: WorkspaceViewModel): string[] {
  return viewModel.activePane.resolvedTabs.flatMap((tab) => {
    if (tab.kind !== 'conversation' && tab.kind !== 'acp-chat') return [];
    const state = viewModel.activePane.entries.get(tab.tabId)?.state as
      | { conversationId?: string }
      | undefined;
    return state?.conversationId ? [state.conversationId] : [];
  });
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
});

afterEach(() => {
  root.unmount();
  host.remove();
  style.remove();
  managerTasks.clear();
  vi.clearAllMocks();
  releaseConversationSessionManager('card-a');
  conversationRegistry.release('card-a');
  terminalRegistry.release('card-a');
});

function cardEl(name: string): Element {
  const label = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === name)!;
  return label.parentElement!;
}

function conversationRow(conversationId: string): HTMLElement {
  return host.querySelector(`[data-conversation-row="${conversationId}"]`) as HTMLElement;
}

describe('Board conversation focus — click-to-landing round trip (ticket #68)', () => {
  it('carries the exact conversation the panel row was clicked for into the task view, landing on its own chat tab', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    // The real, shared registry — preloaded (no RPC involved), exactly as the
    // task manager's own project-mount preload populates it.
    conversationRegistry.acquire('card-a', 'p1', [
      {
        id: 'conversation-1',
        projectId: 'p1',
        taskId: 'card-a',
        providerId: 'claude',
        title: 'Conversation 1',
        lastInteractedAt: '2026-01-01T00:00:00.000Z',
        isInitialConversation: false,
        type: 'acp',
      },
    ]);

    root.render(<BoardMainPanel />);
    await settle();

    // Step 1: click the panel's conversation row — a real click on the real
    // `BoardMainPanel`, not a directly-injected navigation parameter.
    click(cardEl('card-a'));
    await settle();
    click(conversationRow('conversation-1'));
    await settle();

    expect(mocks.navigate).toHaveBeenCalledWith('task', {
      projectId: 'p1',
      taskId: 'card-a',
      focusConversationId: 'conversation-1',
    });

    // What the row actually produced — not a separately hand-typed id — is
    // what the task view below consumes.
    const [, params] = mocks.navigate.mock.calls.find(([viewId]) => viewId === 'task')!;
    const focusConversationId = (params as { focusConversationId?: string }).focusConversationId!;

    // Step 2: the task view's own resolution (`main-panel.tsx`'s
    // `ReadyTaskMainPanel` calls exactly this method once the task turns
    // ready) — constructed directly, mirroring `workspace-view-model.test.ts`.
    const taskView = new WorkspaceViewModel({ data: makeTaskData() } as unknown as TaskStore);
    taskView.resolveFocusedConversation(focusConversationId);

    expect(conversationTabIds(taskView)).toEqual(['conversation-1']);

    taskView.dispose();
  });
});

function click(el: Element) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}
