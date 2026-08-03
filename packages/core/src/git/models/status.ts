export type GitChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'conflicted';

export type GitChange = {
  path: string;
  status: GitChangeStatus;
  additions: number;
  deletions: number;
  indexOid?: string;
  /**
   * The pre-rename path, present only when `status` is `'renamed'` and the
   * producer was able to determine it. Consumers must treat this as
   * best-effort: some producers (e.g. older status snapshots, or paths
   * where the old and new path are identical) never populate it.
   */
  oldPath?: string;
};

export type GitStatusData = {
  kind: 'ok';
  staged: GitChange[];
  unstaged: GitChange[];
  stagedAdded: number;
  stagedDeleted: number;
};

export type GitStatusError = {
  kind: 'error';
  message: string;
};

export type GitStatusModel = GitStatusData | { kind: 'too-many-files' } | GitStatusError;

export type GitStatusUntrackedMode = 'no' | 'normal';

export type GitStatusFingerprint = {
  hash: string;
  byteLength: number;
};
