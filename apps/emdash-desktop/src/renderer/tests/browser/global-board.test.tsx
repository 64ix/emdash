/**
 * Browser-mode integration tests for the Global Board (spec #104, ticket
 * #107): mounts the real `GlobalBoardMainPanel` in Chromium with mocked
 * stores, and asserts the cross-project behavior the ticket promises —
 * mixed-project stage columns with project markers, drags writing
 * stage/rank through the task-scoped write path with stage-authority
 * blocking, card clicks opening the Task Detail Panel in place, no creation
 * affordance anywhere, and the project multi-select filtering the board and
 * persisting through the sidebar store.
 *
 * Mocking follows the pattern established by `board-dnd.test.tsx` /
 * `board-header.test.tsx` (the panel imports the Feature Board's card and
 * authority helper, so their mock set applies), with one addition: the
 * Global Board reads `appState.projects.projects` and `appState.sidebar`
 * directly, so `@renderer/lib/stores/app-state` is mocked with observable
 * stand-ins.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { LinkedIssueRoles } from '@shared/core/linked-issue';
import type { PullRequest } from '@shared/core/pull-requests/pull-requests';
import type { TaskStageAuthority } from '@shared/core/tasks/tasks';

// ── Store mocks ───────────────────────────────────────────────────────────────

type MockStore = {
  data: {
    id: string;
    name: string;
    status: string;
    type: string;
    workflowStage?: string;
    boardRank?: string;
    archivedAt?: string;
    isPinned?: boolean;
    // Stage authority (ticket #48): the facts `authorityForTask` reads.
    linkedIssues?: LinkedIssueRoles;
    prs: PullRequest[];
    assignedPr?: PullRequest;
    workspaceId?: string;
  };
  conversationStats: Record<string, number>;
  updateBoardPosition: ReturnType<typeof vi.fn>;
  setPinned: ReturnType<typeof vi.fn>;
  state?: 'unregistered' | 'unprovisioned' | 'provisioned';
  phase?: string | null;
};

type MockProject = {
  id: string;
  name: string;
  mountedProject: { taskManager: { tasks: Map<string, MockStore> } } | undefined;
};

// Hoisted plain containers + mocks: `vi.mock` factories (hoisted above every
// top-level statement) may only reference these, so the observable store
// reactivity itself stays out of this suite — the tests drive the
// persistence → render wiring by (re)mounting against this state, exactly
// like the existing board suites drive their plain `managerTasks` map.
const mocks = vi.hoisted(() => ({
  projects: new Map<string, MockProject>(),
  sidebar: {
    globalBoardProjectFilter: undefined as string[] | undefined,
    setGlobalBoardProjectFilter: vi.fn((projectIds: string[] | undefined) => {
      mocks.sidebar.globalBoardProjectFilter = projectIds;
    }),
  },
  navigate: vi.fn(),
  captureTelemetry: vi.fn(),
  provisionTask: vi.fn(() => Promise.resolve()),
  getTaskStageAuthority: vi.fn(() =>
    Promise.resolve<TaskStageAuthority>({ holdingPr: null, isCurrentStageGithubProven: false })
  ),
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useParams: () => ({ params: {} }),
  useNavigate: () => ({ navigate: mocks.navigate }),
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    projects: { projects: mocks.projects },
    sidebar: mocks.sidebar,
  },
  sidebarStore: mocks.sidebar,
}));

vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectStore: (projectId: string) => mocks.projects.get(projectId),
  projectDisplayName: (store: MockProject | undefined) => store?.name ?? undefined,
  // Ticket #100: the Task Detail Panel's assign picker reads the project's
  // PR-capable repository URL through this selector; undefined here means
  // the picker's queries stay disabled.
  getGitRepositoryStore: () => undefined,
}));

vi.mock('@renderer/features/tasks/stores/task-selectors', () => ({
  getTaskManagerStore: () => ({
    tasks: new Map(),
    provisionTask: mocks.provisionTask,
  }),
  taskAgentStatus: () => 'idle',
  // The Task Detail Panel resolves the clicked card through this selector —
  // look it up across every mocked project's task manager.
  getTaskStore: (_projectId: string, taskId: string) => {
    for (const project of mocks.projects.values()) {
      const store = project.mountedProject?.taskManager.tasks.get(taskId);
      if (store) return store;
    }
    return undefined;
  },
  getTaskGitWorktreeStore: () => undefined,
  // Ticket #68's Conversations section reads this to build its rows.
  getConversationsForTask: () => undefined,
}));

vi.mock('@renderer/features/tasks/stores/task-store', () => ({
  registeredTaskData: (store: MockStore) => store.data,
  // `isRegistered` is imported by TaskGitDiffStats / the store chain; the
  // mock shadows the real export so that import does not resolve to
  // `undefined` (same as board-dnd.test.tsx).
  isRegistered: () => true,
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
  captureTelemetry: mocks.captureTelemetry,
}));

// The Task Detail Panel fetches stage authority on open; every other RPC the
// imported module graph references is never called in this suite.
vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    tasks: {
      getTaskStageAuthority: mocks.getTaskStageAuthority,
    },
  },
  events: {
    on: vi.fn(() => () => {}),
  },
}));

import { GlobalBoardMainPanel } from '@renderer/features/board/global-board-main-panel';

function makeStore(id: string, overrides: Partial<MockStore['data']> = {}): MockStore {
  return {
    data: { id, name: id, status: 'active', type: 'task', prs: [], ...overrides },
    conversationStats: {},
    updateBoardPosition: vi.fn().mockResolvedValue(undefined),
    setPinned: vi.fn().mockResolvedValue(undefined),
    state: 'provisioned',
    phase: null,
  };
}

function makeProject(projectId: string, name: string, stores: MockStore[]): MockProject {
  return {
    id: projectId,
    name,
    mountedProject: { taskManager: { tasks: new Map(stores.map((s) => [s.data.id, s])) } },
  };
}

function addProject(projectId: string, name: string, stores: MockStore[]): void {
  mocks.projects.set(projectId, makeProject(projectId, name, stores));
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

// ── Layout CSS: just enough of the utility classes the board uses ─────────────

const LAYOUT_CSS = `
  html, body, #board-host { margin: 0; height: 100%; }
  .flex { display: flex; }
  .flex-col { flex-direction: column; }
  .flex-1 { flex: 1 1 0%; min-height: 0; }
  .flex-wrap { flex-wrap: wrap; }
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

// ── Pointer-drag driver (mirrors board-dnd.test.tsx) ─────────────────────────

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

/** Press on `from`, walk to the target in steps, hover a beat, release. */
async function drag(from: Element, toX: number, toY: number, hoverFrames = 4) {
  const start = center(from);
  from.dispatchEvent(pointer('pointerdown', start.x, start.y));
  await settle();
  // Exceed the 6px activation constraint, then walk to the target in steps so
  // dnd-kit gets intermediate collision passes (like a real hand would).
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

/** A stationary click (no movement) — the gesture that opens the panel. */
function click(el: Element | null) {
  expect(el).not.toBeNull();
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

// ── Harness ───────────────────────────────────────────────────────────────────

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
    await page.viewport(2200, 800);
  });

  afterEach(() => {
    root.unmount();
    host.remove();
    style.remove();
    mocks.projects.clear();
    mocks.sidebar.globalBoardProjectFilter = undefined;
    vi.clearAllMocks();
  });
}

async function mount() {
  root.render(<GlobalBoardMainPanel />);
  await settle();
}

/** The column's own outer container — carries `aria-disabled`/`title` (ticket #48). */
function columnContainer(label: string): Element {
  const header = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === label)!;
  return header.parentElement!.parentElement!;
}

/** The column list container (droppable zone) for a given column label. */
function columnZone(label: string): Element {
  return columnContainer(label).lastElementChild!;
}

/** A card's root element, located by its task name (a <span>, unique per test). */
function cardEl(name: string): Element {
  const label = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === name)!;
  return label.parentElement!; // sortable wrapper div
}

function cardNamesIn(zone: Element): (string | null)[] {
  // Each card's own name is its first <span> descendant (ticket #47 added
  // further spans to a card's body — agent state, artifact badge, provider
  // logos — so this reads only the title of each direct card child).
  return Array.from(zone.children).map((card) => card.querySelector('span')?.textContent ?? null);
}

function projectsTrigger(): HTMLElement {
  return Array.from(host.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Projects')
  ) as HTMLElement;
}

/** Popover content renders in a portal on document.body — query it globally. */
function projectCheckbox(name: string): HTMLElement | null {
  return document.querySelector(`[aria-label="${name}"]`);
}

function activeFiltersText(): string {
  return document.querySelector('[aria-label="Active filters"]')?.textContent ?? '';
}

describe('Global Board — mixed-project columns and project markers (spec #104, ticket #107)', () => {
  setupDom();

  it("renders every project's cards in the shared stage columns, each marked with its project", async () => {
    const alphaSpec = makeStore('alpha-spec', { workflowStage: 'spec', boardRank: 'a' });
    const betaSpec = makeStore('beta-spec', { workflowStage: 'spec', boardRank: 'm' });
    const betaUnstaged = makeStore('beta-unstaged');
    const alphaTriage = makeStore('alpha-triage', { workflowStage: 'triage' });
    addProject('alpha', 'Alpha', [alphaSpec, alphaTriage]);
    addProject('beta', 'Beta', [betaSpec, betaUnstaged]);
    await mount();

    // Unstaged and Triage included, exactly like the Feature Board's columns.
    expect(cardNamesIn(columnZone('Unstaged'))).toEqual(['beta-unstaged']);
    expect(cardNamesIn(columnZone('Spec'))).toEqual(['alpha-spec', 'beta-spec']);
    expect(cardNamesIn(columnZone('Triage'))).toEqual(['alpha-triage']);

    // Each card carries its project marker.
    const specZone = columnZone('Spec');
    const badgeTexts = Array.from(specZone.querySelectorAll('span')).map((s) => s.textContent);
    expect(badgeTexts).toContain('Alpha');
    expect(badgeTexts).toContain('Beta');
    const unstagedZone = columnZone('Unstaged');
    expect(
      Array.from(unstagedZone.querySelectorAll('span')).some((s) => s.textContent === 'Beta')
    ).toBe(true);
  });

  it('renders an empty state when no project has a displayable card', async () => {
    await mount();
    expect(host.textContent).toContain('No projects with displayable tasks yet');
  });

  it('omits a project whose tasks are all archived — from the board and the filter list', async () => {
    const archived = makeStore('archived-task', { archivedAt: '2026-01-01T00:00:00.000Z' });
    addProject('gamma', 'Gamma', [archived]);
    addProject('alpha', 'Alpha', [makeStore('alpha-spec', { workflowStage: 'spec' })]);
    await mount();

    expect(cardNamesIn(columnZone('Spec'))).toEqual(['alpha-spec']);

    click(projectsTrigger());
    await settle();
    expect(projectCheckbox('Alpha')).not.toBeNull();
    expect(projectCheckbox('Beta')).toBeNull();
    expect(projectCheckbox('Gamma')).toBeNull();
  });
});

describe('Global Board — drag-and-drop (spec #104, ticket #107)', () => {
  setupDom();

  it('drags an unstaged card into a stage column and writes stage + rank through the task store', async () => {
    const a = makeStore('card-a');
    const b = makeStore('card-b');
    addProject('alpha', 'Alpha', [a, b]);
    await mount();

    const target = center(columnZone('Spec'));
    await drag(cardEl('card-a'), target.x, target.y);

    expect(a.updateBoardPosition).toHaveBeenCalledTimes(1);
    expect(a.updateBoardPosition).toHaveBeenCalledWith('spec', expect.any(String));
  });

  it('drops a staged card back into Unstaged (stage cleared)', async () => {
    const a = makeStore('card-a', { workflowStage: 'spec', boardRank: 'm' });
    const b = makeStore('card-b');
    addProject('alpha', 'Alpha', [a, b]);
    await mount();

    const target = center(columnZone('Unstaged'));
    await drag(cardEl('card-a'), target.x, target.y);

    expect(a.updateBoardPosition).toHaveBeenCalledTimes(1);
    expect(a.updateBoardPosition).toHaveBeenCalledWith(null, expect.any(String));
  });

  it('interpolates Board Rank in the shared per-stage column across projects', async () => {
    // Stored order in the shared Spec column: alpha-card ('a') < beta-top ('m')
    // < beta-bottom ('x'). Dragging beta-bottom into the gap just above
    // beta-top must land strictly between 'a' and 'm'.
    const alphaCard = makeStore('alpha-card', { workflowStage: 'spec', boardRank: 'a' });
    const betaTop = makeStore('beta-top', { workflowStage: 'spec', boardRank: 'm' });
    const betaBottom = makeStore('beta-bottom', { workflowStage: 'spec', boardRank: 'x' });
    addProject('alpha', 'Alpha', [alphaCard]);
    addProject('beta', 'Beta', [betaTop, betaBottom]);
    await mount();

    const betaTopCenter = center(cardEl('beta-top'));
    await drag(cardEl('beta-bottom'), betaTopCenter.x, betaTopCenter.y - 10);

    expect(betaBottom.updateBoardPosition).toHaveBeenCalledTimes(1);
    const [stage, rank] = betaBottom.updateBoardPosition.mock.calls[0]!;
    expect(stage).toBe('spec');
    expect(rank > 'a').toBe(true);
    expect(rank < 'm').toBe(true);
  });

  it('blocks a GitHub-authoritative card from an unsafe cross-stage destination', async () => {
    const a = makeStore('card-a', { workflowStage: 'spec', linkedIssues: openSpecLink() });
    addProject('alpha', 'Alpha', [a]);
    await mount();

    const target = center(columnZone('Idea'));
    await drag(cardEl('card-a'), target.x, target.y);

    expect(a.updateBoardPosition).not.toHaveBeenCalled();
    expect(mocks.captureTelemetry).toHaveBeenCalledWith(
      'board_move_blocked',
      expect.objectContaining({
        from_stage: 'spec',
        attempted_stage: 'idea',
        governing_fact: 'open-spec',
      })
    );
  });

  it('allows a cross-stage destination the governing fact would not contest', async () => {
    const a = makeStore('card-a', { workflowStage: 'spec', linkedIssues: openSpecLink() });
    addProject('alpha', 'Alpha', [a]);
    await mount();

    const target = center(columnZone('Implementing'));
    await drag(cardEl('card-a'), target.x, target.y);

    expect(a.updateBoardPosition).toHaveBeenCalledTimes(1);
    expect(a.updateBoardPosition).toHaveBeenCalledWith('implementing', expect.any(String));
  });
});

describe('Global Board — Task Detail Panel and creation absence (spec #104, ticket #107)', () => {
  setupDom();

  it("opens the Task Detail Panel for the clicked card, scoped to the card's own project", async () => {
    const a = makeStore('card-a', { workflowStage: 'spec' });
    addProject('alpha', 'Alpha', [a]);
    await mount();

    click(cardEl('card-a'));
    await settle();

    // The panel opens in place: its header carries the task name and a close
    // button (CONTEXT.md "Task Detail Panel" — same ephemeral behavior as the
    // Feature Board).
    const panelHeading = Array.from(host.querySelectorAll('h2')).find(
      (h) => h.textContent === 'card-a'
    );
    expect(panelHeading).toBeDefined();
    expect(host.querySelector('[aria-label="Close task details"]')).not.toBeNull();
  });

  it('offers no creation affordance anywhere — no header button, no column "+"', async () => {
    const a = makeStore('card-a', { workflowStage: 'spec' });
    addProject('alpha', 'Alpha', [a]);
    await mount();

    expect(
      Array.from(host.querySelectorAll('button')).some((b) => b.textContent?.includes('New task'))
    ).toBe(false);
    expect(host.querySelector('button[aria-label^="New task in"]')).toBeNull();
  });
});

describe('Global Board — project multi-select (spec #104, ticket #107)', () => {
  setupDom();

  it('defaults to all projects, filters the board on deselection, and persists through the sidebar store', async () => {
    const alphaCard = makeStore('alpha-card', { workflowStage: 'spec' });
    const betaCard = makeStore('beta-card', { workflowStage: 'spec' });
    addProject('alpha', 'Alpha', [alphaCard]);
    addProject('beta', 'Beta', [betaCard]);
    await mount();

    // Default: all projects' cards are present.
    expect(cardNamesIn(columnZone('Spec'))).toEqual(['alpha-card', 'beta-card']);

    // Deselect Beta through the Projects popover.
    click(projectsTrigger());
    await settle();
    click(projectCheckbox('Beta'));
    await settle();

    // The selection persists through the sidebar store — the only storage
    // path (wave 1's `setGlobalBoardProjectFilter`, snapshot-backed).
    expect(mocks.sidebar.setGlobalBoardProjectFilter).toHaveBeenCalledWith(['alpha']);
    expect(mocks.sidebar.globalBoardProjectFilter).toEqual(['alpha']);

    // A fresh render against the persisted state (the store's own MobX
    // reactivity re-renders the app live; here the remount proves the
    // persistence → render wiring end to end): Beta's cards are gone,
    // Alpha's stay, and the excluded project is explained by a chip.
    root.unmount();
    root = createRoot(host);
    await mount();
    expect(cardNamesIn(columnZone('Spec'))).toEqual(['alpha-card']);
    expect(activeFiltersText()).toContain('Beta');

    // Re-selecting Beta returns to the canonical default (empty = all).
    click(projectsTrigger());
    await settle();
    click(projectCheckbox('Beta'));
    await settle();
    expect(mocks.sidebar.setGlobalBoardProjectFilter).toHaveBeenLastCalledWith([]);

    root.unmount();
    root = createRoot(host);
    await mount();
    expect(cardNamesIn(columnZone('Spec'))).toEqual(['alpha-card', 'beta-card']);
    expect(activeFiltersText()).toBe('');
  });

  it('restores a persisted selection on open (per-workspace persistence, default all)', async () => {
    const alphaCard = makeStore('alpha-card', { workflowStage: 'spec' });
    const betaCard = makeStore('beta-card', { workflowStage: 'spec' });
    addProject('alpha', 'Alpha', [alphaCard]);
    addProject('beta', 'Beta', [betaCard]);
    // A selection persisted by an earlier session (wave 1's snapshot field).
    mocks.sidebar.globalBoardProjectFilter = ['beta'];
    await mount();

    expect(cardNamesIn(columnZone('Spec'))).toEqual(['beta-card']);
    expect(activeFiltersText()).toContain('Alpha');
  });
});
