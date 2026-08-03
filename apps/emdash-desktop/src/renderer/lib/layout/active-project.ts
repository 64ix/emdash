import type { ViewId } from '@renderer/app/view-registry';

/**
 * Which project the current navigation state is scoped to, given the active
 * view and each project-scoped view's own `projectId` param. `task`,
 * `project`, and `board` (ticket #43) are the only views scoped to a single
 * project — every other view (home, settings, library, ...) has none.
 *
 * Centralizes a ternary chain that used to be duplicated across the sidebar
 * (project row active state, task-list scroll-into-view), the global
 * keyboard shortcut handlers, and the sidebar's search trigger — exactly the
 * duplication that let the board's project-active-state bug happen in the
 * first place: `board` was added as a view without updating every place the
 * chain lived, so opening a project's board silently lost project context.
 *
 * Takes each view's `projectId` directly (not the whole params object) so
 * call sites keep passing the exact primitive their `useEffect`/`useMemo`
 * dependency arrays already list — a whole params object here would make
 * `react-hooks/exhaustive-deps` demand it too, even though only `.projectId`
 * is ever read from it.
 */
export function activeProjectIdForView(
  currentView: ViewId,
  projectIdByView: {
    task: string | undefined;
    project: string | undefined;
    board: string | undefined;
  }
): string | undefined {
  switch (currentView) {
    case 'task':
      return projectIdByView.task;
    case 'project':
      return projectIdByView.project;
    case 'board':
      return projectIdByView.board;
    default:
      return undefined;
  }
}
