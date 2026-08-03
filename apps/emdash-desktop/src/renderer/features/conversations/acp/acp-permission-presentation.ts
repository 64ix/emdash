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
  const redacted = redactSecrets(toDisplayString(raw));
  const bounded = boundCodePoints(redacted, max);
  return { ...bounded, fullText: redacted };
}

/** Bound + redact a single normalized parameter value for the params list. */
function paramValue(raw: unknown): string {
  return boundCodePoints(redactSecrets(toDisplayString(raw)), PERMISSION_PARAM_MAX_CHARS).text;
}

// ── Normalized operation model ───────────────────────────────────────────────

export type PermissionParam = { label: string; value: string };

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
      const path = toolCall.path ?? toolCall.resource;
      return {
        kind: 'read',
        operationLabel: 'Read file',
        scope: WORKSPACE_SCOPE,
        path,
        params: path ? [{ label: 'Path', value: paramValue(path) }] : [],
        resources: path ? [{ kind: 'path', path }] : [],
        riskCues: ['Reads the contents of a file or resource.'],
      };
    }

    case 'create-file-tool-call': {
      return {
        kind: 'write',
        operationLabel: 'Create file',
        scope: WORKSPACE_SCOPE,
        path: toolCall.path,
        content: summarizePermissionText(toolCall.content),
        params: [{ label: 'Path', value: paramValue(toolCall.path) }],
        resources: [{ kind: 'path', path: toolCall.path }],
        riskCues: ['Creates a new file with the content shown below.'],
      };
    }

    case 'modify-file-tool-call': {
      return {
        kind: 'write',
        operationLabel: 'Modify file',
        scope: WORKSPACE_SCOPE,
        path: toolCall.path,
        diff: {
          oldText: summarizePermissionText(toolCall.oldText),
          newText: summarizePermissionText(toolCall.newText),
        },
        params: [{ label: 'Path', value: paramValue(toolCall.path) }],
        resources: [{ kind: 'path', path: toolCall.path }],
        riskCues: ['Overwrites part of an existing file.'],
      };
    }

    case 'delete-file-tool-call': {
      return {
        kind: 'delete',
        operationLabel: 'Delete file',
        scope: WORKSPACE_SCOPE,
        path: toolCall.path,
        params: [{ label: 'Path', value: paramValue(toolCall.path) }],
        resources: [{ kind: 'path', path: toolCall.path }],
        riskCues: ['Permanently deletes a file. Emdash does not provide an undo for this action.'],
      };
    }

    case 'search-tool-call': {
      return {
        kind: 'search',
        operationLabel: 'Search workspace',
        scope: WORKSPACE_SCOPE,
        params: [{ label: 'Query', value: paramValue(toolCall.query) }],
        resources: [],
        riskCues: ['Searches the workspace; does not modify files by itself.'],
      };
    }

    case 'mcp-tool-call': {
      const params: PermissionParam[] = [{ label: 'Tool', value: paramValue(toolCall.tool) }];
      if (toolCall.server) params.push({ label: 'Server', value: paramValue(toolCall.server) });
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
      const params: PermissionParam[] = [{ label: 'URL', value: paramValue(toolCall.url) }];
      if (toolCall.pageTitle) {
        params.push({ label: 'Page title', value: paramValue(toolCall.pageTitle) });
      }
      return {
        kind: 'fetch',
        operationLabel: 'Fetch URL',
        scope: NETWORK_SCOPE,
        params,
        resources: toolCall.url ? [{ kind: 'url', url: toolCall.url }] : [],
        riskCues: [
          'Requests data from a URL. Emdash cannot verify what the destination does with this request.',
        ],
      };
    }

    case 'spawn-subagent-tool-call': {
      const params: PermissionParam[] = [{ label: 'Name', value: paramValue(toolCall.name) }];
      if (toolCall.background) params.push({ label: 'Background', value: 'Yes' });
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
      const params: PermissionParam[] = [{ label: 'Tool', value: paramValue(toolCall.name) }];
      if (toolCall.toolKind)
        params.push({ label: 'Raw kind', value: paramValue(toolCall.toolKind) });
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
  for (const param of detail.params) lines.push(`${param.label}: ${param.value}`);
  for (const resource of detail.resources) {
    lines.push(
      resource.kind === 'url' ? `Resource: ${resource.url}` : `Resource: ${resource.path}`
    );
  }
  if (detail.riskCues.length > 0) lines.push('', 'Notes:', ...detail.riskCues);
  return lines.join('\n');
}
