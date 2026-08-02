import { describe, expect, it } from 'vitest';
import type { LinkedIssue, LinkedIssueRoles } from '@shared/core/linked-issue';
import type { StageHoldingPr, Task, TaskStageAuthority } from '@shared/core/tasks/tasks';
import {
  buildTaskDetailPanelViewModel,
  DECLARATIVE_WORKFLOW_STAGES,
  deriveGhostDetailViewModel,
  deriveLinkedIssueSections,
  deriveStageSection,
  deriveTaskVitals,
} from './task-detail-panel-view-model';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    name: 'Example task',
    status: 'todo',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    statusChangedAt: '2026-01-01T00:00:00.000Z',
    isPinned: false,
    prs: [],
    conversations: {},
    type: 'task',
    ...overrides,
  };
}

function makeIssue(overrides: Partial<LinkedIssue> = {}): LinkedIssue {
  return {
    provider: 'github',
    url: 'https://github.com/acme/repo/issues/1',
    title: 'Example issue',
    identifier: '#1',
    ...overrides,
  };
}

function makeHoldingPr(overrides: Partial<StageHoldingPr> = {}): StageHoldingPr {
  return {
    url: 'https://github.com/acme/repo/pull/1',
    title: 'Example PR',
    identifier: '#1',
    status: 'open',
    isDraft: false,
    ...overrides,
  };
}

describe('deriveTaskVitals', () => {
  it('packages name, branch, creation date, session counts and agent status', () => {
    const task = makeTask({ name: 'My task', createdAt: '2026-02-01T00:00:00.000Z' });
    const vitals = deriveTaskVitals(task, {
      branchName: 'task/my-branch',
      sessionCounts: { claude: 2, codex: 1 },
      agentStatus: 'awaiting-input',
    });

    expect(vitals).toEqual({
      name: 'My task',
      branchName: 'task/my-branch',
      createdAt: '2026-02-01T00:00:00.000Z',
      sessionCounts: { claude: 2, codex: 1 },
      totalSessionCount: 3,
      agentStatus: 'awaiting-input',
    });
  });

  it('reports no branch and zero sessions for an unprovisioned, idle task', () => {
    const vitals = deriveTaskVitals(makeTask(), {
      branchName: null,
      sessionCounts: {},
      agentStatus: null,
    });

    expect(vitals.branchName).toBeNull();
    expect(vitals.totalSessionCount).toBe(0);
    expect(vitals.agentStatus).toBeNull();
  });
});

describe('deriveLinkedIssueSections', () => {
  it('is empty for a link-less task', () => {
    expect(deriveLinkedIssueSections(null)).toEqual([]);
    expect(deriveLinkedIssueSections(undefined)).toEqual([]);
  });

  it('includes only the Origin role when only Origin is set', () => {
    const origin = makeIssue({ identifier: '#10', title: 'Origin issue' });
    const links: LinkedIssueRoles = { version: '1', origin };
    expect(deriveLinkedIssueSections(links)).toEqual([{ role: 'origin', issue: origin }]);
  });

  it('includes only the Map role when only Map is set', () => {
    const map = makeIssue({ identifier: '#11', title: 'Map issue' });
    const links: LinkedIssueRoles = { version: '1', map };
    expect(deriveLinkedIssueSections(links)).toEqual([{ role: 'map', issue: map }]);
  });

  it('includes only the Spec role when only Spec is set', () => {
    const spec = makeIssue({ identifier: '#12', title: 'Spec issue' });
    const links: LinkedIssueRoles = { version: '1', spec };
    expect(deriveLinkedIssueSections(links)).toEqual([{ role: 'spec', issue: spec }]);
  });

  it('orders Origin, Map, Spec and omits no role that is set', () => {
    const origin = makeIssue({ identifier: '#10', title: 'Origin issue' });
    const map = makeIssue({ identifier: '#11', title: 'Map issue' });
    const spec = makeIssue({ identifier: '#12', title: 'Spec issue' });
    const links: LinkedIssueRoles = { version: '1', origin, map, spec };

    expect(deriveLinkedIssueSections(links)).toEqual([
      { role: 'origin', issue: origin },
      { role: 'map', issue: map },
      { role: 'spec', issue: spec },
    ]);
  });

  it('omits unset roles from a partial combination (Origin + Spec, no Map)', () => {
    const origin = makeIssue({ identifier: '#10', title: 'Origin issue' });
    const spec = makeIssue({ identifier: '#12', title: 'Spec issue' });
    const links: LinkedIssueRoles = { version: '1', origin, spec };

    expect(deriveLinkedIssueSections(links)).toEqual([
      { role: 'origin', issue: origin },
      { role: 'spec', issue: spec },
    ]);
  });
});

describe('deriveStageSection', () => {
  it('is unlocked with the declarative stages when there is no authority fact yet', () => {
    expect(deriveStageSection('idea', undefined)).toEqual({
      current: 'idea',
      locked: false,
      options: DECLARATIVE_WORKFLOW_STAGES,
      explanation: null,
      explanationLink: null,
    });
  });

  it('is unlocked with the declarative stages for a link-less task (no holding PR)', () => {
    const authority: TaskStageAuthority = { holdingPr: null, isCurrentStageGithubProven: false };
    expect(deriveStageSection(null, authority)).toEqual({
      current: null,
      locked: false,
      options: DECLARATIVE_WORKFLOW_STAGES,
      explanation: null,
      explanationLink: null,
    });
  });

  it('is locked, explaining an open PR, when the stage is GitHub-proven by Review', () => {
    const pr = makeHoldingPr({ status: 'open', identifier: '#77', url: 'https://x/pull/77' });
    const authority: TaskStageAuthority = { holdingPr: pr, isCurrentStageGithubProven: true };

    const section = deriveStageSection('review', authority);

    expect(section.locked).toBe(true);
    expect(section.options).toEqual([]);
    expect(section.explanation).toContain('Review');
    expect(section.explanation).toContain('#77');
    expect(section.explanationLink).toEqual({ url: 'https://x/pull/77', label: '#77' });
  });

  it('is locked, explaining a merged PR, when the stage is GitHub-proven by Shipped', () => {
    const pr = makeHoldingPr({ status: 'merged', identifier: '#78' });
    const authority: TaskStageAuthority = { holdingPr: pr, isCurrentStageGithubProven: true };

    const section = deriveStageSection('shipped', authority);

    expect(section.locked).toBe(true);
    expect(section.explanation).toContain('Shipped');
  });

  it('is locked, explaining a closed PR, when a currently-contradicting fact proves Triage', () => {
    const pr = makeHoldingPr({ status: 'closed', identifier: '#79' });
    const authority: TaskStageAuthority = { holdingPr: pr, isCurrentStageGithubProven: true };

    const section = deriveStageSection('idea', authority);

    expect(section.locked).toBe(true);
    expect(section.explanation).toContain('Triage');
  });

  it('is unlocked while the task currently sits in triage, even with a holding PR', () => {
    const pr = makeHoldingPr({ status: 'closed', identifier: '#80' });
    const authority: TaskStageAuthority = { holdingPr: pr, isCurrentStageGithubProven: false };

    const section = deriveStageSection('triage', authority);

    expect(section.locked).toBe(false);
    expect(section.options).toEqual(DECLARATIVE_WORKFLOW_STAGES);
    expect(section.explanation).toBeNull();
  });

  // `exploring`/`spec` are GitHub-provable stages (CONTEXT.md "Workflow Stage",
  // docs/adr/0003) the PR-only `tasks.getTaskStageAuthority` RPC can't speak to.
  // Since they are never offered as a manual choice (DECLARATIVE_WORKFLOW_STAGES
  // excludes them), a persisted `exploring`/`spec` stage can only have come from
  // the issue-derived sync pass — the selector must lock using that same link
  // rather than let a manual write silently and permanently outrank the fact.
  it('is locked, naming the linked Map issue, when the stage is GitHub-proven by Exploring', () => {
    const map = makeIssue({ identifier: '#55', title: 'Map issue', url: 'https://x/issues/55' });
    const declarativeAuthority: TaskStageAuthority = {
      holdingPr: null,
      isCurrentStageGithubProven: false,
    };

    const section = deriveStageSection('exploring', declarativeAuthority, {
      version: '1',
      map,
    });

    expect(section.locked).toBe(true);
    expect(section.options).toEqual([]);
    expect(section.explanation).toContain('Exploring');
    expect(section.explanation).toContain('#55');
    expect(section.explanationLink).toEqual({ url: 'https://x/issues/55', label: '#55' });
  });

  it('is locked, naming the linked Spec issue, when the stage is GitHub-proven by Spec', () => {
    const spec = makeIssue({ identifier: '#56', title: 'Spec issue', url: 'https://x/issues/56' });

    const section = deriveStageSection('spec', undefined, { version: '1', spec });

    expect(section.locked).toBe(true);
    expect(section.explanation).toContain('Spec');
    expect(section.explanation).toContain('#56');
    expect(section.explanationLink).toEqual({ url: 'https://x/issues/56', label: '#56' });
  });

  it('falls back to unlocked/declarative for exploring/spec when the matching link is missing', () => {
    // Defensive only — this combination should not occur in practice (the stage
    // can't be set without the corresponding link), but must never crash or
    // silently offer an unexplained lock.
    const section = deriveStageSection('exploring', undefined, { version: '1' });

    expect(section.locked).toBe(false);
    expect(section.options).toEqual(DECLARATIVE_WORKFLOW_STAGES);
  });
});

describe('deriveGhostDetailViewModel', () => {
  it('maps a Ghost Card issue to its title, body and url', () => {
    const ghostCard = {
      id: 'https://github.com/acme/repo/issues/5',
      issue: makeIssue({
        title: 'A candidate idea',
        description: 'Some body text',
        url: 'https://github.com/acme/repo/issues/5',
      }),
    };

    expect(deriveGhostDetailViewModel(ghostCard)).toEqual({
      title: 'A candidate idea',
      body: 'Some body text',
      url: 'https://github.com/acme/repo/issues/5',
    });
  });

  it('falls back to an empty body when the issue has no description', () => {
    const ghostCard = {
      id: 'https://github.com/acme/repo/issues/6',
      issue: makeIssue({ url: 'https://github.com/acme/repo/issues/6' }),
    };

    expect(deriveGhostDetailViewModel(ghostCard).body).toBe('');
  });
});

describe('buildTaskDetailPanelViewModel', () => {
  it('assembles vitals, an empty links list and a null PR for a purely local task', () => {
    const task = makeTask({ name: 'Local only', linkedIssues: undefined });

    const vm = buildTaskDetailPanelViewModel({
      task,
      branchName: null,
      sessionCounts: {},
      agentStatus: null,
      stageAuthority: undefined,
    });

    expect(vm.links).toEqual([]);
    expect(vm.pr).toBeNull();
    expect(vm.stage.locked).toBe(false);
    expect(vm.vitals.name).toBe('Local only');
  });

  it('surfaces the holding PR as the Spec-derived PR when the stage is GitHub-proven', () => {
    const pr = makeHoldingPr({ status: 'merged' });
    const spec = makeIssue({ identifier: '#20', title: 'Spec issue' });
    const task = makeTask({
      workflowStage: 'shipped',
      linkedIssues: { version: '1', spec },
    });

    const vm = buildTaskDetailPanelViewModel({
      task,
      branchName: 'task/branch',
      sessionCounts: { claude: 1 },
      agentStatus: 'idle',
      stageAuthority: { holdingPr: pr, isCurrentStageGithubProven: true },
    });

    expect(vm.pr).toEqual(pr);
    expect(vm.stage.locked).toBe(true);
    expect(vm.links).toEqual([{ role: 'spec', issue: spec }]);
  });

  it('locks the stage selector for a task sitting in Spec with no PR yet (issue-derived authority)', () => {
    const spec = makeIssue({ identifier: '#30', title: 'Spec issue' });
    const task = makeTask({
      workflowStage: 'spec',
      linkedIssues: { version: '1', spec },
    });

    const vm = buildTaskDetailPanelViewModel({
      task,
      branchName: null,
      sessionCounts: {},
      agentStatus: null,
      stageAuthority: { holdingPr: null, isCurrentStageGithubProven: false },
    });

    expect(vm.pr).toBeNull();
    expect(vm.stage.locked).toBe(true);
    expect(vm.stage.explanation).toContain('#30');
    expect(vm.stage.options).toEqual([]);
  });
});
