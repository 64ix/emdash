import { githubRepositoryResolver } from '@main/core/github/services/github-repository-resolver';
import { projectManager } from '@main/core/projects/project-manager';

/**
 * The single GitHub repository whose issues belong to a project: the one behind
 * its configured base remote, resolved exactly the way the outbound issue
 * picker resolves its repository (`withResolvedRemote` in
 * `src/main/core/issues/controller.ts`), so both surfaces always talk about the
 * same tracker.
 *
 * Deliberately *not* "every GitHub remote of the project" the way PR sync fans
 * out. In a fork checkout the `upstream` remote's tracker belongs to somebody
 * else: treating its issues as inbound facts surfaces them as Ghost Cards and
 * link suggestions on our board, which is never what a fork wants. It is also
 * expensive — the root-issue scan spends one `getParent` call per candidate
 * issue, so a second tracker doubles the API budget every cadence tick for
 * issues nobody asked for. PR sync stays multi-remote on purpose: a fork's PRs
 * can legitimately live on either remote.
 *
 * Returns null when the project isn't mounted, has no base remote, or that
 * remote isn't a reachable GitHub repository. Callers treat null as "nothing to
 * sync" rather than falling back to another remote — silently reading a
 * different tracker is the bug this function exists to prevent.
 */
export async function getIssueTrackerRepositoryUrl(projectId: string): Promise<string | null> {
  const project = projectManager.getProject(projectId);
  if (!project) return null;

  const [remotes, baseRemoteName] = await Promise.all([
    project.gitRepository.getRemotes().catch(() => []),
    project.gitRepository.getBaseRemote().catch(() => undefined),
  ]);

  const baseRemote = remotes.find((remote) => remote.name === baseRemoteName);
  if (!baseRemote) return null;

  const resolved = await githubRepositoryResolver.resolve(baseRemote.url);
  return resolved.success ? resolved.data.repositoryUrl : null;
}
