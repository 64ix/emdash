import { when } from 'mobx';
import type { WorkflowStage } from '@shared/core/tasks/tasks';

/** The minimal `TaskStore` shape this needs — kept narrow (rather than importing the concrete
 * class) so it is trivially unit-testable with a plain MobX-observable fake. */
export type RegistrationAwareTaskStore = {
  readonly state: 'unregistered' | 'unprovisioned' | 'provisioned';
  readonly phase: string | null;
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
      if (store.state !== 'unregistered') void store.updateBoardPosition(stage, null);
    }
  );
}
