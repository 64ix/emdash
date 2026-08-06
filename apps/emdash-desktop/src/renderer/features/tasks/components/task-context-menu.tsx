import {
  Archive,
  Copy,
  Eye,
  EyeOff,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import React from 'react';
import { toast } from '@renderer/lib/hooks/use-toast';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/lib/ui/context-menu';

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
  /** Hidden Task (spec #85, ticket #87): sidebar-only view state — see CONTEXT.md "Hidden Task". */
  isHiddenFromSidebar?: boolean;
  /** "Hide from sidebar" — removes the task from the sidebar only. */
  onHideFromSidebar?: () => void;
  /** "Show in sidebar" — restores the task's sidebar row. */
  onShowInSidebar?: () => void;
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
  isHiddenFromSidebar,
  onHideFromSidebar,
  onShowInSidebar,
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
        {/* Hidden Task (spec #85, ticket #87): the sidebar-only hide/show
            pair — available for any task, in any stage (CONTEXT.md "Hidden
            Task"). The sidebar offers "Hide from sidebar"; a hidden task's
            project-view row offers "Show in sidebar". */}
        {!isHiddenFromSidebar && onHideFromSidebar && (
          <ContextMenuItem onClick={onHideFromSidebar}>
            <EyeOff className="size-4" />
            Hide from sidebar
          </ContextMenuItem>
        )}
        {isHiddenFromSidebar && onShowInSidebar && (
          <ContextMenuItem onClick={onShowInSidebar}>
            <Eye className="size-4" />
            Show in sidebar
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
