import { describe, expect, it } from 'vitest';
import { findUpdateFeedProblems } from './update-feed.ts';

// Verbatim from a fork build packaged with electron-builder.fork.config.ts.
const FORK_FEED = `owner: 64ix
repo: emdash
provider: github
releaseType: release
updaterCacheDirName: '@emdashemdash-desktop-updater'
`;

// Verbatim from an upstream stable build.
const UPSTREAM_FEED = `owner: generalaction
repo: emdash
provider: github
releaseType: draft
updaterCacheDirName: '@emdashemdash-desktop-updater'
`;

describe('findUpdateFeedProblems', () => {
  it('accepts a fork feed', () => {
    expect(findUpdateFeedProblems(FORK_FEED)).toEqual([]);
  });

  it('rejects the upstream feed', () => {
    expect(findUpdateFeedProblems(UPSTREAM_FEED)).toEqual([
      'expected "owner: 64ix", found "generalaction"',
      'references the upstream update feed ("generalaction")',
    ]);
  });

  it('rejects the R2 generic feed even when the owner is right', () => {
    expect(findUpdateFeedProblems(`${FORK_FEED}url: https://releases.emdash.sh\n`)).toEqual([
      'references the upstream update feed ("releases.emdash.sh")',
    ]);
  });

  it('rejects a publisher name, which would make the updater reject unsigned installers', () => {
    expect(findUpdateFeedProblems(`${FORK_FEED}publisherName: General Action, Inc.\n`)).toEqual([
      'carries "publisherName: General Action, Inc."; fork installers are unsigned, so the updater would refuse every update',
    ]);
  });

  it('reports a missing owner rather than passing on an empty manifest', () => {
    expect(findUpdateFeedProblems('')).toEqual([
      'expected "owner: 64ix", found no owner key',
      'expected "repo: emdash", found no repo key',
    ]);
  });
});
