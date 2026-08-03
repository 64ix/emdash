import type { GuardResult } from '@renderer/app/view-registry';
import { ProjectViewWrapper } from '@renderer/features/projects/components/project-view-wrapper';
import { appState } from '@renderer/lib/stores/app-state';
import { ProjectMainPanel } from './components/main-panel/main-panel';
import { ProjectTitlebar } from './components/project-titlebar';
import { getProjectViewStore } from './stores/project-selectors';

export const projectView = {
  WrapView: ProjectViewWrapper,
  TitlebarSlot: ProjectTitlebar,
  MainPanel: ProjectMainPanel,
  canActivate: (params: unknown): GuardResult => {
    const projectId =
      typeof params === 'object' && params !== null
        ? (params as { projectId?: unknown }).projectId
        : undefined;
    if (typeof projectId !== 'string') return { ok: false, redirect: 'home' };
    if (
      !appState.projects.projects.has(projectId) &&
      !appState.projects.pendingCreationIds.has(projectId)
    ) {
      return { ok: false, redirect: 'home' };
    }
    // Work-mode persistence (ticket #44): once this project's last-used mode
    // is Board, every path back into `project` (sidebar row, breadcrumbs,
    // command palette, ...) lands on the already-canonical `board`
    // destination instead of List, so "reopening a project returns me to the
    // context I use" holds for Board too. Snapshots that predate Board, or
    // that were never explicitly switched to it, never carry this value —
    // see `ProjectViewStore`'s default and `isProjectView` guard.
    if (getProjectViewStore(projectId)?.activeView === 'board') {
      return { ok: false, redirect: 'board', params: { projectId } };
    }
    return { ok: true };
  },
};
