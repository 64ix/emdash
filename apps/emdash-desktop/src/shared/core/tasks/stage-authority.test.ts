import { describe, expect, it } from 'vitest';
import type { LinkedIssue } from '@shared/core/linked-issue';
import {
  deriveStageAuthority,
  describeStageAuthorityFact,
  isStageDestinationSafe,
  type StageAuthorityFact,
} from './stage-authority';
import type { StageHoldingPr, TaskStageAuthority, WorkflowStage } from './tasks';

function issue(overrides: Partial<LinkedIssue> = {}): LinkedIssue {
  return {
    provider: 'github',
    url: 'https://github.com/acme/repo/issues/1',
    title: 'Example issue',
    identifier: '#1',
    ...overrides,
  };
}

function pr(overrides: Partial<StageHoldingPr> = {}): StageHoldingPr {
  return {
    url: 'https://github.com/acme/repo/pull/1',
    title: 'Example PR',
    identifier: '#1',
    status: 'open',
    isDraft: false,
    ...overrides,
  };
}

function prAuthority(overrides: Partial<TaskStageAuthority> = {}): TaskStageAuthority {
  return { holdingPr: null, isCurrentStageGithubProven: false, ...overrides };
}

describe('deriveStageAuthority — manual/unknown placement', () => {
  it('is manual with no linked issues, no PR authority and no workspace', () => {
    expect(deriveStageAuthority({ currentStage: 'idea', hasWorkspace: false })).toEqual({
      fact: { kind: 'manual' },
      governs: false,
    });
  });

  it('is manual for an unstaged task', () => {
    expect(deriveStageAuthority({ currentStage: null, hasWorkspace: false })).toEqual({
      fact: { kind: 'manual' },
      governs: false,
    });
  });
});

describe('deriveStageAuthority — open Map (false-authority regression, ticket #56)', () => {
  it('governs Exploring when the linked Map issue is open on GitHub', () => {
    const map = issue({ identifier: '#55', status: 'open' });
    const result = deriveStageAuthority({
      currentStage: 'exploring',
      linkedIssues: { version: '1', map },
      hasWorkspace: false,
    });
    expect(result).toEqual({ fact: { kind: 'open-map', issue: map }, governs: true });
  });

  it('governs an Idea/Unstaged card too — an open Map issue would advance it into Exploring next sync pass', () => {
    const map = issue({ identifier: '#55', status: 'open' });
    for (const currentStage of ['idea', null] as const) {
      const result = deriveStageAuthority({
        currentStage,
        linkedIssues: { version: '1', map },
        hasWorkspace: false,
      });
      expect(result.fact).toEqual({ kind: 'open-map', issue: map });
      expect(result.governs).toBe(true);
    }
  });

  it('is manual — not open-map — when the Map issue is closed', () => {
    const map = issue({ identifier: '#55', status: 'closed' });
    const result = deriveStageAuthority({
      currentStage: 'exploring',
      linkedIssues: { version: '1', map },
      hasWorkspace: false,
    });
    expect(result).toEqual({ fact: { kind: 'manual' }, governs: false });
  });

  it('is manual — not open-map — when the Map issue is from a non-GitHub provider', () => {
    const map = issue({ provider: 'gitlab', identifier: '#55', status: 'open' });
    const result = deriveStageAuthority({
      currentStage: 'exploring',
      linkedIssues: { version: '1', map },
      hasWorkspace: false,
    });
    expect(result.fact).toEqual({ kind: 'manual' });
  });

  it('does not govern once already advanced past Exploring (never regresses a stronger stage)', () => {
    const map = issue({ identifier: '#55', status: 'open' });
    for (const currentStage of ['spec', 'implementing', 'review', 'shipped'] as const) {
      const result = deriveStageAuthority({
        currentStage,
        linkedIssues: { version: '1', map },
        hasWorkspace: false,
      });
      expect(result).toEqual({ fact: { kind: 'manual' }, governs: false });
    }
  });

  it('a Spec link, even closed, always pre-empts a Map fact', () => {
    const map = issue({ identifier: '#55', status: 'open' });
    const spec = issue({ identifier: '#56', status: 'closed', url: 'https://x/issues/56' });
    const result = deriveStageAuthority({
      currentStage: 'exploring',
      linkedIssues: { version: '1', map, spec },
      hasWorkspace: false,
    });
    // Falls to the closed-Spec Triage contradiction, not open-map.
    expect(result.fact.kind).toBe('triage-contradiction');
  });
});

describe('deriveStageAuthority — open Spec', () => {
  it('governs Spec when the linked Spec issue is open on GitHub', () => {
    const spec = issue({ identifier: '#30', status: 'open' });
    const result = deriveStageAuthority({
      currentStage: 'spec',
      linkedIssues: { version: '1', spec },
      hasWorkspace: false,
    });
    expect(result).toEqual({ fact: { kind: 'open-spec', issue: spec }, governs: true });
  });

  it('governs an Exploring/Idea/Unstaged card too — pending advance into Spec', () => {
    const spec = issue({ identifier: '#30', status: 'open' });
    for (const currentStage of ['exploring', 'idea', null] as const) {
      const result = deriveStageAuthority({
        currentStage,
        linkedIssues: { version: '1', spec },
        hasWorkspace: false,
      });
      expect(result.fact).toEqual({ kind: 'open-spec', issue: spec });
      expect(result.governs).toBe(true);
    }
  });

  it('does not govern once already advanced past Spec', () => {
    const spec = issue({ identifier: '#30', status: 'open' });
    for (const currentStage of ['implementing', 'review', 'shipped'] as const) {
      const result = deriveStageAuthority({
        currentStage,
        linkedIssues: { version: '1', spec },
        hasWorkspace: false,
      });
      expect(result).toEqual({ fact: { kind: 'manual' }, governs: false });
    }
  });

  it('is not open-spec when the Spec issue is closed — it reads as the closed-Spec Triage contradiction instead', () => {
    const spec = issue({ identifier: '#30', status: 'closed' });
    const result = deriveStageAuthority({
      currentStage: 'implementing',
      linkedIssues: { version: '1', spec },
      hasWorkspace: false,
    });
    expect(result.fact.kind).not.toBe('open-spec');
    expect(result.fact).toEqual({
      kind: 'triage-contradiction',
      reason: { kind: 'closed-spec', issue: spec },
    });
  });
});

describe('deriveStageAuthority — provisioned/active implementation', () => {
  it('explains, but does not govern, Implementing backed by a provisioned workspace', () => {
    const result = deriveStageAuthority({ currentStage: 'implementing', hasWorkspace: true });
    expect(result).toEqual({ fact: { kind: 'provisioned-implementation' }, governs: false });
  });

  it('is manual for Implementing with no provisioned workspace', () => {
    const result = deriveStageAuthority({ currentStage: 'implementing', hasWorkspace: false });
    expect(result).toEqual({ fact: { kind: 'manual' }, governs: false });
  });
});

describe('deriveStageAuthority — open PR (direction-independent, mirrors deriveTaskStageAuthorityFact)', () => {
  it('governs Review for an open Spec-referencing PR regardless of the persisted current stage', () => {
    const open = pr({ status: 'open', identifier: '#77' });
    for (const currentStage of ['idea', 'implementing', 'review'] as const) {
      const result = deriveStageAuthority({
        currentStage,
        prAuthority: prAuthority({ holdingPr: open, isCurrentStageGithubProven: true }),
        hasWorkspace: false,
      });
      expect(result).toEqual({ fact: { kind: 'open-pr', pr: open }, governs: true });
    }
  });

  it('is not governed when the PR fact does not currently prove the persisted stage (isCurrentStageGithubProven false)', () => {
    const open = pr({ status: 'open' });
    const result = deriveStageAuthority({
      currentStage: 'idea',
      prAuthority: prAuthority({ holdingPr: open, isCurrentStageGithubProven: false }),
      hasWorkspace: false,
    });
    expect(result).toEqual({ fact: { kind: 'manual' }, governs: false });
  });
});

describe('deriveStageAuthority — merged PR', () => {
  it('governs Shipped for a merged Spec-referencing PR', () => {
    const merged = pr({ status: 'merged', identifier: '#78' });
    const result = deriveStageAuthority({
      currentStage: 'shipped',
      prAuthority: prAuthority({ holdingPr: merged, isCurrentStageGithubProven: true }),
      hasWorkspace: false,
    });
    expect(result).toEqual({ fact: { kind: 'merged-pr', pr: merged }, governs: true });
  });
});

describe('deriveStageAuthority — Triage-causing contradictions', () => {
  it('governs a closed-PR contradiction even before the persisted stage has swept to Triage', () => {
    const closed = pr({ status: 'closed', identifier: '#79' });
    const result = deriveStageAuthority({
      currentStage: 'idea',
      prAuthority: prAuthority({ holdingPr: closed, isCurrentStageGithubProven: true }),
      hasWorkspace: false,
    });
    expect(result).toEqual({
      fact: { kind: 'triage-contradiction', reason: { kind: 'closed-pr', pr: closed } },
      governs: true,
    });
  });

  it('does not govern once the task currently sits in Triage, even with a holding closed PR', () => {
    const closed = pr({ status: 'closed' });
    const result = deriveStageAuthority({
      currentStage: 'triage',
      prAuthority: prAuthority({ holdingPr: closed, isCurrentStageGithubProven: false }),
      hasWorkspace: false,
    });
    expect(result).toEqual({ fact: { kind: 'manual' }, governs: false });
  });

  it('governs a closed-Spec contradiction (Spec closed mid-flight, no merged PR)', () => {
    const spec = issue({ identifier: '#30', status: 'closed' });
    const result = deriveStageAuthority({
      currentStage: 'implementing',
      linkedIssues: { version: '1', spec },
      hasWorkspace: false,
    });
    expect(result).toEqual({
      fact: { kind: 'triage-contradiction', reason: { kind: 'closed-spec', issue: spec } },
      governs: true,
    });
  });

  it('does not raise the closed-Spec contradiction once the task is already in Triage', () => {
    const spec = issue({ identifier: '#30', status: 'closed' });
    const result = deriveStageAuthority({
      currentStage: 'triage',
      linkedIssues: { version: '1', spec },
      hasWorkspace: false,
    });
    expect(result).toEqual({ fact: { kind: 'manual' }, governs: false });
  });

  it('does not raise the closed-Spec contradiction against Review/Shipped — PR-proven stages it cannot outrank', () => {
    const spec = issue({ identifier: '#30', status: 'closed' });
    for (const currentStage of ['review', 'shipped'] as const) {
      const result = deriveStageAuthority({
        currentStage,
        linkedIssues: { version: '1', spec },
        hasWorkspace: false,
      });
      expect(result).toEqual({ fact: { kind: 'manual' }, governs: false });
    }
  });

  it('leaves the stage unexplained when the Spec closed but a merged PR already proves Shipped', () => {
    const spec = issue({ identifier: '#30', status: 'closed' });
    const merged = pr({ status: 'merged' });
    const result = deriveStageAuthority({
      currentStage: 'shipped',
      linkedIssues: { version: '1', spec },
      prAuthority: prAuthority({ holdingPr: merged, isCurrentStageGithubProven: true }),
      hasWorkspace: false,
    });
    // The PR fact wins outright (step 1) — the merged PR explains Shipped,
    // the closed Spec is never even consulted.
    expect(result).toEqual({ fact: { kind: 'merged-pr', pr: merged }, governs: true });
  });
});

describe('isStageDestinationSafe', () => {
  const allStages: (WorkflowStage | null)[] = [
    null,
    'idea',
    'exploring',
    'spec',
    'implementing',
    'review',
    'shipped',
    'triage',
  ];

  it('never treats a governing fact as unsafe against Triage', () => {
    const facts: StageAuthorityFact[] = [
      { kind: 'open-map', issue: issue() },
      { kind: 'open-spec', issue: issue() },
      { kind: 'open-pr', pr: pr({ status: 'open' }) },
      { kind: 'merged-pr', pr: pr({ status: 'merged' }) },
      { kind: 'triage-contradiction', reason: { kind: 'closed-pr', pr: pr({ status: 'closed' }) } },
    ];
    for (const fact of facts) expect(isStageDestinationSafe(fact, 'triage')).toBe(true);
  });

  it('open-map: only destinations ranked past Exploring are safe', () => {
    const fact: StageAuthorityFact = { kind: 'open-map', issue: issue() };
    const safe = allStages.filter((s) => isStageDestinationSafe(fact, s));
    expect(safe).toEqual(['spec', 'implementing', 'review', 'shipped', 'triage']);
  });

  it('open-spec: only destinations ranked past Spec are safe', () => {
    const fact: StageAuthorityFact = { kind: 'open-spec', issue: issue() };
    const safe = allStages.filter((s) => isStageDestinationSafe(fact, s));
    expect(safe).toEqual(['implementing', 'review', 'shipped', 'triage']);
  });

  it('open-pr: no destination is safe except Triage', () => {
    const fact: StageAuthorityFact = { kind: 'open-pr', pr: pr({ status: 'open' }) };
    const safe = allStages.filter((s) => isStageDestinationSafe(fact, s));
    expect(safe).toEqual(['triage']);
  });

  it('merged-pr: no destination is safe except Triage', () => {
    const fact: StageAuthorityFact = { kind: 'merged-pr', pr: pr({ status: 'merged' }) };
    const safe = allStages.filter((s) => isStageDestinationSafe(fact, s));
    expect(safe).toEqual(['triage']);
  });

  it('closed-pr Triage contradiction: no destination is safe except Triage', () => {
    const fact: StageAuthorityFact = {
      kind: 'triage-contradiction',
      reason: { kind: 'closed-pr', pr: pr({ status: 'closed' }) },
    };
    const safe = allStages.filter((s) => isStageDestinationSafe(fact, s));
    expect(safe).toEqual(['triage']);
  });

  it('closed-spec Triage contradiction: Review, Shipped and Triage are safe (issue facts cannot outrank a PR-proven stage)', () => {
    const fact: StageAuthorityFact = {
      kind: 'triage-contradiction',
      reason: { kind: 'closed-spec', issue: issue() },
    };
    const safe = allStages.filter((s) => isStageDestinationSafe(fact, s));
    expect(safe).toEqual(['review', 'shipped', 'triage']);
  });

  it('manual and provisioned-implementation never restrict any destination', () => {
    for (const fact of [
      { kind: 'manual' } as const,
      { kind: 'provisioned-implementation' } as const,
    ]) {
      for (const stage of allStages) expect(isStageDestinationSafe(fact, stage)).toBe(true);
    }
  });
});

describe('describeStageAuthorityFact', () => {
  it('names the open PR and the action required for Review', () => {
    const description = describeStageAuthorityFact({
      kind: 'open-pr',
      pr: pr({ identifier: '#77' }),
    });
    expect(description?.fact).toContain('Review');
    expect(description?.fact).toContain('#77');
    expect(description?.action).toContain('#77');
    expect(description?.link).toEqual({ url: 'https://github.com/acme/repo/pull/1', label: '#77' });
  });

  it('names the merged PR for Shipped, with no reversible action', () => {
    const description = describeStageAuthorityFact({
      kind: 'merged-pr',
      pr: pr({ status: 'merged', identifier: '#78' }),
    });
    expect(description?.fact).toContain('Shipped');
    expect(description?.action).toContain('permanent');
  });

  it('names the open Map issue for Exploring', () => {
    const description = describeStageAuthorityFact({
      kind: 'open-map',
      issue: issue({ identifier: '#55' }),
    });
    expect(description?.fact).toContain('Exploring');
    expect(description?.fact).toContain('#55');
  });

  it('names the open Spec issue for Spec', () => {
    const description = describeStageAuthorityFact({
      kind: 'open-spec',
      issue: issue({ identifier: '#56' }),
    });
    expect(description?.fact).toContain('Spec');
    expect(description?.fact).toContain('#56');
  });

  it('names the closed PR for the Triage contradiction', () => {
    const description = describeStageAuthorityFact({
      kind: 'triage-contradiction',
      reason: { kind: 'closed-pr', pr: pr({ status: 'closed', identifier: '#79' }) },
    });
    expect(description?.fact).toContain('Triage');
    expect(description?.fact).toContain('#79');
  });

  it('names the closed Spec issue for the Triage contradiction', () => {
    const description = describeStageAuthorityFact({
      kind: 'triage-contradiction',
      reason: { kind: 'closed-spec', issue: issue({ identifier: '#30' }) },
    });
    expect(description?.fact).toContain('Triage');
    expect(description?.fact).toContain('#30');
  });

  it('has no explanation for manual or provisioned-implementation placements', () => {
    expect(describeStageAuthorityFact({ kind: 'manual' })).toBeNull();
    expect(describeStageAuthorityFact({ kind: 'provisioned-implementation' })).toBeNull();
  });
});
