import { describe, expect, it } from 'vitest';
import { parseGitHubIssueUrl } from './github-issue-url';

describe('parseGitHubIssueUrl', () => {
  it('parses a github.com issue URL', () => {
    const parsed = parseGitHubIssueUrl('https://github.com/acme/repo/issues/42');
    expect(parsed?.number).toBe(42);
    expect(parsed?.repository.repositoryUrl).toBe('https://github.com/acme/repo');
  });

  it('parses a GitHub Enterprise issue URL', () => {
    const parsed = parseGitHubIssueUrl('https://ghe.example.com/acme/repo/issues/7');
    expect(parsed?.number).toBe(7);
    expect(parsed?.repository.repositoryUrl).toBe('https://ghe.example.com/acme/repo');
  });

  it('normalizes the host the same way parseRepositoryRef does', () => {
    const parsed = parseGitHubIssueUrl('https://www.github.com/acme/repo/issues/1');
    expect(parsed?.repository.repositoryUrl).toBe('https://github.com/acme/repo');
  });

  it('returns null for a pull request URL', () => {
    expect(parseGitHubIssueUrl('https://github.com/acme/repo/pull/42')).toBeNull();
  });

  it('returns null for a repository URL with no issue path', () => {
    expect(parseGitHubIssueUrl('https://github.com/acme/repo')).toBeNull();
  });

  it('returns null for a malformed URL', () => {
    expect(parseGitHubIssueUrl('not-a-url')).toBeNull();
  });

  it('returns null when the issue number segment is missing or non-numeric', () => {
    expect(parseGitHubIssueUrl('https://github.com/acme/repo/issues/')).toBeNull();
    expect(parseGitHubIssueUrl('https://github.com/acme/repo/issues/abc')).toBeNull();
  });
});
