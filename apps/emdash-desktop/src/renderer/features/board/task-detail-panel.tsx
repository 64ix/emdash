import {
  Archive,
  ArrowUpRight,
  Download,
  ExternalLink,
  GitBranch,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  X,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { STAGE_LABELS } from '@renderer/features/board/board-columns';
import {
  buildTaskDetailPanelViewModel,
  deriveGhostDetailViewModel,
  type TaskDetailPanelConversationInput,
  type TaskDetailPanelConversationRow,
  type TaskDetailPanelLink,
} from '@renderer/features/board/task-detail-panel-view-model';
import { ConversationAgentIcon } from '@renderer/features/conversations/conversation-agent-icon';
import type { ConversationManagerStore } from '@renderer/features/conversations/conversation-manager';
import { TaskGitDiffStats } from '@renderer/features/tasks/components/task-git-diff-stats';
import {
  getConversationsForTask,
  getTaskGitWorktreeStore,
  getTaskManagerStore,
  getTaskStore,
  taskAgentStatus,
} from '@renderer/features/tasks/stores/task-selectors';
import { registeredTaskData } from '@renderer/features/tasks/stores/task-store';
import { AgentStatusIndicator } from '@renderer/lib/components/agent-status-indicator';
import { StatusIcon } from '@renderer/lib/components/pr-status-icon';
import { StackedAgentLogos } from '@renderer/lib/components/stacked-agent-logos';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { RelativeTime } from '@renderer/lib/ui/relative-time';
import { MAX_CONVERSATION_TITLE_LENGTH } from '@shared/core/conversations/conversations';
import type { GhostCard } from '@shared/core/issues/ghost-card';
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

/** The chain's final link (ticket #49): the Spec-derived PR. `data-delivery-chain-item`
 * distinguishes this row from the typed Linked Issue rows above it within the
 * same "Delivery chain" section. */
function SpecDerivedPrRow({ pr }: { pr: StageHoldingPr }) {
  return (
    <div data-delivery-chain-item="pr" className="flex items-center gap-2 text-xs">
      <StatusIcon pr={pr} className="size-3.5" disableTooltip />
      <span className="min-w-0 flex-1 truncate" title={pr.title}>
        {pr.title}
      </span>
      <ExternalLinkButton url={pr.url} label={`Open ${pr.title} on GitHub`} />
    </div>
  );
}

/**
 * A single Conversations section row (ticket #68): provider icon, display
 * title (inline-editable), live agent status/last-active time, and the same
 * management actions the task view's own conversations sidebar
 * (`SidebarConversationsList`) offers — rename, delete (behind a
 * confirmation) and, for ACP conversations, transcript export — exposed here
 * as small icon buttons (mirroring this panel's own header convention:
 * `aria-label`led icon buttons, e.g. "Rename task") rather than the
 * sidebar's right-click context menu, which needs real pointer geometry a
 * fixed-width inspector row doesn't have room for. Clicking the row body (or
 * Enter/Space while it is focused) calls `onOpen`, which the panel wires to
 * the same provision-then-navigate handler the "Open task" button already
 * uses, carrying this conversation's id. A row whose Conversation was
 * deleted between render and click is not specially handled here: `onOpen`
 * still fires with that (now-stale) id, and the shared navigation/open-
 * conversation machinery (ticket #67) already treats an id that doesn't
 * resolve as a complete, safe no-op — the task view just opens with nothing
 * focused.
 */
const PanelConversationRow = observer(function PanelConversationRow({
  row,
  projectId,
  taskId,
  manager,
  onOpen,
}: {
  row: TaskDetailPanelConversationRow;
  projectId: string;
  taskId: string;
  manager: ConversationManagerStore | undefined;
  onOpen: (conversationId: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const committedRef = useRef(false);
  const showConfirm = useShowModal('confirmActionModal');

  const handleRenameInputRef = useCallback((input: HTMLInputElement | null) => {
    input?.focus();
    input?.select();
  }, []);

  const handleRename = () => {
    committedRef.current = false;
    window.setTimeout(() => setIsEditing(true), 0);
  };

  // Exact commit semantics as the sidebar's own rename (ticket #68's
  // criterion): Enter commits, Escape cancels, blur commits, capped at the
  // shared maximum title length, and an empty or unchanged value is a no-op
  // that just closes the input rather than writing anything.
  const commitRename = (value: string) => {
    if (committedRef.current) return;
    committedRef.current = true;
    const trimmed = value.trim().slice(0, MAX_CONVERSATION_TITLE_LENGTH);
    setIsEditing(false);
    if (trimmed && trimmed !== row.rawTitle) {
      void manager?.renameConversation(row.id, trimmed);
    }
  };

  const handleDelete = () => {
    showConfirm({
      title: 'Delete conversation',
      description: `"${row.displayTitle}" will be permanently deleted. This action cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'destructive',
      onSuccess: () => {
        void manager?.deleteConversation(row.id);
      },
    });
  };

  // Export (ACP only): delegates to the exact same resource lookup and
  // not-loaded toast the sidebar's own export uses — the board is not where
  // the ACP chat transcript store gets loaded (that only happens once the
  // task view mounts the chat), so this toast is the expected outcome from
  // here, not an edge case. Dynamically imported: `AcpChatStore`'s module
  // pulls in the full ACP/chat-ui runtime, which every board browser test
  // would otherwise have to shadow just to render an inspector panel that
  // never triggers an export — deferring the import to the actual export
  // gesture keeps that weight out of the board's always-loaded module graph.
  const handleExport = async () => {
    const { getAcpChatResourceManager } = await import(
      '@renderer/features/conversations/acp/acp-chat-resource-manager'
    );
    const store = getAcpChatResourceManager(taskId, projectId).get(row.id);
    if (!store) {
      toast({
        title: 'Failed to export transcript',
        description: 'Open the chat before exporting it.',
        variant: 'destructive',
      });
      return;
    }
    store.exportTranscript('parsed');
  };

  const displayTitle = isEditing ? row.rawTitle : row.displayTitle;

  return (
    <div className="group flex w-full items-center gap-1 rounded-md px-1.5 py-1 hover:bg-background-1">
      <div
        data-conversation-row={row.id}
        role="button"
        tabIndex={0}
        onClick={() => onOpen(row.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen(row.id);
          }
        }}
        className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm text-foreground-muted"
        title={displayTitle}
      >
        <ConversationAgentIcon
          providerId={row.providerId}
          isAcp={row.tabKind === 'acp-chat'}
          size={16}
          className="size-4 shrink-0"
        />
        {isEditing ? (
          <input
            ref={handleRenameInputRef}
            className="min-w-0 flex-1 rounded bg-background-1 px-1.5 py-0.5 text-sm text-foreground ring-1 ring-foreground/20 outline-none focus:ring-foreground/40"
            defaultValue={row.rawTitle}
            maxLength={MAX_CONVERSATION_TITLE_LENGTH}
            onClick={(event) => event.stopPropagation()}
            onBlur={(event) => commitRename(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') commitRename(event.currentTarget.value);
              else if (event.key === 'Escape') {
                committedRef.current = true;
                setIsEditing(false);
              }
            }}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate">{row.displayTitle}</span>
        )}
      </div>
      <span className="shrink-0">
        {row.indicatorStatus ? (
          <AgentStatusIndicator status={row.indicatorStatus} disableTooltip />
        ) : (
          <RelativeTime
            value={row.lastInteractedAt ?? ''}
            className="flex h-full items-center pr-1 font-sans text-xs text-foreground-passive"
            compact
          />
        )}
      </span>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
        {row.tabKind === 'acp-chat' && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Export transcript"
            onClick={() => void handleExport()}
          >
            <Download className="size-3.5" />
          </Button>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Rename conversation"
          onClick={handleRename}
        >
          <Pencil className="size-3.5" />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Delete conversation" onClick={handleDelete}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
});

/**
 * The Conversations section (ticket #68): one row per Conversation on the
 * task, in the pure view model's already-derived order (Awaiting Input
 * first, then most-recent activity — never re-sorted here). Always renders,
 * even with zero rows — an explicit empty state, not a hidden section or a
 * loading-like blank. The header names the exact count, replacing Vitals'
 * former "N sessions" line (ticket #68: the count now labels an actual
 * list instead of being repeated in both places).
 */
function ConversationsSection({
  rows,
  projectId,
  taskId,
  manager,
  onOpenConversation,
}: {
  rows: TaskDetailPanelConversationRow[];
  projectId: string;
  taskId: string;
  manager: ConversationManagerStore | undefined;
  onOpenConversation: (conversationId: string) => void;
}) {
  return (
    <PanelSection id="conversations" title={`Conversations (${String(rows.length)})`}>
      {rows.length === 0 ? (
        <p className="text-xs text-foreground-passive">No conversations yet.</p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {rows.map((row) => (
            <PanelConversationRow
              key={row.id}
              row={row}
              projectId={projectId}
              taskId={taskId}
              manager={manager}
              onOpen={onOpenConversation}
            />
          ))}
        </div>
      )}
    </PanelSection>
  );
}

/** Which task or ghost card the panel is currently showing (CONTEXT.md "Task Detail Panel"). */
export type TaskDetailPanelTarget =
  | { kind: 'task'; taskId: string }
  | { kind: 'ghost'; ghostCard: GhostCard };

/**
 * Task Detail Panel (CONTEXT.md): the side panel that opens on the right of
 * the Feature Board when a card is clicked. Shows the task's vitals, typed
 * Linked Issue Roles, the Spec-derived PR, the Workflow Stage with its
 * authority, management actions (rename, pin/unpin, archive, "Open task"),
 * and — for a Ghost Card — the issue's own details with Adopt/Reject.
 *
 * All display logic lives in the pure `task-detail-panel-view-model` module;
 * this component only renders what it computes.
 */
export const TaskDetailPanel = observer(function TaskDetailPanel({
  projectId,
  target,
  onClose,
  onOpenTask,
  onOpenConversation,
  onAdoptGhostCard,
  onRejectGhostCard,
}: {
  projectId: string;
  target: TaskDetailPanelTarget;
  onClose: () => void;
  /** Direct navigation (CONTEXT.md "Task Detail Panel"): the panel's "Open
   * task" button delegates to the same handler `BoardMainPanel` already
   * built for the card's hover arrow, so provision-then-navigate has one
   * implementation, not two. */
  onOpenTask: (taskId: string) => void;
  /** Direct navigation to one Conversation (ticket #68): the Conversations
   * section's rows delegate to the same provision-then-navigate handler as
   * `onOpenTask`, carrying the target conversation's id as the navigation
   * parameter ticket #67 built (`focusConversationId`) rather than a second
   * navigation path. */
  onOpenConversation: (taskId: string, conversationId: string) => void;
  onAdoptGhostCard: (ghostCard: GhostCard) => void;
  onRejectGhostCard: (ghostCard: GhostCard) => void;
}) {
  if (target.kind === 'ghost') {
    return (
      <GhostDetailPanel
        ghostCard={target.ghostCard}
        onClose={onClose}
        onAdopt={() => onAdoptGhostCard(target.ghostCard)}
        onReject={() => onRejectGhostCard(target.ghostCard)}
      />
    );
  }

  return (
    <TaskDetailPanelBody
      projectId={projectId}
      taskId={target.taskId}
      onClose={onClose}
      onOpenTask={onOpenTask}
      onOpenConversation={onOpenConversation}
    />
  );
});

/**
 * The real-task half of the Task Detail Panel: vitals, typed links, derived
 * PR and stage authority (ticket #41), plus management actions and direct
 * navigation (ticket #42). Store access follows the documented selectors:
 * `getTaskStore`/`getTaskManagerStore` plus explicit null checks, never
 * `asProvisioned(...)!` / `asMounted(...)!`.
 */
const TaskDetailPanelBody = observer(function TaskDetailPanelBody({
  projectId,
  taskId,
  onClose,
  onOpenTask,
  onOpenConversation,
}: {
  projectId: string;
  taskId: string;
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
  onOpenConversation: (taskId: string, conversationId: string) => void;
}) {
  const showRenameTask = useShowModal('renameTaskModal');
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

  const manager = getTaskManagerStore(projectId);
  const branchName = getTaskGitWorktreeStore(projectId, taskId)?.branchName ?? null;
  // Conversations section (ticket #68): reads the same per-task conversation
  // manager registry the task-level status dot already reads through
  // `taskAgentStatus` — populated for every task, provisioned or not, when
  // the project mounts (see `TaskManagerStore`'s own preload). Never a new
  // RPC, and never a read that could provision a workspace or mount a
  // worktree just to display this section.
  const conversationManager = getConversationsForTask(taskId);
  const conversationInputs: TaskDetailPanelConversationInput[] = conversationManager
    ? Array.from(conversationManager.conversations.values()).map((conversation) => ({
        id: conversation.data.id,
        providerId: conversation.data.providerId,
        title: conversation.data.title,
        type: conversation.data.type,
        lastInteractedAt: conversation.data.lastInteractedAt,
        indicatorStatus: conversation.indicatorStatus,
      }))
    : [];
  const vm = buildTaskDetailPanelViewModel({
    task,
    branchName,
    sessionCounts: store.conversationStats,
    agentStatus: taskAgentStatus(store),
    stageAuthority,
    conversations: conversationInputs,
  });

  const handleStageChange = (next: string) => {
    void store.updateBoardPosition(next === '' ? null : (next as WorkflowStage), null);
  };

  const handleRename = () => showRenameTask({ projectId, taskId, currentName: task.name });

  const handleTogglePin = () => void store.setPinned(!task.isPinned);

  // Reuses the existing archive RPC via the task manager. Safe if the task
  // disappears mid-interaction: `archiveTask` itself re-reads the task from
  // the manager and no-ops if it is already gone, and once archived the task
  // stops being board-displayable — `BoardMainPanel`'s disappearance effect
  // then closes this very panel on its own.
  const handleArchive = () => void manager?.archiveTask(taskId);

  // Delegates to `BoardMainPanel.handleOpenTask` (passed down as `onOpenTask`),
  // the same handler the card's hover arrow uses — one provision-then-navigate
  // implementation for both direct-navigation gestures, not two.
  const handleOpenTask = () => onOpenTask(taskId);

  // Direct navigation to one Conversation (ticket #68): delegates to
  // `BoardMainPanel.handleOpenConversation` (passed down as
  // `onOpenConversation`) — the same provision-then-navigate implementation
  // as `handleOpenTask` above, carrying the conversation's id so the task
  // view lands on it via the focused-conversation navigation parameter
  // ticket #67 built.
  const handleOpenConversation = (conversationId: string) =>
    onOpenConversation(taskId, conversationId);

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
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-4 py-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium" title={task.name}>
          {task.name}
        </h2>
        <Button size="icon-sm" variant="ghost" aria-label="Rename task" onClick={handleRename}>
          <Pencil className="size-3.5" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={task.isPinned ? 'Unpin task' : 'Pin task'}
          onClick={handleTogglePin}
        >
          {task.isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Archive task" onClick={handleArchive}>
          <Archive className="size-3.5" />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Close task details" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      <div className="shrink-0 border-b border-border px-4 py-2">
        <Button size="sm" variant="outline" className="w-full" onClick={handleOpenTask}>
          Open task
          <ArrowUpRight className="size-3.5" />
        </Button>
      </div>

      <PanelSection id="vitals" title="Vitals">
        {/* Branch and working-tree changes (ticket #49): read-only, and never
            provisions anything to display them. `TaskGitDiffStats` (ticket
            #47's card primitive, reused rather than duplicated here) only
            ever reads a live `GitWorktreeStore` already mounted for a
            provisioned task, or the cached `workspaceGit` snapshot for one
            that isn't — browsing the board (or its inspector) never mounts a
            worktree or provisions a task just to show this. */}
        <div className="flex items-center gap-1.5 text-xs text-foreground-muted">
          <GitBranch className="size-3 shrink-0" />
          {vm.vitals.branchName ? (
            <span className="min-w-0 flex-1 truncate" title={vm.vitals.branchName}>
              {vm.vitals.branchName}
            </span>
          ) : (
            <span className="flex-1">Not provisioned yet</span>
          )}
          <TaskGitDiffStats task={store} />
        </div>
        <div className="flex items-center justify-between text-xs text-foreground-muted">
          <span>Created</span>
          <RelativeTime value={task.createdAt} />
        </div>
        {/* Agent state (ticket #49; count moved to the Conversations section
            below in ticket #68 — a 400px inspector no longer says "N
            sessions" in two places). The stacked per-provider logos and the
            task-level status indicator stay here as the task-level summary;
            reused, not re-derived. */}
        <div className="flex items-center justify-end gap-1.5">
          {Object.keys(vm.vitals.sessionCounts).length > 0 && (
            <StackedAgentLogos stats={vm.vitals.sessionCounts} />
          )}
          <AgentStatusIndicator status={vm.vitals.agentStatus} />
        </div>
      </PanelSection>

      <ConversationsSection
        rows={vm.conversations}
        projectId={projectId}
        taskId={taskId}
        manager={conversationManager}
        onOpenConversation={handleOpenConversation}
      />

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

      {/* Delivery chain (ticket #49, CONTEXT.md "Origin Issue", "Map",
          "Spec"): Origin -> Map -> Spec -> Pull Request, in that order, each
          opening at its external source (`ExternalLinkButton` -> `app.openExternal`,
          the same helper every row here already used before this ticket —
          never a raw `window.open`/`<a target=_blank>`). Origin/Map/Spec come
          from `vm.links` (already Origin-Map-Spec ordered); the Spec-derived
          PR — the chain's most advanced link — renders last, in the same
          section, rather than as a second, disconnected block. */}
      {(vm.links.length > 0 || vm.pr) && (
        <PanelSection id="delivery-chain" title="Delivery chain">
          <div className="flex flex-col gap-1.5">
            {vm.links.map((link) => (
              <LinkedIssueRow key={link.role} link={link} />
            ))}
            {vm.pr && <SpecDerivedPrRow pr={vm.pr} />}
          </div>
        </PanelSection>
      )}
    </div>
  );
});

/**
 * Ghost mode (CONTEXT.md "Task Detail Panel", "Ghost Card"): shown when a
 * Ghost Card is clicked instead of a real task. Reads directly off the
 * candidate issue — there is no task yet — and offers Adopt/Reject, which
 * reuse the same ghost-card actions the card itself exposes (`useGhostCards`).
 */
function GhostDetailPanel({
  ghostCard,
  onClose,
  onAdopt,
  onReject,
}: {
  ghostCard: GhostCard;
  onClose: () => void;
  onAdopt: () => void;
  onReject: () => void;
}) {
  const vm = deriveGhostDetailViewModel(ghostCard);

  return (
    <div
      className={`flex h-full ${TASK_DETAIL_PANEL_WIDTH_CLASS} shrink-0 flex-col overflow-y-auto border-l border-border bg-background`}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <Badge variant="outline" className="shrink-0">
          Ghost
        </Badge>
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium" title={vm.title}>
          {vm.title}
        </h2>
        <Button size="icon-sm" variant="ghost" aria-label="Close task details" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      <PanelSection id="ghost-issue" title="Issue">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="min-w-0 flex-1 truncate" title={vm.url}>
            {vm.url}
          </span>
          <ExternalLinkButton url={vm.url} label={`Open ${vm.title} on GitHub`} />
        </div>
        {vm.body && <p className="text-xs whitespace-pre-wrap text-foreground-muted">{vm.body}</p>}
      </PanelSection>

      <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-3">
        <Button size="sm" variant="outline" className="flex-1" onClick={onAdopt}>
          Adopt
        </Button>
        <Button size="sm" variant="ghost" className="flex-1" onClick={onReject}>
          Reject
        </Button>
      </div>
    </div>
  );
}
