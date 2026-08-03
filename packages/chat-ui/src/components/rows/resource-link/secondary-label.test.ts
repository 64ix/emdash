import { describe, expect, it } from 'vitest';
import { secondaryLabel } from './secondary-label';

describe('secondaryLabel', () => {
  it('shows the resolved path for a workspace-file target', () => {
    expect(
      secondaryLabel('docs/readme.md', { kind: 'workspace-file', path: 'docs/readme.md' })
    ).toBe('docs/readme.md');
  });

  it('shows the resolved path for a local-file target', () => {
    expect(secondaryLabel('/tmp/chart.png', { kind: 'local-file', path: '/tmp/chart.png' })).toBe(
      '/tmp/chart.png'
    );
  });

  it('shows the hostname for an external target', () => {
    expect(
      secondaryLabel('https://example.com/docs', {
        kind: 'external',
        url: 'https://example.com/docs',
      })
    ).toBe('example.com');
  });

  it('falls back to the raw url when it fails to parse as a URL', () => {
    expect(secondaryLabel('not-a-url', { kind: 'external', url: 'not-a-url' })).toBe('not-a-url');
  });

  it('shows a capped scheme for an opaque target', () => {
    expect(secondaryLabel('mcp://server/resource', { kind: 'opaque' })).toBe('mcp://…');
  });

  it('falls back to the raw uri for an opaque target with no scheme delimiter', () => {
    expect(secondaryLabel('plain-resource-id', { kind: 'opaque' })).toBe('plain-resource-id');
  });

  // A resource-link item decoded directly from real ACP content (ticket #21)
  // can reach this component before the desktop's target-resolution step
  // runs. This must degrade to a display fallback, never throw.
  it('never throws when target is not yet resolved', () => {
    expect(() => secondaryLabel('output/chart.png', undefined)).not.toThrow();
    expect(secondaryLabel('output/chart.png', undefined)).toBe('output/chart.png');
  });
});
