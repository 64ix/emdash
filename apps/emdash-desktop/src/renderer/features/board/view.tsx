import type { GuardResult } from '@renderer/app/view-registry';
import { BoardTitlebar } from '@renderer/features/projects/components/project-titlebar';
import { ProjectViewWrapper } from '@renderer/features/projects/components/project-view-wrapper';
import { getProjectViewStore } from '@renderer/features/projects/stores/project-selectors';
import { appState } from '@renderer/lib/stores/app-state';
import { BoardMainPanel } from './board-main-panel';

export const boardView = {
  WrapView: ProjectViewWrapper,
  TitlebarSlot: BoardTitlebar,
  MainPanel: BoardMainPanel,
  canActivate: (params: unknown): GuardResult => {
    const projectId =
      typeof params === 'object' && params !== null
        ? (params as { projectId?: unknown }).projectId
        : undefined;
    if (typeof projectId !== 'string') return { ok: false, redirect: 'home' };
    if (!appState.projects.projects.has(projectId)) return { ok: false, redirect: 'home' };
    // Work-mode persistence (ticket #44): Board is a single canonical
    // destination reached from several entry points (sidebar row, command
    // palette, the project work-mode switcher, ...). Recording the choice
    // here, once activation is already granted, keeps every present and
    // future entry point in sync without duplicating the write at each call
    // site; setting the same value again is a no-op.
    getProjectViewStore(projectId)?.setProjectView('board');
    return { ok: true };
  },
};
