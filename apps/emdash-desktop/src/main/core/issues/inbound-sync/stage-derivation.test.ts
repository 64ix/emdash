import { describe, expect, it } from 'vitest';
import { deriveWorkflowStageFromIssues } from './stage-derivation';

describe('deriveWorkflowStageFromIssues', () => {
  it('derives spec from an open Spec issue on an unstaged task', () => {
    expect(
      deriveWorkflowStageFromIssues({
        currentStage: undefined,
        specIssue: { state: 'open' },
        hasMergedPullRequest: false,
      })
    ).toBe('spec');
  });

  it('derives exploring from an open Map issue when there is no Spec link', () => {
    expect(
      deriveWorkflowStageFromIssues({
        currentStage: 'idea',
        mapIssue: { state: 'open' },
        hasMergedPullRequest: false,
      })
    ).toBe('exploring');
  });

  it('prefers the Spec fact over the Map fact when both links exist', () => {
    expect(
      deriveWorkflowStageFromIssues({
        currentStage: 'exploring',
        specIssue: { state: 'open' },
        mapIssue: { state: 'open' },
        hasMergedPullRequest: false,
      })
    ).toBe('spec');
  });

  it('derives triage when the Spec closes without a merged PR', () => {
    expect(
      deriveWorkflowStageFromIssues({
        currentStage: 'spec',
        specIssue: { state: 'closed' },
        hasMergedPullRequest: false,
      })
    ).toBe('triage');
  });

  it('leaves the stage untouched when the Spec closes with a merged PR (owned by PR-fact derivation)', () => {
    expect(
      deriveWorkflowStageFromIssues({
        currentStage: 'shipped',
        specIssue: { state: 'closed' },
        hasMergedPullRequest: true,
      })
    ).toBeNull();
  });

  it('never derives a change once a task is already in triage', () => {
    expect(
      deriveWorkflowStageFromIssues({
        currentStage: 'triage',
        specIssue: { state: 'open' },
        hasMergedPullRequest: false,
      })
    ).toBeNull();
    expect(
      deriveWorkflowStageFromIssues({
        currentStage: 'triage',
        mapIssue: { state: 'open' },
        hasMergedPullRequest: false,
      })
    ).toBeNull();
  });

  it('never regresses a stage already advanced past what issue facts prove', () => {
    expect(
      deriveWorkflowStageFromIssues({
        currentStage: 'implementing',
        specIssue: { state: 'open' },
        hasMergedPullRequest: false,
      })
    ).toBeNull();
    expect(
      deriveWorkflowStageFromIssues({
        currentStage: 'review',
        specIssue: { state: 'open' },
        hasMergedPullRequest: false,
      })
    ).toBeNull();
    expect(
      deriveWorkflowStageFromIssues({
        currentStage: 'shipped',
        mapIssue: { state: 'open' },
        hasMergedPullRequest: false,
      })
    ).toBeNull();
  });

  it('never drags a PR-proven review/shipped task into triage when the Spec closes', () => {
    // e.g. "Closes #N" auto-closes the Spec before the merged PR row is synced
    // locally — review/shipped are PR-fact stages a closed Spec cannot outrank.
    expect(
      deriveWorkflowStageFromIssues({
        currentStage: 'review',
        specIssue: { state: 'closed' },
        hasMergedPullRequest: false,
      })
    ).toBeNull();
    expect(
      deriveWorkflowStageFromIssues({
        currentStage: 'shipped',
        specIssue: { state: 'closed' },
        hasMergedPullRequest: false,
      })
    ).toBeNull();
  });

  it('still derives triage from a mid-flight stage when the Spec closes without a merged PR', () => {
    expect(
      deriveWorkflowStageFromIssues({
        currentStage: 'implementing',
        specIssue: { state: 'closed' },
        hasMergedPullRequest: false,
      })
    ).toBe('triage');
  });

  it('returns null when neither issue fact applies', () => {
    expect(
      deriveWorkflowStageFromIssues({
        currentStage: 'idea',
        hasMergedPullRequest: false,
      })
    ).toBeNull();
    expect(
      deriveWorkflowStageFromIssues({
        currentStage: 'idea',
        mapIssue: { state: 'closed' },
        hasMergedPullRequest: false,
      })
    ).toBeNull();
  });

  it('is idempotent when the desired stage already matches the current one', () => {
    expect(
      deriveWorkflowStageFromIssues({
        currentStage: 'spec',
        specIssue: { state: 'open' },
        hasMergedPullRequest: false,
      })
    ).toBe('spec');
  });
});
