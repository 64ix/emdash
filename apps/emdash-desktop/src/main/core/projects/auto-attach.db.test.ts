/**
 * Auto-attach service tests (spec #130, ticket #136): scanning the default
 * projects directory for a repo whose live remotes match a freshly imported
 * project's carried remotes, and attaching silently.
 *
 * The scanner reads REAL git remotes from temp repositories (os.tmpdir()
 * style); the git runtime used by the attach operation is mocked per-path.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GitRemote } from '@emdash/core/git';
import { ok } from '@emdash/shared';
import { openFixture, type FixtureDb } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectRemotes, projects } from '@main/db/schema';
import type { AttachProjectError, AttachProjectResult } from '@shared/projects';
import {
  createDefaultRepoScanner,
  ProjectAutoAttachService,
  type RepoScanner,
} from './auto-attach';

const execFileAsync = promisify(execFile);

const mocks = vi.hoisted(() => ({
  acquireMock: vi.fn(),
  ensureRepositoryMock: vi.fn(),
  inspectPathMock: vi.fn(),
  openRepositoryMock: vi.fn(),
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
  runtimeManager: { acquire: mocks.acquireMock },
}));

vi.mock('@main/core/projects/project-manager', () => ({
  projectManager: { openProject: vi.fn(), getProject: vi.fn() },
}));

async function makeTempRepo(parent: string, name: string, remotes: GitRemote[]): Promise<string> {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: dir });
  for (const remote of remotes) {
    await execFileAsync('git', ['remote', 'add', remote.name, remote.url], { cwd: dir });
  }
  return dir;
}

/** Scanner over real temp repos: reads git remotes with the real git CLI. */
function realRepoScanner(): RepoScanner {
  return {
    async listDirectories(directory) {
      const entries = await fs.promises.readdir(directory, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => path.join(directory, entry.name));
    },
    async readRemotes(repoPath) {
      try {
        const names = (await execFileAsync('git', ['-C', repoPath, 'remote'])).stdout
          .trim()
          .split('\n')
          .filter(Boolean);
        const remotes: GitRemote[] = [];
        for (const name of names) {
          const { stdout } = await execFileAsync('git', [
            '-C',
            repoPath,
            'remote',
            'get-url',
            name,
          ]);
          remotes.push({ name, url: stdout.trim() });
        }
        return remotes;
      } catch {
        return [];
      }
    },
  };
}

describe('ProjectAutoAttachService (spec #130, ticket #136)', () => {
  let fixture: FixtureDb;
  let projectsDir: string;
  const cleanupDirs: string[] = [];
  const remotesByPath = new Map<string, GitRemote[]>();

  function seedUnattachedLocalProject(remoteUrl: string, projectId = 'synced-local') {
    return fixture.db
      .insert(projects)
      .values({
        id: projectId,
        name: 'Synced Repo',
        path: null,
        workspaceProvider: 'local',
        baseRef: 'main',
      })
      .then(() =>
        fixture.db.insert(projectRemotes).values({
          projectId,
          remoteName: 'origin',
          remoteUrl,
        })
      );
  }

  function makeService(attachLocal: ProjectAutoAttachService['deps']['attachLocal']) {
    return new ProjectAutoAttachService({
      getDefaultProjectsDirectory: async () => projectsDir,
      scanner: realRepoScanner(),
      attachLocal,
    });
  }

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emdash-auto-attach-'));
    cleanupDirs.push(projectsDir);
    remotesByPath.clear();
    vi.clearAllMocks();

    mocks.acquireMock.mockImplementation(async () => ({
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
    }));
    mocks.ensureRepositoryMock.mockImplementation(async (p: string) =>
      ok({ kind: 'repository', rootPath: p, baseRef: 'main' })
    );
    mocks.inspectPathMock.mockImplementation(async (p: string) => ({
      kind: 'repository',
      rootPath: p,
      baseRef: 'main',
    }));
    mocks.openRepositoryMock.mockImplementation(async (p: string) => ({
      value: { getRemotes: async () => ({ remotes: remotesByPath.get(p) ?? [] }) },
      release: mocks.releaseMock,
    }));
    mocks.statMock.mockResolvedValue(ok({ path: 'repo', type: 'directory' }));
    mocks.releaseMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    fixture?.close();
    mocks.db = undefined;
    for (const dir of cleanupDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('attaches silently to a matching repo in the default projects directory (ssh-spelled live remote vs https hint)', async () => {
    await makeTempRepo(projectsDir, 'repo', [
      { name: 'origin', url: 'git@github.com:org/repo.git' },
    ]);
    await seedUnattachedLocalProject('https://github.com/org/repo');
    // The mocked git runtime the attach op uses mirrors the real repo.
    remotesByPath.set(path.join(projectsDir, 'repo'), [
      { name: 'origin', url: 'git@github.com:org/repo.git' },
    ]);

    const attached = vi.fn();
    const service = makeService(async (projectId, p) => {
      attached(projectId, p);
      const { attachProject } = await import('./operations/attachProject');
      return attachProject({ type: 'local', projectId, path: p });
    });

    const result = await service.attemptAttach('synced-local', 'local');

    expect(result).toEqual({
      kind: 'attached',
      projectId: 'synced-local',
      path: path.join(projectsDir, 'repo'),
    });
    expect(attached).toHaveBeenCalledWith('synced-local', path.join(projectsDir, 'repo'));
    const [row] = await fixture.db.select().from(projects).where(eq(projects.id, 'synced-local'));
    expect(row.path).toBe(path.join(projectsDir, 'repo'));
  });

  it('stays unattached when no repo in the directory matches', async () => {
    await makeTempRepo(projectsDir, 'other-repo', [
      { name: 'origin', url: 'git@github.com:other/repo.git' },
    ]);
    await seedUnattachedLocalProject('https://github.com/org/repo');

    const attachLocal = vi.fn();
    const service = makeService(attachLocal);

    const result = await service.attemptAttach('synced-local', 'local');

    expect(result).toEqual({ kind: 'unattached' });
    expect(attachLocal).not.toHaveBeenCalled();
    const [row] = await fixture.db.select().from(projects).where(eq(projects.id, 'synced-local'));
    expect(row.path).toBeNull();
  });

  it('stays unattached when the project has no carried remotes to match against', async () => {
    await fixture.db.insert(projects).values({
      id: 'no-remotes',
      name: 'No Remotes',
      path: null,
      workspaceProvider: 'local',
      baseRef: 'main',
    });
    const attachLocal = vi.fn();
    const service = makeService(attachLocal);

    const result = await service.attemptAttach('no-remotes', 'local');

    expect(result).toEqual({ kind: 'unattached' });
    expect(attachLocal).not.toHaveBeenCalled();
  });

  it('never auto-attaches SSH projects (connection picking is a user decision)', async () => {
    const attachLocal = vi.fn();
    const service = makeService(attachLocal);

    const result = await service.attemptAttach('synced-local', 'ssh');

    expect(result).toEqual({ kind: 'not-local-project' });
    expect(attachLocal).not.toHaveBeenCalled();
  });

  it('reports a merge when the matching repo already belongs to a local project', async () => {
    await makeTempRepo(projectsDir, 'repo', [
      { name: 'origin', url: 'https://github.com/org/repo' },
    ]);
    await seedUnattachedLocalProject('https://github.com/org/repo');

    const service = makeService(async (projectId, p) => {
      expect(projectId).toBe('synced-local');
      const success: AttachProjectResult = {
        success: true,
        data: {
          project: {
            type: 'local',
            id: 'local-winner',
            name: 'Local Winner',
            path: p,
            baseRef: 'main',
            repositoryWorkspaceId: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          mergedInto: 'local-winner',
        },
      };
      return success;
    });

    const result = await service.attemptAttach('synced-local', 'local');

    expect(result).toEqual({
      kind: 'merged',
      projectId: 'synced-local',
      targetProjectId: 'local-winner',
    });
  });

  it('stays unattached when the match is ambiguous (user must pick)', async () => {
    await makeTempRepo(projectsDir, 'repo', [
      { name: 'origin', url: 'https://github.com/org/repo' },
    ]);
    await seedUnattachedLocalProject('https://github.com/org/repo');

    const failure: AttachProjectResult = {
      success: false,
      error: {
        type: 'ambiguity',
        path: path.join(projectsDir, 'repo'),
        candidates: [
          { projectId: 'local-match', name: 'Local', type: 'local' },
          { projectId: 'ssh-match', name: 'SSH', type: 'ssh' },
        ],
      } as AttachProjectError,
    };
    const service = makeService(async () => failure);

    const result = await service.attemptAttach('synced-local', 'local');

    expect(result).toEqual({ kind: 'unattached' });
  });

  it('skips non-matching and non-repo directories deterministically and takes the first match in sorted order', async () => {
    // `a-first` sorts before `z-last`; both match, sorted scan must pick a-first.
    const first = await makeTempRepo(projectsDir, 'a-first', [
      { name: 'origin', url: 'https://github.com/org/repo' },
    ]);
    await makeTempRepo(projectsDir, 'z-last', [
      { name: 'origin', url: 'https://github.com/org/repo' },
    ]);
    // A plain directory that is not a git repo must not break the scan.
    fs.mkdirSync(path.join(projectsDir, 'not-a-repo'), { recursive: true });
    await seedUnattachedLocalProject('https://github.com/org/repo');

    const calls: string[] = [];
    const attachedProject = {
      type: 'local' as const,
      id: 'synced-local',
      name: 'Synced Repo',
      path: first,
      baseRef: 'main',
      repositoryWorkspaceId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const service = makeService(async (_projectId, p) => {
      calls.push(p);
      return ok({ project: attachedProject, mergedInto: null });
    });

    await service.attemptAttach('synced-local', 'local');

    expect(calls).toEqual([first]);
  });

  it('uses the production scanner shape (direct children, hidden dirs skipped)', async () => {
    const scanner = createDefaultRepoScanner();
    const visible = await makeTempRepo(projectsDir, 'visible', [
      { name: 'origin', url: 'https://github.com/org/repo' },
    ]);
    fs.mkdirSync(path.join(projectsDir, '.hidden'), { recursive: true });
    // The mocked git runtime stands in for the real one here; the scanner's
    // shape (delegation + error tolerance) is what this test pins down.
    remotesByPath.set(visible, [{ name: 'origin', url: 'https://github.com/org/repo' }]);

    const dirs = await scanner.listDirectories(projectsDir);
    expect(dirs).toEqual([visible]);
    const remotes = await scanner.readRemotes(visible);
    expect(remotes).toEqual([{ name: 'origin', url: 'https://github.com/org/repo' }]);
    // Non-repo directories yield an empty remote set.
    expect(await scanner.readRemotes(path.join(projectsDir, '.hidden'))).toEqual([]);
  });
});
