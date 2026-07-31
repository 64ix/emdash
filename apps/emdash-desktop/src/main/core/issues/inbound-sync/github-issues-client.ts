import { err, ok, type Result } from '@emdash/shared';
import type { Octokit } from '@octokit/rest';
import type { GitHubApiAuthError } from '@main/core/github/services/github-api-auth-errors';
import type { GitHubApiAuthContext } from '@main/core/github/services/github-api-auth-service';
import { getOctokit } from '@main/core/github/services/octokit-provider';
import { githubRateLimiter } from '@main/lib/rate-limiter';
import { withRetry } from '@main/lib/retry';
import type { RepositoryRef } from '@shared/repository-ref';

/** Only what the inbound issues sync needs to know about a fetched GitHub issue. */
export type RemoteIssue = {
  number: number;
  url: string;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  updatedAt: string;
};

/**
 * The GitHub read surface the inbound issues sync depends on. Kept narrow and
 * separate from the outbound issue-picker provider (`src/main/core/issues/`)
 * because that provider only lists *open* issues and doesn't expose labels or
 * body content — both of which this sync needs.
 */
export interface GitHubIssuesClient {
  /** Fetches one issue by number, refreshing the state of an already-linked Spec/Map issue. Null when not found. */
  getIssue(repo: RepositoryRef, number: number): Promise<RemoteIssue | null>;
  /** Lists Map-shaped issues (open + closed) via the `wayfinder:map` label. */
  listMapIssues(repo: RepositoryRef): Promise<RemoteIssue[]>;
  /** Lists Spec-shaped candidate issues (open + closed) via a title search for `[Spec]`. */
  listSpecIssues(repo: RepositoryRef): Promise<RemoteIssue[]>;
  /**
   * Lists open issues that are not sub-issues of another issue (Ghost Card
   * candidates — ticket #9). Shape filtering (not `[Spec]`, not
   * `wayfinder:*`, no Task Marker) and "already linked to a task" exclusion
   * happen in `IssuesSyncEngine`, not here.
   */
  listOpenRootIssues(repo: RepositoryRef): Promise<RemoteIssue[]>;
}

const PER_PAGE = 100;

function toRemoteIssue(issue: {
  number: number;
  html_url: string;
  title: string;
  body?: string | null;
  state: string;
  labels: Array<string | { name?: string }>;
  updated_at: string;
}): RemoteIssue {
  return {
    number: issue.number,
    url: issue.html_url,
    title: issue.title,
    body: issue.body ?? null,
    state: issue.state === 'closed' ? 'closed' : 'open',
    labels: issue.labels.map((label) => (typeof label === 'string' ? label : (label.name ?? ''))),
    updatedAt: issue.updated_at,
  };
}

/**
 * Whether an issue is itself a sub-issue of another (has a parent) via the
 * REST "sub-issues" feature (ticket #9's root-issue filter). Defensive: any
 * error other than "no parent" (404) is treated as "no parent" too, since
 * older GitHub Enterprise instances or reduced-scope tokens may not expose
 * this endpoint at all — a lookup failure shouldn't block the whole sync pass.
 */
async function hasParentIssue(
  octokit: Octokit,
  repo: RepositoryRef,
  issueNumber: number
): Promise<boolean> {
  try {
    await withRetry(() =>
      githubRateLimiter.acquire().then(() =>
        octokit.rest.issues.getParent({
          owner: repo.owner,
          repo: repo.repo,
          issue_number: issueNumber,
        })
      )
    );
    return true;
  } catch {
    return false;
  }
}

function createClientFromOctokit(octokit: Octokit): GitHubIssuesClient {
  return {
    async getIssue(repo, number) {
      try {
        const { data } = await withRetry(() =>
          githubRateLimiter
            .acquire()
            .then(() =>
              octokit.rest.issues.get({ owner: repo.owner, repo: repo.repo, issue_number: number })
            )
        );
        if ('pull_request' in data && data.pull_request) return null;
        return toRemoteIssue(data);
      } catch (error) {
        if ((error as { status?: number })?.status === 404) return null;
        throw error;
      }
    },

    async listMapIssues(repo) {
      const { data } = await withRetry(() =>
        githubRateLimiter.acquire().then(() =>
          octokit.rest.issues.listForRepo({
            owner: repo.owner,
            repo: repo.repo,
            state: 'all',
            labels: 'wayfinder:map',
            per_page: PER_PAGE,
          })
        )
      );
      return data.filter((issue) => !issue.pull_request).map(toRemoteIssue);
    },

    async listSpecIssues(repo) {
      const { data } = await withRetry(() =>
        githubRateLimiter.acquire().then(() =>
          octokit.rest.search.issuesAndPullRequests({
            q: `"[Spec]" in:title repo:${repo.nameWithOwner} is:issue`,
            per_page: PER_PAGE,
          })
        )
      );
      return data.items
        .filter((issue) => !issue.pull_request)
        .map(toRemoteIssue)
        .filter((issue) => issue.title.trimStart().startsWith('[Spec]'));
    },

    async listOpenRootIssues(repo) {
      const { data } = await withRetry(() =>
        githubRateLimiter.acquire().then(() =>
          octokit.rest.issues.listForRepo({
            owner: repo.owner,
            repo: repo.repo,
            state: 'open',
            per_page: PER_PAGE,
          })
        )
      );
      const candidates = data.filter((issue) => !issue.pull_request).map(toRemoteIssue);

      const rootIssues: RemoteIssue[] = [];
      for (const issue of candidates) {
        if (!(await hasParentIssue(octokit, repo, issue.number))) rootIssues.push(issue);
      }
      return rootIssues;
    },
  };
}

/** Resolves an authenticated `GitHubIssuesClient` for a host, mirroring `PrSyncEngine`'s Octokit resolution pattern. */
export async function getGitHubIssuesClient(
  host: string,
  authContext: GitHubApiAuthContext = {}
): Promise<Result<GitHubIssuesClient, GitHubApiAuthError>> {
  const octokit = await getOctokit(host, authContext);
  if (!octokit.success) return err(octokit.error);
  return ok(createClientFromOctokit(octokit.data));
}
