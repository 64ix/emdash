import { ChevronLeft, ChevronRight, MessageSquare } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import {
  getProjectStore,
  projectDisplayName,
} from '@renderer/features/projects/stores/project-selectors';
import { getTaskManagerStore } from '@renderer/features/tasks/stores/task-selectors';
import { registeredTaskData, type TaskStore } from '@renderer/features/tasks/stores/task-store';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { Badge } from '@renderer/lib/ui/badge';
import {
  linkedIssueDisplayIdentifier,
  linkedIssueRoleLabels,
  mostAdvancedLinkedIssue,
  type LinkedIssue,
  type LinkedIssueRole,
} from '@shared/core/linked-issue';
import { workflowStages, type Task, type WorkflowStage } from '@shared/core/tasks/tasks';

/** Column ids: every workflow stage, plus a leading bucket for unstaged tasks. */
type ColumnId = WorkflowStage | 'unstaged';

const STAGE_LABELS: Record<ColumnId, string> = {
  unstaged: 'Unstaged',
  idea: 'Idea',
  grilled: 'Grilled',
  spec: 'Spec',
  tickets: 'Tickets',
  implementing: 'Implementing',
  pr: 'PR',
  shipped: 'Shipped',
};

const COLUMNS: ColumnId[] = ['unstaged', ...workflowStages.options];

function stageOf(task: Task): ColumnId {
  return task.workflowStage ?? 'unstaged';
}

/** The stage reached by moving one column left/right; null when already at the edge. */
function adjacentStage(current: ColumnId, delta: -1 | 1): WorkflowStage | 'unstaged' | null {
  const index = COLUMNS.indexOf(current) + delta;
  if (index < 0 || index >= COLUMNS.length) return null;
  return COLUMNS[index];
}

/** "Spec #123" (or just "Spec" when the issue has no identifier) for the most-advanced-link badge. */
function linkedIssueBadgeText(link: { role: LinkedIssueRole; issue: LinkedIssue }): string {
  const label = linkedIssueRoleLabels[link.role];
  const identifier = linkedIssueDisplayIdentifier(link.issue);
  return identifier ? `${label} ${identifier}` : label;
}

export const BoardMainPanel = observer(function BoardMainPanel() {
  const {
    params: { projectId },
  } = useParams('board');
  const manager = getTaskManagerStore(projectId);
  const projectName = projectDisplayName(getProjectStore(projectId)) ?? 'Project';

  if (!manager) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-foreground-muted">
        Open the project first so its tasks are loaded.
      </div>
    );
  }

  const byColumn = new Map<ColumnId, TaskStore[]>(COLUMNS.map((c) => [c, []]));
  for (const [, store] of manager.tasks) {
    const task = registeredTaskData(store);
    if (!task || task.archivedAt || task.type !== 'task') continue;
    byColumn.get(stageOf(task))?.push(store);
  }

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <div className="flex items-baseline gap-2 px-4 pt-4 pb-2">
        <h1 className="text-sm font-medium">Feature board</h1>
        <span className="text-xs text-foreground-muted">{projectName}</span>
      </div>
      <div className="flex flex-1 gap-3 overflow-x-auto px-4 pb-4">
        {COLUMNS.map((column) => (
          <BoardColumn
            key={column}
            column={column}
            stores={byColumn.get(column) ?? []}
            projectId={projectId}
          />
        ))}
      </div>
    </div>
  );
});

const BoardColumn = observer(function BoardColumn({
  column,
  stores,
  projectId,
}: {
  column: ColumnId;
  stores: TaskStore[];
  projectId: string;
}) {
  return (
    <div className="flex w-56 shrink-0 flex-col rounded-lg border border-border bg-background-2/40">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium text-foreground-muted">{STAGE_LABELS[column]}</span>
        <Badge variant="secondary">{stores.length}</Badge>
      </div>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {stores.map((store) => (
          <BoardCard key={store.data.id} store={store} column={column} projectId={projectId} />
        ))}
      </div>
    </div>
  );
});

const BoardCard = observer(function BoardCard({
  store,
  column,
  projectId,
}: {
  store: TaskStore;
  column: ColumnId;
  projectId: string;
}) {
  const { navigate } = useNavigate();
  const task = registeredTaskData(store);
  if (!task) return null;

  const sessionCount = Object.values(store.conversationStats).reduce((a, b) => a + b, 0);
  const linkedIssue = mostAdvancedLinkedIssue(task.linkedIssues);

  const move = (delta: -1 | 1) => {
    const next = adjacentStage(column, delta);
    if (next === null) return;
    void store.updateWorkflowStage(next === 'unstaged' ? null : next);
  };

  return (
    <div className="group rounded-md border border-border bg-background p-2 shadow-sm">
      <button
        className="w-full text-left text-xs font-medium hover:underline"
        onClick={() => navigate('task', { projectId, taskId: task.id })}
      >
        {task.name}
      </button>
      <div className="mt-1.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Badge variant="outline">{task.status}</Badge>
          {linkedIssue && (
            <Badge variant="outline" title={linkedIssue.issue.title}>
              {linkedIssueBadgeText(linkedIssue)}
            </Badge>
          )}
          {sessionCount > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] text-foreground-muted">
              <MessageSquare className="size-3" />
              {sessionCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            className="rounded p-0.5 text-foreground-muted hover:bg-background-2 disabled:opacity-30"
            disabled={adjacentStage(column, -1) === null}
            onClick={() => move(-1)}
            aria-label="Move to previous stage"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <button
            className="rounded p-0.5 text-foreground-muted hover:bg-background-2 disabled:opacity-30"
            disabled={adjacentStage(column, 1) === null}
            onClick={() => move(1)}
            aria-label="Move to next stage"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
});
