import fs from 'node:fs';
import path from 'node:path';
import type { GitRemote } from '@emdash/core/git';
import { runtimeManager } from '@main/core/runtime/runtime-manager';
import { appSettingsService } from '@main/core/settings/settings-service';
import { log } from '@main/lib/logger';
import type { AttachProjectResult } from '@shared/projects';
import { attachProject } from './operations/attachProject';
import { getProjectSyncedRemotes, remotePairSetsMatch } from './remote-matching';

/**
 * Auto-attach (spec #130, ticket #136): when a synced local project arrives on
 * this machine with no local path, scan the machine's default projects
 * directory for a repo whose live remotes match the project's carried remotes
 * and attach silently. Otherwise the project stays Unattached and the user
 * attaches manually.
 *
 * The service is deliberately injectable (scanner + attach operation) so the
 * matching logic stays deterministic and hermetic in tests.
 */

export type AutoAttachResult =
  | { kind: 'attached'; projectId: string; path: string }
  | { kind: 'merged'; projectId: string; targetProjectId: string }
  | { kind: 'not-local-project' }
  | { kind: 'unattached' };

export interface RepoScanner {
  /** Direct child directories of the projects directory (repo candidates). */
  listDirectories(directory: string): Promise<string[]>;
  /** Live remotes of a candidate repo directory (empty when not a repo). */
  readRemotes(repoPath: string): Promise<GitRemote[]>;
}

export type ProjectAutoAttachServiceDeps = {
  getDefaultProjectsDirectory: () => Promise<string | null>;
  scanner: RepoScanner;
  attachLocal: (projectId: string, path: string) => Promise<AttachProjectResult>;
};

export class ProjectAutoAttachService {
  constructor(private readonly deps: ProjectAutoAttachServiceDeps) {}

  /**
   * Attempt to silently anchor a freshly imported project. Only local
   * projects participate (SSH projects re-attach by picking a connection —
   * a user decision). Returns `unattached` when there is no match, when the
   * match is ambiguous (local/SSH both match — a user decision), or when the
   * scan is not possible.
   */
  async attemptAttach(
    projectId: string,
    workspaceProvider: string | null
  ): Promise<AutoAttachResult> {
    if (workspaceProvider !== 'local') return { kind: 'not-local-project' };

    const syncedRemotes = await getProjectSyncedRemotes(projectId);
    if (syncedRemotes.length === 0) return { kind: 'unattached' };

    const directory = await this.deps.getDefaultProjectsDirectory();
    if (!directory) return { kind: 'unattached' };

    const entries = await this.deps.scanner.listDirectories(directory);
    // Deterministic: scan in sorted order, first match wins.
    entries.sort();
    for (const entry of entries) {
      const live = await this.deps.scanner.readRemotes(entry);
      if (!remotePairSetsMatch(live, syncedRemotes)) continue;

      const result = await this.deps.attachLocal(projectId, entry);
      if (result.success) {
        if (result.data.mergedInto !== null) {
          return { kind: 'merged', projectId, targetProjectId: result.data.mergedInto };
        }
        return { kind: 'attached', projectId, path: entry };
      }
      // An ambiguity needs the user; any other attach failure just means this
      // candidate did not attach — keep scanning for a better one.
      if (result.error.type === 'ambiguity') return { kind: 'unattached' };
    }
    return { kind: 'unattached' };
  }
}

/**
 * Production scanner: direct children of the default projects directory, read
 * through the local git runtime. Non-repo directories yield empty remote sets
 * and are skipped by the matcher.
 */
export function createDefaultRepoScanner(): RepoScanner {
  return {
    async listDirectories(directory) {
      try {
        const entries = await fs.promises.readdir(directory, { withFileTypes: true });
        return entries
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
          .map((entry) => path.join(directory, entry.name));
      } catch {
        return [];
      }
    },
    async readRemotes(repoPath) {
      try {
        const lease = await runtimeManager.acquire({ kind: 'local' });
        try {
          const repoLease = await lease.value.git.openRepository(repoPath);
          try {
            const { remotes } = await repoLease.value.getRemotes();
            return remotes;
          } finally {
            await repoLease.release();
          }
        } catch {
          return [];
        } finally {
          await lease.release();
        }
      } catch {
        return [];
      }
    },
  };
}

/**
 * The engine's `projectAttachHook` (SyncEngineOptions): fires after a pull
 * that freshly imported project rows. The app passes this to the engine when
 * it wires the SyncEngine into startup (ticket #137).
 */
export function createProjectAutoAttachHook(): (
  projectId: string,
  workspaceProvider: string | null
) => Promise<void> {
  const service = new ProjectAutoAttachService({
    getDefaultProjectsDirectory: async () => {
      const settings = await appSettingsService.get('localProject');
      return settings.defaultProjectsDirectory || null;
    },
    scanner: createDefaultRepoScanner(),
    attachLocal: async (projectId, projectPath) =>
      attachProject({ type: 'local', projectId, path: projectPath }),
  });
  return async (projectId, workspaceProvider) => {
    const result = await service.attemptAttach(projectId, workspaceProvider);
    if (result.kind === 'attached' || result.kind === 'merged') {
      log.info('[auto-attach] project anchored on this machine', result);
    }
  };
}
