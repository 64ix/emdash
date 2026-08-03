import { observer } from 'mobx-react-lite';
import { PullRequestView } from '@renderer/features/projects/components/pr-view/pr-view';
import { SettingsPanel } from '@renderer/features/projects/components/settings-view/settings-panel';
import { TaskList } from '@renderer/features/projects/components/task-view/task-list';
import { asMounted, getProjectStore } from '@renderer/features/projects/stores/project-selectors';
import { useParams } from '@renderer/lib/layout/navigation-provider';

/**
 * The `project` view's own content: List, Pull Requests, and Settings, all
 * rendered inside the narrow settings-style content column (`max-w-4xl`)
 * that legitimately still constrains them (ticket #44). Board never renders
 * here -- the work-mode switcher in `ProjectTitlebar` navigates straight to
 * the full-width `board` view instead, so this component never needs to
 * escape the column at all.
 */
export const ActiveProject = observer(function ActiveProject() {
  const {
    params: { projectId },
  } = useParams('project');
  const store = asMounted(getProjectStore(projectId));

  if (!store) return null;

  const activeView = store.view.activeView;

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col overflow-x-hidden overflow-y-auto px-8">
        <div className="mx-auto flex h-full min-h-0 w-full flex-col px-1 py-10">
          {activeView === 'pull-request' && <PullRequestView />}
          {activeView === 'settings' && <SettingsPanel />}
          {/* Falls back to List for 'tasks' and for the transient 'board' case
              (a persisted Board snapshot restored a tick before the
              `project` view's guard redirects to the real board view) --
              never a blank panel. */}
          {activeView !== 'pull-request' && activeView !== 'settings' && <TaskList />}
        </div>
      </div>
    </div>
  );
});
