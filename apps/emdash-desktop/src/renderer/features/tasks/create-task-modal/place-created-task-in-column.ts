import { when } from 'mobx';
import { log } from '@renderer/utils/logger';
import type { WorkflowStage } from '@shared/core/tasks/tasks';

/** The minimal `TaskStore` shape this needs — kept narrow (rather than importing the concrete
 * class) so it is trivially unit-testable with a plain MobX-observable fake. */
export type RegistrationAwareTaskStore = {
  state: 'unregistered' | 'unprovisioned' | 'provisioned';
  phase: string | null;
  updateBoardPosition(stage: WorkflowStage | null, rank: string | null): Promise<void>;
};

/**
 * Column-scoped task creation (ticket #45): places a just-created task into
 * the column whose "+" offered creation. `TaskManagerStore.createTask`
 * inserts the new (`unregistered`) `TaskStore` synchronously, before its
 * first `await` — so by the time this is called right after invoking (not
 * necessarily awaiting) `createTask`, the store already exists in
 * `taskManager.tasks`.
 *
 * Reuses the exact same atomic write drag-and-drop and the Task Detail
 * Panel's stage selector already use (`TaskStore.updateBoardPosition`) —
 * this never introduces a second write path. `rank: null` — the same choice
 * the stage selector's non-drag gesture makes — leaves the task unranked;
 * `sortColumn` (board-ordering.ts) places unranked cards after ranked ones in
 * their existing (insertion) order, which for a just-created task is the end
 * of the column.
 *
 * Waits for the creation RPC to register the task (or fail) before writing
 * anything, since `updateBoardPosition` is a no-op on an unregistered store.
 * A permanent creation failure (`phase === 'create-error'`) bails out without
 * writing, instead of waiting forever.
 *
 * This write and task creation itself are two separate RPC round trips, not
 * one atomic operation (unlike drag-and-drop's stage+rank write, which ticket
 * #48 deliberately kept atomic for exactly this reason) — a genuine, disclosed
 * gap: if this second write fails, the task still exists, registered, just
 * left in Unstaged rather than the column the user chose. `updateBoardPosition`
 * itself already logs and rolls back its optimistic state on failure (see
 * `TaskStore.updateBoardPosition`); the `.catch` below only prevents an
 * unhandled promise rejection from this fire-and-forget call site — it does
 * not add a user-visible error for this specific failure mode.
 */
export function placeCreatedTaskInColumn(
  taskManager: { tasks: ReadonlyMap<string, RegistrationAwareTaskStore> },
  taskId: string,
  stage: WorkflowStage
): void {
  const store = taskManager.tasks.get(taskId);
  if (!store) return;

  when(
    () => store.state !== 'unregistered' || store.phase === 'create-error',
    () => {
      if (store.state !== 'unregistered') {
        store
          .updateBoardPosition(stage, null)
          .catch((e) => log.error('placeCreatedTaskInColumn: updateBoardPosition failed', e));
      }
    }
  );
}
