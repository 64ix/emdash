import type { GuardResult } from '@renderer/app/view-registry';
import { GlobalBoardMainPanel } from './global-board-main-panel';
import { refreshGlobalBoardTasks } from './global-board-open';

/**
 * Global Board view (spec #104, ticket #107): the cross-project sibling of
 * the Feature Board. Takes no `projectId` parameter — `canActivate` passes
 * without any project, and the panel aggregates every project's already-
 * loaded task sets itself. Not the app's default landing view (CONTEXT.md
 * "Global Board"); its entry points (sidebar Board button, command palette)
 * are later tickets of the spec.
 */
export const globalBoardView = {
  MainPanel: GlobalBoardMainPanel,
  canActivate: (_params: unknown): GuardResult => {
    // Open sync (spec #104, ticket #108): every opening path — the sidebar
    // Board button, the command palette command, history navigation, snapshot
    // restore, revalidation — funnels through this guard, so the ONE
    // best-effort global `tasks.getTasks()` (no projectId, wave 1's batched
    // cross-project path) is fired exactly here: a single RPC on open, never
    // a per-project fan-out. Best-effort by contract — a failure must not
    // block or error the view, which renders from the already-loaded
    // per-project task stores regardless.
    refreshGlobalBoardTasks();
    // No project (or any other) parameter is required: the view activates
    // unconditionally and renders whatever task sets are loaded. Stale
    // persisted params from older builds are ignored, never validated.
    return { ok: true };
  },
};
