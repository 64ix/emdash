import { describe, expect, it } from 'vitest';
import { isRootIssueCandidate } from './root-issue';

function makeIssue(overrides: Partial<Parameters<typeof isRootIssueCandidate>[0]> = {}) {
  return {
    title: 'Fix the login bug',
    labels: [] as readonly string[],
    body: null as string | null,
    ...overrides,
  };
}

describe('isRootIssueCandidate', () => {
  it('accepts a plain open issue with no shape and no marker', () => {
    expect(isRootIssueCandidate(makeIssue())).toBe(true);
  });

  it('rejects a Spec-shaped issue', () => {
    expect(isRootIssueCandidate(makeIssue({ title: '[Spec] Feature' }))).toBe(false);
  });

  it('rejects any wayfinder:*-labelled issue, not just wayfinder:map', () => {
    expect(isRootIssueCandidate(makeIssue({ labels: ['wayfinder:map'] }))).toBe(false);
    expect(isRootIssueCandidate(makeIssue({ labels: ['wayfinder:research'] }))).toBe(false);
  });

  it('rejects an issue carrying a Task Marker, even one pointing at an unknown task', () => {
    expect(isRootIssueCandidate(makeIssue({ body: 'Emdash-Task: task-1' }))).toBe(false);
    expect(isRootIssueCandidate(makeIssue({ body: 'Emdash-Task: does-not-exist' }))).toBe(false);
  });

  it('accepts an issue whose body has no marker line at all', () => {
    expect(isRootIssueCandidate(makeIssue({ body: 'Just a description, no marker here.' }))).toBe(
      true
    );
  });
});
