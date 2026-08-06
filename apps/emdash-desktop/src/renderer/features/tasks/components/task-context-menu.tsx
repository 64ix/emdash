import {
  Archive,
  Copy,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  Trash2,
  Workflow,
} from 'lucide-react';
import React from 'react';
import { type SidebarStageMoveOption } from '@renderer/features/sidebar/stage-group-row-model';
import { toast } from '@renderer/lib/hooks/use-toast';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@renderer/lib/ui/context-menu';
import type { WorkflowStage } from '@shared/core/tasks/tasks';

interface TaskContextMenuProps {
  children: React.ReactNode;
  isPinned: boolean;
  canPin: boolean;
  isArchived: boolean;
  branchName?: string;
  onPin: () => void;
  onUnpin: () => void;
  onRename: () => void;
  onArchive: () => void;
  onRestore?: () => void;
  onReconnect?: () => void;
  onConvertAutomation?: () => void;
  onDelete: () => void;
  /**
   * "Move to stage…" submenu entries (spec #85, ticket #88): every Workflow
   * Stage plus Unstaged, with the board's authority-gated destinations
   * disabled exactly like a blocked board drop. Absent (or an absent
   * `onMoveToStage`) renders no submenu, so callers that never move stages
   * (e.g. the project view's task list) keep today's menu unchanged.
   */
  stageMoveOptions?: readonly SidebarStageMoveOption[];
  /**
   * Feedback shown inside the submenu while any destination is blocked: the
   * governing GitHub fact and what must change before the move sticks,
   * composed exactly like the board's blocked-drop explanation (ticket #88
   * acceptance: a move a GitHub fact would overwrite is blocked *with
   * feedback*).
   */
  stageMoveExplanation?: string | null;
  onMoveToStage?: (stage: WorkflowStage | null) => void;
}

export function TaskContextMenu({
  children,
  isPinned,
  canPin,
  isArchived,
  branchName,
  onPin,
  onUnpin,
  onRename,
  onArchive,
  onRestore,
  onReconnect,
  onConvertAutomation,
  onDelete,
  stageMoveOptions,
  stageMoveExplanation,
  onMoveToStage,
}: TaskContextMenuProps) {
  const handleCopyBranchName = async () => {
    if (!branchName) return;

    try {
      await navigator.clipboard.writeText(branchName);
      toast({ title: 'Branch name copied' });
    } catch {
      toast({
        title: 'Copy failed',
        description: 'The branch name could not be copied to the clipboard.',
        variant: 'destructive',
      });
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {canPin &&
          (isPinned ? (
            <ContextMenuItem onClick={onUnpin}>
              <PinOff className="size-4" />
              Unpin task
            </ContextMenuItem>
          ) : (
            <ContextMenuItem onClick={onPin}>
              <Pin className="size-4" />
              Pin task
            </ContextMenuItem>
          ))}
        <ContextMenuItem onClick={onRename}>
          <Pencil className="size-4" />
          Rename
        </ContextMenuItem>
        {onReconnect && (
          <ContextMenuItem onClick={onReconnect}>
            <RotateCcw className="size-4" />
            Reconnect
          </ContextMenuItem>
        )}
        {onConvertAutomation && (
          <ContextMenuItem onClick={onConvertAutomation}>
            <MessageSquare className="size-4" />
            Convert to regular task
          </ContextMenuItem>
        )}
        {onMoveToStage && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Workflow className="size-4" />
              Move to stage…
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {stageMoveOptions?.map((option) => (
                <ContextMenuItem
                  key={option.stage ?? 'unstaged'}
                  disabled={option.blocked}
                  onClick={() => onMoveToStage(option.stage)}
                >
                  {option.label}
                </ContextMenuItem>
              ))}
              {stageMoveExplanation && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem disabled className="max-w-64 text-xs whitespace-normal">
                    {stageMoveExplanation}
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {!isArchived && (
          <ContextMenuItem onClick={onArchive}>
            <Archive className="size-4" />
            Archive
          </ContextMenuItem>
        )}
        {isArchived && onRestore && (
          <ContextMenuItem onClick={onRestore}>
            <RotateCcw className="size-4" />
            Restore
          </ContextMenuItem>
        )}
        {branchName && (
          <ContextMenuItem onClick={() => void handleCopyBranchName()}>
            <Copy className="size-4" />
            Copy branch name
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={onDelete}>
          <Trash2 className="size-4" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
