/**
 * Shared types and pure extension policy for local chat artifact preview
 * (spec #18 ticket #21). Used by both the renderer (to decide whether a
 * classified chat link is a preview candidate at all) and the main process
 * (as the first, cheapest check before any filesystem access). The renderer
 * classifying a path as a candidate is never a substitute for the main
 * process's own independent validation — see
 * `src/main/core/files/file-system/artifact-preview.ts`.
 */

/** The two content families this feature previews. SVG/PDF/executables are not part of either set. */
export type ArtifactPreviewKind = 'image' | 'text';

/** Raster formats only — no SVG (active content risk; explicitly blocked this increment). */
export const ARTIFACT_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
]);

/** Plain-text-rendered content only — never parsed/executed as HTML. */
export const ARTIFACT_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
]);

export const MAX_ARTIFACT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_ARTIFACT_TEXT_BYTES = 1 * 1024 * 1024;

/** Returns the byte cap for a preview kind. */
export function maxArtifactBytesForKind(kind: ArtifactPreviewKind): number {
  return kind === 'image' ? MAX_ARTIFACT_IMAGE_BYTES : MAX_ARTIFACT_TEXT_BYTES;
}

function extensionOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  // A dot at index 0 ("‎.gitignore") is a dotfile, not an extension.
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

/**
 * Extension-only pre-check: does this path *look like* a previewable
 * artifact? Pure and synchronous — never inspects file contents. The main
 * process still re-validates the real bytes (size cap, magic-byte sniff for
 * images, binary-content sniff for text) before ever returning content.
 */
export function classifyArtifactExtension(filePath: string): ArtifactPreviewKind | 'unsupported' {
  const ext = extensionOf(filePath);
  if (ARTIFACT_IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ARTIFACT_TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'unsupported';
}

/** Text sub-kind, used to pick a renderer (plain vs. markdown vs. CSV table). */
export type ArtifactTextContentType = 'text' | 'markdown' | 'csv';

export function artifactTextContentType(filePath: string): ArtifactTextContentType {
  const ext = extensionOf(filePath);
  if (ext === '.csv') return 'csv';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  return 'text';
}

/**
 * Explicit denial reasons the preview policy can return. Every refusal is
 * one of these — never a silent fallback or a blank pane.
 */
export type ArtifactPreviewDenialReason =
  | 'invalid-path'
  | 'traversal'
  | 'symlink-escape'
  | 'missing'
  | 'directory'
  | 'oversized'
  | 'type-mismatch'
  | 'unsupported-content';

export type ArtifactPreviewResult =
  | {
      status: 'ok';
      kind: 'image';
      dataUrl: string;
      mimeType: string;
      size: number;
      resolvedPath: string;
    }
  | {
      status: 'ok';
      kind: 'text';
      content: string;
      contentType: ArtifactTextContentType;
      size: number;
      resolvedPath: string;
    }
  | { status: 'needs-confirmation'; kind: ArtifactPreviewKind; resolvedPath: string }
  | { status: 'denied'; reason: ArtifactPreviewDenialReason; resolvedPath?: string };
