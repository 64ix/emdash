import { taskAgentStatus } from '@renderer/features/tasks/stores/task-selectors';
import type { TaskStore } from '@renderer/features/tasks/stores/task-store';
import { CLISpinner } from '@renderer/lib/components/cliSpinner';
import { cn } from '@renderer/utils/utils';
import type { SidebarSignal } from './project-card-model';

/**
 * The status-dot language of the project cards (spec #120): one small
 * indicator that reads identically on a task row, a pinned row and a card
 * header — spinner while working, amber dot for awaiting input, red for
 * error, green for completed (US11, "Deliberate visual changes": task names
 * switch to this language instead of the old trailing blue treatment).
 * Reuses the theme's signal tokens (`--foreground-warning` etc.), so light
 * and dark themes stay readable without hardcoded colors.
 */
const SIGNAL_LABELS: Record<SidebarSignal, string> = {
  working: 'Working',
  'awaiting-input': 'Needs input',
  error: 'Error',
  completed: 'Done',
};

/** The live sidebar signal of one task store — `null` when idle or missing. */
export function taskSidebarSignal(task: TaskStore): SidebarSignal | null {
  const status = taskAgentStatus(task);
  if (status === null || status === 'idle') return null;
  return status;
}

export function SidebarSignalDot({
  signal,
  className,
}: {
  signal: SidebarSignal | null;
  className?: string;
}) {
  if (!signal) return null;
  if (signal === 'working') {
    return (
      <span
        className={cn('flex size-3.5 shrink-0 items-center justify-center', className)}
        title={SIGNAL_LABELS.working}
        aria-label={SIGNAL_LABELS.working}
      >
        <CLISpinner />
      </span>
    );
  }
  return (
    <span
      className={cn('size-2 shrink-0 rounded-full', className, {
        'bg-foreground-warning': signal === 'awaiting-input',
        'bg-foreground-error': signal === 'error',
        'bg-foreground-success': signal === 'completed',
      })}
      title={SIGNAL_LABELS[signal]}
      aria-label={SIGNAL_LABELS[signal]}
    />
  );
}
