/**
 * tool-presentation — provider-agnostic presentation model for the generic
 * tool inspector (search / fetch / MCP / unknown tool calls; ticket #30).
 *
 * Pure, DOM-free helpers so the mapping from raw `ToolNode` data to the
 * inspectable `ChatToolCall` shape (params, result/error text, status,
 * resources) is unit-testable without SolidJS or a browser. `toolFromItem` in
 * `tool.def.tsx` is the only caller in production code.
 *
 * Defensive by design: every helper accepts genuinely malformed input
 * (missing fields, wrong types, huge blobs, non-UTF-16-safe strings) and
 * degrades to a safe fallback rather than throwing — the `unknown-tool-call`
 * kind is the catch-all every future provider tool lands in, so it must never
 * crash or render blank on an unexpected payload shape.
 */

import type { SegmentCtx } from '@core/units';
import { redactSecrets } from '@emdash/shared/logger';
import type {
  ChatToolCall,
  ToolNode,
  ToolParam,
  ToolPresentationStatus,
  ToolResource,
  ToolStatus,
  ToolTextBlock,
} from '@/model';

// ── Bounds ────────────────────────────────────────────────────────────────────

/** Max characters kept in a result/error text block before truncation. */
export const MAX_RESULT_CHARS = 4000;
/** Max characters kept in a single normalized parameter value. */
export const MAX_PARAM_VALUE_CHARS = 300;

// ── Text bounding ─────────────────────────────────────────────────────────────

/**
 * Coerce an arbitrary (possibly malformed) value to a display-safe string.
 * Never throws — non-string values are stringified defensively.
 */
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
 * Bound `text` to at most `max` Unicode code points. Splits via the string
 * iterator (`Array.from`) rather than slicing UTF-16 code units, so a
 * surrogate pair (astral-plane characters, e.g. emoji) is never bisected into
 * an unpaired lone surrogate — the same defect fixed for auto-title
 * truncation (see `maybeAutoTitleConversation.ts`).
 */
export function boundCodePoints(text: string, max: number): ToolTextBlock {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: '', truncated: false, omittedChars: 0 };
  }
  if (max <= 0) {
    const codePoints = Array.from(text);
    return { text: '', truncated: codePoints.length > 0, omittedChars: codePoints.length };
  }
  const codePoints = Array.from(text);
  if (codePoints.length <= max) {
    return { text, truncated: false, omittedChars: 0 };
  }
  return {
    text: codePoints.slice(0, max).join(''),
    truncated: true,
    omittedChars: codePoints.length - max,
  };
}

/**
 * Bound + redact a raw provider text payload for safe, honest display.
 * Redaction runs on the *full* text before truncation so a secret pattern
 * cannot be exposed by being cut in half at the truncation boundary.
 */
export function summarizeToolText(raw: unknown, max = MAX_RESULT_CHARS): ToolTextBlock | undefined {
  if (raw === undefined || raw === null) return undefined;
  const safe = toDisplayString(raw);
  if (safe.length === 0) return undefined;
  const redacted = redactSecrets(safe);
  return boundCodePoints(redacted, max);
}

/** Bound + redact a single normalized parameter value for the params list. */
function paramValue(raw: unknown): string {
  return boundCodePoints(redactSecrets(toDisplayString(raw)), MAX_PARAM_VALUE_CHARS).text;
}

// ── Status derivation ─────────────────────────────────────────────────────────

export type ToolStatusInput = {
  status: ToolStatus;
  awaitingPermission: boolean;
  /** True when the call produced a non-empty result (or an explicit non-zero count). */
  hasResult: boolean;
  /** True when the call's enclosing turn was cancelled before it settled. */
  turnCancelled: boolean;
};

/**
 * Derive the richer inspector status from raw ACP status + context.
 *
 * Precedence: permission-pending > running > error > (done: cancelled | empty
 * | success). `turnCancelled` only ever demotes a "done"-with-no-result call
 * to 'cancelled' — a call that finished with a real result is always
 * 'success' even inside a turn the user later stopped elsewhere.
 */
export function deriveToolPresentationStatus(input: ToolStatusInput): ToolPresentationStatus {
  if (input.awaitingPermission) return 'permission-pending';
  if (input.status === 'running') return 'running';
  if (input.status === 'error') return 'error';
  if (input.turnCancelled && !input.hasResult) return 'cancelled';
  return input.hasResult ? 'success' : 'empty';
}

// ── Params / resources per semantic kind ──────────────────────────────────────

export type ToolCallLike = {
  kind: string;
  query?: unknown;
  matchCount?: unknown;
  server?: unknown;
  tool?: unknown;
  url?: unknown;
  pageTitle?: unknown;
  name?: unknown;
  toolKind?: unknown;
};

/** Build the normalized, bounded, redacted parameter list for one tool call. */
export function buildToolParams(item: ToolCallLike): ToolParam[] {
  switch (item.kind) {
    case 'search-tool-call': {
      const params: ToolParam[] = [{ label: 'Query', value: paramValue(item.query) }];
      if (typeof item.matchCount === 'number' && Number.isFinite(item.matchCount)) {
        params.push({ label: 'Matches', value: String(item.matchCount) });
      }
      return params;
    }
    case 'mcp-tool-call': {
      const params: ToolParam[] = [{ label: 'Tool', value: paramValue(item.tool) }];
      if (item.server !== undefined && item.server !== null) {
        params.push({ label: 'Server', value: paramValue(item.server) });
      }
      return params;
    }
    case 'web-fetch-tool-call': {
      const params: ToolParam[] = [{ label: 'URL', value: paramValue(item.url) }];
      if (item.pageTitle !== undefined && item.pageTitle !== null) {
        params.push({ label: 'Page title', value: paramValue(item.pageTitle) });
      }
      return params;
    }
    case 'unknown-tool-call': {
      const params: ToolParam[] = [{ label: 'Tool', value: paramValue(item.name) }];
      if (item.toolKind !== undefined && item.toolKind !== null) {
        params.push({ label: 'Raw kind', value: paramValue(item.toolKind) });
      }
      return params;
    }
    default:
      return [];
  }
}

/** Build the affected-resources list for one tool call (empty when unknown). */
export function buildToolResources(item: ToolCallLike): ToolResource[] {
  if (item.kind === 'web-fetch-tool-call' && typeof item.url === 'string' && item.url.length > 0) {
    const label =
      typeof item.pageTitle === 'string' && item.pageTitle.length > 0 ? item.pageTitle : item.url;
    return [{ kind: 'url', url: item.url, label }];
  }
  return [];
}

/**
 * Whether a call's raw output/matchCount represents a *meaningful* result —
 * distinct from a call that finished with nothing to show (the 'empty' state).
 */
export function computeHasResult(
  item: ToolCallLike,
  outputText: ToolTextBlock | undefined
): boolean {
  if (typeof item.matchCount === 'number' && Number.isFinite(item.matchCount)) {
    return item.matchCount > 0;
  }
  return !!outputText && outputText.text.length > 0;
}

/** Safe fallback display name for an unknown/malformed tool call. */
export function safeToolName(rawName: unknown, fallback = 'Tool'): string {
  if (typeof rawName === 'string' && rawName.trim().length > 0) return rawName;
  return fallback;
}

/** A short, bounded, single-line message safe for a native tooltip (`title`). */
export function firstLine(block: ToolTextBlock | undefined, max = 200): string | undefined {
  if (!block || block.text.length === 0) return undefined;
  const line = block.text.split('\n')[0] ?? block.text;
  return boundCodePoints(line, max).text;
}

// ── toolFromItem (the adapter) ─────────────────────────────────────────────────

/**
 * Build the inspectable presentation model for one generic (search / fetch /
 * MCP / unknown) tool call. Every other `ToolNode` kind (tool-group headers,
 * the unreachable-in-practice subagent fallback) keeps the original minimal
 * one-liner shape — this function only enriches the four kinds that actually
 * render through the generic inspector (see `unit-registry.ts`).
 *
 * Lives in this DOM-free module (rather than `tool.def.tsx`) so it stays
 * importable from the `node` vitest project — `tool.def.tsx` re-exports it for
 * callers that only need the UnitDef.
 */
export function toolFromItem(item: ToolNode, ctx: SegmentCtx): ChatToolCall {
  const base = 'toolCallId' in item ? item : null;
  const name =
    item.kind === 'search-tool-call'
      ? 'Search'
      : item.kind === 'mcp-tool-call'
        ? 'MCP'
        : item.kind === 'web-fetch-tool-call'
          ? 'Fetch'
          : item.kind === 'spawn-subagent-tool-call'
            ? 'Subagent'
            : item.kind === 'unknown-tool-call'
              ? safeToolName(item.name)
              : item.kind === 'tool-group'
                ? item.label
                : 'Tool';
  const inputSummary =
    item.kind === 'search-tool-call'
      ? `${item.query}${item.matchCount !== undefined ? ` (${item.matchCount} matches)` : ''}`
      : item.kind === 'mcp-tool-call'
        ? [item.server, item.tool].filter(Boolean).join('.')
        : item.kind === 'web-fetch-tool-call'
          ? (item.pageTitle ?? item.url)
          : item.kind === 'spawn-subagent-tool-call'
            ? `${item.name}${item.background ? ' (background)' : ''}`
            : item.kind === 'unknown-tool-call'
              ? (item.toolKind ?? undefined)
              : base?.inputSummary;

  const status = 'status' in item ? item.status : 'done';
  const awaitingPermission = base ? ctx.pendingToolCallIds().has(base.toolCallId) : false;

  // Only these four kinds render through the generic inspector body — every
  // other kind (tool-group header, unreachable subagent fallback) keeps the
  // original minimal shape untouched.
  if (
    item.kind !== 'search-tool-call' &&
    item.kind !== 'mcp-tool-call' &&
    item.kind !== 'web-fetch-tool-call' &&
    item.kind !== 'unknown-tool-call'
  ) {
    return { kind: 'tool', id: item.id, name, status, awaitingPermission, inputSummary };
  }

  const outputText = summarizeToolText(item.outputText);
  const hasResult = computeHasResult(item, outputText);
  const turnCancelled = ctx.turnOutcome?.()?.kind === 'cancelled';
  const presentationStatus = deriveToolPresentationStatus({
    status,
    awaitingPermission,
    hasResult,
    turnCancelled,
  });
  const isError = presentationStatus === 'error';

  return {
    kind: 'tool',
    id: item.id,
    name,
    status,
    awaitingPermission,
    inputSummary,
    presentationStatus,
    rawToolKind: item.kind === 'unknown-tool-call' ? item.toolKind : undefined,
    params: buildToolParams(item),
    resources: buildToolResources(item),
    ...(isError
      ? { errorDetail: outputText, error: firstLine(outputText) }
      : { result: outputText }),
  };
}

// ── Diagnostic copy payload ────────────────────────────────────────────────────

/** Build the flat, human-readable text the "Copy" action places on the clipboard. */
export function buildCopyText(item: ChatToolCall): string {
  const lines: string[] = [`Tool: ${item.name}`];
  if (item.rawToolKind) lines.push(`Raw kind: ${item.rawToolKind}`);
  for (const p of item.params ?? []) lines.push(`${p.label}: ${p.value}`);
  if (item.result) {
    lines.push('', 'Result:', item.result.text);
    if (item.result.truncated)
      lines.push(`(truncated — ${item.result.omittedChars} chars omitted)`);
  }
  if (item.errorDetail) {
    lines.push('', 'Error:', item.errorDetail.text);
    if (item.errorDetail.truncated) {
      lines.push(`(truncated — ${item.errorDetail.omittedChars} chars omitted)`);
    }
  }
  for (const r of item.resources ?? []) {
    lines.push(r.kind === 'url' ? `Resource: ${r.url}` : `Resource: ${r.path}`);
  }
  return lines.join('\n');
}
