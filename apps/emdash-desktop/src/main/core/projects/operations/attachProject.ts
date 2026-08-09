import type { GitRemote } from '@emdash/core/git';
import { err, ok, type Result } from '@emdash/shared';
import { eq } from 'drizzle-orm';
import { syncProjectRemotes } from '@main/core/pull-requests/project-remotes-service';
import { runtimeManager } from '@main/core/runtime/runtime-manager';
import { db } from '@main/db/client';
import {
  automations,
  conversations,
  projectRemotes,
  projectSettings,
  projects,
  sshConnections,
  tasks,
} from '@main/db/schema';
import { log } from '@main/lib/logger';
import type {
  AttachProjectError,
  AttachProjectParams,
  AttachProjectResult,
  LocalProject,
  SshProject,
} from '@shared/projects';
import { asAttachedProject } from '@shared/projects';
import {
  getProjectSyncedRemotes,
  remotePairSetsMatch,
  sshConnectionFingerprint,
} from '../remote-matching';
import { getLocalProjectPathStatus } from './create-local-project';
import { ensureRepositoryWorkspace } from './ensure-repository-workspace';
import { getProjectById, getProjectByPathAnyType, getProjects } from './getProjects';

/**
 * Attach (re-anchor) an unattached project on this machine (spec #130, ticket
 * #136).
 *
 * - Local: sets the machine-local `path` (the unique path index is respected:
 *   a path held by another project dedupes into a merge when the repositories
 *   are the same repo). The picked directory's live remotes must match the
 *   synced project's remotes. If the repo matches an existing same-type local
 *   project, the synced row merges into it (the local row wins, one sidebar
 *   entry); if it matches BOTH a local and an SSH project, the caller must
 *   pick (ambiguity error).
 * - SSH: the remote path travels, so attaching only picks the machine-local
 *   connection. The path-index dedupe uses the (host, port, username)
 *   fingerprint + path — NOT connectionId, which is machine-local.
 *
 * Every successful attach re-runs `ensureRepositoryWorkspace` so tasks are
 * provisionable on demand after the project is attached.
 */
export async function attachProject(params: AttachProjectParams): Promise<AttachProjectResult> {
  if (params.type === 'local') return attachLocalProject(params);
  return attachSshProject(params);
}

// ---------------------------------------------------------------------------
// Local
// ---------------------------------------------------------------------------

async function attachLocalProject(
  params: Extract<AttachProjectParams, { type: 'local' }>
): Promise<AttachProjectResult> {
  const row = await getProjectById(params.projectId);
  if (!row) return err({ type: 'project-not-found', projectId: params.projectId });
  if (row.type !== 'local') return err({ type: 'already-attached' });
  if (row.path !== null) return err({ type: 'already-attached' });

  const status = await getLocalProjectPathStatus(params.path);
  if (status.error) {
    return err({ type: 'inspect-failed', path: params.path, message: status.error.message });
  }
  if (!status.isDirectory) {
    return err({ type: 'invalid-directory', path: params.path, message: 'Invalid directory' });
  }
  if (!status.isGitRepo) return err({ type: 'not-repository', path: params.path });

  const inspected = await inspectPickedRepository(params.path);
  if (!inspected.success) return inspected;
  const { rootPath, remotes: pickedRemotes } = inspected.data;

  const syncedRemotes = await getProjectSyncedRemotes(params.projectId);
  if (syncedRemotes.length > 0 && !remotePairSetsMatch(pickedRemotes, syncedRemotes)) {
    return err({ type: 'remote-mismatch', path: params.path });
  }

  const candidates = await findMergeCandidates(params.projectId, rootPath, pickedRemotes);
  if (candidates.kind === 'path-conflict') return err(candidates.error);

  const list = candidates.list;
  if (list.length > 1 && params.mergeTargetProjectId === undefined) {
    return err({ type: 'ambiguity', path: params.path, candidates: list });
  }
  if (list.length > 0) {
    const chosen =
      params.mergeTargetProjectId === undefined
        ? list[0]
        : list.find((c) => c.projectId === params.mergeTargetProjectId);
    if (chosen === undefined) {
      return err({ type: 'merge-target-invalid', projectId: params.projectId });
    }
    return mergeInto(params.projectId, chosen.projectId);
  }
  if (params.mergeTargetProjectId !== undefined) {
    return err({ type: 'merge-target-invalid', projectId: params.projectId });
  }

  // Direct attach: set the machine-local path and provision the project root.
  const attached = asAttachedProject({ ...row, path: rootPath });
  if (!attached) return err({ type: 'inspect-failed', path: params.path, message: 'No path' });
  db.transaction((tx) => {
    tx.update(projects)
      .set({ path: rootPath, updatedAt: new Date().toISOString() })
      .where(eq(projects.id, params.projectId))
      .run();
  });
  try {
    attached.repositoryWorkspaceId = ensureRepositoryWorkspace(attached);
  } catch (error) {
    log.warn('attachProject: ensureRepositoryWorkspace failed (non-fatal)', {
      projectId: params.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await syncProjectRemotes(params.projectId, pickedRemotes);

  const project = await getProjectById(params.projectId);
  return ok({ project: project as LocalProject, mergedInto: null });
}

// ---------------------------------------------------------------------------
// SSH
// ---------------------------------------------------------------------------

async function attachSshProject(
  params: Extract<AttachProjectParams, { type: 'ssh' }>
): Promise<AttachProjectResult> {
  const row = await getProjectById(params.projectId);
  if (!row) return err({ type: 'project-not-found', projectId: params.projectId });
  if (row.type !== 'ssh') return err({ type: 'already-attached' });
  if (row.connectionId !== null) return err({ type: 'already-attached' });
  if (row.path === null) return err({ type: 'remote-path-missing', projectId: params.projectId });

  const [connection] = await db
    .select({
      host: sshConnections.host,
      port: sshConnections.port,
      username: sshConnections.username,
    })
    .from(sshConnections)
    .where(eq(sshConnections.id, params.connectionId))
    .limit(1);
  if (!connection) {
    return err({ type: 'ssh-connection-not-found', connectionId: params.connectionId });
  }
  const pickedFingerprint = sshConnectionFingerprint(
    connection.host,
    connection.port,
    connection.username
  );

  // Re-attach dedupes against the unique path index: another row already holds
  // the remote path. Same type + same (host, port, username) fingerprint means
  // it is the same remote repo — merge. Anything else is a hard conflict.
  const conflicts = await getProjectByPathAnyType(row.path, params.projectId);
  let mergeTarget: SshProject | undefined;
  for (const conflict of conflicts) {
    if (conflict.type === 'local') {
      return err({
        type: 'path-conflict',
        path: row.path,
        message: `A local project already uses the path ${row.path}. Remove or re-attach it first.`,
      });
    }
    if (conflict.connectionId === null) {
      return err({
        type: 'path-conflict',
        path: row.path,
        message: 'Another unattached SSH project already holds this remote path.',
      });
    }
    const [conflictConnection] = await db
      .select({
        host: sshConnections.host,
        port: sshConnections.port,
        username: sshConnections.username,
      })
      .from(sshConnections)
      .where(eq(sshConnections.id, conflict.connectionId))
      .limit(1);
    const conflictFingerprint =
      conflictConnection === undefined
        ? null
        : sshConnectionFingerprint(
            conflictConnection.host,
            conflictConnection.port,
            conflictConnection.username
          );
    if (conflictFingerprint !== pickedFingerprint) {
      return err({
        type: 'path-conflict',
        path: row.path,
        message: `Another SSH project already uses the path ${row.path} on a different host.`,
      });
    }
    mergeTarget = conflict;
  }

  if (mergeTarget !== undefined) {
    return mergeInto(params.projectId, mergeTarget.id);
  }

  const attached = asAttachedProject({ ...row, connectionId: params.connectionId });
  if (!attached) return err({ type: 'remote-path-missing', projectId: params.projectId });
  db.transaction((tx) => {
    tx.update(projects)
      .set({ sshConnectionId: params.connectionId, updatedAt: new Date().toISOString() })
      .where(eq(projects.id, params.projectId))
      .run();
  });
  try {
    attached.repositoryWorkspaceId = ensureRepositoryWorkspace(attached);
  } catch (error) {
    log.warn('attachProject: ensureRepositoryWorkspace failed (non-fatal)', {
      projectId: params.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const project = await getProjectById(params.projectId);
  return ok({ project: project as SshProject, mergedInto: null });
}

// ---------------------------------------------------------------------------
// Merge candidate discovery
// ---------------------------------------------------------------------------

type Candidate = { projectId: string; name: string; type: 'local' | 'ssh' };

/**
 * Find existing projects the picked repository could merge into: same-type
 * local projects whose live remotes match, plus SSH projects whose synced
 * remotes match. An SSH project already holding the picked path with
 * non-matching remotes is a hard path-index conflict.
 */
async function findMergeCandidates(
  projectId: string,
  pickedPath: string,
  pickedRemotes: GitRemote[]
): Promise<
  { kind: 'ok'; list: Candidate[] } | { kind: 'path-conflict'; error: AttachProjectError }
> {
  const candidates: Candidate[] = [];
  const projectsAtPath = await getProjectByPathAnyType(pickedPath, projectId);
  for (const p of projectsAtPath) {
    if (p.type === 'ssh') {
      const synced = await getProjectSyncedRemotes(p.id);
      if (synced.length > 0 && remotePairSetsMatch(pickedRemotes, synced)) {
        candidates.push({ projectId: p.id, name: p.name, type: 'ssh' });
      } else {
        return {
          kind: 'path-conflict',
          error: {
            type: 'path-conflict',
            path: pickedPath,
            message: `The path is already used by the SSH project "${p.name}".`,
          },
        };
      }
    }
  }

  const all = await getProjects();
  for (const p of all) {
    if (p.id === projectId) continue;
    if (p.type === 'local' && p.path !== null) {
      const live = await readLiveRemotes(p.path);
      if (live.success && remotePairSetsMatch(live.data, pickedRemotes)) {
        candidates.push({ projectId: p.id, name: p.name, type: 'local' });
      }
    } else if (p.type === 'ssh' && p.connectionId !== null && p.path !== null) {
      const synced = await getProjectSyncedRemotes(p.id);
      if (synced.length > 0 && remotePairSetsMatch(synced, pickedRemotes)) {
        candidates.push({ projectId: p.id, name: p.name, type: 'ssh' });
      }
    }
  }

  // Dedupe by id (an SSH project at the picked path is listed twice otherwise).
  const byId = new Map(candidates.map((c) => [c.projectId, c]));
  return { kind: 'ok', list: Array.from(byId.values()) };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Merge the synced project into the winning local project: the local row
 * survives (one sidebar entry) and the synced row's children (tasks,
 * conversations, automations, settings) are re-parented so no data is lost.
 * The synced row is deleted — its tombstone will propagate through the sync
 * layer; cross-machine merge convergence is out of scope for ticket #136.
 */
async function mergeInto(
  syncedProjectId: string,
  targetProjectId: string
): Promise<AttachProjectResult> {
  db.transaction((tx) => {
    const [targetSettings] = tx
      .select({ projectId: projectSettings.projectId })
      .from(projectSettings)
      .where(eq(projectSettings.projectId, targetProjectId))
      .limit(1)
      .all();
    if (targetSettings !== undefined) {
      tx.delete(projectSettings).where(eq(projectSettings.projectId, syncedProjectId)).run();
    } else {
      tx.update(projectSettings)
        .set({ projectId: targetProjectId })
        .where(eq(projectSettings.projectId, syncedProjectId))
        .run();
    }
    tx.update(tasks)
      .set({ projectId: targetProjectId })
      .where(eq(tasks.projectId, syncedProjectId))
      .run();
    tx.update(conversations)
      .set({ projectId: targetProjectId })
      .where(eq(conversations.projectId, syncedProjectId))
      .run();
    tx.update(automations)
      .set({ projectId: targetProjectId })
      .where(eq(automations.projectId, syncedProjectId))
      .run();
    tx.delete(projectRemotes).where(eq(projectRemotes.projectId, syncedProjectId)).run();
    tx.delete(projects).where(eq(projects.id, syncedProjectId)).run();
  });

  const target = await getProjectById(targetProjectId);
  if (!target) {
    return err({ type: 'project-not-found', projectId: targetProjectId });
  }
  return ok({ project: target, mergedInto: targetProjectId });
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function inspectPickedRepository(
  path: string
): Promise<Result<{ rootPath: string; remotes: GitRemote[] }, AttachProjectError>> {
  const lease = await runtimeManager.acquire({ kind: 'local' });
  try {
    const ensured = await lease.value.git.ensureRepository(path, { initIfMissing: false });
    if (!ensured.success) {
      if (ensured.error.type === 'not-repository') return err({ type: 'not-repository', path });
      return err({ type: 'inspect-failed', path, message: ensured.error.message });
    }
    const repoLease = await lease.value.git.openRepository(ensured.data.rootPath);
    try {
      const { remotes } = await repoLease.value.getRemotes();
      return ok({ rootPath: ensured.data.rootPath, remotes });
    } finally {
      await repoLease.release();
    }
  } catch (error) {
    return err({
      type: 'inspect-failed',
      path,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await lease.release();
  }
}

async function readLiveRemotes(path: string): Promise<Result<GitRemote[], { message: string }>> {
  const lease = await runtimeManager.acquire({ kind: 'local' });
  try {
    const repoLease = await lease.value.git.openRepository(path);
    try {
      const { remotes } = await repoLease.value.getRemotes();
      return ok(remotes);
    } finally {
      await repoLease.release();
    }
  } catch (error) {
    return err({ message: error instanceof Error ? error.message : String(error) });
  } finally {
    await lease.release();
  }
}
