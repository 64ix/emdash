import { Loader2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import { usePanelRef } from 'react-resizable-panels';
import {
  getTaskStore,
  taskErrorMessage,
  taskViewKind,
} from '@renderer/features/tasks/stores/task-selectors';
import {
  useTaskViewContext,
  useWorkspaceViewModel,
} from '@renderer/features/tasks/task-view-context';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@renderer/lib/ui/resizable';
import { taskTabView } from './task-tab-registry';
import { TaskMainColumn } from './view/task-main-column';
import { TaskSidebar } from './view/task-sidebar';

export const TaskMainPanel = observer(function TaskMainPanel() {
  const { projectId, taskId } = useTaskViewContext();
  const taskStore = getTaskStore(projectId, taskId);
  const kind = taskViewKind(taskStore, projectId);

  if (kind === 'creating') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-foreground-muted" />
        <p className="font-sans text-xs text-foreground-muted">Creating task</p>
      </div>
    );
  }

  if (kind === 'create-error') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center p-8">
        <div className="flex max-w-xs flex-col items-center gap-2 text-center">
          <p className="font-sans text-sm font-medium text-foreground-destructive">
            Error creating task
          </p>
          <p className="font-sans text-xs text-foreground-passive">{taskErrorMessage(taskStore)}</p>
        </div>
      </div>
    );
  }

  if (kind === 'project-mounting' || kind === 'provisioning') {
    const progressMessage = taskStore?.provisionProgressMessage ?? 'Setting up workspace…';
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-foreground-muted" />
        <p className="font-sans text-xs text-foreground-muted">{progressMessage}</p>
      </div>
    );
  }

  if (kind === 'provision-error' || kind === 'project-error') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center p-8">
        <div className="flex max-w-xs flex-col items-center gap-2 text-center">
          <p className="font-sans text-sm font-medium text-foreground-destructive">
            Failed to set up workspace
          </p>
          <p className="font-sans text-xs text-foreground-muted">{taskErrorMessage(taskStore)}</p>
        </div>
      </div>
    );
  }

  if (kind === 'idle' || kind === 'teardown') {
    const progressMessage = taskStore?.provisionProgressMessage ?? 'Setting up workspace…';
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-foreground-muted" />
        <p className="font-sans text-xs text-foreground-muted">{progressMessage}</p>
      </div>
    );
  }

  if (kind === 'teardown-error') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center p-8">
        <div className="flex max-w-xs flex-col items-center gap-2 text-center">
          <p className="font-sans text-sm font-medium text-foreground-destructive">
            Failed to tear down workspace
          </p>
          <p className="font-sans text-xs text-foreground-muted">{taskErrorMessage(taskStore)}</p>
        </div>
      </div>
    );
  }

  if (kind === 'missing') {
    return null;
  }

  return <ReadyTaskMainPanel />;
});

const SIDEBAR_COLLAPSED_SIZE = '0px';

const ReadyTaskMainPanel = observer(function ReadyTaskMainPanel() {
  const taskView = useWorkspaceViewModel();
  const sidebarPanelRef = usePanelRef();
  const { params, setParams } = useParams('task');
  // Focused-conversation navigation (ticket #67): the command palette's
  // conversation jumps (and the Task Detail Panel's conversation row, next
  // ticket) carry an optional `focusConversationId` back to this view —
  // resolved here, once the task is `ready` (this component only ever
  // renders in that state), the direct mirror of the board's own
  // `focusTaskId` handling (`BoardMainPanel`). A guard ref keyed on the
  // parameter value ensures a given id is only ever resolved once per
  // arrival, so a later unrelated re-render can never re-steal the active
  // tab from the user's own subsequent choice. The parameter is cleared
  // through the navigation store's existing view-param update API once
  // resolved — view params are persisted and restored across app restarts,
  // and a lingering id would re-fire on a cold start and override restored
  // tab state.
  //
  // Goes through `resolveFocusedConversation`, not the plain
  // `openConversation`: a never-provisioned task turns `ready` (mounting
  // this effect) in the very tick its conversation list starts loading over
  // IPC, before that fetch resolves — `openConversation`'s synchronous check
  // would see an empty registry and silently no-op, losing the very race
  // this ticket exists to close. `resolveFocusedConversation` waits for
  // conversation data to actually arrive before resolving, and its returned
  // disposer is cleaned up here if this effect reruns or unmounts first.
  const focusHandledRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const focusConversationId = params.focusConversationId;
    if (!focusConversationId || focusHandledRef.current === focusConversationId) return;
    focusHandledRef.current = focusConversationId;
    setParams({ focusConversationId: undefined });
    return taskView.resolveFocusedConversation(focusConversationId);
  }, [params.focusConversationId, taskView, setParams]);

  useEffect(() => {
    if (taskView.isSidebarCollapsed) {
      sidebarPanelRef.current?.collapse();
    } else {
      sidebarPanelRef.current?.expand();
    }
  }, [taskView.isSidebarCollapsed, sidebarPanelRef]);

  return (
    <taskTabView.TabLayoutProvider layout={taskView.paneLayout}>
      <ResizablePanelGroup orientation="horizontal" id="task-sidebar-layout">
        <ResizablePanel id="task-main-area">
          <TaskMainColumn />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel
          id="task-sidebar"
          panelRef={sidebarPanelRef}
          defaultSize="25%"
          minSize="280px"
          maxSize="50%"
          collapsible
          collapsedSize={SIDEBAR_COLLAPSED_SIZE}
          onResize={() =>
            taskView.setSidebarCollapsed(sidebarPanelRef.current?.isCollapsed() ?? false)
          }
        >
          <TaskSidebar />
        </ResizablePanel>
      </ResizablePanelGroup>
    </taskTabView.TabLayoutProvider>
  );
});
