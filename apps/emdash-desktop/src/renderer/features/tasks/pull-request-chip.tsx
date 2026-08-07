import { rpc } from '@renderer/lib/ipc';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import {
  getPrNumber,
  type PullRequest,
  type PullRequestStatus,
} from '@shared/core/pull-requests/pull-requests';

/**
 * The task titlebar's PR chip (ticket #99, CONTEXT.md "Assigned PR"): shows
 * the task's PR — the user-assigned PR when one is set, else the derived PR
 * (`resolveTaskPr`) — as its number plus a status dot, with the full title
 * in a tooltip. Activating it opens the PR in the external browser.
 *
 * Kept in its own dependency-light leaf module (only `rpc` and the tooltip
 * primitive) rather than defined inline in `task-titlebar.tsx`, whose other
 * imports (git actions, workspace view context, conversation/task stores,
 * ...) are the heavy transitive chain a plain browser test for this chip
 * has no reason to load — the same reason `WorkflowStageChip` lives in its
 * own leaf module. `TaskTitlebar`'s gating of the chip to the derived PR
 * (`taskPr ? <PullRequestChip/> : null`) is a plain conditional render
 * verified by the derivation helper's unit tests, not re-tested here.
 */
export function PullRequestChip({ pr }: { pr: PullRequest }) {
  const prNumber = getPrNumber(pr);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Pull request ${prNumber != null ? `#${prNumber}` : ''}: ${pr.title}. Open in browser.`}
            onClick={() => void rpc.app.openExternal(pr.url)}
            className="hover:bg-muted/30 flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs text-foreground-muted"
          >
            <PrStatusDot status={pr.status} isDraft={pr.isDraft} />
            {prNumber != null ? (
              <span className="font-sans">#{prNumber}</span>
            ) : (
              <span className="max-w-[180px] truncate">{pr.title}</span>
            )}
          </button>
        }
      />
      <TooltipContent>{pr.title}</TooltipContent>
    </Tooltip>
  );
}

/** A status dot (open/merged/closed/draft), mirroring the color language of
 * `pr-status-icon.tsx` so the chip never invents a second status palette. */
function PrStatusDot({ status, isDraft }: { status: PullRequestStatus; isDraft: boolean }) {
  return (
    <span
      aria-hidden
      className={cn('h-1.5 w-1.5 shrink-0 rounded-full', {
        'bg-foreground-success': status === 'open' && !isDraft,
        'bg-foreground-muted': status === 'open' && isDraft,
        'bg-foreground-merged': status === 'merged',
        'bg-foreground-error': status === 'closed',
      })}
    />
  );
}
