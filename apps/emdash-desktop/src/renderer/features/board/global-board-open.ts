import { getTaskManagerStore } from '@renderer/features/tasks/stores/task-selectors';
import { rpc } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { log } from '@renderer/utils/logger';
import type { Task } from '@shared/core/tasks/tasks';

/**
 * Global Board open sync (spec #104, ticket #108): fires ONE best-effort
 * global `tasks.getTasks()` — the no-projectId path (wave 1) that returns
 * every project's tasks with batched PRs — whenever the Global Board opens,
 * and merges the result into the already-loaded per-project
 * `TaskManagerStore`s the panel composes. There is deliberately no
 * per-project fan-out: a single RPC on open, everything else is in-memory
 * composition of state the app already holds.
 *
 * Best-effort by contract: a failed refresh never blocks or errors the view
 * — the board renders from the loaded stores either way, exactly like a
 * board that skipped its freshness pass.
 */
export function refreshGlobalBoardTasks(): void {
  rpc.tasks
    .getTasks()
    .then(mergeGlobalBoardTasks)
    .catch((error: unknown) => {
      log.warn('Global Board refresh failed (best-effort)', error);
    });
}

/**
 * Distributes a global task set (tasks of any project) into the mounted
 * projects' task managers, which each filter to their own project. Mounted
 * only — the board panel renders exclusively from mounted projects' stores,
 * so an unmounted project's tasks stay untouched until its project mounts.
 */
export function mergeGlobalBoardTasks(tasks: readonly Task[]): void {
  for (const projectId of appState.projects.projects.keys()) {
    getTaskManagerStore(projectId)?.mergeGlobalTasks(tasks);
  }
}
