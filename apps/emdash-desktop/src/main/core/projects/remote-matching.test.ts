import { describe, expect, it, vi } from 'vitest';
import {
  normalizeRemoteUrl,
  remotePairKey,
  remotePairSet,
  remotePairSetsMatch,
  sshConnectionFingerprint,
} from './remote-matching';

// The module imports the app's singleton db client; none of these pure tests
// touch the database, so a lazy getter that throws keeps the import side
// effect (a real SQLite connection) out of the node test project.
vi.mock('@main/db/client', () => ({
  get db() {
    throw new Error('remote-matching unit tests must not touch the database');
  },
}));

describe('remote matching helpers (spec #130, ticket #136)', () => {
  it('normalizes remote URLs like the app does elsewhere (ssh + https + .git)', () => {
    expect(normalizeRemoteUrl('git@github.com:org/repo.git')).toBe('https://github.com/org/repo');
    expect(normalizeRemoteUrl('https://github.com/org/repo')).toBe('https://github.com/org/repo');
    expect(normalizeRemoteUrl('https://github.com/org/repo.git')).toBe(
      'https://github.com/org/repo'
    );
    expect(normalizeRemoteUrl('ssh://git@github.com:22/org/repo.git')).toBe(
      'https://github.com/org/repo'
    );
    // Non-parsable URLs (local paths, exotic hosts) fall back to the raw value.
    expect(normalizeRemoteUrl('/srv/git/repo.git')).toBe('/srv/git/repo.git');
    expect(normalizeRemoteUrl('git@my-git.internal:team/repo.git')).toBe(
      'https://my-git.internal/team/repo'
    );
  });

  it('pairs a remote name with its normalized url', () => {
    expect(remotePairKey('origin', 'git@github.com:org/repo.git')).toBe(
      'origin:https://github.com/org/repo'
    );
    expect(remotePairKey('origin', 'https://github.com/org/repo')).toBe(
      remotePairKey('origin', 'git@github.com:org/repo.git')
    );
    // Same URL under different remote names is a different pair.
    expect(remotePairKey('upstream', 'https://github.com/org/repo')).not.toBe(
      remotePairKey('origin', 'https://github.com/org/repo')
    );
  });

  it('matches pair sets exactly, ignoring url spelling differences', () => {
    const a = [
      { name: 'origin', url: 'git@github.com:org/repo.git' },
      { name: 'upstream', url: 'https://github.com/upstream/repo' },
    ];
    const b = [
      { name: 'origin', url: 'https://github.com/org/repo' },
      { name: 'upstream', url: 'git@github.com:upstream/repo.git' },
    ];
    expect(remotePairSetsMatch(a, b)).toBe(true);
  });

  it('rejects mismatched names, urls, or sizes', () => {
    expect(
      remotePairSetsMatch(
        [{ name: 'origin', url: 'https://github.com/org/repo' }],
        [{ name: 'upstream', url: 'https://github.com/org/repo' }]
      )
    ).toBe(false);
    expect(
      remotePairSetsMatch(
        [{ name: 'origin', url: 'https://github.com/org/repo' }],
        [{ name: 'origin', url: 'https://github.com/other/repo' }]
      )
    ).toBe(false);
    expect(
      remotePairSetsMatch(
        [{ name: 'origin', url: 'https://github.com/org/repo' }],
        [
          { name: 'origin', url: 'https://github.com/org/repo' },
          { name: 'upstream', url: 'https://github.com/upstream/repo' },
        ]
      )
    ).toBe(false);
  });

  it('never matches when either side has no remotes', () => {
    expect(remotePairSetsMatch([], [{ name: 'origin', url: 'https://github.com/org/repo' }])).toBe(
      false
    );
    expect(remotePairSetsMatch([], [])).toBe(false);
  });

  it('derives the ssh merge fingerprint from host/port/username, not the connection id', () => {
    expect(sshConnectionFingerprint('example.com', 22, 'alice')).toBe('example.com:22:alice');
    expect(sshConnectionFingerprint('example.com', 22, 'bob')).not.toBe(
      sshConnectionFingerprint('example.com', 22, 'alice')
    );
    expect(sshConnectionFingerprint('example.com', 2222, 'alice')).not.toBe(
      sshConnectionFingerprint('example.com', 22, 'alice')
    );
  });

  it('builds a pair set from remote lists', () => {
    expect(
      remotePairSet([
        { name: 'origin', url: 'git@github.com:org/repo.git' },
        { name: 'origin', url: 'https://github.com/org/repo' },
      ])
    ).toEqual(new Set(['origin:https://github.com/org/repo']));
  });
});
