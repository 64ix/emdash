import { and, desc, eq, ne } from 'drizzle-orm';
import { db } from '@main/db/client';
import { projects } from '@main/db/schema';
import type { LocalProject, SshProject } from '@shared/projects';

function toProjectDto(row: {
  id: string;
  name: string;
  path: string | null;
  baseRef: string | null;
  workspaceProvider: string;
  sshConnectionId: string | null;
  repositoryWorkspaceId: string | null;
  createdAt: string;
  updatedAt: string;
}): LocalProject | SshProject {
  if (row.workspaceProvider === 'local') {
    return {
      type: 'local' as const,
      id: row.id,
      name: row.name,
      path: row.path,
      baseRef: row.baseRef ?? 'main',
      repositoryWorkspaceId: row.repositoryWorkspaceId ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  return {
    type: 'ssh' as const,
    id: row.id,
    name: row.name,
    path: row.path,
    baseRef: row.baseRef ?? 'main',
    connectionId: row.sshConnectionId,
    repositoryWorkspaceId: row.repositoryWorkspaceId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getProjects(): Promise<(LocalProject | SshProject)[]> {
  const rows = await db.select().from(projects).orderBy(desc(projects.updatedAt));
  return rows.map(toProjectDto);
}

export async function getProjectById(
  projectId: string
): Promise<LocalProject | SshProject | undefined> {
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  return row ? toProjectDto(row) : undefined;
}

export async function getLocalProjectByPath(path: string): Promise<LocalProject | undefined> {
  const [row] = await db.select().from(projects).where(eq(projects.path, path)).limit(1);
  return row && row.workspaceProvider === 'local' ? (toProjectDto(row) as LocalProject) : undefined;
}

export async function getSshProjectByPath(
  path: string,
  connectionId: string
): Promise<SshProject | undefined> {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.path, path), eq(projects.sshConnectionId, connectionId)))
    .limit(1);
  return row && row.workspaceProvider === 'ssh' ? (toProjectDto(row) as SshProject) : undefined;
}

/** Every project row holding the given path (any type) — used for path-index dedupe. */
export async function getProjectByPathAnyType(
  path: string,
  excludeProjectId?: string
): Promise<(LocalProject | SshProject)[]> {
  const rows = await db
    .select()
    .from(projects)
    .where(
      excludeProjectId === undefined
        ? eq(projects.path, path)
        : and(eq(projects.path, path), ne(projects.id, excludeProjectId))
    );
  return rows.map(toProjectDto);
}
