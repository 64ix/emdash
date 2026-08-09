import { describe, expect, it } from 'vitest';
import { workspaceConfig, workspaceConfigSchema, type WorkspaceConfig } from './workspace-config';

const V2_REPOSITORY_INSTANCE = {
  version: '2',
  git: { kind: 'none' },
  workspace: { kind: 'repository-instance', workspaceId: 'ws-repo-1' },
};

const V2_NEW_WORKTREE = {
  version: '2',
  git: { kind: 'create-branch', branchName: 'x', fromBranch: { type: 'local', branch: 'main' } },
  workspace: { kind: 'new-worktree' },
};

describe('workspaceConfig v3', () => {
  it('upgrades v2 repository-instance to v3, preserving workspaceId', () => {
    const result = workspaceConfig.safeParse(V2_REPOSITORY_INSTANCE);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.version).toBe('3');
      expect(result.data.workspace).toEqual({
        kind: 'repository-instance',
        workspaceId: 'ws-repo-1',
      });
    }
  });

  it('upgrades v2 new-worktree to v3 unchanged', () => {
    const result = workspaceConfig.safeParse(V2_NEW_WORKTREE);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.version).toBe('3');
      expect(result.data.workspace).toEqual({ kind: 'new-worktree' });
      expect(result.data.git).toEqual(V2_NEW_WORKTREE.git);
    }
  });

  it('parses a v3 repository-instance target without a workspaceId', () => {
    const v3 = {
      version: '3',
      git: { kind: 'none' },
      workspace: { kind: 'repository-instance' },
    };
    expect(workspaceConfig.safeParse(v3)).toEqual({ status: 'ok', data: v3 });
  });

  it('parses a v3 repository-instance target with a workspaceId', () => {
    const v3 = {
      version: '3',
      git: { kind: 'none' },
      workspace: { kind: 'repository-instance', workspaceId: 'ws-repo-1' },
    };
    expect(workspaceConfig.safeParse(v3)).toEqual({ status: 'ok', data: v3 });
  });

  it('rejects a v3 repository-instance target with a non-string workspaceId', () => {
    const result = workspaceConfig.safeParse({
      version: '3',
      git: { kind: 'none' },
      workspace: { kind: 'repository-instance', workspaceId: 42 },
    });
    expect(result.status).toBe('invalid');
  });

  it('round-trips a v3 config (with and without workspaceId) through serialize/parseJson', () => {
    const bare: WorkspaceConfig = {
      version: '3',
      git: { kind: 'none' },
      workspace: { kind: 'repository-instance' },
    };
    expect(workspaceConfig.parseJson(workspaceConfig.serialize(bare))).toEqual(bare);

    const withId: WorkspaceConfig = {
      version: '3',
      git: { kind: 'none' },
      workspace: { kind: 'repository-instance', workspaceId: 'ws-repo-1' },
    };
    expect(workspaceConfig.parseJson(workspaceConfig.serialize(withId))).toEqual(withId);
  });

  it('validates the latest schema (v3) through workspaceConfigSchema', () => {
    const parsed = workspaceConfigSchema.parse({
      version: '3',
      git: { kind: 'none' },
      workspace: { kind: 'repository-instance' },
    });
    expect(parsed.workspace).toEqual({ kind: 'repository-instance' });
  });

  it('preserves future-version blobs untouched', () => {
    const result = workspaceConfig.safeParse({ version: '99', git: {}, workspace: {} });
    expect(result).toEqual({ status: 'future-version', version: '99' });
  });
});
