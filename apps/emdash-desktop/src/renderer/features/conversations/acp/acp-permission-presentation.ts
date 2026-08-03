/**
 * acp-permission-presentation — provider-agnostic normalization of an ACP
 * permission request's tool call into the concrete operation detail a user
 * needs to make an informed decision (ticket #32, spec #18): normalized
 * command/path, operation kind, parameters, scope, affected resources, and
 * defensible risk cues.
 *
 * Pure and DOM-free (no MobX, no chat-ui import) so it is unit-testable from
 * the `node` vitest project and reusable by both `AcpChatStore` and any future
 * host. `AcpPermissionRequest.toolCall` is the same `ToolCallItem` shape the
 * transcript itself renders — see `@emdash/chat-ui`'s
 * `components/rows/tools/tool/tool-presentation.ts` for the equivalent
 * adapter used by the generic tool inspector (ticket #30). That module cannot
 * be imported here: `@emdash/chat-ui`'s bundle touches `document` at import
 * time, which breaks both the app's `node` vitest project and this file's
 * intended use from the composer-docked permission surface (a plain React/
 * MobX seam, not the SolidJS transcript). The bounding/redaction helpers below
 * are therefore intentionally small, independent copies rather than a shared
 * import — see the wave-2/3 prior-work notes for this constraint.
 *
 * Defensive by design: every helper accepts malformed input (missing fields,
 * huge blobs, non-UTF-16-safe strings) and degrades to a safe fallback rather
 * than throwing — a permission request is a security decision surface, so a
 * crash or blank render here is worse than a plain one.
 */

import type { ToolCallItem } from '@emdash/core/acp/client';
import { redactSecrets } from '@emdash/shared/logger';

// ── Bounds ────────────────────────────────────────────────────────────────────

/** Max characters kept in a single displayed text block (command/content/diff side). */
export const PERMISSION_TEXT_MAX_CHARS = 4000;
/** Max characters kept in a single normalized parameter value. */
export const PERMISSION_PARAM_MAX_CHARS = 300;

// ── Text bounding (surrogate-pair safe) ──────────────────────────────────────

function toDisplayString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  } catch {
    return '[unrepresentable value]';
  }
}

// ── Display-safety (bidi/zero-width spoofing) ────────────────────────────────
//
// A permission request is a security decision surface: provider-authored text
// (command, path, params, option labels) must never be able to visually
// disguise itself — e.g. a right-to-left override making a destructive
// command read as something benign, or an embedded line break making a label
// impersonate a second prompt/button. Mirrors the equivalent mitigation for
// link display in `chat-link-classification.ts`'s `BIDI_CONTROL_CHARS`.
// U+200B-200F (zero-width space/joiner/non-joiner + LTR/RTL marks),
// U+202A-202E (LTR/RTL embedding/override/pop), U+2060-2069 (word joiner +
// invisible operators), U+FEFF (zero-width no-break space / BOM).
const UNSAFE_DISPLAY_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

function stripUnsafeDisplayChars(value: string): string {
  return value.replace(UNSAFE_DISPLAY_CHARS, '');
}

/**
 * Sanitize a short, single-line provider-authored label — a permission
 * request's `title` or an option's `name` — for safe display: strips bidi/
 * zero-width spoofing characters and collapses any embedded line break to a
 * single space so multi-line input can never fake a second prompt or row.
 * Used by `AcpChatStore.permissionQueue` for `title`/`options[].name`, which
 * are not routed through `describePermissionOperation` below.
 */
export function sanitizeSingleLineText(value: string): string {
  return stripUnsafeDisplayChars(value)
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/**
 * Sanitize + redact a permission request's `title` for safe display.
 *
 * Unlike an option's `name` (a short provider-decided label that must be
 * "preserved exactly" per ticket #32's acceptance criteria), `title` is a
 * free-form summary the reducer sometimes derives directly from a raw
 * resource — e.g. `web-fetch-tool-call`'s title falls back to the raw,
 * unredacted URL when the provider sends no page title (see
 * `packages/core/src/acp/reducer/item-fold.ts`'s `upsertSpecialEvent`). That
 * URL can carry a secret in its query string the same way `toolCall.url`
 * itself can, so `title` must go through the same `redactSecrets` pass as
 * every other displayed field, not just the bidi/newline stripping
 * `sanitizeSingleLineText` alone provides.
 */
export function sanitizePermissionTitle(value: string): string {
  return redactSecrets(sanitizeSingleLineText(value));
}

/**
 * Bound `text` to at most `max` Unicode code points via the string iterator
 * (`Array.from`) rather than slicing UTF-16 code units, so an astral-plane
 * character (e.g. an emoji surrogate pair) is never bisected into an unpaired
 * lone surrogate.
 */
function boundCodePoints(
  text: string,
  max: number
): { text: string; truncated: boolean; omittedChars: number } {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: '', truncated: false, omittedChars: 0 };
  }
  const codePoints = Array.from(text);
  if (max <= 0) {
    return { text: '', truncated: codePoints.length > 0, omittedChars: codePoints.length };
  }
  if (codePoints.length <= max) return { text, truncated: false, omittedChars: 0 };
  return {
    text: codePoints.slice(0, max).join(''),
    truncated: true,
    omittedChars: codePoints.length - max,
  };
}

export type PermissionTextBlock = {
  /** Bounded, redacted text safe to render directly. */
  text: string;
  truncated: boolean;
  omittedChars: number;
  /**
   * Full redacted (but never bounded) text. A "Copy" action must always use
   * this, never `text` — copying a silently-truncated view of a command or
   * file content the user is about to approve would be a genuine defect, not
   * a cosmetic one (see #28's `formatPatchText`, which the same rule).
   */
  fullText: string;
};

/**
 * Bound + redact a raw provider text payload for safe, honest display.
 * Redaction runs on the full text before bounding so a secret pattern can
 * never be exposed by being cut in half at the bounding boundary.
 */
export function summarizePermissionText(
  raw: unknown,
  max = PERMISSION_TEXT_MAX_CHARS
): PermissionTextBlock {
  const redacted = redactSecrets(stripUnsafeDisplayChars(toDisplayString(raw)));
  const bounded = boundCodePoints(redacted, max);
  return { ...bounded, fullText: redacted };
}

/**
 * Bound + redact a single normalized parameter value for the params list.
 * Params render in a single-line flex row, so — unlike `summarizePermissionText`
 * — embedded line breaks are collapsed too (see `sanitizeSingleLineText`).
 *
 * Unlike a resource identifier (`sanitizeResourceIdentifier`), a param value
 * can be genuinely free-text (a search query, a subagent name) with no
 * natural length limit, so it is bounded the same way a command/content block
 * is — and the truncation is surfaced (`truncated`/`fullValue`), never
 * silently dropped, for exactly the same reason `PermissionTextBlock.fullText`
 * exists: hiding the tail of what the user is approving without any
 * indication would be a genuine defect, not a cosmetic one.
 */
function buildParam(label: string, raw: unknown): PermissionParam {
  const singleLine = sanitizeSingleLineText(toDisplayString(raw));
  const redacted = redactSecrets(singleLine);
  const bounded = boundCodePoints(redacted, PERMISSION_PARAM_MAX_CHARS);
  return { label, value: bounded.text, truncated: bounded.truncated, fullValue: redacted };
}

/**
 * Sanitize a resource identifier (workspace path or URL) for single-line
 * display — see `sanitizeSingleLineText`. Never bounded: unlike a free-text
 * param value, a path or URL is exactly the resource the user is being asked
 * to approve acting on, so truncating it (even with an indicator) risks
 * hiding the very thing — a trailing path segment, a query string — that
 * makes the request dangerous or benign.
 */
function sanitizeResourceIdentifier(value: string): string {
  return redactSecrets(sanitizeSingleLineText(value));
}

// ── Normalized operation model ───────────────────────────────────────────────

export type PermissionParam = {
  label: string;
  value: string;
  /** Whether `value` was cut short of the true (redacted) content. */
  truncated: boolean;
  /** Full redacted (never bounded) value — Copy must always use this, never `value`. */
  fullValue: string;
};

/** A param whose `value` is already complete (never bounded) — e.g. a path or a fixed literal. */
function exactParam(label: string, value: string): PermissionParam {
  return { label, value, truncated: false, fullValue: value };
}

export type PermissionResource = { kind: 'path'; path: string } | { kind: 'url'; url: string };

export type PermissionOperationKind =
  | 'command'
  | 'read'
  | 'write'
  | 'delete'
  | 'search'
  | 'mcp'
  | 'fetch'
  | 'subagent'
  | 'plan'
  | 'unknown';

export interface PermissionOperationDetail {
  kind: PermissionOperationKind;
  /** Human-readable operation label, e.g. "Execute command", "Modify file". */
  operationLabel: string;
  /** Where this operation acts, phrased only in terms defensible from the request itself. */
  scope: string;
  /** Normalized shell command (execute-tool-call only). */
  command?: PermissionTextBlock;
  /** Normalized workspace path, when the request names one. */
  path?: string;
  /** New-file content (create-file-tool-call only). */
  content?: PermissionTextBlock;
  /** Before/after text (modify-file-tool-call only). */
  diff?: { oldText: PermissionTextBlock; newText: PermissionTextBlock };
  /** Additional normalized parameters not already surfaced as command/path. */
  params: PermissionParam[];
  /** Concrete resources this operation touches. */
  resources: PermissionResource[];
  /**
   * Plain, defensible descriptions of what the operation mechanically does.
   * Never claims a guarantee (sandboxing, safety, reversibility) the runtime
   * cannot back up.
   */
  riskCues: string[];
  /** Raw provider tool kind string, surfaced as a diagnostic for unknown tools only. */
  rawToolKind?: string | null;
}

const WORKSPACE_SCOPE = 'Task workspace';
const NETWORK_SCOPE = 'Network (outside the task workspace)';
const UNKNOWN_SCOPE = 'Unknown';

/**
 * Build the normalized, bounded, redacted operation detail for one ACP
 * permission request's tool call. Exhaustive over every `ToolCallItem` kind
 * (permission requests never wrap a `tool-group`) so a newly-added kind is a
 * compile-time error here, not a silent blank permission card.
 */
export function describePermissionOperation(toolCall: ToolCallItem): PermissionOperationDetail {
  switch (toolCall.kind) {
    case 'execute-tool-call': {
      const commandSource = toolCall.command ?? toolCall.title;
      return {
        kind: 'command',
        operationLabel: 'Execute command',
        scope: WORKSPACE_SCOPE,
        command: summarizePermissionText(commandSource),
        params: [],
        resources: [],
        riskCues: ['Runs a shell command with the permissions of the agent process.'],
      };
    }

    case 'read-tool-call': {
      const rawPath = toolCall.path ?? toolCall.resource;
      const path = rawPath ? sanitizeResourceIdentifier(rawPath) : undefined;
      return {
        kind: 'read',
        operationLabel: 'Read file',
        scope: WORKSPACE_SCOPE,
        path,
        params: path ? [exactParam('Path', path)] : [],
        resources: path ? [{ kind: 'path', path }] : [],
        riskCues: ['Reads the contents of a file or resource.'],
      };
    }

    case 'create-file-tool-call': {
      const path = sanitizeResourceIdentifier(toolCall.path);
      return {
        kind: 'write',
        operationLabel: 'Create file',
        scope: WORKSPACE_SCOPE,
        path,
        content: summarizePermissionText(toolCall.content),
        params: [exactParam('Path', path)],
        resources: [{ kind: 'path', path }],
        riskCues: ['Creates a new file with the content shown below.'],
      };
    }

    case 'modify-file-tool-call': {
      const path = sanitizeResourceIdentifier(toolCall.path);
      return {
        kind: 'write',
        operationLabel: 'Modify file',
        scope: WORKSPACE_SCOPE,
        path,
        diff: {
          oldText: summarizePermissionText(toolCall.oldText),
          newText: summarizePermissionText(toolCall.newText),
        },
        params: [exactParam('Path', path)],
        resources: [{ kind: 'path', path }],
        riskCues: ['Overwrites part of an existing file.'],
      };
    }

    case 'delete-file-tool-call': {
      const path = sanitizeResourceIdentifier(toolCall.path);
      return {
        kind: 'delete',
        operationLabel: 'Delete file',
        scope: WORKSPACE_SCOPE,
        path,
        params: [exactParam('Path', path)],
        resources: [{ kind: 'path', path }],
        riskCues: ['Permanently deletes a file. Emdash does not provide an undo for this action.'],
      };
    }

    case 'search-tool-call': {
      return {
        kind: 'search',
        operationLabel: 'Search workspace',
        scope: WORKSPACE_SCOPE,
        params: [buildParam('Query', toolCall.query)],
        resources: [],
        riskCues: ['Searches the workspace; does not modify files by itself.'],
      };
    }

    case 'mcp-tool-call': {
      const params: PermissionParam[] = [buildParam('Tool', toolCall.tool)];
      if (toolCall.server) params.push(buildParam('Server', toolCall.server));
      return {
        kind: 'mcp',
        operationLabel: 'Call MCP tool',
        scope: NETWORK_SCOPE,
        params,
        resources: [],
        riskCues: [
          'Calls a tool on an MCP server. Emdash cannot verify what the server does with this request.',
        ],
      };
    }

    case 'web-fetch-tool-call': {
      // Redact/sanitize once and reuse for both the param row and the
      // affected-resources entry — the resource list must never bypass the
      // same redaction the URL param goes through (a raw, unredacted
      // `toolCall.url` here would leak a secret embedded in a query string).
      // Never bounded (see `sanitizeResourceIdentifier`): the URL *is* the
      // resource being approved, so truncating it — even with an indicator —
      // risks hiding a trailing path segment or query param that changes
      // what is actually being fetched.
      const url = toolCall.url ? sanitizeResourceIdentifier(toolCall.url) : undefined;
      const params: PermissionParam[] = url ? [exactParam('URL', url)] : [];
      if (toolCall.pageTitle) {
        params.push(buildParam('Page title', toolCall.pageTitle));
      }
      return {
        kind: 'fetch',
        operationLabel: 'Fetch URL',
        scope: NETWORK_SCOPE,
        params,
        resources: url ? [{ kind: 'url', url }] : [],
        riskCues: [
          'Requests data from a URL. Emdash cannot verify what the destination does with this request.',
        ],
      };
    }

    case 'spawn-subagent-tool-call': {
      const params: PermissionParam[] = [buildParam('Name', toolCall.name)];
      if (toolCall.background) params.push(exactParam('Background', 'Yes'));
      return {
        kind: 'subagent',
        operationLabel: 'Spawn subagent',
        scope: WORKSPACE_SCOPE,
        params,
        resources: [],
        riskCues: ['Launches a subagent that can take further actions on its own.'],
      };
    }

    case 'create-plan-tool-call': {
      return {
        kind: 'plan',
        operationLabel: 'Create plan',
        scope: WORKSPACE_SCOPE,
        params: [],
        resources: [],
        riskCues: ['Creates or updates a plan. Does not modify files directly.'],
      };
    }

    case 'unknown-tool-call': {
      const params: PermissionParam[] = [buildParam('Tool', toolCall.name)];
      if (toolCall.toolKind) params.push(buildParam('Raw kind', toolCall.toolKind));
      return {
        kind: 'unknown',
        operationLabel: 'Unrecognized tool request',
        scope: UNKNOWN_SCOPE,
        rawToolKind: toolCall.toolKind,
        params,
        resources: [],
        riskCues: [
          'Emdash does not recognize this tool. Review the raw details carefully before approving.',
        ],
      };
    }
  }
}

// ── Diagnostic copy payload ────────────────────────────────────────────────────

/** Build the flat, human-readable, full (never bounded) text a "Copy" action places on the clipboard. */
export function buildPermissionCopyText(detail: PermissionOperationDetail): string {
  const lines: string[] = [detail.operationLabel, `Scope: ${detail.scope}`];
  if (detail.path) lines.push(`Path: ${detail.path}`);
  if (detail.command) lines.push('', 'Command:', detail.command.fullText);
  if (detail.content) lines.push('', 'Content:', detail.content.fullText);
  if (detail.diff) {
    lines.push('', 'Current content:', detail.diff.oldText.fullText);
    lines.push('', 'New content:', detail.diff.newText.fullText);
  }
  for (const param of detail.params) lines.push(`${param.label}: ${param.fullValue}`);
  for (const resource of detail.resources) {
    lines.push(
      resource.kind === 'url' ? `Resource: ${resource.url}` : `Resource: ${resource.path}`
    );
  }
  if (detail.riskCues.length > 0) lines.push('', 'Notes:', ...detail.riskCues);
  return lines.join('\n');
}
