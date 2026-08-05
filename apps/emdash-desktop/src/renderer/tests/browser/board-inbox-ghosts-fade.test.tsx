/**
 * Browser-mode tests for ticket #51: the board Inbox disclosure, Ghost Card
 * sortable exclusion, and the Shipped Fade window disclosure. This ticket is
 * a re-presentation of three already-working features
 * (`BoardLinkSuggestions`, `ghost-cards.tsx`, Shipped Fade) — the point of
 * this suite is to prove every existing behaviour survives: attach, adopt and
 * dismiss per Link Suggestion; Ghost Card adopt/reject and its exclusion from
 * dnd-kit's sortable ids; and Shipped Fade staying a pure display filter.
 *
 * Mounts the real BoardMainPanel in Chromium, following the pattern
 * established by `board-dnd.test.tsx` / `board-detail-panel.test.tsx`:
 * mocked stores, mocked `@renderer/lib/ipc` (so this suite can hand back
 * distinct Link Suggestion / Ghost Card fixtures per test), and the same
 * `AgentStatusIndicator` / `StackedAgentLogos` mocks (both transitively reach
 * unrelated app-wide dependencies these tests have no reason to load).
 */

import type { Result } from '@emdash/shared';
import { observable, runInAction } from 'mobx';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { SHIPPED_FADE_WINDOW_DAYS } from '@renderer/features/board/board-columns';
import type { GhostCard } from '@shared/core/issues/ghost-card';
import type { LinkSuggestion } from '@shared/core/issues/link-suggestion';
import { SHIPPED_FADE_WINDOW_MS } from '@shared/core/pull-requests/pr-workflow-derivation';
import type { PullRequest } from '@shared/core/pull-requests/pull-requests';
import type { CreateTaskError, CreateTaskSuccess, Task } from '@shared/core/tasks/tasks';

// ── Store mocks (mirrors board-dnd.test.tsx / board-detail-panel.test.tsx) ──

type MockStore = {
  data: {
    id: string;
    name: string;
    status: string;
    type: string;
    createdAt: string;
    workflowStage?: string;
    boardRank?: string;
    archivedAt?: string;
    prs: PullRequest[];
  };
  conversationStats: Record<string, number>;
  updateBoardPosition: ReturnType<typeof vi.fn>;
};

const managerTasks = new Map<string, MockStore>();

// `vi.mock` factories are hoisted above all other top-level statements, so a
// mock a factory below needs to reference must itself be declared through
// `vi.hoisted` (mirrors board-detail-panel.test.tsx's `mocks` pattern).
// Overridden per test via `.mockImplementation` / `.mockResolvedValueOnce`.
const mocks = vi.hoisted(() => ({
  getLinkSuggestions: vi.fn(() => Promise.resolve<LinkSuggestion[]>([])),
  acceptLinkSuggestion: vi.fn(() => Promise.resolve()),
  adoptLinkSuggestion:
    vi.fn<
      (
        projectId: string,
        suggestion: LinkSuggestion
      ) => Promise<Result<CreateTaskSuccess, CreateTaskError>>
    >(),
  dismissLinkSuggestion: vi.fn(() => Promise.resolve()),
  getGhostCards: vi.fn(() => Promise.resolve<GhostCard[]>([])),
  adoptGhostCard:
    vi.fn<
      (
        projectId: string,
        ghostCard: GhostCard
      ) => Promise<Result<CreateTaskSuccess, CreateTaskError>>
    >(),
  rejectGhostCard: vi.fn(() => Promise.resolve()),
}));

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
  taskAgentStatus: () => 'idle',
  getTaskStore: (_projectId: string, taskId: string) => managerTasks.get(taskId),
  getTaskGitWorktreeStore: () => undefined,
  // Ticket #68's Conversations section reads this to build its rows.
  getConversationsForTask: () => undefined,
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

// `ConversationAgentIcon` (ticket #68's Conversations section rows) reaches
// the same heavy chain `StackedAgentLogos` above is mocked away for.
vi.mock('@renderer/features/conversations/conversation-agent-icon', () => ({
  ConversationAgentIcon: () => null,
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    issues: {
      getLinkSuggestions: mocks.getLinkSuggestions,
      acceptLinkSuggestion: mocks.acceptLinkSuggestion,
      adoptLinkSuggestion: mocks.adoptLinkSuggestion,
      dismissLinkSuggestion: mocks.dismissLinkSuggestion,
      getGhostCards: mocks.getGhostCards,
      adoptGhostCard: mocks.adoptGhostCard,
      rejectGhostCard: mocks.rejectGhostCard,
      syncIssuesNow: vi.fn(() => Promise.resolve()),
    },
    tasks: {
      syncBoardStages: vi.fn(() => Promise.resolve()),
      getTaskStageAuthority: vi.fn(() =>
        Promise.resolve({ holdingPr: null, isCurrentStageGithubProven: false })
      ),
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
  };
}

/** A store whose `data` is a mobx observable, so mutating it re-renders BoardMainPanel. */
function makeLiveStore(id: string, overrides: Partial<MockStore['data']> = {}) {
  const data = observable({
    id,
    name: id,
    status: 'active',
    type: 'task',
    createdAt: '2026-01-01T00:00:00.000Z',
    prs: [] as PullRequest[],
    ...overrides,
  });
  return {
    data,
    conversationStats: {},
    updateBoardPosition: vi.fn().mockResolvedValue(undefined),
  } as unknown as MockStore & { data: typeof data };
}

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    url: 'https://github.com/acme/repo/pull/1',
    provider: 'github',
    repositoryUrl: 'https://github.com/acme/repo',
    baseRefName: 'main',
    baseRefOid: 'base',
    headRepositoryUrl: 'https://github.com/acme/repo',
    headRefName: 'feature',
    headRefOid: 'head',
    identifier: '#1',
    title: 'Test PR',
    description: null,
    status: 'merged',
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

function makeSuggestion(
  overrides: Partial<LinkSuggestion['issue']> & { role?: LinkSuggestion['role'] } = {}
): LinkSuggestion {
  const { role, ...issueOverrides } = overrides;
  const url = issueOverrides.url ?? 'https://github.com/acme/repo/issues/10';
  return {
    id: url,
    role: role ?? 'spec',
    issue: {
      provider: 'github',
      url,
      title: 'An orphan Spec issue',
      identifier: '#10',
      ...issueOverrides,
    },
  };
}

function makeGhostCard(overrides: Partial<GhostCard['issue']> = {}): GhostCard {
  const url = overrides.url ?? 'https://github.com/acme/repo/issues/5';
  return {
    id: url,
    issue: {
      provider: 'github',
      url,
      title: 'A candidate idea',
      identifier: '#5',
      ...overrides,
    },
  };
}

function makeCreatedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'new-task',
    projectId: 'p1',
    name: 'A created task',
    status: 'todo',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    statusChangedAt: '2026-01-01T00:00:00.000Z',
    isPinned: false,
    prs: [],
    conversations: {},
    type: 'task',
    workflowStage: 'idea',
    ...overrides,
  };
}

// ── Layout CSS: same subset the board's geometry depends on (board-dnd.test.tsx) ──

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

// ── Pointer-drag driver (mirrors board-dnd.test.tsx) ───────────────────────

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

/** Press on `from`, walk to the target in steps, hover a beat, release — a genuine drag. */
async function drag(from: Element, toX: number, toY: number, hoverFrames = 4) {
  const start = center(from);
  from.dispatchEvent(pointer('pointerdown', start.x, start.y));
  await settle();
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

function click(el: Element) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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
    mocks.getLinkSuggestions.mockImplementation(() => Promise.resolve([]));
    mocks.acceptLinkSuggestion.mockImplementation(() => Promise.resolve());
    mocks.adoptLinkSuggestion.mockReset();
    mocks.dismissLinkSuggestion.mockImplementation(() => Promise.resolve());
    mocks.getGhostCards.mockImplementation(() => Promise.resolve([]));
    mocks.adoptGhostCard.mockReset();
    mocks.rejectGhostCard.mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    root.unmount();
    host.remove();
    style.remove();
    managerTasks.clear();
    vi.clearAllMocks();
  });
}

async function mount() {
  root.render(<BoardMainPanel />);
  await settle();
}

/** A card's sortable wrapper div, located by its name (a <span>, not a button). */
function cardEl(name: string): HTMLElement {
  const label = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === name)!;
  return label.parentElement as HTMLElement;
}

/** A card's name <span>, or `undefined` if no such card is rendered. */
function findCardLabel(name: string): HTMLElement | undefined {
  return Array.from(host.querySelectorAll('span')).find((s) => s.textContent === name) as
    | HTMLElement
    | undefined;
}

/** A Ghost Card's root element on the board, located by its stable id (ticket #9). */
function ghostCardEl(id: string): HTMLElement {
  return host.querySelector(`[data-ghost-card="${CSS.escape(id)}"]`) as HTMLElement;
}

/** The column list container (droppable zone) for a given column label. */
function columnZone(label: string): Element {
  const header = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === label)!;
  const column = header.parentElement!.parentElement!;
  return column.lastElementChild!;
}

/** The column's own `role="group"` container for a given column label. */
function columnGroup(label: string): HTMLElement {
  const header = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === label)!;
  return header.parentElement!.parentElement as HTMLElement;
}

/** The board Inbox's toggle button — found by its accessible name (aria-label), never by class or id. */
function inboxToggle(): HTMLElement | undefined {
  return Array.from(host.querySelectorAll('button')).find((b) =>
    b.getAttribute('aria-label')?.includes('link suggestions inbox')
  ) as HTMLElement | undefined;
}

function buttonWithText(text: string): HTMLElement | undefined {
  return Array.from(host.querySelectorAll('button')).find((b) => b.textContent === text) as
    | HTMLElement
    | undefined;
}

function searchInput(): HTMLInputElement {
  return host.querySelector(
    'input[aria-label="Search tasks, Linked Issues, and Pull Requests"]'
  ) as HTMLInputElement;
}

/** Sets the controlled search `<input>` through React's synthetic event system —
 * the native setter bypasses React's value-tracker, which would otherwise
 * swallow the change (same reason as `board-header.test.tsx`'s own helper). */
function typeIntoSearch(value: string) {
  const input = searchInput();
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set;
  nativeSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function needsAttentionToggle(): HTMLElement {
  return host.querySelector('[aria-label="Filter to tasks needing attention"]') as HTMLElement;
}

/** Every Ghost Card currently rendered on the board. */
function renderedGhostCards(): Element[] {
  return Array.from(host.querySelectorAll('[data-ghost-card]'));
}

/** True while the Task Detail Panel is open (its close button exists only then). */
function panelIsOpen(): boolean {
  return host.querySelector('[aria-label="Close task details"]') !== null;
}

describe('Board Inbox — count-bearing summary (ticket #51)', () => {
  setupDom();

  it('renders nothing when there are no Link Suggestions', async () => {
    await mount();
    await settle();

    expect(inboxToggle()).toBeUndefined();
  });

  it('summarizes suggestions behind a collapsed toggle instead of an always-expanded list', async () => {
    mocks.getLinkSuggestions.mockImplementation(() => Promise.resolve([makeSuggestion()]));
    await mount();
    await settle();

    const toggle = inboxToggle();
    expect(toggle).toBeTruthy();
    expect(toggle!.getAttribute('aria-expanded')).toBe('false');
    // Accessible name (queried above by aria-label, not by class/test id)
    // names both the action and the count.
    expect(toggle!.getAttribute('aria-label')).toContain('Expand');
    expect(toggle!.getAttribute('aria-label')).toContain('1');
    expect(toggle!.textContent).toContain('1');
    // Collapsed: none of the per-suggestion reconciliation controls render yet.
    expect(buttonWithText('Attach')).toBeUndefined();
    expect(buttonWithText('Adopt')).toBeUndefined();
    expect(buttonWithText('Dismiss')).toBeUndefined();
  });

  it('counts every pending suggestion, derived from the same suggestion state the workflow reconciles', async () => {
    mocks.getLinkSuggestions.mockImplementation(() =>
      Promise.resolve([
        makeSuggestion({ url: 'https://github.com/acme/repo/issues/10' }),
        makeSuggestion({
          role: 'map',
          url: 'https://github.com/acme/repo/issues/11',
          title: 'An orphan Map issue',
        }),
      ])
    );
    await mount();
    await settle();

    expect(inboxToggle()!.getAttribute('aria-label')).toContain('2');
  });

  it('expanding the Inbox through its accessible name reveals attach, adopt and dismiss for the suggestion', async () => {
    const suggestion = makeSuggestion();
    mocks.getLinkSuggestions.mockImplementation(() => Promise.resolve([suggestion]));
    await mount();
    await settle();

    click(inboxToggle()!);
    await settle();

    const toggle = inboxToggle()!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toContain('Collapse');
    expect(host.textContent).toContain(suggestion.issue.title);
    expect(
      host.querySelector(`select[aria-label='Attach "${suggestion.issue.title}" to a task']`)
    ).not.toBeNull();
    expect(buttonWithText('Attach')).toBeTruthy();
    expect(buttonWithText('Adopt')).toBeTruthy();
    expect(buttonWithText('Dismiss')).toBeTruthy();
  });

  it('collapsing hides the reconciliation controls again without losing the suggestion', async () => {
    mocks.getLinkSuggestions.mockImplementation(() => Promise.resolve([makeSuggestion()]));
    await mount();
    await settle();

    click(inboxToggle()!);
    await settle();
    expect(buttonWithText('Dismiss')).toBeTruthy();

    click(inboxToggle()!);
    await settle();

    expect(inboxToggle()!.getAttribute('aria-expanded')).toBe('false');
    expect(buttonWithText('Dismiss')).toBeUndefined();
    // The count survives the collapse — nothing was reconciled or lost.
    expect(inboxToggle()!.getAttribute('aria-label')).toContain('1');
  });

  it('collapsing and expanding the Inbox never calls any reconciliation RPC — it is local, display-only state', async () => {
    mocks.getLinkSuggestions.mockImplementation(() => Promise.resolve([makeSuggestion()]));
    await mount();
    await settle();

    click(inboxToggle()!); // expand
    await settle();
    click(inboxToggle()!); // collapse
    await settle();
    click(inboxToggle()!); // expand again
    await settle();

    expect(mocks.acceptLinkSuggestion).not.toHaveBeenCalled();
    expect(mocks.adoptLinkSuggestion).not.toHaveBeenCalled();
    expect(mocks.dismissLinkSuggestion).not.toHaveBeenCalled();
  });
});

describe('Board Inbox — retains attach, adopt and dismiss per suggestion (ticket #51)', () => {
  setupDom();

  it('Attach: selecting a task and clicking Attach calls the existing accept RPC and removes the row', async () => {
    const suggestion = makeSuggestion();
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    mocks.getLinkSuggestions.mockImplementation(() => Promise.resolve([suggestion]));
    await mount();
    await settle();

    click(inboxToggle()!);
    await settle();

    const select = host.querySelector(
      `select[aria-label='Attach "${suggestion.issue.title}" to a task']`
    ) as HTMLSelectElement;
    select.value = 'card-a';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    click(buttonWithText('Attach')!);
    await settle();
    await settle();

    expect(mocks.acceptLinkSuggestion).toHaveBeenCalledWith('p1', 'card-a', suggestion);
    // The Inbox disappears entirely once nothing is left to reconcile,
    // exactly like the pre-Inbox component did at zero suggestions.
    expect(inboxToggle()).toBeUndefined();
  });

  it('Adopt: clicking Adopt calls the existing adopt RPC and removes the row', async () => {
    const suggestion = makeSuggestion();
    mocks.getLinkSuggestions.mockImplementation(() => Promise.resolve([suggestion]));
    mocks.adoptLinkSuggestion.mockResolvedValueOnce({
      success: true,
      data: { task: makeCreatedTask() },
    });
    await mount();
    await settle();

    click(inboxToggle()!);
    await settle();

    click(buttonWithText('Adopt')!);
    await settle();
    await settle();

    expect(mocks.adoptLinkSuggestion).toHaveBeenCalledWith('p1', suggestion);
    expect(inboxToggle()).toBeUndefined();
  });

  it('Dismiss: clicking Dismiss calls the existing dismiss RPC and removes the row', async () => {
    const suggestion = makeSuggestion();
    mocks.getLinkSuggestions.mockImplementation(() => Promise.resolve([suggestion]));
    await mount();
    await settle();

    click(inboxToggle()!);
    await settle();

    click(buttonWithText('Dismiss')!);
    await settle();
    await settle();

    expect(mocks.dismissLinkSuggestion).toHaveBeenCalledWith('p1', suggestion);
    expect(inboxToggle()).toBeUndefined();
  });
});

describe('Ghost Cards remain excluded from sortable ids (ticket #51)', () => {
  setupDom();

  it('a real task card carries the sortable attributes dnd-kit assigns draggable cards', async () => {
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    await mount();
    await settle();

    // dnd-kit's `useSortable` assigns this exact attribute to whichever
    // element activates the drag. Ticket #52 moved it from the card's own
    // wrapper onto its dedicated "Move" handle (a sibling button inside the
    // card) — spreading it on the card body itself would misdescribe it,
    // since Enter/Space there select the card rather than picking it up.
    const moveHandle = cardEl('card-a').querySelector(`[aria-label="Move card-a"]`);
    expect(moveHandle?.getAttribute('aria-roledescription')).toBe('sortable');
  });

  it("a Ghost Card never receives dnd-kit's sortable/draggable attributes — mirrors #43's sidebar Board row exclusion", async () => {
    const ghostCard = makeGhostCard();
    mocks.getGhostCards.mockImplementation(() => Promise.resolve([ghostCard]));
    await mount();
    await settle();

    const el = ghostCardEl(ghostCard.id);
    expect(el).toBeTruthy();
    expect(el.getAttribute('aria-roledescription')).toBeNull();
    expect(el.getAttribute('aria-describedby')).toBeNull();
    // Ticket #52: a Ghost Card also never gets the real card's "Move" handle
    // — it is never draggable/sortable at all, so there is nothing to move.
    expect(el.querySelector('[aria-label^="Move "]')).toBeNull();
  });

  it('a drag gesture on a Ghost Card never persists a board position on any task, and the card stays put', async () => {
    await page.viewport(2200, 800);
    const ghostCard = makeGhostCard();
    const a = makeStore('card-a');
    managerTasks.set(a.data.id, a);
    mocks.getGhostCards.mockImplementation(() => Promise.resolve([ghostCard]));
    await mount();
    await settle();

    const target = center(columnZone('Spec'));
    await drag(ghostCardEl(ghostCard.id), target.x, target.y);

    expect(a.updateBoardPosition).not.toHaveBeenCalled();
    // Ghost Cards only ever render in Idea (mirrors board-main-panel.tsx's
    // `column === 'idea' ? ghostCards : undefined` wiring) — still there,
    // never relocated by the attempted drag.
    expect(columnZone('Idea').contains(ghostCardEl(ghostCard.id))).toBe(true);
  });
});

/**
 * Regression: Ghost Cards were rendered straight from `useGhostCards` and so
 * bypassed the board's own filtering entirely. A query matching nothing hid
 * every task card while leaving all four candidates on screen, so the board
 * read as unfiltered even though the header advertised an active filter — and
 * "Needs Attention" kept showing candidates that can never need attention.
 * `ghostCardPassesBoardFilters` (board-filters.ts) now gates them; these
 * assertions drive it through the real header controls.
 */
describe('Ghost Cards honour the board search and filters', () => {
  setupDom();

  it('hides a Ghost Card whose issue does not match the search query, and keeps a matching one', async () => {
    const matching = makeGhostCard({
      url: 'https://github.com/acme/repo/issues/58',
      title: 'SplitButton never renders the tone dot',
      identifier: '#58',
    });
    const other = makeGhostCard({
      url: 'https://github.com/acme/repo/issues/59',
      title: 'MarkdownRenderer parses raw HTML',
      identifier: '#59',
    });
    mocks.getGhostCards.mockImplementation(() => Promise.resolve([matching, other]));
    await mount();
    await settle();
    expect(renderedGhostCards()).toHaveLength(2);

    typeIntoSearch('splitbutton');
    await settle();

    expect(ghostCardEl(matching.id)).toBeTruthy();
    expect(renderedGhostCards()).toHaveLength(1);
  });

  it("matches a Ghost Card on its candidate issue's display identifier too", async () => {
    const ghostCard = makeGhostCard({ title: 'Unrelated title', identifier: '#58' });
    mocks.getGhostCards.mockImplementation(() => Promise.resolve([ghostCard]));
    await mount();
    await settle();

    typeIntoSearch('#58');
    await settle();
    expect(ghostCardEl(ghostCard.id)).toBeTruthy();

    typeIntoSearch('#59');
    await settle();
    expect(renderedGhostCards()).toHaveLength(0);
  });

  it('hides every Ghost Card when a search query matches nothing at all', async () => {
    mocks.getGhostCards.mockImplementation(() =>
      Promise.resolve([
        makeGhostCard({ url: 'https://github.com/acme/repo/issues/1', title: 'One' }),
        makeGhostCard({ url: 'https://github.com/acme/repo/issues/2', title: 'Two' }),
      ])
    );
    await mount();
    await settle();
    expect(renderedGhostCards()).toHaveLength(2);

    typeIntoSearch('qqqqq-matches-nothing');
    await settle();

    expect(renderedGhostCards()).toHaveLength(0);
  });

  it('hides Ghost Cards under Needs Attention — a candidate has no agent to need it', async () => {
    const ghostCard = makeGhostCard();
    mocks.getGhostCards.mockImplementation(() => Promise.resolve([ghostCard]));
    await mount();
    await settle();
    expect(ghostCardEl(ghostCard.id)).toBeTruthy();

    click(needsAttentionToggle());
    await settle();

    expect(renderedGhostCards()).toHaveLength(0);
  });

  it("restores hidden Ghost Cards once the query is cleared — filtering never consumed the project's candidates", async () => {
    const ghostCard = makeGhostCard();
    mocks.getGhostCards.mockImplementation(() => Promise.resolve([ghostCard]));
    await mount();
    await settle();

    typeIntoSearch('qqqqq-matches-nothing');
    await settle();
    expect(renderedGhostCards()).toHaveLength(0);

    typeIntoSearch('');
    await settle();

    expect(ghostCardEl(ghostCard.id)).toBeTruthy();
    // The mutation seam: filtering a candidate out of view must never adopt or
    // reject it — nothing is persisted for a ghost before adoption.
    expect(mocks.adoptGhostCard).not.toHaveBeenCalled();
    expect(mocks.rejectGhostCard).not.toHaveBeenCalled();
  });

  it('keeps an open ghost inspector open while the search hides its card', async () => {
    const ghostCard = makeGhostCard({ title: 'A candidate idea' });
    mocks.getGhostCards.mockImplementation(() => Promise.resolve([ghostCard]));
    await mount();
    await settle();

    click(ghostCardEl(ghostCard.id));
    await settle();
    expect(panelIsOpen()).toBe(true);

    typeIntoSearch('qqqqq-matches-nothing');
    await settle();

    // The card is gone from the column, but the panel the user deliberately
    // opened stays: its target resolves against the unfiltered candidate set,
    // mirroring how `storeById` stays unfiltered for tasks.
    expect(renderedGhostCards()).toHaveLength(0);
    expect(panelIsOpen()).toBe(true);
  });
});

describe('Shipped Fade — discloses its window and stays display-only (ticket #51)', () => {
  setupDom();

  it("discloses the fade window on the Shipped column's accessible name, derived from the fade logic's own constant", async () => {
    await mount();
    await settle();

    const shipped = columnGroup('Shipped');
    expect(shipped.getAttribute('aria-label')).toContain(`${SHIPPED_FADE_WINDOW_DAYS} days`);
  });

  it('hides a Shipped task whose PR merged past the fade window, without ever calling updateBoardPosition', async () => {
    const oldMergedAt = new Date(Date.now() - (SHIPPED_FADE_WINDOW_MS + 1000)).toISOString();
    const a = makeStore('faded-task', {
      workflowStage: 'shipped',
      prs: [makePr({ status: 'merged', mergedAt: oldMergedAt })],
    });
    managerTasks.set(a.data.id, a);
    await mount();
    await settle();

    expect(findCardLabel('faded-task')).toBeUndefined();
    expect(a.updateBoardPosition).not.toHaveBeenCalled();
  });

  it('keeps showing a Shipped task whose PR merged inside the fade window', async () => {
    const recentMergedAt = new Date(Date.now() - 1000).toISOString();
    const a = makeStore('fresh-task', {
      workflowStage: 'shipped',
      prs: [makePr({ status: 'merged', mergedAt: recentMergedAt })],
    });
    managerTasks.set(a.data.id, a);
    await mount();
    await settle();

    expect(findCardLabel('fresh-task')).toBeTruthy();
  });

  it('a task that ages past the fade window disappears from a re-render with no mutation call — purely a display filter', async () => {
    const stillFresh = new Date(Date.now() - (SHIPPED_FADE_WINDOW_MS - 2000)).toISOString();
    const a = makeLiveStore('aging-task', {
      workflowStage: 'shipped',
      prs: [makePr({ status: 'merged', mergedAt: stillFresh })],
    });
    managerTasks.set(a.data.id, a);
    await mount();
    await settle();

    expect(findCardLabel('aging-task')).toBeTruthy();

    // Simulate time passing past the fade window — no user action, no drag,
    // no explicit archive. The card must disappear on the next render alone.
    const nowStale = new Date(Date.now() - (SHIPPED_FADE_WINDOW_MS + 2000)).toISOString();
    runInAction(() => {
      a.data.prs = [makePr({ status: 'merged', mergedAt: nowStale })];
    });
    await settle();

    expect(findCardLabel('aging-task')).toBeUndefined();
    // The mutation seam: Shipped Fade hiding the card never wrote anything —
    // no board-position update, no archive — the task keeps its stage forever.
    expect(a.updateBoardPosition).not.toHaveBeenCalled();
  });
});
