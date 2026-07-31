import { describe, expect, it } from 'vitest';
import {
  linkedIssueDisplayIdentifier,
  linkedIssueMentionName,
  linkedIssueRoles,
  linkedIssueRolesFromOrigin,
  mostAdvancedLinkedIssue,
  setLinkedIssueRole,
  type LinkedIssue,
  type LinkedIssueRoles,
} from './linked-issue';

function makeIssue(overrides: Partial<LinkedIssue> = {}): LinkedIssue {
  return {
    provider: 'github',
    identifier: '#42',
    title: 'Fix login',
    url: 'https://github.com/acme/repo/issues/42',
    ...overrides,
  };
}

describe('linkedIssueRoles versioned schema', () => {
  it('migrates a legacy (unversioned) single-issue link to the Origin role', () => {
    const legacy = makeIssue();
    const result = linkedIssueRoles.safeParse(legacy);

    expect(result).toEqual({
      status: 'ok',
      data: { version: '1', origin: legacy },
    });
  });

  it('parses a v1 role container unchanged', () => {
    const roles: LinkedIssueRoles = {
      version: '1',
      origin: makeIssue({ identifier: '#1' }),
      spec: makeIssue({ identifier: '#2' }),
    };
    const result = linkedIssueRoles.safeParse(roles);

    expect(result).toEqual({ status: 'ok', data: roles });
  });
});

describe('linkedIssueRolesFromOrigin', () => {
  it('returns null when no issue is given', () => {
    expect(linkedIssueRolesFromOrigin(undefined)).toBeNull();
    expect(linkedIssueRolesFromOrigin(null)).toBeNull();
  });

  it('wraps the issue as the Origin role', () => {
    const issue = makeIssue();
    expect(linkedIssueRolesFromOrigin(issue)).toEqual({ version: '1', origin: issue });
  });
});

describe('setLinkedIssueRole', () => {
  it('sets a role on an empty container', () => {
    const issue = makeIssue();
    expect(setLinkedIssueRole(undefined, 'spec', issue)).toEqual({ version: '1', spec: issue });
  });

  it('adds a role alongside existing roles without disturbing them', () => {
    const origin = makeIssue({ identifier: '#1' });
    const spec = makeIssue({ identifier: '#2' });
    const roles: LinkedIssueRoles = { version: '1', origin };

    expect(setLinkedIssueRole(roles, 'spec', spec)).toEqual({ version: '1', origin, spec });
  });

  it('replaces the issue already set for a role', () => {
    const oldSpec = makeIssue({ identifier: '#1' });
    const newSpec = makeIssue({ identifier: '#2' });
    const roles: LinkedIssueRoles = { version: '1', spec: oldSpec };

    expect(setLinkedIssueRole(roles, 'spec', newSpec)).toEqual({ version: '1', spec: newSpec });
  });

  it('clears a single role, keeping the others', () => {
    const origin = makeIssue({ identifier: '#1' });
    const roles: LinkedIssueRoles = { version: '1', origin, spec: makeIssue({ identifier: '#2' }) };

    expect(setLinkedIssueRole(roles, 'spec', null)).toEqual({ version: '1', origin });
  });

  it('returns undefined when clearing the only set role', () => {
    const roles: LinkedIssueRoles = { version: '1', origin: makeIssue() };
    expect(setLinkedIssueRole(roles, 'origin', null)).toBeUndefined();
  });

  it('returns undefined when clearing a role on an already-empty container', () => {
    expect(setLinkedIssueRole(undefined, 'origin', null)).toBeUndefined();
  });
});

describe('mostAdvancedLinkedIssue', () => {
  it('returns null when there are no linked issues', () => {
    expect(mostAdvancedLinkedIssue(undefined)).toBeNull();
    expect(mostAdvancedLinkedIssue(null)).toBeNull();
  });

  it('prefers Spec over Map and Origin', () => {
    const spec = makeIssue({ identifier: 'spec-issue' });
    const roles: LinkedIssueRoles = {
      version: '1',
      origin: makeIssue({ identifier: 'origin-issue' }),
      map: makeIssue({ identifier: 'map-issue' }),
      spec,
    };

    expect(mostAdvancedLinkedIssue(roles)).toEqual({ role: 'spec', issue: spec });
  });

  it('prefers Map over Origin when there is no Spec', () => {
    const map = makeIssue({ identifier: 'map-issue' });
    const roles: LinkedIssueRoles = {
      version: '1',
      origin: makeIssue({ identifier: 'origin-issue' }),
      map,
    };

    expect(mostAdvancedLinkedIssue(roles)).toEqual({ role: 'map', issue: map });
  });

  it('falls back to Origin when Spec and Map are unset', () => {
    const origin = makeIssue({ identifier: 'origin-issue' });
    const roles: LinkedIssueRoles = { version: '1', origin };

    expect(mostAdvancedLinkedIssue(roles)).toEqual({ role: 'origin', issue: origin });
  });
});

describe('linked issue display helpers', () => {
  it('uses displayIdentifier for issue mentions when available', () => {
    expect(
      linkedIssueMentionName({
        identifier: 'internal-id',
        displayIdentifier: 'ENG-123',
        title: 'Fix issue mentions',
      })
    ).toBe('ENG-123');
  });

  it('uses title for issue mentions when the provider hides internal identifiers', () => {
    expect(
      linkedIssueMentionName({
        identifier: '37818d1b-a831-812e-8ca0-c115c72de662',
        displayIdentifier: null,
        title: 'ai health paper website',
      })
    ).toBe('ai health paper website');
  });

  it('keeps raw identifiers visible only when displayIdentifier is unspecified', () => {
    const issue = { identifier: '#42', title: 'Fix login' };

    expect(linkedIssueDisplayIdentifier(issue)).toBe('#42');
    expect(linkedIssueMentionName(issue)).toBe('#42');
  });

  it('uses a generic mention name when both display identifier and title are hidden', () => {
    expect(
      linkedIssueMentionName({
        identifier: 'internal-id',
        displayIdentifier: null,
        title: '',
      })
    ).toBe('Linked issue');
  });
});
