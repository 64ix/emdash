import { describe, expect, it, vi } from 'vitest';

// `projectView` pulls in `ProjectMainPanel`/`ProjectTitlebar`/`ProjectViewWrapper`
// purely for their component references, which `canActivate` never touches.
// Mocking those modules keeps this suite scoped to the guard itself instead
// of the full project render tree (ticket #44).
vi.mock('@renderer/features/projects/components/main-panel/main-panel', () => ({
  ProjectMainPanel: () => null,
}));
vi.mock('@renderer/features/projects/components/project-titlebar', () => ({
  ProjectTitlebar: () => null,
}));
vi.mock('@renderer/features/projects/components/project-view-wrapper', () => ({
  ProjectViewWrapper: () => null,
}));

const mocks = vi.hoisted(() => ({
  getProjectViewStore: vi.fn(),
  projects: new Map<string, unknown>(),
  pendingCreationIds: new Set<string>(),
}));

vi.mock('./stores/project-selectors', () => ({
  getProjectViewStore: mocks.getProjectViewStore,
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    projects: {
      get projects() {
        return mocks.projects;
      },
      get pendingCreationIds() {
        return mocks.pendingCreationIds;
      },
    },
  },
}));

import { projectView } from './view';

describe('projectView.canActivate (ticket #44 work-mode persistence)', () => {
  it('redirects home for a missing projectId', () => {
    expect(projectView.canActivate({})).toEqual({ ok: false, redirect: 'home' });
  });

  it('redirects home for a projectId that is neither registered nor pending creation', () => {
    mocks.projects.clear();
    mocks.pendingCreationIds.clear();

    expect(projectView.canActivate({ projectId: 'ghost' })).toEqual({
      ok: false,
      redirect: 'home',
    });
  });

  it('allows activation for a project that is still pending creation', () => {
    mocks.projects.clear();
    mocks.pendingCreationIds.clear();
    mocks.pendingCreationIds.add('creating-1');
    mocks.getProjectViewStore.mockReturnValue(undefined);

    expect(projectView.canActivate({ projectId: 'creating-1' })).toEqual({ ok: true });
  });

  it('stays on `project` (List/Pull Requests/Settings) when the persisted mode is not Board', () => {
    mocks.projects.clear();
    mocks.pendingCreationIds.clear();
    mocks.projects.set('proj-1', {});
    mocks.getProjectViewStore.mockReturnValue({ activeView: 'pull-request' });

    expect(projectView.canActivate({ projectId: 'proj-1' })).toEqual({ ok: true });
  });

  it('redirects to the canonical board destination once the persisted mode is Board', () => {
    mocks.projects.clear();
    mocks.pendingCreationIds.clear();
    mocks.projects.set('proj-1', {});
    mocks.getProjectViewStore.mockReturnValue({ activeView: 'board' });

    expect(projectView.canActivate({ projectId: 'proj-1' })).toEqual({
      ok: false,
      redirect: 'board',
      params: { projectId: 'proj-1' },
    });
  });

  it(
    'documents the mount-timing gap this ticket disclosed: a project with no mounted view ' +
      'store yet (getProjectViewStore returns undefined) cannot be redirected to Board even ' +
      'if its saved snapshot says Board -- ProjectManagerStore.mountProject revalidates ' +
      'navigation once mounting restores that snapshot to close this window',
    () => {
      mocks.projects.clear();
      mocks.pendingCreationIds.clear();
      mocks.projects.set('proj-1', {});
      mocks.getProjectViewStore.mockReturnValue(undefined);

      expect(projectView.canActivate({ projectId: 'proj-1' })).toEqual({ ok: true });
    }
  );
});
