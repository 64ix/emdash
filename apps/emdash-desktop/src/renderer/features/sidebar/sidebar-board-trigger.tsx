import { Kanban } from 'lucide-react';
import {
  isCurrentView,
  useNavigate,
  useWorkspaceSlots,
} from '@renderer/lib/layout/navigation-provider';
import { SidebarMenuButton } from './sidebar-primitives';

/**
 * Global Board entry point (spec #104, ticket #108): the plain Board button
 * at the top of the left sidebar — above the pinned-task list, below the
 * space switcher. Deliberately no attention badge and no extra chrome: the
 * Global Board aggregates every project's tasks, so a single unweighted
 * button is the honest affordance (CONTEXT.md "Global Board"). Clicking it
 * navigates to the `global-board` view; the view's own `canActivate` runs
 * the single best-effort global refresh.
 */
export function SidebarBoardTrigger() {
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();

  return (
    <SidebarMenuButton
      isActive={isCurrentView(currentView, 'global-board')}
      onClick={() => navigate('global-board')}
      aria-label="Board"
      className="w-full"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Kanban className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" />
        <span className="truncate">Board</span>
      </span>
    </SidebarMenuButton>
  );
}
