import type { IDisposable, IInitializable } from '@emdash/shared';
import { resolveProjectGitHubAuthContext } from '@main/core/github/services/project-github-auth-context';
import { projectManager } from '@main/core/projects/project-manager';
import { syncProjectRemotes } from '@main/core/pull-requests/project-remotes-service';
import { log } from '@main/lib/logger';
import { getIssueTrackerRepositoryUrl } from './issue-tracker-repository';
import { issuesSyncEngine } from './issues-sync-engine';

/** Mirrors the existing per-project PR-sync polling cadence (see `PrSyncScheduler`). */
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Wires the inbound issues sync (ticket #8) to application lifecycle events,
 * mirroring `PrSyncScheduler`'s mount/unmount/interval pattern rather than
 * extending it directly, so the two sync domains stay independently
 * schedulable. `syncNow` additionally lets the renderer trigger a pass when
 * the Feature Board opens, on top of the periodic cadence.
 *
 * Unlike `PrSyncScheduler` it syncs exactly one repository — the project's
 * issue tracker, see `getIssueTrackerRepositoryUrl` — never the full remote
 * list. Fanning out over every remote would pull a fork's upstream issues onto
 * the board as Ghost Cards and link suggestions.
 */
export class IssuesSyncScheduler implements IInitializable, IDisposable {
  private readonly _intervals = new Map<string, ReturnType<typeof setInterval>>();
  private readonly _projectRepositoryUrls = new Map<string, string | null>();
  private _unsubscribes: Array<() => void> = [];

  initialize(): void {
    this._unsubscribes = [
      projectManager.on('projectOpened', (id) => void this.onProjectMounted(id)),
      projectManager.on('projectClosed', (id) => this.onProjectUnmounted(id)),
    ];
  }

  dispose(): void {
    for (const unsub of this._unsubscribes) unsub();
    this._unsubscribes = [];
    for (const projectId of this._intervals.keys()) this.onProjectUnmounted(projectId);
  }

  async onProjectMounted(projectId: string): Promise<void> {
    const repositoryUrl = await this._resolveIssueTrackerRepository(projectId);
    this._projectRepositoryUrls.set(projectId, repositoryUrl);
    await this._syncRepository(projectId, repositoryUrl);

    // The interval re-resolves the tracker on every tick — a remote added,
    // removed or re-pointed while the project stays mounted must be picked up
    // without a remount. Installed even when no GitHub tracker resolved yet,
    // for the same reason.
    this._clearInterval(projectId);
    const handle = setInterval(() => {
      void this._refreshRepositoryAndSync(projectId);
    }, SYNC_INTERVAL_MS);
    this._intervals.set(projectId, handle);
  }

  onProjectUnmounted(projectId: string): void {
    this._clearInterval(projectId);
    this._projectRepositoryUrls.delete(projectId);
  }

  /** Triggered when the renderer opens the Feature Board for a project — additive to the periodic cadence. */
  async syncNow(projectId: string): Promise<void> {
    // A cached null is not proof of "no GitHub tracker" (the project may have
    // gained or re-pointed its base remote since mount) — re-resolve in that
    // case too.
    const cached = this._projectRepositoryUrls.get(projectId);
    if (cached) {
      await this._syncRepository(projectId, cached);
      return;
    }
    await this._refreshRepositoryAndSync(projectId);
  }

  private async _refreshRepositoryAndSync(projectId: string): Promise<void> {
    const repositoryUrl = await this._resolveIssueTrackerRepository(projectId);
    this._projectRepositoryUrls.set(projectId, repositoryUrl);
    await this._syncRepository(projectId, repositoryUrl);
  }

  private _clearInterval(projectId: string): void {
    const handle = this._intervals.get(projectId);
    if (handle) clearInterval(handle);
    this._intervals.delete(projectId);
  }

  /**
   * Refreshes the shared `project_remotes` bookkeeping (other consumers, PR
   * sync included, read the full remote list from it) and resolves the one
   * repository this sync reads issues from.
   */
  private async _resolveIssueTrackerRepository(projectId: string): Promise<string | null> {
    const project = projectManager.getProject(projectId);
    if (!project) return null;

    try {
      const remotes = await project.gitRepository.getRemotes();
      await syncProjectRemotes(projectId, remotes);
    } catch (e) {
      // Bookkeeping only — a stale `project_remotes` table must not stop the
      // tracker resolution below, which reads the live git remotes anyway.
      log.warn('IssuesSyncScheduler: failed to sync project remotes', {
        projectId,
        error: String(e),
      });
    }

    return getIssueTrackerRepositoryUrl(projectId);
  }

  private async _syncRepository(projectId: string, repositoryUrl: string | null): Promise<void> {
    if (!repositoryUrl) return;

    const authContext = await resolveProjectGitHubAuthContext(projectId);
    if (!authContext.success) {
      log.warn('IssuesSyncScheduler: failed to resolve project GitHub account context', {
        projectId,
        repositoryUrl,
        error: authContext.error.message,
      });
      return;
    }

    const result = await issuesSyncEngine.sync(projectId, repositoryUrl, authContext.data);
    if (!result.success) {
      log.warn('IssuesSyncScheduler: sync failed', {
        projectId,
        repositoryUrl,
        error: result.error,
      });
    }
  }
}

export const issuesSyncScheduler = new IssuesSyncScheduler();
