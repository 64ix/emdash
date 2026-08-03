/**
 * chat-link-classification.ts — the one fail-closed taxonomy for every
 * chat-authored link (Markdown prose links and resource-link rows alike).
 *
 * This module is pure and synchronous: no DOM, no RPC, no file-system access.
 * It answers exactly one question — "given this href/uri string and the
 * active task's workspace root, what typed action does clicking it map to?"
 * — and nothing else. `chat-link-activation.ts` performs the actual async
 * work (existence checks, opening the editor, the external-link
 * confirmation flow, reporting a blocked target).
 *
 * `ChatLinkAction` is an exhaustive discriminated union with no catch-all
 * "pass it through" case: every href resolves to `workspace-file`,
 * `external-http`, or `blocked`. There is deliberately no raw anchor /
 * window.open fallback anywhere in this taxonomy — an unparseable or
 * unrecognized target is always `blocked`, never silently allowed through.
 */

// ── Public types ──────────────────────────────────────────────────────────────

export type ChatLinkClassificationContext = {
  /**
   * Absolute path to the active task's workspace root (any OS path form —
   * this module normalizes separators itself), or `null` when no task/
   * workspace is currently resolvable (e.g. no active task).
   */
  workspaceRoot: string | null;
};

/**
 * `workspace-file` — resolves (after `.`/`..` normalization) inside the
 *   active workspace root. `path` is the fully resolved, forward-slash
 *   normalized absolute path, ready for the existing editor-open command.
 * `external-http` — a well-formed `http:`/`https:` URL with no embedded
 *   userinfo. `url` is the canonicalized `URL#href` (e.g. IDNA-normalized,
 *   so a Unicode look-alike hostname surfaces in its safe punycode form).
 * `blocked` — every other target. `reason` names why; `target` is the best
 *   available resolved/original representation, sanitized for safe display
 *   and clipboard copy (control/bidi characters stripped, length-capped).
 */
export type ChatLinkAction =
  | { readonly kind: 'workspace-file'; readonly path: string }
  | { readonly kind: 'external-http'; readonly url: string }
  | { readonly kind: 'blocked'; readonly reason: ChatLinkBlockReason; readonly target: string };

/**
 * `malformed` — empty, oversized, contains disallowed control/bidi-override
 *   characters, or has invalid percent-encoding.
 * `unsupported-scheme` — any scheme other than `http:`/`https:`: `file:`,
 *   `javascript:`, `data:`, `vbscript:`, `ftp:`, `mailto:`, custom schemes,
 *   and protocol-relative (`//host/path`) targets, which are ambiguous by
 *   construction and never resolved implicitly.
 * `suspicious-authority` — an `http(s)` URL with userinfo embedded in the
 *   authority (`https://user@host` / `https://user:pass@host`), a classic
 *   phishing shape where the visible text and the navigated host diverge.
 * `outside-workspace` — a filesystem-shaped path (absolute, home `~`, or a
 *   relative reference that walks above the root) that does not resolve
 *   inside the active workspace. This is the seam ticket #21 (local artifact
 *   preview) extends into a confirmed local-file/preview flow; for now it is
 *   blocked.
 */
export type ChatLinkBlockReason =
  | 'malformed'
  | 'unsupported-scheme'
  | 'suspicious-authority'
  | 'outside-workspace';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_HREF_LENGTH = 4096;
const MAX_DISPLAY_LENGTH = 500;

// C0 controls other than TAB/CR/LF (which the URL parser itself strips per
// the WHATWG URL Standard) plus DEL. Presence anywhere is treated as an
// immediate red flag rather than something to silently tolerate.
const DISALLOWED_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const DISALLOWED_CONTROL_CHARS_GLOBAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// Bidi/direction-override formatting characters used to visually disguise a
// target (e.g. RTL override making a `.exe` read as a `.txt`).
const BIDI_CONTROL_CHARS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const BIDI_CONTROL_CHARS_GLOBAL = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

// A bare drive letter ("C:/..." or, after backslash normalization,
// "C:\...") parses successfully as a URL with a one-letter scheme ("c:") —
// it must be recognized as a filesystem path *before* URL parsing runs.
const DRIVE_LETTER_PATH = /^[A-Za-z]:\//;

// ── Public API ────────────────────────────────────────────────────────────────

export function classifyChatLink(
  hrefRaw: string,
  context: ChatLinkClassificationContext
): ChatLinkAction {
  if (hrefRaw.length === 0) {
    return blocked('malformed', hrefRaw);
  }
  if (hrefRaw.length > MAX_HREF_LENGTH) {
    return blocked('malformed', hrefRaw);
  }
  if (DISALLOWED_CONTROL_CHARS.test(hrefRaw) || BIDI_CONTROL_CHARS.test(hrefRaw)) {
    return blocked('malformed', hrefRaw);
  }

  // Mirror the WHATWG URL parser's own input scrubbing (strip TAB/CR/LF
  // anywhere, trim leading/trailing whitespace) before making any decision
  // ourselves, so a disguised scheme like "java\nscript:alert(1)" or
  // whitespace-padded scheme can't slip past our filesystem-path checks by
  // looking like something else to us while `new URL()` still recognizes it.
  const normalized = hrefRaw.replace(/[\t\r\n]/g, '').trim();
  if (normalized.length === 0) {
    return blocked('malformed', hrefRaw);
  }

  const slashNormalized = normalized.replace(/\\/g, '/');

  if (DRIVE_LETTER_PATH.test(slashNormalized)) {
    return classifyWorkspacePath(slashNormalized, context.workspaceRoot);
  }

  // Protocol-relative ("//evil.com/path") and other scheme-less network
  // paths are ambiguous by construction and are never resolved implicitly.
  if (slashNormalized.startsWith('//')) {
    return blocked('unsupported-scheme', normalized);
  }

  const parsed = tryParseUrl(normalized);
  if (parsed) {
    return classifyParsedUrl(parsed);
  }

  // Not a URL (no recognized scheme) — treat as a workspace-relative or
  // absolute filesystem path candidate.
  return classifyWorkspacePath(slashNormalized, context.workspaceRoot);
}

// ── URL branch ────────────────────────────────────────────────────────────────

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function classifyParsedUrl(url: URL): ChatLinkAction {
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (url.username.length > 0 || url.password.length > 0) {
      return blocked('suspicious-authority', url.href);
    }
    return { kind: 'external-http', url: url.href };
  }
  // file:, javascript:, data:, vbscript:, ftp:, mailto:, custom schemes, etc.
  return blocked('unsupported-scheme', url.href);
}

// ── Filesystem-path branch ────────────────────────────────────────────────────

function classifyWorkspacePath(
  pathCandidate: string,
  workspaceRoot: string | null
): ChatLinkAction {
  if (pathCandidate === '~' || pathCandidate.startsWith('~/')) {
    return blocked('outside-workspace', pathCandidate);
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathCandidate);
  } catch {
    return blocked('malformed', pathCandidate);
  }
  // Catches encoded control/bidi injection (e.g. a literal "%00") that the
  // raw-string check above cannot see before decoding.
  if (DISALLOWED_CONTROL_CHARS.test(decoded) || BIDI_CONTROL_CHARS.test(decoded)) {
    return blocked('malformed', pathCandidate);
  }

  if (workspaceRoot === null) {
    return blocked('outside-workspace', decoded);
  }

  const root = normalizeRoot(workspaceRoot);
  const isDriveAbsolute = DRIVE_LETTER_PATH.test(decoded);
  const isPosixAbsolute = decoded.startsWith('/') && !decoded.startsWith('//');
  const combined = isDriveAbsolute || isPosixAbsolute ? decoded : `${root}/${decoded}`;

  const resolved = resolvePathSegments(combined);
  if (resolved === null) {
    // `..` walked above the drive/root anchor entirely.
    return blocked('outside-workspace', combined);
  }

  if (resolved === root || resolved.startsWith(`${root}/`)) {
    return { kind: 'workspace-file', path: resolved };
  }

  return blocked('outside-workspace', resolved);
}

function normalizeRoot(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Resolves `.`/`..` segments in an absolute POSIX or drive-letter path.
 * Percent-encoding is decoded exactly once by the caller before this runs,
 * so a double-encoded traversal attempt (`%252e%252e`) decodes to a literal
 * `%2e%2e` segment here rather than to `..` — it is never re-decoded, so it
 * can never bypass this normalization.
 *
 * Returns `null` if a `..` segment would walk above the drive/root anchor.
 */
function resolvePathSegments(absolutePath: string): string | null {
  const isDrive = DRIVE_LETTER_PATH.test(absolutePath);
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

// ── Shared helpers ────────────────────────────────────────────────────────────

function blocked(reason: ChatLinkBlockReason, target: string): ChatLinkAction {
  return { kind: 'blocked', reason, target: sanitizeForDisplay(target) };
}

/** Strips control/bidi-override characters and caps length for safe display and clipboard copy. */
function sanitizeForDisplay(value: string): string {
  const stripped = value
    .replace(DISALLOWED_CONTROL_CHARS_GLOBAL, '')
    .replace(BIDI_CONTROL_CHARS_GLOBAL, '');
  return stripped.length > MAX_DISPLAY_LENGTH
    ? `${stripped.slice(0, MAX_DISPLAY_LENGTH)}…`
    : stripped;
}
