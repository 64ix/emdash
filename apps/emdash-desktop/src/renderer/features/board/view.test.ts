import { describe, expect, it, vi } from 'vitest';

// `boardView` pulls in `BoardMainPanel` (dnd-kit, task stores, telemetry...)
// and `BoardTitlebar`/`ProjectViewWrapper` purely for their component
// references, which `canActivate` never touches. Mocking those modules keeps
// this suite scoped to the guard itself instead of the full board render
// tree (ticket #44).
vi.mock('@renderer/features/board/board-main-panel', () => ({ BoardMainPanel: () => null }));
vi.mock('@renderer/features/projects/components/project-titlebar', () => ({
  BoardTitlebar: () => null,
}));
vi.mock('@renderer/features/projects/components/project-view-wrapper', () => ({
  ProjectViewWrapper: () => null,
}));

const mocks = vi.hoisted(() => ({
  setProjectView: vi.fn(),
  getProjectViewStore: vi.fn(),
  projects: new Map<string, unknown>(),
}));

vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectViewStore: mocks.getProjectViewStore,
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    projects: {
      get projects() {
        return mocks.projects;
      },
    },
  },
}));

import { boardView } from './view';

describe('boardView.canActivate (ticket #44 work-mode persistence choke point)', () => {
  it('denies and redirects home without touching the view store when projectId is missing', () => {
    mocks.getProjectViewStore.mockReturnValue({ setProjectView: mocks.setProjectView });
    mocks.setProjectView.mockClear();

    expect(boardView.canActivate({})).toEqual({ ok: false, redirect: 'home' });
    expect(mocks.setProjectView).not.toHaveBeenCalled();
    expect(mocks.getProjectViewStore).not.toHaveBeenCalled();
  });

  it('denies and redirects home without touching the view store for an unknown project', () => {
    mocks.projects.clear();
    mocks.getProjectViewStore.mockReturnValue({ setProjectView: mocks.setProjectView });
    mocks.setProjectView.mockClear();

    expect(boardView.canActivate({ projectId: 'ghost' })).toEqual({
      ok: false,
      redirect: 'home',
    });
    expect(mocks.setProjectView).not.toHaveBeenCalled();
  });

  it('grants activation and records Board as the last-used mode exactly once for a known project', () => {
    mocks.projects.clear();
    mocks.projects.set('proj-1', {});
    mocks.getProjectViewStore.mockReturnValue({ setProjectView: mocks.setProjectView });
    mocks.setProjectView.mockClear();

    expect(boardView.canActivate({ projectId: 'proj-1' })).toEqual({ ok: true });

    expect(mocks.getProjectViewStore).toHaveBeenCalledWith('proj-1');
    expect(mocks.setProjectView).toHaveBeenCalledTimes(1);
    expect(mocks.setProjectView).toHaveBeenCalledWith('board');
  });

  it('never writes when the project is registered but not yet mounted (no view store)', () => {
    mocks.projects.clear();
    mocks.projects.set('proj-2', {});
    mocks.getProjectViewStore.mockReturnValue(undefined);
    mocks.setProjectView.mockClear();

    expect(boardView.canActivate({ projectId: 'proj-2' })).toEqual({ ok: true });
    expect(mocks.setProjectView).not.toHaveBeenCalled();
  });
});
