import { Settings } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { asMounted, getProjectStore } from '@renderer/features/projects/stores/project-selectors';
import type { ProjectView } from '@renderer/features/projects/stores/project-view';
import { useNavigate, useWorkspaceSlots } from '@renderer/lib/layout/navigation-provider';
import { Button } from '@renderer/lib/ui/button';
import { PanelTabs } from '@renderer/lib/ui/panel-tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { captureTelemetry } from '@renderer/utils/telemetryClient';

const WORK_MODE_TABS: Array<{ value: ProjectView; label: string }> = [
  { value: 'board', label: 'Board' },
  { value: 'tasks', label: 'List' },
  { value: 'pull-request', label: 'Pull Requests' },
];

/**
 * The project workspace's primary work-mode switcher (ticket #44): Board,
 * List, and Pull Requests are visible peers here, while Settings is a
 * secondary, project-configuration destination reachable through the
 * adjacent gear button rather than a work-mode peer.
 *
 * Rendered from both the `project` and `board` titlebars (`project-titlebar`)
 * so a project's work mode stays switchable regardless of which of those two
 * canonical views is currently mounted -- selecting Board always navigates
 * to the full-width `board` view rather than rendering board content inline,
 * which is what keeps the board outside the narrow settings-style content
 * column that List, Pull Requests, and Settings intentionally still use.
 */
export const ProjectWorkModeSwitcher = observer(function ProjectWorkModeSwitcher({
  projectId,
}: {
  projectId: string;
}) {
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();
  const mounted = asMounted(getProjectStore(projectId));
  if (!mounted) return null;

  const activeMode: ProjectView = currentView === 'board' ? 'board' : mounted.view.activeView;

  const handleChange = (mode: ProjectView) => {
    if (mode === 'board') {
      captureTelemetry('board_opened', { source: 'work_mode_switcher', project_id: projectId });
      navigate('board', { projectId });
      return;
    }
    mounted.view.setProjectView(mode);
    if (currentView !== 'project') navigate('project', { projectId });
  };

  return (
    <div className="flex items-center gap-1">
      <PanelTabs compact value={activeMode} onChange={handleChange} tabs={WORK_MODE_TABS} />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Project settings"
              onClick={() => {
                mounted.view.setProjectView('settings');
                if (currentView !== 'project') navigate('project', { projectId });
              }}
            >
              <Settings className="size-3.5" />
            </Button>
          }
        />
        <TooltipContent>Project Settings</TooltipContent>
      </Tooltip>
    </div>
  );
});
