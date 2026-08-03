import { describe, expect, it } from 'vitest';
import { classifyChatLink } from './chat-link-classification';

const WORKSPACE_ROOT = '/Users/dev/workspace';

function classify(href: string, workspaceRoot: string | null = WORKSPACE_ROOT) {
  return classifyChatLink(href, { workspaceRoot });
}

describe('classifyChatLink', () => {
  // ── workspace files ────────────────────────────────────────────────────────

  describe('workspace paths', () => {
    it('resolves a relative path against the workspace root', () => {
      expect(classify('docs/readme.md')).toEqual({
        kind: 'workspace-file',
        path: '/Users/dev/workspace/docs/readme.md',
      });
    });

    it('resolves a dot-relative path', () => {
      expect(classify('./docs/readme.md')).toEqual({
        kind: 'workspace-file',
        path: '/Users/dev/workspace/docs/readme.md',
      });
    });

    it('resolves an in-workspace relative path that dot-dots within bounds', () => {
      expect(classify('docs/../notes/readme.md')).toEqual({
        kind: 'workspace-file',
        path: '/Users/dev/workspace/notes/readme.md',
      });
    });

    it('normalizes an absolute path inside the workspace to the same action', () => {
      expect(classify('/Users/dev/workspace/src/foo.ts')).toEqual({
        kind: 'workspace-file',
        path: '/Users/dev/workspace/src/foo.ts',
      });
    });

    it('accepts the workspace root itself', () => {
      expect(classify('/Users/dev/workspace')).toEqual({
        kind: 'workspace-file',
        path: '/Users/dev/workspace',
      });
    });

    it('normalizes backslash separators (Windows-style relative path)', () => {
      expect(classify('src\\foo.ts', 'C:/Users/dev/workspace')).toEqual({
        kind: 'workspace-file',
        path: 'C:/Users/dev/workspace/src/foo.ts',
      });
    });

    it('normalizes a Windows drive-letter absolute path inside the workspace', () => {
      expect(classify('C:\\Users\\dev\\workspace\\src\\foo.ts', 'C:/Users/dev/workspace')).toEqual({
        kind: 'workspace-file',
        path: 'C:/Users/dev/workspace/src/foo.ts',
      });
    });

    it('decodes a percent-encoded space in a relative path', () => {
      expect(classify('docs/my%20file.md')).toEqual({
        kind: 'workspace-file',
        path: '/Users/dev/workspace/docs/my file.md',
      });
    });

    it('tolerates a trailing slash on the configured workspace root', () => {
      expect(
        classifyChatLink('docs/readme.md', { workspaceRoot: '/Users/dev/workspace/' })
      ).toEqual({
        kind: 'workspace-file',
        path: '/Users/dev/workspace/docs/readme.md',
      });
    });
  });

  // ── blocked: outside workspace / traversal / home paths ───────────────────

  describe('outside the workspace', () => {
    it('blocks a relative path that traverses above the workspace root', () => {
      const result = classify('docs/../../secret.md');
      expect(result).toEqual({
        kind: 'blocked',
        reason: 'outside-workspace',
        target: '/Users/dev/secret.md',
      });
    });

    it('blocks a percent-encoded traversal that decodes to a single ".."', () => {
      const result = classify('docs%2f..%2f..%2fsecret.md');
      expect(result.kind).toBe('blocked');
      expect((result as { reason: string }).reason).toBe('outside-workspace');
    });

    it('does NOT get fooled by double-encoded traversal (only ever decodes once)', () => {
      // %252e%252e decodes once to the literal text "%2e%2e" — never to "..".
      const result = classify('docs/%252e%252e/secret.md');
      expect(result).toEqual({
        kind: 'workspace-file',
        path: '/Users/dev/workspace/docs/%2e%2e/secret.md',
      });
    });

    it('blocks an absolute path outside the workspace', () => {
      expect(classify('/etc/passwd')).toEqual({
        kind: 'blocked',
        reason: 'outside-workspace',
        target: '/etc/passwd',
      });
    });

    it('blocks a home-relative path', () => {
      expect(classify('~/notes.md')).toEqual({
        kind: 'blocked',
        reason: 'outside-workspace',
        target: '~/notes.md',
      });
    });

    it('blocks a bare "~"', () => {
      expect(classify('~')).toEqual({
        kind: 'blocked',
        reason: 'outside-workspace',
        target: '~',
      });
    });

    it('blocks any filesystem path when there is no active workspace', () => {
      expect(classify('docs/readme.md', null)).toEqual({
        kind: 'blocked',
        reason: 'outside-workspace',
        target: 'docs/readme.md',
      });
    });

    it('blocks a relative path with enough ".." to walk above the drive/root anchor', () => {
      expect(classify('../../../../../../../../etc/passwd')).toEqual({
        kind: 'blocked',
        reason: 'outside-workspace',
        target: expect.stringContaining('etc/passwd'),
      });
    });
  });

  // ── local-artifact: absolute paths outside the workspace with a
  //    previewable extension (ticket #21) ───────────────────────────────────

  describe('local artifact candidates', () => {
    it('classifies an absolute image path outside the workspace as local-artifact', () => {
      expect(classify('/Users/dev/Desktop/chart.png')).toEqual({
        kind: 'local-artifact',
        path: '/Users/dev/Desktop/chart.png',
      });
    });

    it('classifies an absolute markdown/csv/text path outside the workspace as local-artifact', () => {
      expect(classify('/Users/dev/Desktop/notes.md')).toEqual({
        kind: 'local-artifact',
        path: '/Users/dev/Desktop/notes.md',
      });
      expect(classify('/Users/dev/Desktop/data.csv')).toEqual({
        kind: 'local-artifact',
        path: '/Users/dev/Desktop/data.csv',
      });
    });

    it('classifies a drive-letter image path outside the workspace as local-artifact', () => {
      expect(classify('D:\\Photos\\chart.png', 'C:/Users/dev/workspace')).toEqual({
        kind: 'local-artifact',
        path: 'D:/Photos/chart.png',
      });
    });

    it('still blocks an absolute path outside the workspace with an unsupported extension', () => {
      expect(classify('/etc/passwd')).toEqual({
        kind: 'blocked',
        reason: 'outside-workspace',
        target: '/etc/passwd',
      });
    });

    it('still blocks an absolute path outside the workspace with no extension', () => {
      expect(classify('/Users/dev/Desktop/README')).toEqual({
        kind: 'blocked',
        reason: 'outside-workspace',
        target: '/Users/dev/Desktop/README',
      });
    });

    it('never offers local-artifact for a relative path that traverses outside the workspace, even with a previewable extension', () => {
      const result = classify('docs/../../Desktop/chart.png');
      expect(result).toEqual({
        kind: 'blocked',
        reason: 'outside-workspace',
        target: '/Users/dev/Desktop/chart.png',
      });
    });

    it('never offers local-artifact for a percent-encoded relative traversal with a previewable extension', () => {
      const result = classify('docs%2f..%2f..%2fchart.png');
      expect(result.kind).toBe('blocked');
      expect((result as { reason: string }).reason).toBe('outside-workspace');
    });

    it('still blocks svg outside the workspace (active content risk; not previewed this increment)', () => {
      expect(classify('/Users/dev/Desktop/icon.svg')).toEqual({
        kind: 'blocked',
        reason: 'outside-workspace',
        target: '/Users/dev/Desktop/icon.svg',
      });
    });

    it('still blocks pdf/executables outside the workspace', () => {
      for (const path of ['/Users/dev/Desktop/doc.pdf', '/Users/dev/Desktop/installer.exe']) {
        const result = classify(path);
        expect(result.kind).toBe('blocked');
        expect((result as { reason: string }).reason).toBe('outside-workspace');
      }
    });

    it('has no active workspace -> stays blocked even for a previewable extension', () => {
      expect(classify('/Users/dev/Desktop/chart.png', null)).toEqual({
        kind: 'blocked',
        reason: 'outside-workspace',
        target: '/Users/dev/Desktop/chart.png',
      });
    });
  });

  // ── external http(s) ────────────────────────────────────────────────────────

  describe('external http(s)', () => {
    it('classifies a plain https URL', () => {
      expect(classify('https://example.com/docs')).toEqual({
        kind: 'external-http',
        url: 'https://example.com/docs',
      });
    });

    it('classifies a plain http URL', () => {
      expect(classify('http://example.com/docs')).toEqual({
        kind: 'external-http',
        url: 'http://example.com/docs',
      });
    });

    it('lowercases an uppercase/mixed-case scheme', () => {
      expect(classify('HTTP://EXAMPLE.com/Path')).toEqual({
        kind: 'external-http',
        url: 'http://example.com/Path',
      });
    });

    it('does not get fooled by a Unicode look-alike hostname (IDNA-normalizes to punycode)', () => {
      // Cyrillic "а" (U+0430) look-alike for "apple.com".
      const result = classify('https://\u0430pple.com');
      expect(result).toEqual({
        kind: 'external-http',
        url: 'https://xn--pple-43d.com/',
      });
    });
  });

  // ── blocked: unsupported / unsafe schemes ──────────────────────────────────

  describe('unsupported schemes', () => {
    it('blocks javascript:', () => {
      expect(classify('javascript:alert(1)')).toEqual({
        kind: 'blocked',
        reason: 'unsupported-scheme',
        target: 'javascript:alert(1)',
      });
    });

    it('blocks a javascript: scheme disguised with an embedded newline', () => {
      expect(classify('java\nscript:alert(1)')).toEqual({
        kind: 'blocked',
        reason: 'unsupported-scheme',
        target: 'javascript:alert(1)',
      });
    });

    it('blocks a javascript: scheme disguised with an embedded tab', () => {
      expect(classify('java\tscript:alert(1)')).toEqual({
        kind: 'blocked',
        reason: 'unsupported-scheme',
        target: 'javascript:alert(1)',
      });
    });

    it('blocks data:', () => {
      const result = classify('data:text/html,<script>alert(1)</script>');
      expect(result.kind).toBe('blocked');
      expect((result as { reason: string }).reason).toBe('unsupported-scheme');
    });

    it('blocks vbscript:', () => {
      expect(classify('vbscript:msgbox(1)')).toEqual({
        kind: 'blocked',
        reason: 'unsupported-scheme',
        target: 'vbscript:msgbox(1)',
      });
    });

    it('blocks file:', () => {
      expect(classify('file:///etc/passwd')).toEqual({
        kind: 'blocked',
        reason: 'unsupported-scheme',
        target: 'file:///etc/passwd',
      });
    });

    it('blocks ftp:', () => {
      const result = classify('ftp://host/path');
      expect(result).toEqual({
        kind: 'blocked',
        reason: 'unsupported-scheme',
        target: 'ftp://host/path',
      });
    });

    it('blocks mailto:', () => {
      const result = classify('mailto:foo@bar.com');
      expect(result.kind).toBe('blocked');
      expect((result as { reason: string }).reason).toBe('unsupported-scheme');
    });

    it('blocks an arbitrary custom scheme', () => {
      const result = classify('custom-scheme://payload');
      expect(result.kind).toBe('blocked');
      expect((result as { reason: string }).reason).toBe('unsupported-scheme');
    });

    it('blocks a protocol-relative URL', () => {
      expect(classify('//evil.com/path')).toEqual({
        kind: 'blocked',
        reason: 'unsupported-scheme',
        target: '//evil.com/path',
      });
    });
  });

  // ── blocked: suspicious authority ───────────────────────────────────────────

  describe('suspicious authority', () => {
    it('blocks userinfo embedded before the real host', () => {
      // The real navigated host is "good.com" (after "@"); "evil.com" is just
      // a username. Displaying "evil.com" first is a classic phishing shape.
      const result = classify('https://evil.com@good.com/');
      expect(result.kind).toBe('blocked');
      expect((result as { reason: string }).reason).toBe('suspicious-authority');
    });

    it('blocks a URL with a username and password in the authority', () => {
      const result = classify('https://user:pass@good.com/');
      expect(result.kind).toBe('blocked');
      expect((result as { reason: string }).reason).toBe('suspicious-authority');
    });
  });

  // ── blocked: malformed ───────────────────────────────────────────────────────

  describe('malformed', () => {
    it('blocks an empty string', () => {
      expect(classify('')).toEqual({ kind: 'blocked', reason: 'malformed', target: '' });
    });

    it('blocks a string containing a NUL byte', () => {
      const result = classify('http://example.com\u0000/x');
      expect(result.kind).toBe('blocked');
      expect((result as { reason: string }).reason).toBe('malformed');
    });

    it('blocks a whitespace-only string', () => {
      const result = classify('  \t\n  ');
      expect(result.kind).toBe('blocked');
      expect((result as { reason: string }).reason).toBe('malformed');
    });

    it('blocks invalid percent-encoding in a path candidate', () => {
      const result = classify('docs/%zz.md');
      expect(result.kind).toBe('blocked');
      expect((result as { reason: string }).reason).toBe('malformed');
    });

    it('blocks a path containing an RTL-override character', () => {
      // U+202E disguises a filename's real extension.
      const result = classify('docs/\u202Eexe.txt');
      expect(result.kind).toBe('blocked');
      expect((result as { reason: string }).reason).toBe('malformed');
    });

    it('blocks a hostname carrying an RTL-override character', () => {
      const result = classify('https://example\u202E.com/path');
      expect(result.kind).toBe('blocked');
      expect((result as { reason: string }).reason).toBe('malformed');
    });

    it('blocks an encoded NUL byte (%00) after decoding', () => {
      const result = classify('docs/file%00.md');
      expect(result.kind).toBe('blocked');
      expect((result as { reason: string }).reason).toBe('malformed');
    });

    it('blocks an absurdly long input outright', () => {
      const result = classify(`https://example.com/${'a'.repeat(10_000)}`);
      expect(result.kind).toBe('blocked');
      expect((result as { reason: string }).reason).toBe('malformed');
    });

    it('caps the displayed/copyable target length for oversized input', () => {
      const result = classify(`https://example.com/${'a'.repeat(10_000)}`);
      expect(result.kind).toBe('blocked');
      expect((result as { target: string }).target.length).toBeLessThanOrEqual(501);
    });
  });

  // ── never falls through: every result is one of the four typed kinds ───────

  describe('exhaustiveness', () => {
    const inputs = [
      'docs/readme.md',
      '/etc/passwd',
      '~/notes.md',
      'https://example.com',
      'javascript:alert(1)',
      '//evil.com',
      '',
      'not a url at all but plain prose text',
      '/Users/dev/Desktop/chart.png',
    ];

    it.each(inputs)(
      'always resolves to workspace-file, local-artifact, external-http, or blocked (%s)',
      (input) => {
        const result = classify(input);
        expect(['workspace-file', 'local-artifact', 'external-http', 'blocked']).toContain(
          result.kind
        );
      }
    );
  });
});
