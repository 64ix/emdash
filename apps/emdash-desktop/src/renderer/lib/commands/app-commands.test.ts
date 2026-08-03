import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  captureTelemetry: vi.fn(),
  currentViewId: 'home' as string,
  viewParamsStore: {} as Record<string, { projectId?: string } | undefined>,
}));

// `./registry` pulls in the full view registry (every feature view) purely for
// `commandRegistry.register`, which this suite never calls — mocked out so the
// test only exercises `createAppCommandProvider` itself.
vi.mock('./registry', () => ({
  commandRegistry: { register: vi.fn() },
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
    history: { canGoBack: false, canGoForward: false, back: vi.fn(), forward: vi.fn() },
  },
}));

vi.mock('@renderer/utils/telemetryClient', () => ({
  captureTelemetry: mocks.captureTelemetry,
}));

vi.mock('@renderer/lib/modal/modal-provider', () => ({ showModal: vi.fn() }));
vi.mock('@renderer/lib/theme/theme-toggle', () => ({ toggleAppTheme: vi.fn() }));
vi.mock('@renderer/lib/layout/settings-toggle', () => ({ toggleSettingsView: vi.fn() }));
vi.mock('@renderer/lib/components/nav-buttons', () => ({ applyHistoryEntry: vi.fn() }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn() }));

import { createAppCommandProvider } from './app-commands';

describe('createAppCommandProvider — project-aware Feature Board command (ticket #43)', () => {
  function commandIds(): string[] {
    return createAppCommandProvider()
      .getCommands()
      .map((c) => c.id);
  }

  it('omits "Open Feature Board" when no view resolves a project (e.g. home)', () => {
    mocks.currentViewId = 'home';
    mocks.viewParamsStore = {};
    expect(commandIds()).not.toContain('app.openFeatureBoard');
  });

  it('never falls back to a stale/last-used project when the current view has none', () => {
    // A *different* view previously carried a projectId, but the current view
    // (home) does not — the command must not resolve that stale value.
    mocks.currentViewId = 'home';
    mocks.viewParamsStore = { project: { projectId: 'stale-project' } };
    expect(commandIds()).not.toContain('app.openFeatureBoard');
  });

  it('offers "Open Feature Board" once the current view resolves an explicit project', () => {
    mocks.currentViewId = 'project';
    mocks.viewParamsStore = { project: { projectId: 'proj-1' } };
    expect(commandIds()).toContain('app.openFeatureBoard');
  });

  it('navigates to that project’s board and records the command-palette entry source', () => {
    mocks.currentViewId = 'task';
    mocks.viewParamsStore = { task: { projectId: 'proj-2' } };
    mocks.navigate.mockClear();
    mocks.captureTelemetry.mockClear();

    const command = createAppCommandProvider()
      .getCommands()
      .find((c) => c.id === 'app.openFeatureBoard');
    command?.execute();

    expect(mocks.navigate).toHaveBeenCalledWith('board', { projectId: 'proj-2' });
    expect(mocks.captureTelemetry).toHaveBeenCalledWith('board_opened', {
      source: 'command_palette',
      project_id: 'proj-2',
    });
  });
});
