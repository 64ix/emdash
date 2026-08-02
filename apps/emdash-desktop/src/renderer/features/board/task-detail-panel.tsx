import { ExternalLink, GitBranch, MessageSquare, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type ReactNode, useEffect, useState } from 'react';
import { STAGE_LABELS } from '@renderer/features/board/board-columns';
import {
  buildTaskDetailPanelViewModel,
  type TaskDetailPanelLink,
} from '@renderer/features/board/task-detail-panel-view-model';
import {
  getTaskGitWorktreeStore,
  getTaskStore,
  taskAgentStatus,
} from '@renderer/features/tasks/stores/task-selectors';
import { registeredTaskData } from '@renderer/features/tasks/stores/task-store';
import { AgentStatusIndicator } from '@renderer/lib/components/agent-status-indicator';
import { StatusIcon } from '@renderer/lib/components/pr-status-icon';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { RelativeTime } from '@renderer/lib/ui/relative-time';
import { linkedIssueRoleLabels } from '@shared/core/linked-issue';
import type { StageHoldingPr, TaskStageAuthority, WorkflowStage } from '@shared/core/tasks/tasks';

/** Fixed width (CONTEXT.md "Task Detail Panel"): roughly 380-420px, not resizable in v1. */
export const TASK_DETAIL_PANEL_WIDTH_CLASS = 'w-[400px]';

function PanelSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <div data-panel-section={id} className="flex flex-col gap-2 border-b border-border px-4 py-3">
      <span className="text-xs font-medium text-foreground-muted">{title}</span>
      {children}
    </div>
  );
}

function ExternalLinkButton({ url, label }: { url: string; label: string }) {
  return (
    <button
      type="button"
      className="shrink-0 text-foreground-muted transition-colors hover:text-foreground"
      aria-label={label}
      onClick={() => void rpc.app.openExternal(url)}
    >
      <ExternalLink className="size-3" />
    </button>
  );
}

function LinkedIssueRow({ link }: { link: TaskDetailPanelLink }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        data-linked-issue-role={link.role}
        className="shrink-0 rounded-full bg-background-2 px-1.5 py-0.5 text-[10px] font-medium text-foreground-muted"
      >
        {linkedIssueRoleLabels[link.role]}
      </span>
      <span className="min-w-0 flex-1 truncate" title={link.issue.title}>
        {link.issue.title}
      </span>
      {link.issue.status && (
        <span className="shrink-0 text-foreground-passive">{link.issue.status}</span>
      )}
      <ExternalLinkButton url={link.issue.url} label={`Open ${link.issue.title} on GitHub`} />
    </div>
  );
}

function SpecDerivedPrRow({ pr }: { pr: StageHoldingPr }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <StatusIcon pr={pr} className="size-3.5" disableTooltip />
      <span className="min-w-0 flex-1 truncate" title={pr.title}>
        {pr.title}
      </span>
      <ExternalLinkButton url={pr.url} label={`Open ${pr.title} on GitHub`} />
    </div>
  );
}

/**
 * Task Detail Panel (CONTEXT.md): the side panel that opens on the right of
 * the Feature Board when a card is clicked. Shows the task's vitals, typed
 * Linked Issue Roles, the Spec-derived PR, and the Workflow Stage with its
 * authority (ticket #41). Management actions and ghost mode land in ticket #42.
 *
 * All display logic lives in the pure `task-detail-panel-view-model` module;
 * this component only renders what it computes.
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

  const [stageAuthority, setStageAuthority] = useState<TaskStageAuthority | undefined>(undefined);

  // Re-fetches on the task's own persisted stage too: a background board-sync
  // pass can move the card while the panel stays open, and the authority
  // explanation must never keep pointing at a stale fact.
  useEffect(() => {
    let cancelled = false;
    setStageAuthority(undefined);
    void rpc.tasks.getTaskStageAuthority(taskId).then((result) => {
      if (!cancelled) setStageAuthority(result);
    });
    return () => {
      cancelled = true;
    };
  }, [taskId, task?.workflowStage]);

  // Defensive only: BoardMainPanel already closes the panel itself once the
  // task stops being displayable (CONTEXT.md "Task Detail Panel" —
  // disappearance handling). This guards the render in the interim.
  if (!store || !task) return null;

  const branchName = getTaskGitWorktreeStore(projectId, taskId)?.branchName ?? null;
  const vm = buildTaskDetailPanelViewModel({
    task,
    branchName,
    sessionCounts: store.conversationStats,
    agentStatus: taskAgentStatus(store),
    stageAuthority,
  });

  const handleStageChange = (next: string) => {
    void store.updateBoardPosition(next === '' ? null : (next as WorkflowStage), null);
  };

  // The current stage stays selectable even when it falls outside the
  // declarative set (e.g. a stage this ticket's authority can't currently
  // verify) — a disabled/empty selector must never hide what the task's
  // stage actually is.
  const selectableStages: WorkflowStage[] = vm.stage.locked
    ? vm.stage.current
      ? [vm.stage.current]
      : []
    : vm.stage.current && !vm.stage.options.includes(vm.stage.current)
      ? [vm.stage.current, ...vm.stage.options]
      : [...vm.stage.options];

  return (
    <div
      className={`flex h-full ${TASK_DETAIL_PANEL_WIDTH_CLASS} shrink-0 flex-col overflow-y-auto border-l border-border bg-background`}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="min-w-0 truncate text-sm font-medium" title={task.name}>
          {task.name}
        </h2>
        <Button size="icon-sm" variant="ghost" aria-label="Close task details" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      <PanelSection id="vitals" title="Vitals">
        <div className="flex items-center gap-1.5 text-xs text-foreground-muted">
          <GitBranch className="size-3 shrink-0" />
          {vm.vitals.branchName ? (
            <span className="min-w-0 truncate" title={vm.vitals.branchName}>
              {vm.vitals.branchName}
            </span>
          ) : (
            <span>Not provisioned yet</span>
          )}
        </div>
        <div className="flex items-center justify-between text-xs text-foreground-muted">
          <span>Created</span>
          <RelativeTime value={task.createdAt} />
        </div>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1 text-xs text-foreground-muted">
            <MessageSquare className="size-3" />
            {vm.vitals.totalSessionCount === 1
              ? '1 session'
              : `${String(vm.vitals.totalSessionCount)} sessions`}
          </span>
          <AgentStatusIndicator status={vm.vitals.agentStatus} />
        </div>
      </PanelSection>

      <PanelSection id="workflow-stage" title="Workflow stage">
        <select
          aria-label="Workflow stage"
          className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          value={vm.stage.current ?? ''}
          disabled={vm.stage.locked}
          onChange={(event) => handleStageChange(event.target.value)}
        >
          <option value="">Unstaged</option>
          {selectableStages.map((stage) => (
            <option key={stage} value={stage}>
              {STAGE_LABELS[stage]}
            </option>
          ))}
        </select>
        {vm.stage.explanation && (
          <div className="flex items-start gap-1.5 text-xs text-foreground-muted">
            <span className="min-w-0 flex-1">{vm.stage.explanation}</span>
            {vm.stage.explanationLink && (
              <ExternalLinkButton
                url={vm.stage.explanationLink.url}
                label={`Open ${vm.stage.explanationLink.label} on GitHub`}
              />
            )}
          </div>
        )}
      </PanelSection>

      {vm.links.length > 0 && (
        <PanelSection id="linked-issues" title="Linked issues">
          <div className="flex flex-col gap-1.5">
            {vm.links.map((link) => (
              <LinkedIssueRow key={link.role} link={link} />
            ))}
          </div>
        </PanelSection>
      )}

      {vm.pr && (
        <PanelSection id="pull-request" title="Pull request">
          <SpecDerivedPrRow pr={vm.pr} />
        </PanelSection>
      )}
    </div>
  );
});
