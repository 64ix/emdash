import { Kanban } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { agentStatusNeedsAttention } from '@renderer/features/board/board-attention';
import { isBoardDisplayable } from '@renderer/features/board/board-columns';
import {
  getTaskManagerStore,
  taskAgentStatus,
} from '@renderer/features/tasks/stores/task-selectors';
import { registeredTaskData } from '@renderer/features/tasks/stores/task-store';
import {
  useNavigate,
  useParams,
  useWorkspaceSlots,
} from '@renderer/lib/layout/navigation-provider';
import { Badge } from '@renderer/lib/ui/badge';
import { captureTelemetry } from '@renderer/utils/telemetryClient';
import { SidebarMenuAction, SidebarMenuRow } from './sidebar-primitives';

/**
 * Sidebar Board row (ticket #43): the project-scoped Feature Board's
 * canonical entry point from the sidebar (CONTEXT.md "Feature Board").
 * Rendered by `SidebarVirtualList` right after its project's row and before
 * its task rows via `SidebarStore.sidebarRows`. Never draggable/sortable —
 * it is a fixed anchor, not a reorderable item.
 */
export const SidebarBoardItem = observer(function SidebarBoardItem({
  projectId,
}: {
  projectId: string;
}) {
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();
  const { params } = useParams('board');
  const isActive = currentView === 'board' && params.projectId === projectId;

  // Attention count: mirrors the board's own displayable-task set
  // (`isBoardDisplayable`) and Needs Attention semantics
  // (`agentStatusNeedsAttention`) so the count never promises more than
  // opening the board would actually show.
  const manager = getTaskManagerStore(projectId);
  let attentionCount = 0;
  if (manager) {
    for (const store of manager.tasks.values()) {
      const task = registeredTaskData(store);
      if (!task || !isBoardDisplayable(task)) continue;
      if (agentStatusNeedsAttention(taskAgentStatus(store))) attentionCount++;
    }
  }

  const openBoard = () => {
    captureTelemetry('board_opened', { source: 'sidebar', project_id: projectId });
    navigate('board', { projectId });
  };

  return (
    <SidebarMenuRow
      className="h-8 justify-between gap-1 px-1 pl-8"
      isActive={isActive}
      onMouseDown={(e) => e.preventDefault()}
      onClick={openBoard}
    >
      <SidebarMenuAction aria-label="Open Feature Board" className="gap-2">
        <Kanban className="h-4 w-4 shrink-0" />
        <span className="truncate">Board</span>
      </SidebarMenuAction>
      {attentionCount > 0 && (
        <Badge
          variant="secondary"
          aria-label={`${attentionCount} task${attentionCount === 1 ? '' : 's'} need attention`}
        >
          {attentionCount}
        </Badge>
      )}
    </SidebarMenuRow>
  );
});
