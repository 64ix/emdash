import { KV } from '@main/db/kv';
import type { LinkSuggestion } from '@shared/core/issues/link-suggestion';

type IssuesSyncKvSchema = Record<string, LinkSuggestion[] | string[]>;

/** Cached link suggestions (per project + repository) and dismissed issue URLs — see ticket #8. */
const kv = new KV<IssuesSyncKvSchema>('issues-sync');

function suggestionsKey(projectId: string, repositoryUrl: string): string {
  return `suggestions:${projectId}:${repositoryUrl}`;
}

function dismissedKey(projectId: string, repositoryUrl: string): string {
  return `dismissed:${projectId}:${repositoryUrl}`;
}

function sortedJson(list: LinkSuggestion[]): string {
  return JSON.stringify([...list].sort((a, b) => a.id.localeCompare(b.id)));
}

export async function getCachedSuggestions(
  projectId: string,
  repositoryUrl: string
): Promise<LinkSuggestion[]> {
  return ((await kv.get(suggestionsKey(projectId, repositoryUrl))) as LinkSuggestion[]) ?? [];
}

/** Overwrites the cached suggestion snapshot only when it actually changed. Returns whether it did. */
export async function setCachedSuggestionsIfChanged(
  projectId: string,
  repositoryUrl: string,
  suggestions: LinkSuggestion[]
): Promise<boolean> {
  const existing = await getCachedSuggestions(projectId, repositoryUrl);
  if (sortedJson(existing) === sortedJson(suggestions)) return false;
  await kv.set(suggestionsKey(projectId, repositoryUrl), suggestions);
  return true;
}

export async function getDismissedIssueUrls(
  projectId: string,
  repositoryUrl: string
): Promise<Set<string>> {
  const list = ((await kv.get(dismissedKey(projectId, repositoryUrl))) as string[]) ?? [];
  return new Set(list);
}

/** Marks a suggestion dismissed so a fresh sync pass never re-surfaces it. */
export async function dismissLinkSuggestionUrl(
  projectId: string,
  repositoryUrl: string,
  issueUrl: string
): Promise<void> {
  const dismissed = await getDismissedIssueUrls(projectId, repositoryUrl);
  if (dismissed.has(issueUrl)) return;
  dismissed.add(issueUrl);
  await kv.set(dismissedKey(projectId, repositoryUrl), [...dismissed]);
}
