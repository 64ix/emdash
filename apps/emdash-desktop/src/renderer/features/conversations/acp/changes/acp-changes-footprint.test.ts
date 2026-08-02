import type {
  CreateFileToolCall,
  DeleteFileToolCall,
  ModifyFileToolCall,
  ReadToolCall,
  TranscriptItem,
  TranscriptTurn,
} from '@emdash/core/acp/client';
import type { GitChange, GitChangeStatus } from '@emdash/core/git';
import { describe, expect, it } from 'vitest';
import { buildChangesFootprint, EMPTY_CHANGES_FOOTPRINT } from './acp-changes-footprint';

// ── Fixture builders ──────────────────────────────────────────────────────────

function readCall(id: string, seq: number, path?: string, resource?: string): ReadToolCall {
  return {
    kind: 'read-tool-call',
    id,
    seq,
    toolCallId: id,
    title: `Read ${path ?? resource ?? ''}`,
    status: 'done',
    ...(path !== undefined ? { path } : {}),
    ...(resource !== undefined ? { resource } : {}),
  };
}

function createCall(id: string, seq: number, path: string): CreateFileToolCall {
  return {
    kind: 'create-file-tool-call',
    id,
    seq,
    toolCallId: id,
    title: `Create ${path}`,
    status: 'done',
    path,
    content: '',
  };
}

function modifyCall(id: string, seq: number, path: string): ModifyFileToolCall {
  return {
    kind: 'modify-file-tool-call',
    id,
    seq,
    toolCallId: id,
    title: `Edit ${path}`,
    status: 'done',
    path,
    oldText: '',
    newText: '',
  };
}

function deleteCall(id: string, seq: number, path: string): DeleteFileToolCall {
  return {
    kind: 'delete-file-tool-call',
    id,
    seq,
    toolCallId: id,
    title: `Delete ${path}`,
    status: 'done',
    path,
  };
}

function turn(id: string, seq: number, items: TranscriptItem[]): TranscriptTurn {
  return { id, seq, initiator: 'agent', items, outcome: { kind: 'done' } };
}

function gitChange(path: string, status: GitChangeStatus, additions = 0, deletions = 0): GitChange {
  return { path, status, additions, deletions };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildChangesFootprint', () => {
  it('returns the empty footprint for no turns and no git changes', () => {
    const footprint = buildChangesFootprint({ committedTurns: [], activeTurn: null });
    expect(footprint).toEqual(EMPTY_CHANGES_FOOTPRINT);
  });

  it('classifies create/modify/delete/read tool calls into the appropriate entry', () => {
    const t = turn('t1', 1, [
      createCall('c1', 1, 'src/a.ts'),
      modifyCall('c2', 2, 'src/b.ts'),
      deleteCall('c3', 3, 'src/c.ts'),
      readCall('c4', 4, 'src/d.ts'),
    ]);

    const footprint = buildChangesFootprint({ committedTurns: [t], activeTurn: null });

    expect(footprint.edited).toEqual([
      {
        kind: 'edited',
        path: 'src/a.ts',
        status: 'added',
        additions: 0,
        deletions: 0,
        source: { turnId: 't1', itemId: 'c1' },
      },
      {
        kind: 'edited',
        path: 'src/b.ts',
        status: 'modified',
        additions: 0,
        deletions: 0,
        source: { turnId: 't1', itemId: 'c2' },
      },
      {
        kind: 'edited',
        path: 'src/c.ts',
        status: 'deleted',
        additions: 0,
        deletions: 0,
        source: { turnId: 't1', itemId: 'c3' },
      },
    ]);
    expect(footprint.read).toEqual([
      { kind: 'read', path: 'src/d.ts', source: { turnId: 't1', itemId: 'c4' } },
    ]);
  });

  it('dedupes repeated reads of the same path into a single entry with the latest provenance', () => {
    const t = turn('t1', 1, [readCall('c1', 1, 'src/a.ts'), readCall('c2', 2, 'src/a.ts')]);

    const footprint = buildChangesFootprint({ committedTurns: [t], activeTurn: null });

    expect(footprint.read).toEqual([
      { kind: 'read', path: 'src/a.ts', source: { turnId: 't1', itemId: 'c2' } },
    ]);
  });

  it('keeps an edited file classified as edited even when it is read again afterward', () => {
    const t = turn('t1', 1, [modifyCall('c1', 1, 'src/a.ts'), readCall('c2', 2, 'src/a.ts')]);

    const footprint = buildChangesFootprint({ committedTurns: [t], activeTurn: null });

    expect(footprint.edited).toHaveLength(1);
    expect(footprint.edited[0]).toMatchObject({
      path: 'src/a.ts',
      status: 'modified',
      source: { turnId: 't1', itemId: 'c1' },
    });
    expect(footprint.read).toEqual([]);
  });

  it('reclassifies a read file as edited once a later edit touches it', () => {
    const t = turn('t1', 1, [readCall('c1', 1, 'src/a.ts'), modifyCall('c2', 2, 'src/a.ts')]);

    const footprint = buildChangesFootprint({ committedTurns: [t], activeTurn: null });

    expect(footprint.edited).toHaveLength(1);
    expect(footprint.edited[0]).toMatchObject({
      path: 'src/a.ts',
      source: { turnId: 't1', itemId: 'c2' },
    });
    expect(footprint.read).toEqual([]);
  });

  it('reconciles the active turn with persisted history without duplicating an in-progress edit', () => {
    const committed = [turn('t1', 1, [createCall('c1', 1, 'src/a.ts')])];
    const active = turn('t2', 2, [modifyCall('c2', 1, 'src/a.ts')]);

    const streaming = buildChangesFootprint({ committedTurns: committed, activeTurn: active });
    expect(streaming.edited).toHaveLength(1);
    expect(streaming.edited[0]).toMatchObject({
      path: 'src/a.ts',
      status: 'modified',
      source: { turnId: 't2', itemId: 'c2' },
    });

    // Active-to-persisted transition: the turn commits and is now just another
    // committed turn. The reconciled result must be identical — no duplicate
    // entry, no reverted classification.
    const afterCommit = buildChangesFootprint({
      committedTurns: [...committed, active],
      activeTurn: null,
    });
    expect(afterCommit).toEqual(streaming);
  });

  it('reconciles turns in seq order regardless of the array order the caller passes them in', () => {
    // Simulates an older-history page prepended after the fact: the caller's
    // array is [seq 5, seq 1], but chronologically seq 1 happened first.
    const older = turn('older', 1, [createCall('c1', 1, 'src/a.ts')]);
    const newer = turn('newer', 5, [deleteCall('c2', 1, 'src/a.ts')]);

    const outOfOrder = buildChangesFootprint({ committedTurns: [newer, older], activeTurn: null });
    const inOrder = buildChangesFootprint({ committedTurns: [older, newer], activeTurn: null });

    expect(outOfOrder).toEqual(inOrder);
    expect(outOfOrder.edited).toEqual([
      {
        kind: 'edited',
        path: 'src/a.ts',
        status: 'deleted',
        additions: 0,
        deletions: 0,
        source: { turnId: 'newer', itemId: 'c2' },
      },
    ]);
  });

  it('reconciles nested tool-group children (e.g. a collapsed read-batch group)', () => {
    const t = turn('t1', 1, [
      {
        kind: 'tool-group',
        id: 'group-1',
        seq: 1,
        label: '2 file reads',
        groupKind: 'read-batch',
        status: 'done',
        children: [readCall('c1', 1, 'src/a.ts'), readCall('c2', 2, 'src/b.ts')],
      },
    ]);

    const footprint = buildChangesFootprint({ committedTurns: [t], activeTurn: null });

    expect(footprint.read.map((entry) => entry.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('reconciles file operations nested under a subagent tool call', () => {
    const t = turn('t1', 1, [
      {
        kind: 'spawn-subagent-tool-call',
        id: 'sub-1',
        seq: 1,
        toolCallId: 'sub-1',
        title: 'Subagent',
        status: 'done',
        name: 'Subagent',
        children: [modifyCall('c1', 1, 'src/a.ts')],
      },
    ]);

    const footprint = buildChangesFootprint({ committedTurns: [t], activeTurn: null });

    expect(footprint.edited).toEqual([
      {
        kind: 'edited',
        path: 'src/a.ts',
        status: 'modified',
        additions: 0,
        deletions: 0,
        source: { turnId: 't1', itemId: 'c1' },
      },
    ]);
  });

  it('ignores a read-tool-call that has neither a path nor a resource', () => {
    const t = turn('t1', 1, [readCall('c1', 1)]);
    const footprint = buildChangesFootprint({ committedTurns: [t], activeTurn: null });
    expect(footprint).toEqual(EMPTY_CHANGES_FOOTPRINT);
  });

  it('lets the current Git status override a stale transcript classification', () => {
    const t = turn('t1', 1, [modifyCall('c1', 1, 'src/a.ts')]);
    const changes = [gitChange('src/a.ts', 'deleted', 0, 12)];

    const footprint = buildChangesFootprint({
      committedTurns: [t],
      activeTurn: null,
      gitChanges: changes,
    });

    expect(footprint.edited).toEqual([
      {
        kind: 'edited',
        path: 'src/a.ts',
        status: 'deleted',
        additions: 0,
        deletions: 12,
        // Transcript provenance survives even though Git decided the status.
        source: { turnId: 't1', itemId: 'c1' },
      },
    ]);
  });

  it('surfaces a rename reported purely by Git status, with no transcript activity', () => {
    const changes = [gitChange('src/renamed.ts', 'renamed')];

    const footprint = buildChangesFootprint({
      committedTurns: [],
      activeTurn: null,
      gitChanges: changes,
    });

    expect(footprint.edited).toEqual([
      {
        kind: 'edited',
        path: 'src/renamed.ts',
        status: 'renamed',
        additions: 0,
        deletions: 0,
        source: null,
      },
    ]);
  });

  it('surfaces a Git-only change (never touched by the agent) as an edited entry with no provenance', () => {
    const changes = [gitChange('src/manual.ts', 'modified', 3, 1)];
    const footprint = buildChangesFootprint({
      committedTurns: [],
      activeTurn: null,
      gitChanges: changes,
    });

    expect(footprint.edited).toEqual([
      {
        kind: 'edited',
        path: 'src/manual.ts',
        status: 'modified',
        additions: 3,
        deletions: 1,
        source: null,
      },
    ]);
  });

  it('reflects a changing Git snapshot across two calls with the same transcript', () => {
    const t = turn('t1', 1, [createCall('c1', 1, 'src/a.ts')]);

    // Before the Git watcher catches up: no Git entry yet, so the transcript
    // classification (created -> added) is all we have.
    const before = buildChangesFootprint({ committedTurns: [t], activeTurn: null, gitChanges: [] });
    expect(before.edited[0]).toMatchObject({ status: 'added', additions: 0, deletions: 0 });

    // After a fresh Git snapshot arrives, the same file is reported with real
    // stats and Git's status wins.
    const after = buildChangesFootprint({
      committedTurns: [t],
      activeTurn: null,
      gitChanges: [gitChange('src/a.ts', 'modified', 8, 2)],
    });
    expect(after.edited[0]).toMatchObject({ status: 'modified', additions: 8, deletions: 2 });
  });

  it('normalizes absolute Git paths and workspace-relative transcript paths to the same entry', () => {
    const workspacePath = '/Users/dev/project';
    const t = turn('t1', 1, [modifyCall('c1', 1, 'src/a.ts')]);
    const changes = [gitChange('/Users/dev/project/src/a.ts', 'modified', 4, 1)];

    const footprint = buildChangesFootprint({
      committedTurns: [t],
      activeTurn: null,
      gitChanges: changes,
      workspacePath,
    });

    expect(footprint.edited).toHaveLength(1);
    expect(footprint.edited[0]).toMatchObject({ path: 'src/a.ts', additions: 4, deletions: 1 });
  });

  it('normalizes backslash (Windows-style) paths to the same forward-slash entry', () => {
    const t = turn('t1', 1, [modifyCall('c1', 1, 'src\\nested\\a.ts')]);
    const changes = [gitChange('src/nested/a.ts', 'modified', 2, 0)];

    const footprint = buildChangesFootprint({
      committedTurns: [t],
      activeTurn: null,
      gitChanges: changes,
    });

    expect(footprint.edited).toEqual([
      {
        kind: 'edited',
        path: 'src/nested/a.ts',
        status: 'modified',
        additions: 2,
        deletions: 0,
        source: { turnId: 't1', itemId: 'c1' },
      },
    ]);
  });

  it('sorts both sections alphabetically by path regardless of insertion order', () => {
    const t = turn('t1', 1, [
      createCall('c1', 1, 'z.ts'),
      createCall('c2', 2, 'a.ts'),
      readCall('c3', 3, 'm.ts'),
      readCall('c4', 4, 'b.ts'),
    ]);

    const footprint = buildChangesFootprint({ committedTurns: [t], activeTurn: null });

    expect(footprint.edited.map((entry) => entry.path)).toEqual(['a.ts', 'z.ts']);
    expect(footprint.read.map((entry) => entry.path)).toEqual(['b.ts', 'm.ts']);
  });

  it('never leaks paths across two independent (task-scoped) invocations', () => {
    const taskA = turn('a-1', 1, [modifyCall('a-c1', 1, 'task-a/only.ts')]);
    const taskB = turn('b-1', 1, [modifyCall('b-c1', 1, 'task-b/only.ts')]);

    const footprintA = buildChangesFootprint({
      committedTurns: [taskA],
      activeTurn: null,
      gitChanges: [gitChange('task-a/only.ts', 'modified', 1, 0)],
    });
    const footprintB = buildChangesFootprint({
      committedTurns: [taskB],
      activeTurn: null,
      gitChanges: [gitChange('task-b/only.ts', 'modified', 1, 0)],
    });

    const pathsA = footprintA.edited.map((entry) => entry.path);
    const pathsB = footprintB.edited.map((entry) => entry.path);
    expect(pathsA).toEqual(['task-a/only.ts']);
    expect(pathsB).toEqual(['task-b/only.ts']);
    expect(pathsA).not.toContain('task-b/only.ts');
    expect(pathsB).not.toContain('task-a/only.ts');
  });
});
