import { describe, expect, it } from 'vitest';
import {
  decideArtifactContent,
  looksLikeBinaryContent,
  sniffImageFormat,
} from './artifact-preview-policy';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff, 0xe0];
const GIF89A_SIGNATURE = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const GIF87A_SIGNATURE = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const BMP_SIGNATURE = [0x42, 0x4d];
const ICO_SIGNATURE = [0x00, 0x00, 0x01, 0x00];

function bytes(values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function webpBytes(): Uint8Array {
  // "RIFF" + 4 size bytes (irrelevant) + "WEBP"
  return bytes([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
  ]);
}

function textEncode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('sniffImageFormat', () => {
  it('recognizes a PNG signature', () => {
    expect(sniffImageFormat(bytes([...PNG_SIGNATURE, 1, 2, 3]))).toBe('png');
  });

  it('recognizes a JPEG signature', () => {
    expect(sniffImageFormat(bytes([...JPEG_SIGNATURE, 1, 2]))).toBe('jpeg');
  });

  it('recognizes GIF87a and GIF89a signatures', () => {
    expect(sniffImageFormat(bytes(GIF87A_SIGNATURE))).toBe('gif');
    expect(sniffImageFormat(bytes(GIF89A_SIGNATURE))).toBe('gif');
  });

  it('recognizes a BMP signature', () => {
    expect(sniffImageFormat(bytes([...BMP_SIGNATURE, 1, 2, 3, 4]))).toBe('bmp');
  });

  it('recognizes an ICO signature', () => {
    expect(sniffImageFormat(bytes([...ICO_SIGNATURE, 1, 2]))).toBe('ico');
  });

  it('recognizes a WEBP (RIFF....WEBP) signature', () => {
    expect(sniffImageFormat(webpBytes())).toBe('webp');
  });

  it('returns null for HTML bytes disguised with an image extension', () => {
    expect(sniffImageFormat(textEncode('<html><script>alert(1)</script></html>'))).toBeNull();
  });

  it('returns null for an empty buffer', () => {
    expect(sniffImageFormat(new Uint8Array())).toBeNull();
  });

  it('returns null for a truncated signature', () => {
    expect(sniffImageFormat(bytes(PNG_SIGNATURE.slice(0, 3)))).toBeNull();
  });
});

describe('looksLikeBinaryContent', () => {
  it('is false for plain UTF-8 text', () => {
    expect(looksLikeBinaryContent(textEncode('hello, world\nsecond line'))).toBe(false);
  });

  it('is true when a NUL byte is present', () => {
    expect(looksLikeBinaryContent(bytes([104, 101, 0, 108, 108, 111]))).toBe(true);
  });

  it('only samples the leading window', () => {
    const trailing = new Uint8Array(9000);
    trailing.set(textEncode('a'.repeat(9000)));
    trailing[8500] = 0; // beyond the 8000-byte sample window
    expect(looksLikeBinaryContent(trailing)).toBe(false);
  });
});

describe('decideArtifactContent', () => {
  it('accepts a genuine PNG under the image cap', () => {
    const decision = decideArtifactContent({
      path: '/tmp/chart.png',
      bytes: bytes([...PNG_SIGNATURE, 1, 2, 3]),
      totalSize: 11,
    });
    expect(decision).toEqual({ ok: true, kind: 'image', mimeType: 'image/png' });
  });

  it('denies an oversized image before sniffing content', () => {
    const decision = decideArtifactContent({
      path: '/tmp/chart.png',
      bytes: bytes([...PNG_SIGNATURE, 1, 2, 3]),
      totalSize: 10 * 1024 * 1024 + 1,
    });
    expect(decision).toEqual({ ok: false, reason: 'oversized' });
  });

  it('denies a .png file whose bytes are not a real image (extension spoofing)', () => {
    const html = textEncode('<html><script>alert(document.cookie)</script></html>');
    const decision = decideArtifactContent({ path: '/tmp/evil.png', bytes: html, totalSize: html.byteLength });
    expect(decision).toEqual({ ok: false, reason: 'type-mismatch' });
  });

  it('accepts plain text under the text cap', () => {
    const content = textEncode('hello world');
    const decision = decideArtifactContent({
      path: '/tmp/notes.txt',
      bytes: content,
      totalSize: content.byteLength,
    });
    expect(decision).toEqual({ ok: true, kind: 'text', contentType: 'text' });
  });

  it('classifies markdown content type', () => {
    const content = textEncode('# Title');
    const decision = decideArtifactContent({
      path: '/tmp/notes.md',
      bytes: content,
      totalSize: content.byteLength,
    });
    expect(decision).toEqual({ ok: true, kind: 'text', contentType: 'markdown' });
  });

  it('classifies csv content type', () => {
    const content = textEncode('a,b,c\n1,2,3');
    const decision = decideArtifactContent({
      path: '/tmp/data.csv',
      bytes: content,
      totalSize: content.byteLength,
    });
    expect(decision).toEqual({ ok: true, kind: 'text', contentType: 'csv' });
  });

  it('denies a .txt file that is actually binary', () => {
    const content = bytes([1, 2, 0, 3, 4]);
    const decision = decideArtifactContent({
      path: '/tmp/notes.txt',
      bytes: content,
      totalSize: content.byteLength,
    });
    expect(decision).toEqual({ ok: false, reason: 'type-mismatch' });
  });

  it('denies an oversized text file', () => {
    const decision = decideArtifactContent({
      path: '/tmp/notes.txt',
      bytes: textEncode('x'),
      totalSize: 1024 * 1024 + 1,
    });
    expect(decision).toEqual({ ok: false, reason: 'oversized' });
  });

  it('denies unsupported content types outright (svg, pdf, executables)', () => {
    for (const path of ['/tmp/icon.svg', '/tmp/doc.pdf', '/tmp/run.exe', '/tmp/run.sh']) {
      const decision = decideArtifactContent({ path, bytes: textEncode('x'), totalSize: 1 });
      expect(decision).toEqual({ ok: false, reason: 'unsupported-content' });
    }
  });
});
