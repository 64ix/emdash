import { observer } from 'mobx-react-lite';
import { type TaskStore } from '@renderer/features/tasks/stores/task-store';
import { CLISpinner } from '@renderer/lib/components/cliSpinner';
import { useDelayedBoolean } from '@renderer/lib/hooks/use-delay-boolean';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { RelativeTime } from '@renderer/lib/ui/relative-time';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { getSortInstant, sortKindFor } from './sidebar-store';

/**
 * Sidebar trailing slot (spec #120): the leading status dot
 * (`SidebarSignalDot`, sidebar-signal-dot.tsx) carries the task's live
 * signal now, so this slot is just the bootstrapping spinner and the
 * relative timestamp. The whole metadata cluster is right-aligned by the
 * parent, so the slot just hugs its content — no fixed width to avoid an
 * empty gap between the timestamp and the line-changes / PR icon to its
 * left.
 */
function Slot({ children }: { children: React.ReactNode }) {
  return <span className="flex w-[3ch] shrink-0 items-center justify-end">{children}</span>;
}

export const TaskSidebarTrailingSlot = observer(function TaskSidebarTrailingSlot({
  task,
  showTimestamp,
}: {
  task: TaskStore;
  showTimestamp: boolean;
}) {
  const delayedIsBootstrapping = useDelayedBoolean(task.isBootstrapping, 500);

  if (delayedIsBootstrapping) {
    return (
      <Slot>
        <Tooltip>
          <TooltipTrigger>
            <span className="flex size-6 items-center justify-center">
              <CLISpinner variant="2" />
            </span>
          </TooltipTrigger>
          <TooltipContent>Creating task workspace...</TooltipContent>
        </Tooltip>
      </Slot>
    );
  }

  if (!showTimestamp) return null;

  const instant = getSortInstant(task, sortKindFor(sidebarStore.taskSortBy));
  if (!instant) return null;

  return (
    <Slot>
      <RelativeTime
        value={instant}
        className="font-sans text-xs text-foreground-passive tabular-nums"
        compact
      />
    </Slot>
  );
});
