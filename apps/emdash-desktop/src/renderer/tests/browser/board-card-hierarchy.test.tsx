/**
 * Browser-mode tests for the Feature Board card's information hierarchy
 * (ticket #47): title clamping, actionable agent state (all five states,
 * always with an accessible name — never colour/a bare dot alone), the most
 * relevant delivery artifact, code-change statistics, provider/session
 * context, recent activity, and graceful degradation for a purely local task.
 *
 * Mounts the real `BoardMainPanel` in Chromium, following the pattern
 * established by `board-dnd.test.tsx` / `board-detail-panel.test.tsx`:
 * mocked stores, mocked `@renderer/lib/ipc`, `AgentStatusIndicator` and
 * `StackedAgentLogos` mocked away (both transitively reach unrelated
 * app-wide dependencies — theming, PTY, the full store graph — that these
 * tests have no reason to load).
 */
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { AgentStatus } from '@shared/core/agents/agentEvents';
import type { LinkedIssueRoles } from '@shared/core/linked-issue';
import type { PullRequest } from '@shared/core/pull-requests/pull-requests';

// ── Store mocks (mirrors board-dnd.test.tsx / board-detail-panel.test.tsx) ──

type MockStore = {
  data: {
    id: string;
    name: string;
    status: string;
    type: string;
    createdAt: string;
    updatedAt: string;
    lastInteractedAt?: string;
    workflowStage?: string;
    boardRank?: string;
    archivedAt?: string;
    linkedIssues?: LinkedIssueRoles;
    prs: PullRequest[];
    workspaceGit?: { linesAdded: number; linesDeleted: number };
  };
  conversationStats: Record<string, number>;
  updateBoardPosition: ReturnType<typeof vi.fn>;
};

const managerTasks = new Map<string, MockStore>();
/** Per-task agent status the mocked `taskAgentStatus` selector reads — set by
 * each test rather than derived, since the ticket's own criterion is that the
 * card must never re-derive this fact itself. */
const agentStatusByTaskId = new Map<string, AgentStatus | null>();

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useParams: () => ({ params: { projectId: 'p1' } }),
  useNavigate: () => ({ navigate: vi.fn() }),
}));

vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectStore: () => ({}),
  projectDisplayName: () => 'Test project',
}));

vi.mock('@renderer/features/tasks/stores/task-selectors', () => ({
  getTaskManagerStore: () => ({ tasks: managerTasks }),
  taskAgentStatus: (store: MockStore) => agentStatusByTaskId.get(store.data.id) ?? null,
  getTaskStore: (_projectId: string, taskId: string) => managerTasks.get(taskId),
  // No task in this suite is provisioned; `TaskGitDiffStats` falls back to
  // the task's cached `workspaceGit` snapshot instead (set per test).
  getTaskGitWorktreeStore: () => undefined,
}));

vi.mock('@renderer/features/tasks/stores/task-store', () => ({
  registeredTaskData: (store: MockStore) => store.data,
  isRegistered: () => true,
}));

// `StackedAgentLogos` transitively reaches the app-wide store graph via
// `PluginIcon`'s theme lookup (ThemeProvider -> pty -> appState -> ...) —
// mocked away like `board-dnd.test.tsx` does, rendering just enough to assert
// the card actually asked it to show the task's provider/session counts.
vi.mock('@renderer/lib/components/stacked-agent-logos', () => ({
  StackedAgentLogos: ({ stats }: { stats: Record<string, number> }) => (
    <span data-mock="provider-logos">{Object.entries(stats).length}</span>
  ),
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

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    url: 'https://github.com/acme/repo/pull/9',
    provider: 'github',
    repositoryUrl: 'https://github.com/acme/repo',
    baseRefName: 'main',
    baseRefOid: 'abc',
    headRepositoryUrl: 'https://github.com/acme/repo',
    headRefName: 'feature',
    headRefOid: 'def',
    identifier: '#9',
    title: 'Ship the feature',
    description: null,
    status: 'open',
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
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      prs: [],
      ...overrides,
    },
    conversationStats: {},
    updateBoardPosition: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Layout CSS: same subset the board's geometry depends on ────────────────

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
`;

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle(frames = 4) {
  for (let i = 0; i < frames; i++) await frame();
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
  });

  afterEach(() => {
    root.unmount();
    host.remove();
    style.remove();
    managerTasks.clear();
    agentStatusByTaskId.clear();
    vi.clearAllMocks();
  });
}

async function mount() {
  root.render(<BoardMainPanel />);
  await settle();
}

/** A card's sortable wrapper div, located by its name (the title `<span>`'s parent). */
function cardEl(name: string): HTMLElement {
  const label = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === name)!;
  return label.parentElement as HTMLElement;
}

describe('Feature Board card — title (ticket #47)', () => {
  setupDom();

  it('clamps a long title to a bounded number of lines, keeping the full name in `title`', async () => {
    const longName = 'A very long task name '.repeat(10).trim();
    const a = makeStore('card-a', { name: longName });
    managerTasks.set(a.data.id, a);
    await mount();

    const label = Array.from(host.querySelectorAll('span')).find(
      (s) => s.textContent === longName
    )!;
    expect(label.className).toContain('line-clamp-2');
    expect(label.getAttribute('title')).toBe(longName);
  });
});

describe('Feature Board card — actionable agent state (ticket #47)', () => {
  setupDom();

  const cases: Array<{ status: AgentStatus | null; label: string }> = [
    { status: 'working', label: 'Working' },
    { status: 'awaiting-input', label: 'Awaiting input' },
    { status: 'error', label: 'Error' },
    { status: 'completed', label: 'Completed' },
    { status: null, label: 'Idle' },
  ];

  for (const { status, label } of cases) {
    it(`distinguishes ${status ?? 'idle'} with a visible label and an accessible name`, async () => {
      const a = makeStore('card-a');
      managerTasks.set(a.data.id, a);
      agentStatusByTaskId.set(a.data.id, status);
      await mount();

      const card = cardEl('card-a');
      // Visible text: never colour or a bare dot alone.
      expect(card.textContent).toContain(label);
      // Accessible name: queryable independent of visible text/colour.
      const statusEl = card.querySelector('[role="status"]')!;
      expect(statusEl.getAttribute('aria-label')).toBe(`Agent status: ${label}`);
    });
  }

  it('gives awaiting-input and completed distinct visible labels despite sharing a status colour', async () => {
    const a = makeStore('card-a');
    const b = makeStore('card-b');
    managerTasks.set(a.data.id, a);
    managerTasks.set(b.data.id, b);
    agentStatusByTaskId.set(a.data.id, 'awaiting-input');
    agentStatusByTaskId.set(b.data.id, 'completed');
    await mount();

    expect(cardEl('card-a').textContent).toContain('Awaiting input');
    expect(cardEl('card-b').textContent).toContain('Completed');
  });
});

describe('Feature Board card — most relevant delivery artifact (ticket #47)', () => {
  setupDom();

  it('shows the current PR over a linked issue when both exist', async () => {
    const linkedIssues: LinkedIssueRoles = {
      version: '1',
      spec: {
        provider: 'github',
        url: 'https://github.com/acme/repo/issues/3',
        title: 'Spec issue',
        identifier: '#3',
      },
    };
    const a = makeStore('card-a', { prs: [makePr({ identifier: '#9' })], linkedIssues });
    managerTasks.set(a.data.id, a);
    await mount();

    expect(cardEl('card-a').textContent).toContain('PR #9');
    expect(cardEl('card-a').textContent).not.toContain('Spec #3');
  });

  it('falls back to the most-advanced linked issue when there is no PR', async () => {
    const linkedIssues: LinkedIssueRoles = {
      version: '1',
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

    expect(cardEl('card-a').textContent).toContain('Spec #3');
  });
});

describe('Feature Board card — code-change statistics (ticket #47)', () => {
  setupDom();

  it('shows additions and deletions when the task has a cached diff', async () => {
    const a = makeStore('card-a', { workspaceGit: { linesAdded: 5, linesDeleted: 2 } });
    managerTasks.set(a.data.id, a);
    await mount();

    const card = cardEl('card-a');
    expect(card.textContent).toContain('+5');
    expect(card.textContent).toContain('-2');
  });

  it('shows nothing when the task has no diff to show', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();

    const card = cardEl('card-a');
    expect(card.textContent).not.toContain('+');
  });
});

describe('Feature Board card — provider/session context and recent activity (ticket #47)', () => {
  setupDom();

  it('shows provider/session context reusing the same conversation stats the sidebar reads', async () => {
    const a = makeStore('card-a');
    a.conversationStats = { claude: 2, codex: 1 };
    managerTasks.set(a.data.id, a);
    await mount();

    const logos = cardEl('card-a').querySelector('[data-mock="provider-logos"]');
    expect(logos).not.toBeNull();
    expect(logos!.textContent).toBe('2'); // two distinct providers
  });

  it('shows relative activity preferring the last-interacted instant over updatedAt', async () => {
    const a = makeStore('card-a', {
      updatedAt: '2020-01-01T00:00:00.000Z',
      lastInteractedAt: '2026-01-01T00:00:00.000Z',
    });
    managerTasks.set(a.data.id, a);
    await mount();

    // `RelativeTime`'s compact form renders a `<time>` with the ISO instant.
    const time = cardEl('card-a').querySelector('time')!;
    expect(time.getAttribute('datetime')).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('Feature Board card — local-only task degrades gracefully (ticket #47)', () => {
  setupDom();

  it('renders usefully with no Linked Issues, no Pull Requests, no diff stats, and no sessions', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    agentStatusByTaskId.set(a.data.id, null);
    await mount();

    const card = cardEl('card-a');
    // The card still renders and still shows its idle agent state.
    expect(card.textContent).toContain('Idle');
    // No artifact badge, no provider logos.
    expect(card.querySelector('[data-mock="provider-logos"]')).toBeNull();
    // Nothing throws, and the card stays in the DOM under its column.
    expect(card.isConnected).toBe(true);
  });
});
