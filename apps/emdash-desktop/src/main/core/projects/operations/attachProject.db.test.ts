/**
 * Attach operation tests (spec #130, ticket #136): re-anchoring an unattached
 * synced project on this machine — direct attach, merge into an existing
 * same-type project, local/SSH ambiguity, path-index dedupe, SSH connection
 * re-attach with the (host, port, username) fingerprint, and workspace
 * provisioning after attach.
 *
 * The git layer (runtimeManager) is mocked per-path; the DB is a real
 * migrated SQLite fixture.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GitRemote, GitPathInspection } from '@emdash/core/git';
import { ok, type Result } from '@emdash/shared';
import { openFixture, type FixtureDb } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  automations,
  conversations,
  projectRemotes,
  projects,
  projectSettings,
  sshConnections,
  tasks,
  workspaces,
} from '@main/db/schema';
import { attachProject } from './attachProject';

const mocks = vi.hoisted(() => ({
  acquireMock: vi.fn(),
  ensureRepositoryMock: vi.fn(),
  inspectPathMock: vi.fn(),
  openRepositoryMock: vi.fn(),
  getRemotesMock: vi.fn(),
  statMock: vi.fn(),
  releaseMock: vi.fn(),
  db: undefined as Awaited<ReturnType<typeof openFixture>>['db'] | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

vi.mock('@main/core/runtime/runtime-manager', () => ({
  runtimeManager: {
    acquire: mocks.acquireMock,
  },
}));

vi.mock('@main/core/projects/project-manager', () => ({
  projectManager: {
    openProject: vi.fn().mockResolvedValue({ success: true, data: {} }),
    getProject: vi.fn(),
  },
}));

type Lease = {
  value: {
    files: {
      path: { isAbsolute: () => boolean };
      fileSystem: () => Result<{ stat: unknown }, never>;
    };
    git: {
      ensureRepository: unknown;
      inspectPath: unknown;
      openRepository: unknown;
    };
  };
  release: () => Promise<void>;
};

function makeLease(): Lease {
  return {
    value: {
      files: {
        path: { isAbsolute: () => true },
        fileSystem: () => ok({ stat: mocks.statMock }),
      },
      git: {
        ensureRepository: mocks.ensureRepositoryMock,
        inspectPath: mocks.inspectPathMock,
        openRepository: mocks.openRepositoryMock,
      },
    },
    release: mocks.releaseMock,
  };
}

function expectOk<T, E>(result: Result<T, E>): T {
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(`Expected success, got ${JSON.stringify(result.error)}`);
  return result.data;
}

describe('attachProject (spec #130, ticket #136)', () => {
  let fixture: FixtureDb;
  const tempDirs: string[] = [];

  const remotesByPath = new Map<string, GitRemote[]>();
  const inspectByPath = new Map<string, GitPathInspection>();

  function pickedDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emdash-attach-'));
    tempDirs.push(dir);
    return dir;
  }

  function seedSyncedLocalProject(overrides: Record<string, unknown> = {}) {
    return fixture.db.insert(projects).values({
      id: 'synced-local',
      name: 'Synced Repo',
      path: null,
      workspaceProvider: 'local',
      baseRef: 'main',
      ...overrides,
    });
  }

  function seedSyncedSshProject(overrides: Record<string, unknown> = {}) {
    return fixture.db.insert(projects).values({
      id: 'synced-ssh',
      name: 'Synced SSH Repo',
      path: '/remote/repo',
      workspaceProvider: 'ssh',
      baseRef: 'main',
      sshConnectionId: null,
      ...overrides,
    });
  }

  function seedRemote(projectId: string, name: string, url: string) {
    return fixture.db
      .insert(projectRemotes)
      .values({ projectId, remoteName: name, remoteUrl: url });
  }

  function seedConnection(id: string, host: string, username: string, port = 22) {
    return fixture.db.insert(sshConnections).values({
      id,
      name: id,
      host,
      username,
      port,
      authType: 'agent',
    });
  }

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    remotesByPath.clear();
    inspectByPath.clear();
    vi.clearAllMocks();

    mocks.acquireMock.mockImplementation(async () => makeLease());
    mocks.ensureRepositoryMock.mockImplementation(async (p: string) =>
      ok({ kind: 'repository', rootPath: p, baseRef: 'main' })
    );
    mocks.inspectPathMock.mockImplementation(async (p: string) => {
      const custom = inspectByPath.get(p);
      if (custom) return custom;
      return { kind: 'repository', rootPath: p, baseRef: 'main' };
    });
    mocks.openRepositoryMock.mockImplementation(async (p: string) => ({
      value: {
        getRemotes: async () => ({ remotes: remotesByPath.get(p) ?? [] }),
      },
      release: mocks.releaseMock,
    }));
    mocks.statMock.mockResolvedValue(ok({ path: 'repo', type: 'directory' }));
    mocks.releaseMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    fixture?.close();
    mocks.db = undefined;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('local attach', () => {
    it('attaches directly to a free path, provisions the project-root workspace, and syncs live remotes', async () => {
      const dir = pickedDir();
      await seedSyncedLocalProject();
      await seedRemote('synced-local', 'origin', 'https://github.com/org/repo');
      remotesByPath.set(dir, [{ name: 'origin', url: 'git@github.com:org/repo.git' }]);

      const result = expectOk(
        await attachProject({ type: 'local', projectId: 'synced-local', path: dir })
      );

      expect(result.mergedInto).toBeNull();
      expect(result.project).toMatchObject({ type: 'local', id: 'synced-local', path: dir });
      const [row] = await fixture.db.select().from(projects).where(eq(projects.id, 'synced-local'));
      expect(row.path).toBe(dir);
      // Provisioning enabler: the project-root workspace exists and is linked.
      expect(row.repositoryWorkspaceId).not.toBeNull();
      if (row.repositoryWorkspaceId === null) return;
      const [ws] = await fixture.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, row.repositoryWorkspaceId));
      expect(ws.kind).toBe('project-root');
      expect(ws.path).toBe(dir);
      // Live remotes replaced the carried hint with the machine's normalized set.
      const [remote] = await fixture.db
        .select()
        .from(projectRemotes)
        .where(eq(projectRemotes.projectId, 'synced-local'));
      expect(remote.remoteUrl).toBe('https://github.com/org/repo');
    });

    it('rejects a picked repository whose remotes do not match the synced project', async () => {
      const dir = pickedDir();
      await seedSyncedLocalProject();
      await seedRemote('synced-local', 'origin', 'https://github.com/org/repo');
      remotesByPath.set(dir, [{ name: 'origin', url: 'https://github.com/other/repo' }]);

      const result = await attachProject({ type: 'local', projectId: 'synced-local', path: dir });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.type).toBe('remote-mismatch');
      const [row] = await fixture.db.select().from(projects).where(eq(projects.id, 'synced-local'));
      expect(row.path).toBeNull();
    });

    it('rejects paths that are not git repositories', async () => {
      const dir = pickedDir();
      await seedSyncedLocalProject();
      inspectByPath.set(dir, { kind: 'not-repository', path: dir });

      const result = await attachProject({ type: 'local', projectId: 'synced-local', path: dir });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.type).toBe('not-repository');
    });

    it('refuses an already-attached project', async () => {
      await seedSyncedLocalProject({ path: '/already/set' });
      const result = await attachProject({
        type: 'local',
        projectId: 'synced-local',
        path: '/already/set',
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.type).toBe('already-attached');
    });
  });

  describe('merge at attach', () => {
    it('merges into an existing same-type project at the picked path: one row, local wins, tasks re-parented', async () => {
      const dir = pickedDir();
      await seedSyncedLocalProject();
      await seedRemote('synced-local', 'origin', 'https://github.com/org/repo');
      await fixture.db.insert(projects).values({
        id: 'local-winner',
        name: 'Local Repo',
        path: dir,
        workspaceProvider: 'local',
        baseRef: 'main',
      });
      await fixture.db.insert(projectSettings).values({
        projectId: 'synced-local',
        baseProjectSettingsJson: '{}',
        shareableProjectSettingsJson: '{}',
      });
      await fixture.db.insert(projectSettings).values({
        projectId: 'local-winner',
        baseProjectSettingsJson: '{"defaultBranch":"main"}',
        shareableProjectSettingsJson: '{}',
      });
      await fixture.db.insert(tasks).values({
        id: 'task-1',
        projectId: 'synced-local',
        name: 'Fix bug',
        status: 'todo',
      });
      await fixture.db.insert(conversations).values({
        id: 'conv-1',
        projectId: 'synced-local',
        taskId: 'task-1',
        title: 'Synced conversation',
      });
      await fixture.db.insert(automations).values({
        id: 'automation-1',
        projectId: 'synced-local',
        name: 'Synced automation',
        triggerConfig: { kind: 'interval', minutes: 5 } as never,
        conversationConfig: {} as never,
        taskConfig: {} as never,
        enabled: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      remotesByPath.set(dir, [{ name: 'origin', url: 'git@github.com:org/repo.git' }]);

      const result = expectOk(
        await attachProject({ type: 'local', projectId: 'synced-local', path: dir })
      );

      expect(result.mergedInto).toBe('local-winner');
      expect(result.project.id).toBe('local-winner');
      // One row left; the local row wins.
      const rows = await fixture.db.select().from(projects);
      expect(rows.map((r) => r.id)).toEqual(['local-winner']);
      // The synced row's children travelled with it.
      const [task] = await fixture.db.select().from(tasks).where(eq(tasks.id, 'task-1'));
      expect(task.projectId).toBe('local-winner');
      const [conversation] = await fixture.db
        .select()
        .from(conversations)
        .where(eq(conversations.id, 'conv-1'));
      expect(conversation.projectId).toBe('local-winner');
      const [automation] = await fixture.db
        .select()
        .from(automations)
        .where(eq(automations.id, 'automation-1'));
      expect(automation.projectId).toBe('local-winner');
      const [settings] = await fixture.db
        .select()
        .from(projectSettings)
        .where(eq(projectSettings.projectId, 'local-winner'));
      expect(JSON.parse(settings.baseProjectSettingsJson)).toEqual({ defaultBranch: 'main' });
    });

    it('merges into a same-type project elsewhere with matching remotes', async () => {
      const dir = pickedDir();
      await seedSyncedLocalProject();
      await seedRemote('synced-local', 'origin', 'https://github.com/org/repo');
      const other = pickedDir();
      await fixture.db.insert(projects).values({
        id: 'local-winner',
        name: 'Local Repo',
        path: other,
        workspaceProvider: 'local',
        baseRef: 'main',
      });
      remotesByPath.set(dir, [{ name: 'origin', url: 'https://github.com/org/repo' }]);
      remotesByPath.set(other, [{ name: 'origin', url: 'https://github.com/org/repo' }]);

      const result = expectOk(
        await attachProject({ type: 'local', projectId: 'synced-local', path: dir })
      );

      expect(result.mergedInto).toBe('local-winner');
      const rows = await fixture.db.select().from(projects);
      expect(rows.map((r) => r.id)).toEqual(['local-winner']);
    });

    it('reports an ambiguity when both a local and an SSH project match, then merges into the chosen one', async () => {
      const dir = pickedDir();
      await seedSyncedLocalProject();
      await seedRemote('synced-local', 'origin', 'https://github.com/org/repo');
      const localDir = pickedDir();
      await fixture.db.insert(projects).values({
        id: 'local-match',
        name: 'Local Match',
        path: localDir,
        workspaceProvider: 'local',
        baseRef: 'main',
      });
      await seedConnection('conn-a', 'example.com', 'alice');
      await fixture.db.insert(projects).values({
        id: 'ssh-match',
        name: 'SSH Match',
        path: '/remote/match',
        workspaceProvider: 'ssh',
        sshConnectionId: 'conn-a',
        baseRef: 'main',
      });
      await seedRemote('ssh-match', 'origin', 'https://github.com/org/repo');
      remotesByPath.set(dir, [{ name: 'origin', url: 'git@github.com:org/repo.git' }]);
      remotesByPath.set(localDir, [{ name: 'origin', url: 'git@github.com:org/repo.git' }]);

      const first = await attachProject({ type: 'local', projectId: 'synced-local', path: dir });
      expect(first.success).toBe(false);
      if (first.success) return;
      expect(first.error.type).toBe('ambiguity');
      if (first.error.type !== 'ambiguity') return;
      expect(first.error.candidates.map((c) => c.projectId).sort()).toEqual([
        'local-match',
        'ssh-match',
      ]);

      const resolved = expectOk(
        await attachProject({
          type: 'local',
          projectId: 'synced-local',
          path: dir,
          mergeTargetProjectId: 'local-match',
        })
      );
      expect(resolved.mergedInto).toBe('local-match');
      const rows = await fixture.db.select().from(projects);
      expect(rows.map((r) => r.id).sort()).toEqual(['local-match', 'ssh-match']);
    });

    it('rejects a merge target that is not among the candidates', async () => {
      const dir = pickedDir();
      await seedSyncedLocalProject();
      await seedRemote('synced-local', 'origin', 'https://github.com/org/repo');
      await fixture.db.insert(projects).values({
        id: 'local-other',
        name: 'Other Repo',
        path: pickedDir(),
        workspaceProvider: 'local',
        baseRef: 'main',
      });
      remotesByPath.set(dir, [{ name: 'origin', url: 'https://github.com/org/repo' }]);

      const result = await attachProject({
        type: 'local',
        projectId: 'synced-local',
        path: dir,
        mergeTargetProjectId: 'local-other',
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.type).toBe('merge-target-invalid');
    });

    it('hard-conflicts when the picked path is held by an SSH project of a different repo', async () => {
      const dir = pickedDir();
      await seedSyncedLocalProject();
      await seedRemote('synced-local', 'origin', 'https://github.com/org/repo');
      await seedConnection('conn-a', 'example.com', 'alice');
      await fixture.db.insert(projects).values({
        id: 'ssh-holder',
        name: 'SSH Holder',
        path: dir,
        workspaceProvider: 'ssh',
        sshConnectionId: 'conn-a',
        baseRef: 'main',
      });
      await seedRemote('ssh-holder', 'origin', 'https://github.com/other/repo');
      remotesByPath.set(dir, [{ name: 'origin', url: 'https://github.com/org/repo' }]);

      const result = await attachProject({ type: 'local', projectId: 'synced-local', path: dir });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.type).toBe('path-conflict');
    });

    it('hard-conflicts instead of throwing when the picked path is held by a remotes-less local project', async () => {
      // The remote-mismatch guard is skipped when the synced project carries
      // no remotes; the unique path index would make the direct UPDATE throw.
      // The op must report a clean path-conflict Result instead.
      const dir = pickedDir();
      await seedSyncedLocalProject();
      await fixture.db.insert(projects).values({
        id: 'local-holder',
        name: 'Local Holder',
        path: dir,
        workspaceProvider: 'local',
        baseRef: 'main',
      });
      remotesByPath.set(dir, []);

      const result = await attachProject({ type: 'local', projectId: 'synced-local', path: dir });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.type).toBe('path-conflict');
      // No side effects: the synced row stays unattached, the holder keeps its path.
      const [synced] = await fixture.db
        .select()
        .from(projects)
        .where(eq(projects.id, 'synced-local'));
      expect(synced.path).toBeNull();
      const [holder] = await fixture.db
        .select()
        .from(projects)
        .where(eq(projects.id, 'local-holder'));
      expect(holder.path).toBe(dir);
    });
  });

  describe('SSH attach', () => {
    it('re-attaches a connection directly when the remote path is free', async () => {
      await seedSyncedSshProject();
      await seedConnection('conn-a', 'example.com', 'alice');

      const result = expectOk(
        await attachProject({ type: 'ssh', projectId: 'synced-ssh', connectionId: 'conn-a' })
      );

      expect(result.mergedInto).toBeNull();
      expect(result.project).toMatchObject({
        type: 'ssh',
        id: 'synced-ssh',
        connectionId: 'conn-a',
        path: '/remote/repo',
      });
      const [row] = await fixture.db.select().from(projects).where(eq(projects.id, 'synced-ssh'));
      expect(row.sshConnectionId).toBe('conn-a');
      expect(row.repositoryWorkspaceId).not.toBeNull();
      if (row.repositoryWorkspaceId === null) return;
      const [ws] = await fixture.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, row.repositoryWorkspaceId));
      expect(ws.kind).toBe('project-root');
      expect(ws.location).toBe('remote');
      expect(ws.sshConnectionId).toBe('conn-a');
    });

    it('merges when another SSH project holds the path on the same (host, port, username) fingerprint', async () => {
      // The unique path index normally prevents two rows sharing a path; the
      // op's fingerprint dedupe is defensive against that state (e.g. legacy
      // rows), so the test drops the index to build the precondition.
      fixture.sqlite.prepare('DROP INDEX idx_projects_path').run();
      await seedSyncedSshProject();
      await seedConnection('conn-a', 'example.com', 'alice', 22);
      // conn-b is a *different* connection id pointing at the same host.
      await seedConnection('conn-b', 'example.com', 'alice', 22);
      await fixture.db.insert(projects).values({
        id: 'ssh-winner',
        name: 'SSH Winner',
        path: '/remote/repo',
        workspaceProvider: 'ssh',
        sshConnectionId: 'conn-b',
        baseRef: 'main',
      });
      await fixture.db.insert(tasks).values({
        id: 'task-ssh',
        projectId: 'synced-ssh',
        name: 'Remote task',
        status: 'todo',
      });

      const result = expectOk(
        await attachProject({ type: 'ssh', projectId: 'synced-ssh', connectionId: 'conn-a' })
      );

      expect(result.mergedInto).toBe('ssh-winner');
      const rows = await fixture.db.select().from(projects);
      expect(rows.map((r) => r.id)).toEqual(['ssh-winner']);
      const [task] = await fixture.db.select().from(tasks).where(eq(tasks.id, 'task-ssh'));
      expect(task.projectId).toBe('ssh-winner');
    });

    it('hard-conflicts when the path is held by an SSH project on a different host', async () => {
      fixture.sqlite.prepare('DROP INDEX idx_projects_path').run();
      await seedSyncedSshProject();
      await seedConnection('conn-a', 'example.com', 'alice');
      await seedConnection('conn-b', 'other.example.com', 'alice');
      await fixture.db.insert(projects).values({
        id: 'ssh-winner',
        name: 'SSH Winner',
        path: '/remote/repo',
        workspaceProvider: 'ssh',
        sshConnectionId: 'conn-b',
        baseRef: 'main',
      });

      const result = await attachProject({
        type: 'ssh',
        projectId: 'synced-ssh',
        connectionId: 'conn-a',
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.type).toBe('path-conflict');
    });

    it('hard-conflicts when a local project holds the remote path', async () => {
      fixture.sqlite.prepare('DROP INDEX idx_projects_path').run();
      await seedSyncedSshProject();
      await seedConnection('conn-a', 'example.com', 'alice');
      await fixture.db.insert(projects).values({
        id: 'local-holder',
        name: 'Local Holder',
        path: '/remote/repo',
        workspaceProvider: 'local',
        baseRef: 'main',
      });

      const result = await attachProject({
        type: 'ssh',
        projectId: 'synced-ssh',
        connectionId: 'conn-a',
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.type).toBe('path-conflict');
    });

    it('rejects an unknown connection and an already-attached project', async () => {
      await seedSyncedSshProject();
      const missing = await attachProject({
        type: 'ssh',
        projectId: 'synced-ssh',
        connectionId: 'nope',
      });
      expect(missing.success).toBe(false);
      if (missing.success) return;
      expect(missing.error.type).toBe('ssh-connection-not-found');

      await seedConnection('conn-a', 'example.com', 'alice');
      await fixture.db
        .update(projects)
        .set({ sshConnectionId: 'conn-a' })
        .where(eq(projects.id, 'synced-ssh'));
      const attached = await attachProject({
        type: 'ssh',
        projectId: 'synced-ssh',
        connectionId: 'conn-a',
      });
      expect(attached.success).toBe(false);
      if (attached.success) return;
      expect(attached.error.type).toBe('already-attached');
    });
  });

  describe('provisioning after attach', () => {
    it('opens the attached project and returns its repository workspace id', async () => {
      const dir = pickedDir();
      await seedSyncedLocalProject();
      await seedRemote('synced-local', 'origin', 'https://github.com/org/repo');
      remotesByPath.set(dir, [{ name: 'origin', url: 'git@github.com:org/repo.git' }]);

      expectOk(await attachProject({ type: 'local', projectId: 'synced-local', path: dir }));

      // openProject (with a mocked project provider) now succeeds and reports
      // the repository-root workspace — the precondition for provisioning
      // tasks on demand.
      const { openProject } = await import('./openProject');
      const result = await openProject('synced-local');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.repositoryWorkspaceId).not.toBeNull();
      }
    });

    it('reports unattached (not path-not-found) when opening an unattached project', async () => {
      await seedSyncedLocalProject();
      const { openProject } = await import('./openProject');
      const result = await openProject('synced-local');
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.type).toBe('unattached');
    });
  });
});
