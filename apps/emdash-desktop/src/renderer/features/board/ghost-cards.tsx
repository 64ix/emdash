import { useEffect, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/utils/utils';
import type { GhostCard } from '@shared/core/issues/ghost-card';
import { ghostCardsUpdatedChannel } from '@shared/core/issues/issueEvents';

/**
 * Fetches and keeps a project's cached Ghost Cards (ticket #9, CONTEXT.md
 * "Ghost Card") in sync with inbound issues-sync passes, and exposes
 * adopt/reject actions. Mirrors `BoardLinkSuggestions`'s fetch/subscribe
 * pattern.
 */
export function useGhostCards(projectId: string) {
  const [ghostCards, setGhostCards] = useState<GhostCard[]>([]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void rpc.issues.getGhostCards(projectId).then((result) => {
        if (!cancelled) setGhostCards(result);
      });
    };
    refresh();

    const unsubscribe = events.on(ghostCardsUpdatedChannel, (payload) => {
      if (payload.projectId === projectId) refresh();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectId]);

  // Callers invoke these from fire-and-forget click handlers, so failures are
  // handled here: the card is only removed locally once the RPC succeeded, and
  // an error never escapes as an unhandled rejection.
  const adopt = async (ghostCard: GhostCard) => {
    try {
      const result = await rpc.issues.adoptGhostCard(projectId, ghostCard);
      if (result.success) {
        setGhostCards((current) => current.filter((c) => c.id !== ghostCard.id));
      }
      return result;
    } catch (e) {
      console.error('Failed to adopt ghost card', e);
      return undefined;
    }
  };

  const reject = async (ghostCard: GhostCard) => {
    try {
      await rpc.issues.rejectGhostCard(projectId, ghostCard);
      setGhostCards((current) => current.filter((c) => c.id !== ghostCard.id));
    } catch (e) {
      console.error('Failed to reject ghost card', e);
    }
  };

  return { ghostCards, adopt, reject };
}

/**
 * A lightweight adopt/reject candidate card — visually distinct (muted,
 * dashed border) from real task cards so it reads as "not yet a task".
 * Clicking it opens the Task Detail Panel in ghost mode (CONTEXT.md); the
 * Adopt/Reject buttons stop that click from also (re)selecting it.
 */
export function GhostCardView({
  ghostCard,
  isSelected,
  onSelect,
  onAdopt,
  onReject,
}: {
  ghostCard: GhostCard;
  isSelected: boolean;
  onSelect: () => void;
  onAdopt: () => void;
  onReject: () => void;
}) {
  return (
    <div
      data-ghost-card={ghostCard.id}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'cursor-pointer rounded-md border border-dashed border-border/70 bg-background-2/30 p-2 opacity-80',
        isSelected && 'border-primary ring-1 ring-primary/50'
      )}
    >
      <div
        className="truncate text-xs font-medium text-foreground-muted"
        title={ghostCard.issue.title}
      >
        {ghostCard.issue.title}
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <Badge variant="outline">Ghost</Badge>
        <div className="flex items-center gap-1">
          <Button
            size="xs"
            variant="outline"
            onClick={(event) => {
              event.stopPropagation();
              onAdopt();
            }}
          >
            Adopt
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={(event) => {
              event.stopPropagation();
              onReject();
            }}
          >
            Reject
          </Button>
        </div>
      </div>
    </div>
  );
}
