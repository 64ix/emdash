/**
 * Local chat artifact preview — main-process orchestration (spec #18 ticket
 * #21). This is the third and final security layer behind the renderer's
 * fail-closed link classification (`chat-link-classification.ts`) and the
 * main window's navigation policy (`externalLinks.ts`): every path is
 * re-resolved and re-validated here from scratch. The renderer classifying a
 * candidate as previewable is a UX hint only, never a substitute for this
 * check.
 *
 * Trust model:
 *   - Inside the task's own workspace root -> trusted, read immediately.
 *   - Inside the app-managed temp-artifact root (the exact directory
 *     `persist-dropped-blob.ts` writes to, and only its own
 *     `emdash-drop-`-prefixed files) -> trusted, read immediately.
 *   - Anywhere else -> a supported artifact type requires an explicit
 *     `confirmed` flag before any byte is read; an unsupported type is
 *     denied outright, without ever prompting for confirmation.
 *   - A path that *claims* to be inside a trusted root but whose real
 *     (symlink-resolved) target is not is a hard denial
 *     (`symlink-escape`) — never downgraded to "needs confirmation".
 *
 * Path resolution here is independent of `chat-link-classification.ts`'s:
 * both re-implement `.`/`..` segment resolution so a compromised or buggy
 * renderer can never bypass this policy by pre-resolving a hostile path.
 */

import { app } from 'electron';
import { FileSystem, type IFileSystem } from '@emdash/core/files';
import { DROPPED_BLOB_FILENAME_PREFIX } from '@main/core/pty/persist-dropped-blob';
import {
  classifyArtifactExtension,
  maxArtifactBytesForKind,
  type ArtifactPreviewResult,
} from '@shared/core/fs/artifact-preview';
import { decideArtifactContent } from './artifact-preview-policy';
import {
  basenameMachinePath,
  containsMachinePath,
  dirnameMachinePath,
  isAbsoluteMachinePath,
  joinMachinePath,
} from '../path-utils';
import { isRealPathContained } from '../realpath-containment';

const machinePathOperations = {
  basename: basenameMachinePath,
  contains: containsMachinePath,
  dirname: dirnameMachinePath,
  join: joinMachinePath,
};

// Lazily constructed: `FileSystem` (packages/core, local node:fs backed) has
// no per-instance state, but avoid constructing it before Electron's `app`
// is guaranteed ready in tests that import this module standalone.
let localFsInstance: IFileSystem | null = null;
function localFileSystem(): IFileSystem {
  if (!localFsInstance) localFsInstance = new FileSystem();
  return localFsInstance;
}

export type ArtifactPreviewRequest = {
  /** Active task's workspace root (any OS path form). */
  workspacePath: string;
  /** The task's own filesystem (local or SSH-backed) for workspace-scoped reads. */
  fileSystem: IFileSystem;
  /** Raw candidate path as produced by the renderer's link classification — untrusted. */
  candidatePath: string;
  /** Set once the user has explicitly confirmed previewing a path outside every trusted root. */
  confirmed: boolean;
};

/**
 * Resolves `.`/`..` segments in an absolute POSIX or drive-letter path.
 * Returns `null` if a `..` segment would walk above the drive/root anchor —
 * this is refused outright (`traversal`), never offered for confirmation.
 */
function resolveAbsoluteSegments(absolutePath: string): string | null {
  const isDrive = /^[A-Za-z]:\//.test(absolutePath);
  const driveMarker = isDrive ? absolutePath.slice(0, 2) : '';
  const rest = isDrive ? absolutePath.slice(2) : absolutePath;

  const segments = rest.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === '..') {
      if (stack.length === 0) return null;
      stack.pop();
    } else {
      stack.push(segment);
    }
  }
  return `${driveMarker}/${stack.join('/')}`;
}

function normalizeRoot(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/, '');
}

function isTrustedAppTempPath(resolvedPath: string, appTempRoot: string): boolean {
  return (
    dirnameMachinePath(resolvedPath) === appTempRoot &&
    basenameMachinePath(resolvedPath).startsWith(DROPPED_BLOB_FILENAME_PREFIX)
  );
}

export async function previewLocalArtifact(
  req: ArtifactPreviewRequest
): Promise<ArtifactPreviewResult> {
  const raw = req.candidatePath;
  if (!raw || raw.includes('\0')) return { status: 'denied', reason: 'invalid-path' };

  // Decode percent-encoding exactly once — this module never trusts that the
  // renderer already did so (a caller could reach this RPC directly). Decoding
  // once, and never re-decoding, means a double-encoded traversal attempt
  // (`%252e%252e`) decodes to the literal text `%2e%2e`, never to `..`.
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return { status: 'denied', reason: 'invalid-path' };
  }
  if (decoded.includes('\0')) return { status: 'denied', reason: 'invalid-path' };

  const slashNormalized = decoded.replace(/\\/g, '/');
  const workspaceRoot = normalizeRoot(req.workspacePath);
  const isAbsoluteInput = isAbsoluteMachinePath(slashNormalized);
  const combined = isAbsoluteInput
    ? slashNormalized
    : joinMachinePath(workspaceRoot, slashNormalized);

  const resolved = resolveAbsoluteSegments(combined);
  if (resolved === null) return { status: 'denied', reason: 'traversal' };

  // Path-shape trust bucket, before any filesystem access.
  const inWorkspaceShape =
    resolved === workspaceRoot || containsMachinePath(workspaceRoot, resolved);

  // A *relative* candidate is only ever meant to address something inside the
  // workspace; one that nets outside it did so purely via `..` segments — a
  // traversal attempt, refused outright and never offered for confirmation.
  // Only a candidate that was already absolute/drive-letter/UNC-shaped can
  // legitimately name a path outside the workspace and reach the
  // confirm-then-preview flow below.
  if (!inWorkspaceShape && !isAbsoluteInput) {
    return { status: 'denied', reason: 'traversal' };
  }

  const appTempRoot = normalizeRoot(app.getPath('temp'));
  const inAppTempShape = isTrustedAppTempPath(resolved, appTempRoot);

  if (inWorkspaceShape) {
    return readTrustedArtifact(req.fileSystem, workspaceRoot, resolved);
  }
  if (inAppTempShape) {
    return readTrustedArtifact(localFileSystem(), appTempRoot, resolved);
  }

  // Outside every trusted root: never read bytes before explicit confirmation,
  // and never confirm-gate a type we will refuse regardless of the answer.
  const extKind = classifyArtifactExtension(resolved);
  if (extKind === 'unsupported') {
    return { status: 'denied', reason: 'unsupported-content', resolvedPath: resolved };
  }
  if (!req.confirmed) {
    return { status: 'needs-confirmation', kind: extKind, resolvedPath: resolved };
  }
  return readAndDecide(req.fileSystem, resolved);
}

/** Verifies real (symlink-resolved) containment before reading a claimed-trusted path. */
async function readTrustedArtifact(
  fileSystem: IFileSystem,
  trustedRoot: string,
  resolvedPath: string
): Promise<ArtifactPreviewResult> {
  const contained = await isRealPathContained(
    fileSystem,
    machinePathOperations,
    trustedRoot,
    resolvedPath,
    { candidateErrorMode: 'error' }
  );
  if (!contained.success) {
    return { status: 'denied', reason: 'missing', resolvedPath };
  }
  if (!contained.data) {
    return { status: 'denied', reason: 'symlink-escape', resolvedPath };
  }
  return readAndDecide(fileSystem, resolvedPath);
}

async function readAndDecide(
  fileSystem: IFileSystem,
  resolvedPath: string
): Promise<ArtifactPreviewResult> {
  const extKind = classifyArtifactExtension(resolvedPath);
  if (extKind === 'unsupported') {
    return { status: 'denied', reason: 'unsupported-content', resolvedPath };
  }

  const statResult = await fileSystem.stat(resolvedPath);
  if (!statResult.success) {
    return { status: 'denied', reason: 'missing', resolvedPath };
  }
  if (statResult.data.type === 'directory') {
    return { status: 'denied', reason: 'directory', resolvedPath };
  }

  // Read one byte past the cap so an oversized file is detected without
  // buffering it fully into memory.
  const cap = maxArtifactBytesForKind(extKind);
  const readResult = await fileSystem.readBytes(resolvedPath, { maxBytes: cap + 1 });
  if (!readResult.success) {
    return { status: 'denied', reason: 'missing', resolvedPath };
  }
  if (readResult.data.totalSize > cap) {
    return { status: 'denied', reason: 'oversized', resolvedPath };
  }

  const decision = decideArtifactContent({
    path: resolvedPath,
    bytes: readResult.data.bytes,
    totalSize: readResult.data.totalSize,
  });
  if (!decision.ok) {
    return { status: 'denied', reason: decision.reason, resolvedPath };
  }

  if (decision.kind === 'image') {
    const dataUrl = `data:${decision.mimeType};base64,${Buffer.from(readResult.data.bytes).toString('base64')}`;
    return {
      status: 'ok',
      kind: 'image',
      dataUrl,
      mimeType: decision.mimeType,
      size: readResult.data.totalSize,
      resolvedPath,
    };
  }

  return {
    status: 'ok',
    kind: 'text',
    content: Buffer.from(readResult.data.bytes).toString('utf8'),
    contentType: decision.contentType,
    size: readResult.data.totalSize,
    resolvedPath,
  };
}
