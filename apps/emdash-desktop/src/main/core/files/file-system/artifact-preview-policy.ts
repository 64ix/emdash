/**
 * Pure byte-level content policy for local chat artifact preview (spec #18
 * ticket #21). No filesystem access here — every function takes bytes/sizes
 * already read by the caller and returns a decision. This is the layer that
 * defeats extension spoofing: an extension check alone would let a renamed
 * script or HTML file through as an "image" or "text" preview.
 */

import {
  artifactTextContentType,
  classifyArtifactExtension,
  maxArtifactBytesForKind,
  type ArtifactPreviewDenialReason,
  type ArtifactTextContentType,
} from '@shared/core/fs/artifact-preview';

export type SniffedImageFormat = 'png' | 'jpeg' | 'gif' | 'bmp' | 'ico' | 'webp';

export const IMAGE_MIME_TYPES: Record<SniffedImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  webp: 'image/webp',
};

/**
 * Sniffs the real image format from magic bytes — never trusts the file
 * extension alone. Returns `null` when the bytes don't match any supported
 * raster format (e.g. a `.png`-named file that is actually HTML/a script).
 */
export function sniffImageFormat(bytes: Uint8Array): SniffedImageFormat | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39)) {
    return 'gif';
  }
  if (startsWith(bytes, [0x42, 0x4d])) return 'bmp';
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return 'ico';
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

/**
 * Heuristic binary-content detector for the "text" family (txt/md/csv): a
 * NUL byte anywhere in a leading sample is a strong binary signal (the same
 * heuristic Git uses). Guards against a binary file renamed to `.txt`.
 */
export function looksLikeBinaryContent(bytes: Uint8Array): boolean {
  const sampleLength = Math.min(bytes.length, 8000);
  for (let i = 0; i < sampleLength; i += 1) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

export type ArtifactContentDecision =
  | { ok: true; kind: 'image'; mimeType: string }
  | { ok: true; kind: 'text'; contentType: ArtifactTextContentType }
  | { ok: false; reason: ArtifactPreviewDenialReason };

/**
 * Full content decision: extension candidacy, size cap, and (image) magic
 * bytes / (text) binary-content sniff. `totalSize`/`bytes` must come from a
 * read capped at `maxArtifactBytesForKind(...) + 1` so an oversized file is
 * detected without loading it fully — see `previewLocalArtifact`.
 */
export function decideArtifactContent(args: {
  path: string;
  bytes: Uint8Array;
  totalSize: number;
}): ArtifactContentDecision {
  const kind = classifyArtifactExtension(args.path);
  if (kind === 'unsupported') return { ok: false, reason: 'unsupported-content' };

  const cap = maxArtifactBytesForKind(kind);
  if (args.totalSize > cap) return { ok: false, reason: 'oversized' };

  if (kind === 'image') {
    const format = sniffImageFormat(args.bytes);
    if (!format) return { ok: false, reason: 'type-mismatch' };
    return { ok: true, kind: 'image', mimeType: IMAGE_MIME_TYPES[format] };
  }

  if (looksLikeBinaryContent(args.bytes)) return { ok: false, reason: 'type-mismatch' };
  return { ok: true, kind: 'text', contentType: artifactTextContentType(args.path) };
}
