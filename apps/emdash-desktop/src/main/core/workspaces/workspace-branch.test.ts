import { describe, expect, it } from 'vitest';
import type { WorkspaceConfig } from '@shared/core/workspaces/workspace-config';
import { getProvisionedWorkspaceBranch, getTaskPrBranch } from './workspace-branch';

const createBranchConfig: WorkspaceConfig = {
  version: '3',
  git: {
    kind: 'create-branch',
    branchName: 'task/provisioned',
    fromBranch: { type: 'local', branch: 'main' },
  },
  workspace: { kind: 'new-worktree' },
};

describe('workspace branch metadata', () => {
  it('treats project-root branchName as current branch cache, not provisioned branch', () => {
    const workspace = {
      kind: 'project-root' as const,
      branchName: 'feature/current',
      config: null,
    };

    expect(getProvisionedWorkspaceBranch(workspace)).toBeNull();
  });

  it('does not derive provisioned branch for project-root workspace config', () => {
    expect(
      getProvisionedWorkspaceBranch({
        kind: 'project-root',
        branchName: 'feature/current',
        config: createBranchConfig,
      })
    ).toBeNull();
  });

  it('derives provisioned worktree branch from config before branchName cache', () => {
    expect(
      getProvisionedWorkspaceBranch({
        kind: 'worktree',
        branchName: 'feature/current',
        config: createBranchConfig,
      })
    ).toBe('task/provisioned');
  });

  it('does not treat a worktree row with git none as owning a branch', () => {
    const config: WorkspaceConfig = {
      version: '3',
      git: { kind: 'none' },
      workspace: { kind: 'new-worktree' },
    };

    expect(
      getProvisionedWorkspaceBranch({
        kind: 'worktree',
        branchName: 'feature/current',
        config,
      })
    ).toBeNull();
  });

  it('keeps branchName as legacy fallback when kind and config are missing', () => {
    expect(
      getProvisionedWorkspaceBranch({
        kind: null,
        branchName: 'legacy/task-branch',
        config: null,
      })
    ).toBe('legacy/task-branch');
  });
});

describe('getTaskPrBranch', () => {
  it('returns the persisted branch for a worktree workspace', () => {
    expect(
      getTaskPrBranch({ kind: 'worktree', branchName: 'task/own-branch', config: null })
    ).toBe('task/own-branch');
  });

  // Deliberate: the config-derived branch is a provisioning intent, not PR
  // evidence — before the first bootstrap backfills branchName, a worktree
  // task matches no PRs (see the doc comment on getTaskPrBranch).
  it('does not derive a branch from config before provisioning backfills branchName', () => {
    expect(
      getTaskPrBranch({ kind: 'worktree', branchName: null, config: createBranchConfig })
    ).toBeNull();
  });

  it('never grants a branch to project-root, path or byoi workspaces', () => {
    for (const kind of ['project-root', 'path', 'byoi'] as const) {
      expect(
        getTaskPrBranch({ kind, branchName: 'afk/prd-153-unrelated', config: createBranchConfig })
      ).toBeNull();
    }
  });

  it('keeps matching legacy null-kind rows by their persisted branch', () => {
    expect(getTaskPrBranch({ kind: null, branchName: 'legacy/task-branch', config: null })).toBe(
      'legacy/task-branch'
    );
  });
});
