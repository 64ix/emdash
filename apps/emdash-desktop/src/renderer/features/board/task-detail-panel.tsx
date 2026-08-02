import { X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { getTaskStore } from '@renderer/features/tasks/stores/task-selectors';
import { registeredTaskData } from '@renderer/features/tasks/stores/task-store';
import { Button } from '@renderer/lib/ui/button';

/** Fixed width (CONTEXT.md "Task Detail Panel"): roughly 380-420px, not resizable in v1. */
export const TASK_DETAIL_PANEL_WIDTH_CLASS = 'w-[400px]';

/**
 * Task Detail Panel (CONTEXT.md): the side panel that opens on the right of
 * the Feature Board when a card is clicked. This component is the shell only
 * — the frame, its header, and the close gesture. Vitals, typed links, the
 * derived PR, and stage authority land in a follow-up ticket; management
 * actions and ghost mode in the one after that.
 *
 * Store access follows the documented selectors: `getTaskStore` plus an
 * explicit null check, never `asProvisioned(...)!` / `asMounted(...)!`.
 */
export const TaskDetailPanel = observer(function TaskDetailPanel({
  projectId,
  taskId,
  onClose,
}: {
  projectId: string;
  taskId: string;
  onClose: () => void;
}) {
  const store = getTaskStore(projectId, taskId);
  const task = store ? registeredTaskData(store) : undefined;
  // Defensive only: BoardMainPanel already closes the panel itself once the
  // task stops being displayable (CONTEXT.md "Task Detail Panel" —
  // disappearance handling). This guards the render in the interim.
  if (!task) return null;

  return (
    <div
      className={`flex h-full ${TASK_DETAIL_PANEL_WIDTH_CLASS} shrink-0 flex-col border-l border-border bg-background`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="min-w-0 truncate text-sm font-medium" title={task.name}>
          {task.name}
        </h2>
        <Button size="icon-sm" variant="ghost" aria-label="Close task details" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
});
