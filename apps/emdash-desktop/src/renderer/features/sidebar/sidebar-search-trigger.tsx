import { Search } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { getRegisteredTaskData } from '@renderer/features/tasks/stores/task-selectors';
import { activeProjectIdForView } from '@renderer/lib/layout/active-project';
import { useParams, useWorkspaceSlots } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { BoundShortcut } from '@renderer/lib/ui/shortcut';
import { SidebarMenuButton } from './sidebar-primitives';

export const SidebarSearchTrigger = observer(function SidebarSearchTrigger() {
  const showCommandPalette = useShowModal('commandPaletteModal');
  const { currentView } = useWorkspaceSlots();
  const { params: taskParams } = useParams('task');
  const { params: projectParams } = useParams('project');
  const { params: boardParams } = useParams('board');

  // `board` (ticket #43) resolves here too, so opening search from the
  // Feature Board keeps it scoped to that project.
  const currentProjectId = activeProjectIdForView(currentView, {
    task: taskParams.projectId,
    project: projectParams.projectId,
    board: boardParams.projectId,
  });
  const currentTaskId = currentView === 'task' ? taskParams.taskId : undefined;

  const currentWorkspaceId =
    currentProjectId && currentTaskId
      ? getRegisteredTaskData(currentProjectId, currentTaskId)?.workspaceId
      : undefined;

  return (
    <SidebarMenuButton
      isActive={false}
      onClick={() =>
        showCommandPalette({
          projectId: currentProjectId,
          taskId: currentTaskId,
          workspaceId: currentWorkspaceId,
        })
      }
      aria-label="Search"
      className="w-full justify-between"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Search className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" />
        <span className="truncate">Search…</span>
      </span>
      <BoundShortcut settingsKey="commandPalette" variant="keycaps" />
    </SidebarMenuButton>
  );
});
