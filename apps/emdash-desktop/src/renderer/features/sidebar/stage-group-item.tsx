import { ChevronRight } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { cn } from '@renderer/utils/utils';
import type { WorkflowStage } from '@shared/core/tasks/tasks';
import { SidebarMenuAction, SidebarMenuRow } from './sidebar-primitives';

/**
 * Sidebar Stage Group header (spec #85, ticket #86): the collapsible folder
 * row for one non-empty Workflow Stage, rendered between the project's Board
 * row (above) and its group's task rows. Shows the stage label and the count
 * of visible tasks; clicking toggles the group's collapse state, persisted in
 * the sidebar snapshot via `SidebarStore`. Never draggable — a fixed anchor
 * like the Board row, so the stage sequence cannot be scrambled.
 */
export const SidebarStageGroupItem = observer(function SidebarStageGroupItem({
  projectId,
  stage,
  label,
  count,
}: {
  projectId: string;
  stage: WorkflowStage;
  label: string;
  count: number;
}) {
  const isCollapsed = sidebarStore.isStageGroupCollapsed(projectId, stage);
  return (
    <SidebarMenuRow
      className="group/row h-8 justify-between gap-1 px-1 pl-8"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => sidebarStore.toggleStageGroupCollapsed(projectId, stage)}
    >
      <SidebarMenuAction
        aria-label={`${label}, ${count} ${count === 1 ? 'task' : 'tasks'}${isCollapsed ? ', collapsed' : ''}`}
        className="gap-1.5"
      >
        <ChevronRight
          className={cn(
            'h-4 w-4 shrink-0 transition-transform duration-150',
            isCollapsed ? '' : 'rotate-90'
          )}
        />
        <span className="min-w-0 truncate">{label}</span>
      </SidebarMenuAction>
      <span className="shrink-0 text-xs text-foreground-tertiary-muted">{count}</span>
    </SidebarMenuRow>
  );
});
