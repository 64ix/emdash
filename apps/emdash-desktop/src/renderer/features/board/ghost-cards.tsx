import { useEffect, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
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

  const adopt = async (ghostCard: GhostCard) => {
    const result = await rpc.issues.adoptGhostCard(projectId, ghostCard);
    if (result.success) {
      setGhostCards((current) => current.filter((c) => c.id !== ghostCard.id));
    }
    return result;
  };

  const reject = async (ghostCard: GhostCard) => {
    await rpc.issues.rejectGhostCard(projectId, ghostCard);
    setGhostCards((current) => current.filter((c) => c.id !== ghostCard.id));
  };

  return { ghostCards, adopt, reject };
}

/**
 * A lightweight adopt/reject candidate card — visually distinct (muted,
 * dashed border) from real task cards so it reads as "not yet a task".
 */
export function GhostCardView({
  ghostCard,
  onAdopt,
  onReject,
}: {
  ghostCard: GhostCard;
  onAdopt: () => void;
  onReject: () => void;
}) {
  return (
    <div className="rounded-md border border-dashed border-border/70 bg-background-2/30 p-2 opacity-80">
      <div
        className="truncate text-xs font-medium text-foreground-muted"
        title={ghostCard.issue.title}
      >
        {ghostCard.issue.title}
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <Badge variant="outline">Ghost</Badge>
        <div className="flex items-center gap-1">
          <Button size="xs" variant="outline" onClick={onAdopt}>
            Adopt
          </Button>
          <Button size="xs" variant="ghost" onClick={onReject}>
            Reject
          </Button>
        </div>
      </div>
    </div>
  );
}
