import { CircleSlash2 } from 'lucide-react';

/**
 * "Not resumable on this device" affordance (spec #130, ticket #137):
 * a conversation imported from another machine has no session on this machine
 * until one is created (sessionId is machine-specific and never synced), so
 * the list marks it. Rendered in place of the last-interacted time.
 */
export function ConversationResumabilityBadge() {
  return (
    <span
      data-testid="conversation-not-resumable"
      title="Not resumable on this device — open it to start a new session here"
      className="flex h-full items-center gap-1 pr-1 font-sans text-[11px] text-foreground-passive"
    >
      <CircleSlash2 className="size-3.5" aria-hidden />
      not resumable on this device
    </span>
  );
}
