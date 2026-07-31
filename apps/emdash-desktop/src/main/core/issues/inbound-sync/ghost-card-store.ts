import { KV } from '@main/db/kv';
import type { GhostCard } from '@shared/core/issues/ghost-card';

type GhostCardsKvSchema = Record<string, GhostCard[] | string[]>;

/** Cached Ghost Card candidates (per project + repository) and rejected issue URLs — see ticket #9. */
const kv = new KV<GhostCardsKvSchema>('ghost-cards');

function candidatesKey(projectId: string, repositoryUrl: string): string {
  return `candidates:${projectId}:${repositoryUrl}`;
}

function rejectedKey(projectId: string, repositoryUrl: string): string {
  return `rejected:${projectId}:${repositoryUrl}`;
}

/**
 * Comparison key for change detection, excluding `issue.fetchedAt` — a fresh
 * timestamp `remoteIssueToLinkedIssue` stamps on every sync pass, which would
 * otherwise make every pass look "changed" even when the underlying GitHub
 * state (and therefore the candidate set) didn't move at all. Idempotence
 * (ticket #9) is about the ghost candidate set, not the fetch timestamp.
 */
function comparableCard(card: GhostCard): unknown {
  const { fetchedAt: _fetchedAt, ...issueWithoutFetchedAt } = card.issue;
  return { id: card.id, issue: issueWithoutFetchedAt };
}

function sortedJson(list: GhostCard[]): string {
  return JSON.stringify([...list].sort((a, b) => a.id.localeCompare(b.id)).map(comparableCard));
}

export async function getCachedGhostCards(
  projectId: string,
  repositoryUrl: string
): Promise<GhostCard[]> {
  return ((await kv.get(candidatesKey(projectId, repositoryUrl))) as GhostCard[]) ?? [];
}

/** Overwrites the cached Ghost Card snapshot only when it actually changed. Returns whether it did. */
export async function setCachedGhostCardsIfChanged(
  projectId: string,
  repositoryUrl: string,
  ghostCards: GhostCard[]
): Promise<boolean> {
  const existing = await getCachedGhostCards(projectId, repositoryUrl);
  if (sortedJson(existing) === sortedJson(ghostCards)) return false;
  await kv.set(candidatesKey(projectId, repositoryUrl), ghostCards);
  return true;
}

export async function getRejectedIssueUrls(
  projectId: string,
  repositoryUrl: string
): Promise<Set<string>> {
  const list = ((await kv.get(rejectedKey(projectId, repositoryUrl))) as string[]) ?? [];
  return new Set(list);
}

/**
 * Marks a Ghost Card rejected so a fresh sync pass never re-surfaces it — the
 * only thing persisted for a ghost before adoption (see CONTEXT.md "Ghost Card").
 */
export async function rejectGhostCardUrl(
  projectId: string,
  repositoryUrl: string,
  issueUrl: string
): Promise<void> {
  const rejected = await getRejectedIssueUrls(projectId, repositoryUrl);
  if (rejected.has(issueUrl)) return;
  rejected.add(issueUrl);
  await kv.set(rejectedKey(projectId, repositoryUrl), [...rejected]);
}
