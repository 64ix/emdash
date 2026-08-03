import { describe, expect, it } from 'vitest';
import type { LinkedIssueRoles } from '@shared/core/linked-issue';
import type { PullRequest } from '@shared/core/pull-requests/pull-requests';
import type { Task, WorkflowStage } from '@shared/core/tasks/tasks';
import {
  agentStateFilterValue,
  EMPTY_BOARD_FILTERS,
  hasActiveBoardFilters,
  linkedIssuePresenceFilterValue,
  matchesSearchQuery,
  prStateFilterValue,
  taskPassesBoardFilters,
  toggleSetMember,
  type BoardFilterState,
} from './board-filters';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    name: 'Refactor the diff viewer',
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

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    url: 'https://github.com/acme/repo/pull/1',
    provider: 'github',
    repositoryUrl: 'https://github.com/acme/repo',
    baseRefName: 'main',
    baseRefOid: 'base',
    headRepositoryUrl: 'https://github.com/acme/repo',
    headRefName: 'feature',
    headRefOid: 'head',
    identifier: '#1',
    title: 'Test PR',
    description: null,
    status: 'open',
    isDraft: false,
    additions: null,
    deletions: null,
    changedFiles: null,
    commitCount: null,
    mergeableStatus: null,
    mergeStateStatus: null,
    reviewDecision: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    mergedAt: null,
    author: null,
    labels: [],
    assignees: [],
    checks: [],
    ...overrides,
  };
}

describe('matchesSearchQuery', () => {
  it('matches everything for an empty (or all-whitespace) query', () => {
    const task = makeTask();
    expect(matchesSearchQuery(task, '')).toBe(true);
    expect(matchesSearchQuery(task, '   ')).toBe(true);
  });

  it('matches the task name, case-insensitively', () => {
    const task = makeTask({ name: 'Refactor the Diff Viewer' });
    expect(matchesSearchQuery(task, 'diff viewer')).toBe(true);
    expect(matchesSearchQuery(task, 'DIFF')).toBe(true);
    expect(matchesSearchQuery(task, 'unrelated')).toBe(false);
  });

  it("matches a Linked Issue's display identifier", () => {
    const linkedIssues: LinkedIssueRoles = {
      version: '1',
      spec: {
        provider: 'github',
        url: 'https://github.com/acme/repo/issues/42',
        title: 'Spec issue',
        identifier: '#42',
      },
    };
    const task = makeTask({ name: 'Unrelated name', linkedIssues });
    expect(matchesSearchQuery(task, '#42')).toBe(true);
    expect(matchesSearchQuery(task, '42')).toBe(true);
    expect(matchesSearchQuery(task, '#43')).toBe(false);
  });

  it("prefers a Linked Issue's own displayIdentifier over its raw identifier when both are set", () => {
    const linkedIssues: LinkedIssueRoles = {
      version: '1',
      spec: {
        provider: 'linear',
        url: 'https://linear.app/acme/issue/ACME-7',
        title: 'Spec issue',
        identifier: 'raw-id-7',
        displayIdentifier: 'ACME-7',
      },
    };
    const task = makeTask({ linkedIssues });
    expect(matchesSearchQuery(task, 'ACME-7')).toBe(true);
    expect(matchesSearchQuery(task, 'raw-id-7')).toBe(false);
  });

  it("matches a Pull Request's display identifier", () => {
    const task = makeTask({ prs: [makePr({ identifier: '#99' })] });
    expect(matchesSearchQuery(task, '#99')).toBe(true);
    expect(matchesSearchQuery(task, '#100')).toBe(false);
  });

  it('does not match a linked issue title or PR title alone — only display identifiers', () => {
    const linkedIssues: LinkedIssueRoles = {
      version: '1',
      origin: {
        provider: 'github',
        url: 'https://github.com/acme/repo/issues/1',
        title: 'A very specific title',
        identifier: '#1',
      },
    };
    const task = makeTask({ linkedIssues, prs: [makePr({ title: 'Another specific title' })] });
    expect(matchesSearchQuery(task, 'very specific title')).toBe(false);
    expect(matchesSearchQuery(task, 'another specific title')).toBe(false);
  });
});

describe('agentStateFilterValue', () => {
  it('maps the no-active-status aggregate (null) to the idle bucket', () => {
    expect(agentStateFilterValue(null)).toBe('idle');
  });

  it('passes every other AgentStatus through unchanged', () => {
    expect(agentStateFilterValue('working')).toBe('working');
    expect(agentStateFilterValue('awaiting-input')).toBe('awaiting-input');
    expect(agentStateFilterValue('error')).toBe('error');
    expect(agentStateFilterValue('completed')).toBe('completed');
  });
});

describe('linkedIssuePresenceFilterValue', () => {
  it('is "linked" when any Linked Issue role is set', () => {
    const linkedIssues: LinkedIssueRoles = {
      version: '1',
      origin: {
        provider: 'github',
        url: 'https://github.com/acme/repo/issues/1',
        title: 'Origin',
        identifier: '#1',
      },
    };
    expect(linkedIssuePresenceFilterValue(makeTask({ linkedIssues }))).toBe('linked');
  });

  it('is "unlinked" when no Linked Issue role is set', () => {
    expect(linkedIssuePresenceFilterValue(makeTask())).toBe('unlinked');
  });
});

describe('prStateFilterValue', () => {
  it('is "none" for a task with no PRs', () => {
    expect(prStateFilterValue(makeTask())).toBe('none');
  });

  it('prefers open over merged and closed', () => {
    const task = makeTask({
      prs: [
        makePr({ url: 'https://github.com/acme/repo/pull/1', status: 'merged' }),
        makePr({ url: 'https://github.com/acme/repo/pull/2', status: 'open' }),
        makePr({ url: 'https://github.com/acme/repo/pull/3', status: 'closed' }),
      ],
    });
    expect(prStateFilterValue(task)).toBe('open');
  });

  it('prefers merged over closed when no PR is open', () => {
    const task = makeTask({
      prs: [
        makePr({ url: 'https://github.com/acme/repo/pull/1', status: 'closed' }),
        makePr({ url: 'https://github.com/acme/repo/pull/2', status: 'merged' }),
      ],
    });
    expect(prStateFilterValue(task)).toBe('merged');
  });

  it('is "closed" when every PR is closed', () => {
    const task = makeTask({ prs: [makePr({ status: 'closed' })] });
    expect(prStateFilterValue(task)).toBe('closed');
  });
});

describe('toggleSetMember', () => {
  it('adds a value not already present, without mutating the input set', () => {
    const input = new Set<string>(['a']);
    const result = toggleSetMember(input, 'b');
    expect(result).toEqual(new Set(['a', 'b']));
    expect(input).toEqual(new Set(['a']));
  });

  it('removes a value already present', () => {
    const result = toggleSetMember(new Set(['a', 'b']), 'a');
    expect(result).toEqual(new Set(['b']));
  });
});

describe('hasActiveBoardFilters', () => {
  it('is false for the empty filter state', () => {
    expect(hasActiveBoardFilters(EMPTY_BOARD_FILTERS)).toBe(false);
  });

  it('is true when the search query is non-empty', () => {
    expect(hasActiveBoardFilters({ ...EMPTY_BOARD_FILTERS, query: 'x' })).toBe(true);
  });

  it('is true when Needs Attention is on', () => {
    expect(hasActiveBoardFilters({ ...EMPTY_BOARD_FILTERS, needsAttentionOnly: true })).toBe(true);
  });

  it('is true when any compact filter category has a selection', () => {
    expect(
      hasActiveBoardFilters({
        ...EMPTY_BOARD_FILTERS,
        stages: new Set<WorkflowStage | 'unstaged'>(['idea']),
      })
    ).toBe(true);
  });

  it('is false for a query of only whitespace', () => {
    expect(hasActiveBoardFilters({ ...EMPTY_BOARD_FILTERS, query: '   ' })).toBe(false);
  });
});

describe('taskPassesBoardFilters', () => {
  it('passes everything through the empty filter state', () => {
    expect(taskPassesBoardFilters(makeTask(), null, EMPTY_BOARD_FILTERS)).toBe(true);
    expect(taskPassesBoardFilters(makeTask(), 'error', EMPTY_BOARD_FILTERS)).toBe(true);
  });

  it('Needs Attention hides a task whose agent status does not need attention', () => {
    const filters: BoardFilterState = { ...EMPTY_BOARD_FILTERS, needsAttentionOnly: true };
    expect(taskPassesBoardFilters(makeTask(), 'working', filters)).toBe(false);
    expect(taskPassesBoardFilters(makeTask(), null, filters)).toBe(false);
    expect(taskPassesBoardFilters(makeTask(), 'awaiting-input', filters)).toBe(true);
    expect(taskPassesBoardFilters(makeTask(), 'error', filters)).toBe(true);
    expect(taskPassesBoardFilters(makeTask(), 'completed', filters)).toBe(true);
  });

  it('combines search with a compact filter (AND across categories)', () => {
    const filters: BoardFilterState = {
      ...EMPTY_BOARD_FILTERS,
      query: 'diff',
      agentStates: new Set(['error']),
    };
    expect(taskPassesBoardFilters(makeTask({ name: 'Fix the diff' }), 'error', filters)).toBe(
      true
    );
    // Matches the search but not the agent-state filter.
    expect(taskPassesBoardFilters(makeTask({ name: 'Fix the diff' }), 'working', filters)).toBe(
      false
    );
    // Matches the agent-state filter but not the search.
    expect(
      taskPassesBoardFilters(makeTask({ name: 'Unrelated name' }), 'error', filters)
    ).toBe(false);
  });

  it('a Workflow Stage filter with multiple selected values is an OR within the category', () => {
    const filters: BoardFilterState = {
      ...EMPTY_BOARD_FILTERS,
      stages: new Set<WorkflowStage | 'unstaged'>(['idea', 'spec']),
    };
    expect(taskPassesBoardFilters(makeTask({ workflowStage: 'idea' }), null, filters)).toBe(true);
    expect(taskPassesBoardFilters(makeTask({ workflowStage: 'spec' }), null, filters)).toBe(true);
    expect(
      taskPassesBoardFilters(makeTask({ workflowStage: 'implementing' }), null, filters)
    ).toBe(false);
    expect(taskPassesBoardFilters(makeTask({ workflowStage: undefined }), null, filters)).toBe(
      false
    );
  });

  it('a Linked Issue presence filter hides tasks in the unselected bucket', () => {
    const filters: BoardFilterState = {
      ...EMPTY_BOARD_FILTERS,
      linkedIssuePresence: new Set(['linked']),
    };
    const linkedIssues: LinkedIssueRoles = {
      version: '1',
      origin: {
        provider: 'github',
        url: 'https://github.com/acme/repo/issues/1',
        title: 'Origin',
        identifier: '#1',
      },
    };
    expect(taskPassesBoardFilters(makeTask({ linkedIssues }), null, filters)).toBe(true);
    expect(taskPassesBoardFilters(makeTask(), null, filters)).toBe(false);
  });

  it('a Pull Request state filter hides tasks in the unselected bucket', () => {
    const filters: BoardFilterState = { ...EMPTY_BOARD_FILTERS, prStates: new Set(['open']) };
    expect(
      taskPassesBoardFilters(makeTask({ prs: [makePr({ status: 'open' })] }), null, filters)
    ).toBe(true);
    expect(
      taskPassesBoardFilters(makeTask({ prs: [makePr({ status: 'merged' })] }), null, filters)
    ).toBe(false);
  });
});
