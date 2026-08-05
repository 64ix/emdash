import { afterEach, describe, expect, it } from 'vitest';
import { comparePlainVersions, resolveReleaseVersion } from './version.ts';

const originalRunNumber = process.env.GITHUB_RUN_NUMBER;

afterEach(() => {
  if (originalRunNumber === undefined) {
    delete process.env.GITHUB_RUN_NUMBER;
  } else {
    process.env.GITHUB_RUN_NUMBER = originalRunNumber;
  }
});

describe('resolveReleaseVersion', () => {
  it('uses a validated explicit stable version without changing package.json', () => {
    expect(resolveReleaseVersion('stable', '1.2.8')).toEqual({
      version: '1.2.8',
      tag: 'v1.2.8',
      isCanary: false,
    });
  });

  it.each(['1.2', 'v1.2.8', '1.2.8-beta.1', '1.2.8; echo unsafe'])(
    'rejects invalid explicit version %s',
    (version) => {
      expect(() => resolveReleaseVersion('stable', version)).toThrow(
        'must be a plain major.minor.patch'
      );
    }
  );

  it('rejects an explicit canary version', () => {
    expect(() => resolveReleaseVersion('canary', '1.2.8')).toThrow(
      'only supported on the stable channel'
    );
  });
});

describe('comparePlainVersions', () => {
  it.each([
    ['1.2.8', '1.2.7', 1],
    ['1.3.0', '1.2.99', 1],
    ['2.0.0', '10.0.0', -1],
    ['1.2.8', '1.2.8', 0],
  ] as const)('compares %s with %s', (left, right, expected) => {
    expect(comparePlainVersions(left, right)).toBe(expected);
  });
});
