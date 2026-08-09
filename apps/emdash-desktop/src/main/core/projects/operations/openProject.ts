import { err, ok, type Result } from '@emdash/shared';
import { projectManager } from '@main/core/projects/project-manager';
import { log } from '@main/lib/logger';
import type { OpenProjectError, OpenProjectSuccess } from '@shared/projects';
import { asAttachedProject } from '@shared/projects';
import { checkIsValidDirectory } from '../path-utils';
import { ensureRepositoryWorkspace } from './ensure-repository-workspace';
import { getProjectById } from './getProjects';

export async function openProject(
  projectId: string
): Promise<Result<OpenProjectSuccess, OpenProjectError>> {
  const project = await getProjectById(projectId);
  if (!project) return err({ type: 'error', message: `Project not found: ${projectId}` });
  // An unattached project (no local path / no SSH connection on this machine)
  // cannot be opened — surface the distinct state instead of path-not-found.
  const attached = asAttachedProject(project);
  if (!attached) return err({ type: 'unattached' });
  if (attached.type === 'local' && !checkIsValidDirectory(attached.path)) {
    return err({ type: 'path-not-found', path: attached.path });
  }
  const result = await projectManager.openProject(attached);
  if (!result.success) {
    if (attached.type === 'ssh') {
      return err({ type: 'ssh-disconnected', connectionId: attached.connectionId });
    }
    return err({ type: 'error', message: result.error.message });
  }

  // Ensure the project has a shared repository-root workspace row.
  // This is idempotent and handles both new projects and pre-migration rows.
  let repositoryWorkspaceId: string | null = null;
  try {
    repositoryWorkspaceId = ensureRepositoryWorkspace(attached);
  } catch (error) {
    log.warn('openProject: ensureRepositoryWorkspace failed (non-fatal)', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return ok({ repositoryWorkspaceId });
}
