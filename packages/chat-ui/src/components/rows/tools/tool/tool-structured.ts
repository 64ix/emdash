/**
 * tool-structured — bounded, safe rendering of JSON-shaped tool results
 * (ticket #31, extending the generic inspector adapter from ticket #30).
 *
 * An MCP tool call's `outputText` is arbitrary text from a third-party
 * server; it frequently *is* a JSON payload (see the mcp-tool-call fixtures
 * in `acp-transcript-parser.test.ts`). Dumping that text as one unbroken
 * line — or naively `JSON.stringify`-ing an already-parsed value back out —
 * is not an "inspectable structure": a single very long line is exactly the
 * unreadable-blob failure mode this module exists to avoid.
 *
 * `buildStructuredResult` attempts to parse `outputText` as JSON and, only
 * when the parsed value is a container (object or array — a bare JSON
 * scalar has no structure worth a dedicated view and keeps using the plain
 * text fallback already produced by `summarizeToolText`), builds a bounded
 * `ToolStructuredValue` tree via `buildStructuredValue`. `structuredLines`
 * then renders that tree as indented, bounded text lines — reusing the
 * exact same per-line box/height math the plain-text result already uses
 * in `Tool.tsx`, so no new virtualization/measurement seam is required.
 *
 * `buildStructuredValue` is exported standalone (not just through the JSON
 * string entry point) because its defensiveness must hold for *any* JS
 * value, not only ones that survived `JSON.parse` — a cyclic reference
 * cannot occur in parsed JSON, but nothing stops a future non-JSON.parse
 * caller (or a hostile unit test) from constructing one directly.
 *
 * Bounds, independent of `MAX_RESULT_CHARS`/`MAX_PARAM_VALUE_CHARS` in
 * `tool-presentation.ts` (this module is deliberately self-contained so it
 * never needs to import back from there, avoiding a two-file import cycle):
 *   - MAX_STRUCTURED_SOURCE_CHARS — skip parsing text past this size outright
 *     (bounds worst-case JSON.parse cost/memory on a hostile huge payload).
 *   - MAX_STRUCTURED_DEPTH        — nesting cutoff; deeper values become a
 *     single `truncated` leaf instead of recursing further.
 *   - MAX_STRUCTURED_ENTRIES      — max keys/items kept per object/array
 *     level; the rest are counted, not rendered (bounds a 10k-key object).
 *   - MAX_STRUCTURED_NODES        — total node budget across the whole
 *     tree, shared by reference during the walk (bounds pathological
 *     shallow-but-wide *and* deep-but-narrow combinations alike).
 *   - MAX_STRUCTURED_STRING_CHARS — max characters kept per leaf string
 *     (and per object key) before truncation.
 *   - MAX_STRUCTURED_LINES        — hard cap on rendered lines as a final
 *     safety net once the node/entry bounds above are already exhausted.
 *
 * Secrets: `redactSecrets` runs on the *entire* source text before
 * `JSON.parse` (matching `summarizeToolText`'s "redact before truncating"
 * rule) — its patterns are JSON-key-aware (`"apiKey":"…"` -> `"apiKey":
 * "[REDACTED]"`) and text-scanning, so this catches secrets in nested
 * values *and* in keys, at any depth, before the value is ever parsed or
 * walked. Leaf strings are additionally redacted a second time defensively
 * (constant-cost given the small per-leaf bound) so a value that is not
 * quote-delimited the way the patterns expect still gets caught.
 */

import { redactSecrets } from '@emdash/shared/logger';
import type { ToolStructuredEntry, ToolStructuredValue } from '@/model';

// ── Bounds ────────────────────────────────────────────────────────────────────

/** Skip structured parsing outright for source text past this size. */
export const MAX_STRUCTURED_SOURCE_CHARS = 200_000;
/** Nesting cutoff — deeper values collapse into a single `truncated` leaf. */
export const MAX_STRUCTURED_DEPTH = 12;
/** Max keys/items kept per object/array level; the rest are counted only. */
export const MAX_STRUCTURED_ENTRIES = 50;
/** Total node budget shared across one `buildStructuredValue` call. */
export const MAX_STRUCTURED_NODES = 500;
/** Max characters kept per leaf string value (and per object key). */
export const MAX_STRUCTURED_STRING_CHARS = 300;
/** Hard cap on rendered lines — a final safety net past the bounds above. */
export const MAX_STRUCTURED_LINES = 1000;

// ── Leaf string bounding (self-contained — see module docstring) ─────────────

/**
 * Bound `text` to at most `max` Unicode code points without bisecting a
 * surrogate pair — same approach as `boundCodePoints` in `tool-presentation.ts`,
 * duplicated locally so this module never imports from there (see docstring).
 */
function boundLeafText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const codePoints = Array.from(text);
  if (codePoints.length <= max) return { text, truncated: false };
  return { text: codePoints.slice(0, max).join(''), truncated: true };
}

/** Redact then bound a leaf string (value or key) for safe structured display. */
function safeLeafText(raw: string): { text: string; truncated: boolean } {
  return boundLeafText(redactSecrets(raw), MAX_STRUCTURED_STRING_CHARS);
}

// ── buildStructuredValue — the bounded tree builder ───────────────────────────

type BuildBudget = { remaining: number };

function buildNode(
  value: unknown,
  depth: number,
  budget: BuildBudget,
  ancestors: unknown[]
): ToolStructuredValue {
  budget.remaining -= 1;
  if (budget.remaining < 0) return { kind: 'truncated', reason: 'budget' };
  if (depth > MAX_STRUCTURED_DEPTH) return { kind: 'truncated', reason: 'max-depth' };

  if (value === null) return { kind: 'null' };
  if (value === undefined) return { kind: 'unrepresentable' };

  const t = typeof value;
  if (t === 'string') {
    const bounded = safeLeafText(value as string);
    return { kind: 'string', value: bounded.text, truncated: bounded.truncated };
  }
  if (t === 'number') {
    return Number.isFinite(value as number)
      ? { kind: 'number', value: String(value) }
      : { kind: 'unrepresentable' };
  }
  if (t === 'boolean') return { kind: 'boolean', value: value as boolean };

  if (Array.isArray(value)) {
    if (ancestors.includes(value)) return { kind: 'circular' };
    const nextAncestors = [...ancestors, value];
    const capped = value.slice(0, MAX_STRUCTURED_ENTRIES);
    const items = capped.map((v) => buildNode(v, depth + 1, budget, nextAncestors));
    return { kind: 'array', items, omittedItems: Math.max(0, value.length - capped.length) };
  }

  if (t === 'object') {
    if (ancestors.includes(value)) return { kind: 'circular' };
    const nextAncestors = [...ancestors, value];
    let keys: string[];
    try {
      keys = Object.keys(value as object);
    } catch {
      return { kind: 'unrepresentable' };
    }
    const cappedKeys = keys.slice(0, MAX_STRUCTURED_ENTRIES);
    const entries: ToolStructuredEntry[] = cappedKeys.map((key) => {
      const boundedKey = safeLeafText(key);
      let raw: unknown;
      try {
        raw = (value as Record<string, unknown>)[key];
      } catch {
        raw = undefined;
      }
      return { key: boundedKey.text, value: buildNode(raw, depth + 1, budget, nextAncestors) };
    });
    return {
      kind: 'object',
      entries,
      omittedEntries: Math.max(0, keys.length - cappedKeys.length),
    };
  }

  // bigint, function, symbol, or anything else JSON cannot represent.
  return { kind: 'unrepresentable' };
}

/**
 * Build a bounded, redacted structured tree from any JS value — including a
 * bare scalar, `null`, an empty container, or (defensively) a cyclic object
 * that could never come from `JSON.parse`. Never throws.
 */
export function buildStructuredValue(value: unknown): ToolStructuredValue {
  return buildNode(value, 0, { remaining: MAX_STRUCTURED_NODES }, []);
}

// ── buildStructuredResult — the outputText entry point ────────────────────────

/**
 * Attempt to interpret raw tool-call output text as a JSON object or array
 * and build a bounded structured tree from it. Returns `undefined` (falling
 * back to the existing plain-text result/error rendering) when `raw` is not
 * a non-blank string, is larger than `MAX_STRUCTURED_SOURCE_CHARS`, fails to
 * parse as JSON, or parses to a bare scalar/`null` — a single value has no
 * structure worth a dedicated view. Never throws.
 */
export function buildStructuredResult(raw: unknown): ToolStructuredValue | undefined {
  if (typeof raw !== 'string') return undefined;
  if (raw.length === 0 || raw.length > MAX_STRUCTURED_SOURCE_CHARS) return undefined;
  if (raw.trim().length === 0) return undefined;

  let parsed: unknown;
  try {
    // Redact before parsing so a secret cannot survive inside a nested value
    // or key — matches `summarizeToolText`'s "redact before truncating" rule.
    parsed = JSON.parse(redactSecrets(raw));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  return buildStructuredValue(parsed);
}

// ── structuredLines — bounded text rendering ──────────────────────────────────

function indentText(indent: number): string {
  return '  '.repeat(indent);
}

function keyPrefix(key: string | undefined): string {
  return key === undefined ? '' : `"${key}": `;
}

function scalarText(node: ToolStructuredValue): string {
  switch (node.kind) {
    case 'string':
      return JSON.stringify(node.value) + (node.truncated ? ' …' : '');
    case 'number':
      return node.value;
    case 'boolean':
      return String(node.value);
    case 'null':
      return 'null';
    case 'circular':
      return '[circular reference]';
    case 'truncated':
      return node.reason === 'max-depth' ? '… (max depth reached)' : '… (output truncated)';
    case 'unrepresentable':
      return '[unrepresentable value]';
    default:
      return '';
  }
}

function emitNode(
  node: ToolStructuredValue,
  indent: number,
  key: string | undefined,
  trailingComma: boolean,
  out: string[]
): void {
  if (out.length > MAX_STRUCTURED_LINES) return;
  const prefix = `${indentText(indent)}${keyPrefix(key)}`;
  const comma = trailingComma ? ',' : '';

  if (node.kind === 'object') {
    if (node.entries.length === 0 && node.omittedEntries === 0) {
      out.push(`${prefix}{}${comma}`);
      return;
    }
    out.push(`${prefix}{`);
    node.entries.forEach((entry, i) => {
      const isLast = i === node.entries.length - 1 && node.omittedEntries === 0;
      emitNode(entry.value, indent + 1, entry.key, !isLast, out);
    });
    if (node.omittedEntries > 0) {
      const noun = node.omittedEntries === 1 ? 'key' : 'keys';
      out.push(`${indentText(indent + 1)}… ${node.omittedEntries} more ${noun} omitted`);
    }
    out.push(`${indentText(indent)}}${comma}`);
    return;
  }

  if (node.kind === 'array') {
    if (node.items.length === 0 && node.omittedItems === 0) {
      out.push(`${prefix}[]${comma}`);
      return;
    }
    out.push(`${prefix}[`);
    node.items.forEach((item, i) => {
      const isLast = i === node.items.length - 1 && node.omittedItems === 0;
      emitNode(item, indent + 1, undefined, !isLast, out);
    });
    if (node.omittedItems > 0) {
      const noun = node.omittedItems === 1 ? 'item' : 'items';
      out.push(`${indentText(indent + 1)}… ${node.omittedItems} more ${noun} omitted`);
    }
    out.push(`${indentText(indent)}]${comma}`);
    return;
  }

  out.push(`${prefix}${scalarText(node)}${comma}`);
}

/**
 * Render a `ToolStructuredValue` tree as indented, bounded text lines — one
 * visual line per node (matching the fixed per-line height the result/error
 * detail box already reserves in `Tool.tsx`). Never throws, and always
 * terminates even on a pathologically wide/deep tree thanks to the node
 * budget already applied by `buildStructuredValue`, plus `MAX_STRUCTURED_LINES`
 * as a final backstop.
 */
export function structuredLines(node: ToolStructuredValue): string[] {
  const out: string[] = [];
  emitNode(node, 0, undefined, false, out);
  if (out.length > MAX_STRUCTURED_LINES) {
    return [...out.slice(0, MAX_STRUCTURED_LINES), '… output truncated'];
  }
  return out;
}
