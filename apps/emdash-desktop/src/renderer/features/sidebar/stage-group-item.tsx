import { ChevronRight } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import {
  SHIPPED_FADE_DISCLOSURE,
  SHIPPED_FADE_WINDOW_DAYS,
} from '@renderer/features/board/board-columns';
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
 *
 * The Shipped group carries the same Shipped Fade disclosure as the board's
 * Shipped column (ticket #87): `shipped` tasks past the window leave the
 * group, so the caption explains why the set shrank without the tasks ever
 * appearing to vanish arbitrarily (CONTEXT.md "Shipped Fade").
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
  const isShipped = stage === 'shipped';
  return (
    <SidebarMenuRow
      className="group/row h-8 justify-between gap-1 px-1 pl-8"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => sidebarStore.toggleStageGroupCollapsed(projectId, stage)}
    >
      <SidebarMenuAction
        aria-label={`${label}, ${count} ${count === 1 ? 'task' : 'tasks'}${isCollapsed ? ', collapsed' : ''}${
          isShipped ? ` — ${SHIPPED_FADE_DISCLOSURE}` : ''
        }`}
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
      {isShipped && (
        <span
          className="shrink-0 truncate text-[10px] text-foreground-passive"
          title={SHIPPED_FADE_DISCLOSURE}
        >
          hides after {SHIPPED_FADE_WINDOW_DAYS}d
        </span>
      )}
      <span className="shrink-0 text-xs text-foreground-tertiary-muted">{count}</span>
    </SidebarMenuRow>
  );
});
