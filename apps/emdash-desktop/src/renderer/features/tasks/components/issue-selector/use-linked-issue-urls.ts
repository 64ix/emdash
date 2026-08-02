import { getTaskManagerStore } from '@renderer/features/tasks/stores/task-selectors';
import { isRegistered } from '@renderer/features/tasks/stores/task-store';
import { linkedIssueRoleSchema } from '@shared/core/linked-issue';

export type LinkedIssueInfo = { taskId: string; taskName: string };

/**
 * Reads from observable task state — call only inside `observer` components.
 * Returns a map from issue URL → linked task info for non-archived tasks,
 * optionally excluding a single task (e.g. when re-selecting the same task's issue).
 * Checks every role (Origin / Map / Spec), not just one.
 */
export function getLinkedIssueMap(
  projectId: string | undefined,
  excludeTaskId?: string
): Map<string, LinkedIssueInfo> {
  const map = new Map<string, LinkedIssueInfo>();
  if (!projectId) return map;
  const taskManager = getTaskManagerStore(projectId);
  if (!taskManager) return map;
  for (const store of taskManager.tasks.values()) {
    if (!isRegistered(store)) continue;
    if (excludeTaskId && store.data.id === excludeTaskId) continue;
    if (store.data.archivedAt) continue;
    const roles = store.data.linkedIssues;
    if (!roles) continue;
    for (const role of linkedIssueRoleSchema.options) {
      const url = roles[role]?.url;
      if (!url || map.has(url)) continue;
      map.set(url, { taskId: store.data.id, taskName: store.data.name });
    }
  }
  return map;
}
