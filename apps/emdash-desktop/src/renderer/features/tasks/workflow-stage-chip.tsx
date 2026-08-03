import { STAGE_LABELS } from '@renderer/features/board/board-columns';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { captureTelemetry } from '@renderer/utils/telemetryClient';
import type { WorkflowStage } from '@shared/core/tasks/tasks';

/**
 * Workflow Stage chip (ticket #50): shown in the task titlebar for
 * registered tasks, reusing the board's own `STAGE_LABELS` (never inventing
 * a second label set) so the text here can never drift from what the same
 * stage shows as a Feature Board column. `workflowStage` maps to `unstaged`
 * the same way `stageOf` (`board-ordering.ts`) does — Unstaged is rendered
 * explicitly through that label rather than omitting the chip.
 *
 * Activating it returns to the project's board with this task focused:
 * `BoardMainPanel` resolves, scrolls to, highlights, and opens the inspector
 * for it (see `board-main-panel.tsx`'s focused-task navigation effects).
 * Fires `board_opened` with `source: 'stage_chip'` — the fourth board entry
 * point (tickets #43, #44 built the other three) — so this affordance is not
 * silently missing from the same entry-source instrumentation every other
 * board entry point already carries.
 *
 * Kept in its own dependency-light leaf module (only `useNavigate` and the
 * board's presentation-only `board-columns.ts`) rather than defined inline
 * in `task-titlebar.tsx`, whose other imports (git actions, workspace view
 * context, conversation/task stores, `rpc`, ...) are the heavy transitive
 * chain a plain unit test for this chip has no reason to load.
 */
export function WorkflowStageChip({
  projectId,
  taskId,
  workflowStage,
}: {
  projectId: string;
  taskId: string;
  workflowStage: WorkflowStage | null;
}) {
  const { navigate } = useNavigate();
  const stageLabel = STAGE_LABELS[workflowStage ?? 'unstaged'];

  const handleActivate = () => {
    captureTelemetry('board_opened', { source: 'stage_chip', project_id: projectId });
    navigate('board', { projectId, focusTaskId: taskId });
  };

  return (
    <button
      type="button"
      title="View on Feature Board"
      aria-label={`Workflow stage: ${stageLabel}. View on Feature Board.`}
      onClick={handleActivate}
      className="hover:bg-muted/30 ml-1 flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs text-foreground-muted"
    >
      {stageLabel}
    </button>
  );
}
