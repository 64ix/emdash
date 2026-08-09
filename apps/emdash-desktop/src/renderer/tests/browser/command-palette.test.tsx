/**
 * Browser-mode tests for the Global Board command palette entry point (spec
 * #104, ticket #108): the palette must offer "Open Global Board" without any
 * project context, and selecting it must open the Global Board.
 *
 * Renders the REAL `CommandPaletteModal` (cmdk included) with the surrounding
 * service modules stubbed. The command pool comes from the REAL
 * `createAppCommandProvider()` (whose module graph is safe here because the
 * command registry — the only path into the full view registry — is mocked),
 * with the app-scope navigation state standing in for the current view: home
 * with no project params. The command's FTS entry (which the main process
 * seeds from `ALL_COMMAND_DEFS`) is simulated by the mocked
 * `rpc.search.commandPalette` returning the command item for a typed query.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type { AppCommand } from '@renderer/lib/commands/types';
import type { SearchItem } from '@shared/core/search';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  captureTelemetry: vi.fn(),
  onClose: vi.fn(),
  onSuccess: vi.fn(),
  commandPalette: vi.fn(),
  registry: {
    activeCommands: [] as AppCommand[],
    findById: (id: string): AppCommand | undefined =>
      mocks.registry.activeCommands.find((c) => c.id === id),
  },
  currentViewId: 'home' as string,
  viewParamsStore: {} as Record<string, { projectId?: string } | undefined>,
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ prefetchQuery: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => ({
    data: mocks.commandPalette(queryKey[1] ?? ''),
  }),
  // Never exercised by the palette itself; present so any module in the
  // import graph that constructs a client keeps loading.
  QueryClient: class {},
  QueryClientProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@renderer/lib/commands/registry', () => ({
  commandRegistry: mocks.registry,
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: mocks.navigate }),
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    navigation: {
      get currentViewId() {
        return mocks.currentViewId;
      },
      get viewParamsStore() {
        return mocks.viewParamsStore;
      },
      navigate: mocks.navigate,
      lastNonSettingsView: 'home',
      lastNonLibraryView: 'home',
    },
    resourceMonitor: { start: vi.fn(), dispose: vi.fn() },
    history: { canGoBack: false, canGoForward: false, back: vi.fn(), forward: vi.fn() },
  },
}));

vi.mock('@renderer/utils/telemetryClient', () => ({
  captureTelemetry: mocks.captureTelemetry,
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    search: {
      commandPalette: mocks.commandPalette,
    },
  },
  events: {
    on: vi.fn(() => () => {}),
  },
}));

vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({ value: {} }),
}));

vi.mock('@renderer/lib/hooks/useKeyboardShortcuts', () => ({
  getEffectiveHotkey: () => null,
}));

vi.mock('@renderer/lib/ui/shortcut', () => ({
  Shortcut: () => null,
  // `nav-buttons` (real, imported by the app-commands module graph) binds
  // shortcuts through this export.
  BoundShortcut: () => null,
}));

vi.mock('@renderer/features/conversations/stores/conversation-registry', () => ({
  conversationRegistry: { get: () => undefined },
}));

vi.mock('@renderer/features/tasks/stores/task-selectors', () => ({
  getTaskStore: () => undefined,
  getTaskView: () => undefined,
}));

vi.mock('@renderer/features/tasks/stores/workspace-registry', () => ({
  workspaceRegistry: { get: () => undefined },
}));

vi.mock('@renderer/lib/editor/file-icon', () => ({
  FileIcon: () => null,
}));

vi.mock('@renderer/features/command-palette/resource-monitor-view', () => ({
  ResourceMonitorView: () => null,
}));

vi.mock('@renderer/features/command-palette/palette-notifications-group', () => ({
  PaletteNotificationsGroup: () => null,
}));

vi.mock('@renderer/features/command-palette/palette-projects-group', () => ({
  PaletteProjectsGroup: () => null,
}));

vi.mock('@renderer/features/command-palette/palette-task-item', () => ({
  PaletteTaskItem: () => null,
}));

vi.mock('@renderer/features/command-palette/palette-conversation-item', () => ({
  PaletteConversationItem: () => null,
}));

import { CommandPaletteModal } from '@renderer/features/command-palette/command-palette-modal';
import { createAppCommandProvider } from '@renderer/lib/commands/app-commands';

const LAYOUT_CSS = `
  html, body, #palette-host { margin: 0; }
  .flex { display: flex; }
  .flex-col { flex-direction: column; }
  .overflow-hidden { overflow: hidden; }
  .h-96 { height: 24rem; }
  .p-1 { padding: 0.25rem; }
`;

let host: HTMLDivElement;
let root: Root;
let style: HTMLStyleElement;

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle(frames = 2) {
  for (let i = 0; i < frames; i++) await frame();
}

/** The main-process FTS result the palette resolves through the registry. */
function globalBoardCommandItem(): SearchItem {
  return {
    kind: 'command',
    id: 'app.openGlobalBoard',
    projectId: null,
    taskId: null,
    title: 'Open Global Board',
    subtitle: 'Open the cross-project Global Board',
    score: 1,
  };
}

async function mount() {
  root.render(<CommandPaletteModal onClose={mocks.onClose} onSuccess={mocks.onSuccess} />);
  await settle();
}

async function typeQuery(query: string) {
  const input = host.querySelector('input');
  expect(input).not.toBeNull();
  // Real keystrokes through the user-event API (same as the other browser
  // suites) so cmdk's onChange fires exactly like a human typing.
  await userEvent.type(input!, query);
  // Let the 100 ms debounce elapse, then settle the re-render.
  await new Promise((resolve) => setTimeout(resolve, 150));
  await settle();
}

describe('command palette: Open Global Board (spec #104, ticket #108)', () => {
  beforeEach(async () => {
    await page.viewport(900, 800);
    style = document.createElement('style');
    style.textContent = LAYOUT_CSS;
    document.head.appendChild(style);
    host = document.createElement('div');
    host.id = 'palette-host';
    document.body.appendChild(host);
    root = createRoot(host);

    mocks.navigate.mockClear();
    mocks.captureTelemetry.mockClear();
    mocks.onClose.mockClear();
    mocks.commandPalette.mockReset();
    mocks.currentViewId = 'home';
    mocks.viewParamsStore = {};
    // The REAL app-scope provider decides what the palette may offer; with
    // the home view and no project params, only context-free commands appear.
    mocks.registry.activeCommands = createAppCommandProvider().getCommands();
  });

  afterEach(() => {
    root.unmount();
    host.remove();
    style.remove();
    mocks.registry.activeCommands = [];
  });

  it('offers Open Global Board for a typed query with no project context, and opens it on select', async () => {
    // The palette never resolves this item through FTS in the test, but the
    // item must still come from the live registry — same as the real app.
    expect(mocks.registry.activeCommands.some((c) => c.id === 'app.openGlobalBoard')).toBe(true);

    mocks.commandPalette.mockImplementation((query: string) =>
      String(query).toLowerCase().includes('global') ? [globalBoardCommandItem()] : []
    );

    await mount();
    await typeQuery('Open Global Board');

    // The item renders from the registry-backed FTS result.
    expect(host.textContent).toContain('Open Global Board');
    const item = Array.from(host.querySelectorAll('[cmdk-item]')).find(
      (el) => el.textContent === 'Open Global Board'
    );
    expect(item).toBeDefined();

    item?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle();

    expect(mocks.onClose).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith('global-board');
  });

  it('does not leak the project-scoped Feature Board command without a project', async () => {
    // Contrast (ticket #43): with home active, the real provider omits
    // app.openFeatureBoard, so no typed query can surface it.
    expect(mocks.registry.activeCommands.some((c) => c.id === 'app.openFeatureBoard')).toBe(false);
  });
});
