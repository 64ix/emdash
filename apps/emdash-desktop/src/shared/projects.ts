import type { Result } from '@emdash/shared';

export type ProjectPathStatus = {
  isDirectory: boolean;
  isGitRepo: boolean;
  error?: { type: 'inspect-failed'; path: string; message: string };
};

/**
 * A project synced from another machine arrives **unattached** (spec #130,
 * ticket #136): a local project has `path === null` (the path is machine-local
 * and never travels) and an SSH project has `connectionId === null` (only the
 * connection is machine-local; the remote `path` travels). This is distinct
 * from `path-not-found`, where the row still has a path but the directory was
 * deleted.
 */
export type LocalProject = {
  type: 'local';
  id: string;
  name: string;
  /** Local directory of the repository; `null` while the project is unattached on this machine. */
  path: string | null;
  baseRef: string;
  /** The workspace ID of this project's repository-root workspace. Set on first mount. */
  repositoryWorkspaceId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SshProject = {
  type: 'ssh';
  id: string;
  name: string;
  /** Remote directory of the repository; travels across machines. `null` only for pre-136 rows. */
  path: string | null;
  baseRef: string;
  /** Machine-local connection id; `null` while the project is unattached on this machine. */
  connectionId: string | null;
  /** The workspace ID of this project's repository-root workspace. Set on first mount. */
  repositoryWorkspaceId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Project = LocalProject | SshProject;

/** A project with a concrete local anchor: path (and connection for SSH) set. */
export type AttachedLocalProject = LocalProject & { path: string };

export type AttachedSshProject = SshProject & { path: string; connectionId: string };

export type AttachedProject = AttachedLocalProject | AttachedSshProject;

/** Whether the project is unattached on this machine (no local anchor). */
export function isUnattachedProjectData(project: Project): boolean {
  return project.type === 'local' ? project.path === null : project.connectionId === null;
}

/** Narrow to the attached form, or `null` when the project is unattached. */
export function asAttachedProject(project: Project): AttachedProject | null {
  if (project.type === 'local') {
    return project.path === null ? null : (project as AttachedLocalProject);
  }
  return project.path === null || project.connectionId === null
    ? null
    : (project as AttachedSshProject);
}

export type CreateLocalProjectParams = {
  type: 'local';
  id?: string;
  path: string;
  name: string;
  initGitRepository?: boolean;
};

export type CreateSshProjectParams = {
  type: 'ssh';
  id?: string;
  name: string;
  path: string;
  connectionId: string;
  initGitRepository?: boolean;
};

export type CreateProjectParams = CreateLocalProjectParams | CreateSshProjectParams;

export type CreateProjectError =
  | { type: 'invalid-directory'; path: string; message: string }
  | { type: 'not-repository'; path: string }
  | { type: 'inspect-failed'; path: string; message: string }
  | { type: 'init-failed'; path: string; message: string }
  | { type: 'open-repository-failed'; path: string; message: string };

export type CreateProjectResult = Result<Project, CreateProjectError>;

export type InspectLocalProjectPathParams = {
  type: 'local';
  path: string;
};

export type InspectSshProjectPathParams = {
  type: 'ssh';
  path: string;
  connectionId: string;
};

export type InspectProjectPathParams = InspectLocalProjectPathParams | InspectSshProjectPathParams;

export type ProjectPathInspection = ProjectPathStatus & {
  existingProject?: Project;
};

export type OpenProjectError =
  | { type: 'path-not-found'; path: string }
  | { type: 'ssh-disconnected'; connectionId: string }
  | { type: 'unattached' }
  | { type: 'error'; message: string };

export type OpenProjectSuccess = {
  repositoryWorkspaceId: string | null;
};

export type AttachLocalProjectParams = {
  type: 'local';
  projectId: string;
  path: string;
  /**
   * Resolves a local/SSH ambiguity: merge into this specific project instead
   * of asking again. Must be one of the candidates the previous call reported.
   */
  mergeTargetProjectId?: string;
};

export type AttachSshProjectParams = {
  type: 'ssh';
  projectId: string;
  connectionId: string;
};

export type AttachProjectParams = AttachLocalProjectParams | AttachSshProjectParams;

export type AttachProjectError =
  | { type: 'project-not-found'; projectId: string }
  | { type: 'already-attached' }
  | { type: 'invalid-directory'; path: string; message: string }
  | { type: 'not-repository'; path: string }
  | { type: 'inspect-failed'; path: string; message: string }
  /** The picked repository's remotes do not match the synced project's remotes. */
  | { type: 'remote-mismatch'; path: string }
  /** The path (or SSH remote path) is already held by another, non-mergeable project. */
  | { type: 'path-conflict'; path: string; message: string }
  | { type: 'ssh-connection-not-found'; connectionId: string }
  /** The synced SSH project carries no remote path (pre-136 row); cannot attach. */
  | { type: 'remote-path-missing'; projectId: string }
  /** The merge target given for an ambiguity was not among the reported candidates. */
  | { type: 'merge-target-invalid'; projectId: string }
  /** Both a local and an SSH project match the picked repository; pick one. */
  | {
      type: 'ambiguity';
      path: string;
      candidates: Array<{ projectId: string; name: string; type: 'local' | 'ssh' }>;
    };

export type AttachProjectSuccess = {
  /** The surviving project row (the attached project, or the local winner after a merge). */
  project: LocalProject | SshProject;
  /** Id of the project the synced row was merged into, when a merge happened. */
  mergedInto: string | null;
};

export type AttachProjectResult = Result<AttachProjectSuccess, AttachProjectError>;

export type UpdateProjectSettingsError =
  | { type: 'project-not-found' }
  | { type: 'invalid-settings' }
  | { type: 'invalid-worktree-directory' }
  | { type: 'write-config-failed'; message: string }
  | { type: 'error' };

export type ProjectRemoteState = {
  hasRemote: boolean;
  selectedRemoteUrl: string | null;
};
