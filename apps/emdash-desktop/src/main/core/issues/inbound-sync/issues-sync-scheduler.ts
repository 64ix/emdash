import type { IDisposable, IInitializable } from '@emdash/shared';
import { githubRepositoryResolver } from '@main/core/github/services/github-repository-resolver';
import { resolveProjectGitHubAuthContext } from '@main/core/github/services/project-github-auth-context';
import { projectManager } from '@main/core/projects/project-manager';
import { syncProjectRemotes } from '@main/core/pull-requests/project-remotes-service';
import { log } from '@main/lib/logger';
import { issuesSyncEngine } from './issues-sync-engine';

/** Mirrors the existing per-project PR-sync polling cadence (see `PrSyncScheduler`). */
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Wires the inbound issues sync (ticket #8) to application lifecycle events,
 * mirroring `PrSyncScheduler`'s mount/unmount/interval pattern rather than
 * extending it directly, so the two sync domains stay independently
 * schedulable. `syncNow` additionally lets the renderer trigger a pass when
 * the Feature Board opens, on top of the periodic cadence.
 */
export class IssuesSyncScheduler implements IInitializable, IDisposable {
  private readonly _intervals = new Map<string, ReturnType<typeof setInterval>>();
  private readonly _projectRemoteUrls = new Map<string, string[]>();
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
    const remoteUrls = await this._syncAndGetGitHubRemotes(projectId);
    this._projectRemoteUrls.set(projectId, remoteUrls);
    if (remoteUrls.length === 0) return;

    await this._syncRemotes(projectId, remoteUrls);
    this._clearInterval(projectId);
    const handle = setInterval(() => {
      void this._syncRemotes(projectId, remoteUrls);
    }, SYNC_INTERVAL_MS);
    this._intervals.set(projectId, handle);
  }

  onProjectUnmounted(projectId: string): void {
    this._clearInterval(projectId);
    this._projectRemoteUrls.delete(projectId);
  }

  /** Triggered when the renderer opens the Feature Board for a project — additive to the periodic cadence. */
  async syncNow(projectId: string): Promise<void> {
    const remoteUrls =
      this._projectRemoteUrls.get(projectId) ?? (await this._syncAndGetGitHubRemotes(projectId));
    await this._syncRemotes(projectId, remoteUrls);
  }

  private _clearInterval(projectId: string): void {
    const handle = this._intervals.get(projectId);
    if (handle) clearInterval(handle);
    this._intervals.delete(projectId);
  }

  private async _syncRemotes(projectId: string, remoteUrls: string[]): Promise<void> {
    for (const remoteUrl of remoteUrls) {
      await this._syncRemote(projectId, remoteUrl);
    }
  }

  private async _syncRemote(projectId: string, remoteUrl: string): Promise<void> {
    const authContext = await resolveProjectGitHubAuthContext(projectId);
    if (!authContext.success) {
      log.warn('IssuesSyncScheduler: failed to resolve project GitHub account context', {
        projectId,
        remoteUrl,
        error: authContext.error.message,
      });
      return;
    }

    const result = await issuesSyncEngine.sync(projectId, remoteUrl, authContext.data);
    if (!result.success) {
      log.warn('IssuesSyncScheduler: sync failed', {
        projectId,
        remoteUrl,
        error: result.error,
      });
    }
  }

  private async _syncAndGetGitHubRemotes(projectId: string): Promise<string[]> {
    const project = projectManager.getProject(projectId);
    if (!project) return [];

    try {
      const remotes = await project.gitRepository.getRemotes();
      await syncProjectRemotes(projectId, remotes);
      const resolved = await Promise.all(
        remotes.map((r) => githubRepositoryResolver.resolve(r.url))
      );
      return resolved.flatMap((repository) =>
        repository.success ? [repository.data.repositoryUrl] : []
      );
    } catch (e) {
      log.warn('IssuesSyncScheduler: failed to sync project remotes', {
        projectId,
        error: String(e),
      });
      return [];
    }
  }
}

export const issuesSyncScheduler = new IssuesSyncScheduler();
