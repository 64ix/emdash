/**
 * Browser-mode tests for the Global Board entry point in the left sidebar
 * (spec #104, ticket #108): a plain Board button above the pinned-task list
 * and below the space switcher, with no attention badge, whose click opens
 * the Global Board.
 *
 * Mounts the REAL `LeftSidebar` (the same pattern as the sidebar row suites,
 * which mount the real row component) with the heavyweight surrounding
 * features stubbed out — the layout's responsibility is the placement and
 * the button's behavior, not the pinned list or the space switcher. The
 * space switcher and the pinned-task list are replaced by stable
 * `data-testid` anchors so DOM order can be asserted precisely.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  currentView: 'home' as string,
  setCollapsed: vi.fn(),
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: mocks.navigate }),
  useWorkspaceSlots: () => ({ currentView: mocks.currentView }),
  isCurrentView: (current: string | null | undefined, target: string) => current === target,
  useParams: () => ({ params: {} }),
}));

vi.mock('@renderer/lib/layout/layout-provider', () => ({
  useWorkspaceLayoutContext: () => ({
    isLeftOpen: true,
    setCollapsed: mocks.setCollapsed,
  }),
}));

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useShowModal: () => vi.fn(),
  showModal: vi.fn(),
}));

// The real app-state singleton spins up store resources that RPC-fetch on
// construction (ssh.getHealthStates) — unavailable in the browser harness —
// so the sidebar store is stubbed with the empty-project double the other
// sidebar suites use; the empty state is what the real chain renders anyway.
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    sshConnections: {
      stateFor: () => 'connected' as string | null,
      connect: vi.fn(),
    },
  },
  sidebarStore: {
    get sidebarRows() {
      return [];
    },
    get isEmpty() {
      return true;
    },
    orderedProjects: [] as { id: string }[],
    expandedProjectIds: {
      has: () => false,
      add: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
    },
    collapsedStageGroupIdsByProject: {},
    hiddenTaskIdsByProject: {},
    taskSortBy: 'created-at',
    ensureProjectExpanded: vi.fn(),
    toggleProjectExpanded: vi.fn(),
    toggleStageGroupCollapsed: vi.fn(),
    isStageGroupCollapsed: () => false,
    visibleTaskIdsForProject: () => [],
    hideTaskFromSidebar: vi.fn(),
    showTaskInSidebar: vi.fn(),
  },
}));

vi.mock('@renderer/lib/ui/shortcut', () => ({
  BoundShortcut: () => null,
  Shortcut: () => null,
}));

vi.mock('@renderer/features/provider-usage/provider-usage-gauges', () => ({
  ProviderUsageGauges: () => null,
}));

vi.mock('@renderer/features/sidebar/sidebar-space', () => ({
  SidebarSpace: () => <div data-testid="space-switcher" />,
}));

vi.mock('@renderer/features/sidebar/pinned-task-list', () => ({
  SidebarPinnedTaskList: () => <div data-testid="pinned-task-list" />,
}));

vi.mock('@renderer/features/sidebar/sidebar-search-trigger', () => ({
  SidebarSearchTrigger: () => null,
}));

vi.mock('@renderer/features/sidebar/sidebar-virtual-list', () => ({
  SidebarVirtualList: () => null,
}));

vi.mock('@renderer/features/sidebar/projects-group-label', () => ({
  ProjectsGroupLabel: () => null,
}));

vi.mock('@renderer/features/sidebar/update-section', () => ({
  UpdateSection: () => null,
}));

vi.mock('@renderer/features/sidebar/use-sidebar-drop', () => ({
  useSidebarDrop: () => ({
    isDragOver: false,
    onDragOver: vi.fn(),
    onDragEnter: vi.fn(),
    onDragLeave: vi.fn(),
    onDrop: vi.fn(),
  }),
}));

import { LeftSidebar } from '@renderer/features/sidebar/left-sidebar';

const LAYOUT_CSS = `
  html, body, #sidebar-host { margin: 0; height: 100%; }
  .flex { display: flex; }
  .flex-col { flex-direction: column; }
  .flex-1 { flex: 1 1 0%; min-height: 0; }
  .h-full { height: 100%; }
  .min-h-0 { min-height: 0; }
`;

let host: HTMLDivElement;
let root: Root;
let style: HTMLStyleElement;

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle(frames = 2) {
  for (let i = 0; i < frames; i++) await frame();
}

async function mount() {
  root.render(<LeftSidebar />);
  await settle();
}

function boardButton(): HTMLButtonElement | null {
  return host.querySelector('button[aria-label="Board"]');
}

/** Sidebar landmarks in document order, named by their stable marker. */
function sidebarOrder(): string[] {
  return Array.from(
    host.querySelectorAll(
      '[data-testid="space-switcher"], [aria-label="Board"], [data-testid="pinned-task-list"]'
    )
  ).map((el) => el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? '');
}

describe('left sidebar: Global Board button (spec #104, ticket #108)', () => {
  beforeEach(async () => {
    await page.viewport(400, 800);
    style = document.createElement('style');
    style.textContent = LAYOUT_CSS;
    document.head.appendChild(style);
    host = document.createElement('div');
    host.id = 'sidebar-host';
    document.body.appendChild(host);
    root = createRoot(host);

    mocks.navigate.mockClear();
    mocks.setCollapsed.mockClear();
    mocks.currentView = 'home';
  });

  afterEach(() => {
    root.unmount();
    host.remove();
    style.remove();
  });

  it('sits above the pinned-task list and below the space switcher, as a plain button', async () => {
    await mount();

    expect(sidebarOrder()).toEqual(['space-switcher', 'Board', 'pinned-task-list']);
    expect(boardButton()?.textContent).toContain('Board');
    // Plain by construction: no attention badge anywhere on the button.
    expect(
      host.querySelector('button[aria-label="Board"] [aria-label$="need attention"]')
    ).toBeNull();
  });

  it('navigates to the Global Board on click', async () => {
    await mount();

    boardButton()?.click();

    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith('global-board');
  });

  it('renders inactive while another view is open', async () => {
    mocks.currentView = 'home';
    await mount();

    expect(boardButton()?.getAttribute('data-active')).toBeNull();
  });

  it('shows an active state while the Global Board is the open view', async () => {
    mocks.currentView = 'global-board';
    await mount();

    expect(boardButton()?.getAttribute('data-active')).toBe('true');
  });
});
