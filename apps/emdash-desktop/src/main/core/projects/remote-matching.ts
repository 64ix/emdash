import type { GitRemote } from '@emdash/core/git';
import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { projectRemotes } from '@main/db/schema';
import { parseRepositoryRef } from '@shared/repository-ref';

/**
 * Remote matching for project attach/auto-attach (spec #130, ticket #136).
 *
 * A repo is identified by the pair set of its live remotes: `(remoteName,
 * normalizedUrl)` pairs. Normalization follows the existing convention used
 * by `syncProjectRemotes` (parseRepositoryRef → `https://<host>/<owner>/<repo>`),
 * so `git@github.com:org/repo.git` and `https://github.com/org/repo` compare
 * equal. Matching is strict pair-set equality — the same repo cloned with the
 * same remote names on both machines.
 */

export function normalizeRemoteUrl(url: string): string {
  return parseRepositoryRef(url)?.repositoryUrl ?? url;
}

export function remotePairKey(name: string, url: string): string {
  return `${name}:${normalizeRemoteUrl(url)}`;
}

/** The (remoteName, normalizedUrl) pair set of a remote list. */
export function remotePairSet(remotes: GitRemote[]): Set<string> {
  return new Set(remotes.map((r) => remotePairKey(r.name, r.url)));
}

export function remotePairSetsMatch(a: GitRemote[], b: GitRemote[]): boolean {
  const aSet = remotePairSet(a);
  const bSet = remotePairSet(b);
  if (aSet.size === 0 || bSet.size === 0) return false;
  if (aSet.size !== bSet.size) return false;
  for (const pair of aSet) {
    if (!bSet.has(pair)) return false;
  }
  return true;
}

/**
 * The synced (portable) remotes of a project — the auto-attach hint carried
 * from the machine that created the project.
 */
export async function getProjectSyncedRemotes(projectId: string): Promise<GitRemote[]> {
  const rows = await db
    .select({ remoteName: projectRemotes.remoteName, remoteUrl: projectRemotes.remoteUrl })
    .from(projectRemotes)
    .where(eq(projectRemotes.projectId, projectId));
  return rows.map((r) => ({ name: r.remoteName, url: r.remoteUrl }));
}

/**
 * Cross-machine SSH merge key: `(host, port, username)` — NOT the connection
 * id, which is machine-local. Two connections with the same fingerprint point
 * at the same host, so a project on one of them is the same repo as a project
 * on the other when the remote path also matches.
 */
export function sshConnectionFingerprint(host: string, port: number, username: string): string {
  return `${host}:${port}:${username}`;
}
