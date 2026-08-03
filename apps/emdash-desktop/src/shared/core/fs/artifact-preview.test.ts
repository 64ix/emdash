import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_IMAGE_EXTENSIONS,
  ARTIFACT_TEXT_EXTENSIONS,
  artifactTextContentType,
  classifyArtifactExtension,
  MAX_ARTIFACT_IMAGE_BYTES,
  MAX_ARTIFACT_TEXT_BYTES,
  maxArtifactBytesForKind,
} from './artifact-preview';

describe('classifyArtifactExtension', () => {
  it.each(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico'])(
    'classifies %s as image',
    (ext) => {
      expect(classifyArtifactExtension(`/tmp/file${ext}`)).toBe('image');
    }
  );

  it.each(['.txt', '.md', '.markdown', '.csv'])('classifies %s as text', (ext) => {
    expect(classifyArtifactExtension(`/tmp/file${ext}`)).toBe('text');
  });

  it('is case-insensitive', () => {
    expect(classifyArtifactExtension('/tmp/FILE.PNG')).toBe('image');
    expect(classifyArtifactExtension('/tmp/FILE.MD')).toBe('text');
  });

  // SVG is explicitly not previewed this increment (active content risk).
  it('treats svg as unsupported', () => {
    expect(classifyArtifactExtension('/tmp/icon.svg')).toBe('unsupported');
  });

  it.each(['.pdf', '.html', '.htm', '.exe', '.sh', '.bat', '.dmg', '.app'])(
    'treats %s as unsupported',
    (ext) => {
      expect(classifyArtifactExtension(`/tmp/file${ext}`)).toBe('unsupported');
    }
  );

  it('treats a dotfile with no extension as unsupported', () => {
    expect(classifyArtifactExtension('/tmp/.gitignore')).toBe('unsupported');
  });

  it('treats an extensionless path as unsupported', () => {
    expect(classifyArtifactExtension('/tmp/README')).toBe('unsupported');
  });
});

describe('artifactTextContentType', () => {
  it('maps .csv to csv', () => {
    expect(artifactTextContentType('/tmp/data.csv')).toBe('csv');
  });

  it('maps .md and .markdown to markdown', () => {
    expect(artifactTextContentType('/tmp/notes.md')).toBe('markdown');
    expect(artifactTextContentType('/tmp/notes.markdown')).toBe('markdown');
  });

  it('maps .txt to plain text', () => {
    expect(artifactTextContentType('/tmp/notes.txt')).toBe('text');
  });
});

describe('maxArtifactBytesForKind', () => {
  it('caps images at 10 MiB', () => {
    expect(maxArtifactBytesForKind('image')).toBe(MAX_ARTIFACT_IMAGE_BYTES);
    expect(MAX_ARTIFACT_IMAGE_BYTES).toBe(10 * 1024 * 1024);
  });

  it('caps text at 1 MiB', () => {
    expect(maxArtifactBytesForKind('text')).toBe(MAX_ARTIFACT_TEXT_BYTES);
    expect(MAX_ARTIFACT_TEXT_BYTES).toBe(1 * 1024 * 1024);
  });
});

describe('extension sets', () => {
  it('never overlap', () => {
    for (const ext of ARTIFACT_IMAGE_EXTENSIONS) {
      expect(ARTIFACT_TEXT_EXTENSIONS.has(ext)).toBe(false);
    }
  });

  it('exclude svg from the image set', () => {
    expect(ARTIFACT_IMAGE_EXTENSIONS.has('.svg')).toBe(false);
  });
});
