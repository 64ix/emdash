/**
 * searchTranscript — pure derivation of transcript search results over
 * canonical transcript data (ticket #36, spec #18).
 *
 * Mirrors `deriveTranscriptOutline` (`state/outline.ts`): recomputed fresh
 * from `committedTurns`/`activeTurn`/`pendingPrompt` on every call — never
 * incrementally patched — so prepending older history (see
 * `AcpHistoryPagination` / `ChatView.loadOlder`) can never duplicate or
 * reorder already-derived results. Every result is keyed on the item's own
 * stable id (matches `RenderUnit.itemId`), so callers pass it straight to
 * `ChatView.scrollToItem()` / `AcpChatStore.scrollToTranscriptItem()` — no DOM
 * scan, no `MutationObserver`, no manual `scrollTop` math.
 *
 * ── Scope: loaded history only ───────────────────────────────────────────────
 *
 * "The canonical transcript" can be far larger than what is loaded — #24
 * paginates history in 100-turn windows. This module only ever sees the
 * turns already paged into `ChatState`; it has no way to search history that
 * has not been fetched yet. The host (`AcpChatStore`/`AcpChatSearchController`
 * — see the app layer) is responsible for being honest about that: expose
 * whether persisted history is exhausted (`AcpHistoryPagination.exhausted`)
 * and offer to page in the rest on demand, rather than silently searching a
 * partial window while implying full coverage.
 *
 * ── One result per item ───────────────────────────────────────────────────────
 *
 * An item can carry several searchable fields (a tool call's path, title, and
 * output can all match the same query). Rather than emitting one result per
 * *field* — which would let the same item appear multiple times and complicate
 * "free of duplicate items after pagination" — each item contributes at most
 * one result: `candidatesForItem` lists that item's searchable fields in a
 * fixed priority order (most specific/normalized field first, generic
 * title/summary next, bulk output last) and the first one that matches wins
 * the result's `kind` and snippet.
 *
 * ── Redaction runs before matching ────────────────────────────────────────────
 *
 * Every candidate field is redacted with `redactSecrets` (same helper
 * `tool-presentation.ts` uses for the tool inspector) *before* the
 * case-insensitive substring search runs, so a query can never surface a
 * secret pattern that the rest of the UI already hides, and the returned
 * snippet is always built from the same redacted text a match position was
 * found in — never a mismatch between "what matched" and "what's shown".
 *
 * ── Truncation never drops a match ────────────────────────────────────────────
 *
 * The tool inspector caps *displayed* result/error text to `MAX_RESULT_CHARS`
 * (see `tool-presentation.ts`). This module does not reuse that bound for
 * searching — it searches the full redacted field text, so a match past that
 * display boundary is still found and returned, never silently dropped. The
 * snippet itself is windowed *around the match* (±`contextCodePoints`,
 * default below) rather than truncated from the start, so the matched text
 * is always present in what's shown regardless of the field's overall length
 * or where in it the match falls. A known, accepted trade-off: because the
 * tool card itself still only renders its own display-bounded prefix, a
 * search hit whose match lies past that prefix will land on the right
 * transcript row when the user jumps to it, but may not be visible without
 * the tool's own "load more" affordance — the search result is honest about
 * the hit existing, not about every consumer's independent display bound.
 *
 * ── Grapheme-safe snippets ────────────────────────────────────────────────────
 *
 * Snippet windows are computed in Unicode code points (`Array.from`), never
 * UTF-16 code units, so a surrogate pair (e.g. an emoji) straddling a window
 * boundary is never bisected into an unpaired lone surrogate — the same
 * defect `boundCodePoints` (`tool-presentation.ts`) fixes for tool text.
 *
 * ── Case sensitivity ──────────────────────────────────────────────────────────
 *
 * Matching is case-insensitive via `String.prototype.toLowerCase()` on both
 * the query and each candidate field. This is a pragmatic, dependency-free
 * choice (no fuzzy-search library — the existing stack already has
 * `redactSecrets` and a working substring search is sufficient for "find text
 * I remember typing or seeing"); it does not implement full Unicode case
 * folding for rare characters whose lowercase form changes length.
 *
 * ── What is not indexed ───────────────────────────────────────────────────────
 *
 * Full file bodies (`create-file-tool-call.content`) and diff regions
 * (`modify-file-tool-call.oldText`/`newText`) are intentionally excluded.
 * They are already reviewable through the diff/Changes surfaces (#28/#29),
 * and including them would make every keystroke rescan potentially large
 * blobs for no benefit the acceptance criteria ask for (which enumerate
 * messages, tool summaries/details, results, errors, and paths — not full
 * file contents).
 */

import type { PendingPrompt } from './session-state';
import { redactSecrets } from '@emdash/shared/logger';
import type { ToolNode, TranscriptItem, TranscriptTurn } from '@/model';

/**
 * `ToolNode` minus its one non-tool-call member (`ToolGroup`) — chat-ui's
 * `model.ts` re-exports `ToolNode` but not the underlying `ToolCallItem`
 * union, so it is reconstructed here rather than reaching into
 * `@emdash/core`'s internal turn model.
 */
type ToolCallNode = Exclude<ToolNode, { kind: 'tool-group' }>;

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Coarse category a search result is labeled with, so the UI can show what
 * kind of thing matched without the caller needing to switch on raw
 * `TranscriptItem.kind` values.
 */
export type TranscriptSearchResultKind =
  | 'prompt'
  | 'response'
  | 'thinking'
  | 'tool'
  | 'tool-result'
  | 'tool-error'
  | 'path'
  | 'resource';

export type TranscriptSearchResult = {
  /** Stable, unique per result (== `itemId` — one result per item, see module doc). */
  readonly id: string;
  /** Canonical item id — pass straight to `ChatView.scrollToItem()`. */
  readonly itemId: string;
  /** The `TranscriptTurn.id` this result's item belongs to. */
  readonly turnId: string;
  readonly kind: TranscriptSearchResultKind;
  /**
   * Bounded, redacted, grapheme-safe text window around the match, with a
   * leading/trailing `…` when the window is a truncated slice of a larger
   * field. Never markdown/HTML — render as plain text only.
   */
  readonly snippet: string;
  /** Code-point offset of the match within `snippet`. */
  readonly matchStart: number;
  /** Code-point length of the match within `snippet`. */
  readonly matchLength: number;
};

export type TranscriptSearchOptions = {
  /** Code points of context kept on each side of the match inside the snippet. */
  contextCodePoints?: number;
};

const DEFAULT_CONTEXT_CODEPOINTS = 40;

// ── Candidate fields per item kind ───────────────────────────────────────────

type Candidate = { kind: TranscriptSearchResultKind; text: string };

function toolCallCandidates(item: ToolCallNode): Candidate[] {
  const out: Candidate[] = [];
  const pushPath = (text: string | null | undefined) => {
    if (text) out.push({ kind: 'path', text });
  };
  const pushTool = (text: string | null | undefined) => {
    if (text) out.push({ kind: 'tool', text });
  };

  switch (item.kind) {
    case 'read-tool-call':
      pushPath(item.path);
      pushPath(item.resource);
      break;
    case 'create-file-tool-call':
    case 'modify-file-tool-call':
    case 'delete-file-tool-call':
      pushPath(item.path);
      break;
    case 'execute-tool-call':
      pushTool(item.command);
      break;
    case 'search-tool-call':
      pushTool(item.query);
      break;
    case 'mcp-tool-call':
      pushTool(item.tool);
      pushTool(item.server);
      break;
    case 'web-fetch-tool-call':
      pushTool(item.url);
      pushTool(item.pageTitle);
      break;
    case 'spawn-subagent-tool-call':
      pushTool(item.name);
      break;
    case 'unknown-tool-call':
      pushTool(item.name);
      pushTool(item.toolKind);
      break;
    case 'create-plan-tool-call':
      break;
  }

  // Generic fallback label, common to every tool call kind.
  pushTool(item.title);
  pushTool(item.inputSummary);

  if ('outputText' in item && item.outputText) {
    out.push({ kind: item.status === 'error' ? 'tool-error' : 'tool-result', text: item.outputText });
  }

  return out;
}

/** Fields to check, in priority order — the first one that matches wins the result. */
function candidatesForItem(item: TranscriptItem): Candidate[] {
  switch (item.kind) {
    case 'message':
      return [{ kind: item.role === 'user' ? 'prompt' : 'response', text: item.text }];
    case 'thinking':
      return [{ kind: 'thinking', text: item.text }];
    case 'resource-link': {
      const out: Candidate[] = [];
      if (item.title) out.push({ kind: 'resource', text: item.title });
      out.push({ kind: 'resource', text: item.name });
      if (item.description) out.push({ kind: 'resource', text: item.description });
      out.push({ kind: 'path', text: item.uri });
      return out;
    }
    case 'tool-group':
      return [{ kind: 'tool', text: item.label }];
    default:
      return toolCallCandidates(item);
  }
}

// ── Matching ──────────────────────────────────────────────────────────────────

/**
 * Extract a grapheme-safe, redacted snippet window around a match found at
 * `matchIndex`/`matchLength` (UTF-16 code-unit offsets into `redactedText`).
 * See the module doc's "Grapheme-safe snippets" section.
 */
function buildSnippet(
  redactedText: string,
  matchIndex: number,
  matchLength: number,
  contextCodePoints: number
): { snippet: string; matchStart: number; matchLength: number } {
  const prefixCp = Array.from(redactedText.slice(0, matchIndex)).length;
  const matchCp = Array.from(redactedText.slice(matchIndex, matchIndex + matchLength)).length;
  const allCp = Array.from(redactedText);

  const windowStart = Math.max(0, prefixCp - contextCodePoints);
  const windowEnd = Math.min(allCp.length, prefixCp + matchCp + contextCodePoints);
  const truncatedBefore = windowStart > 0;
  const truncatedAfter = windowEnd < allCp.length;

  const windowText = allCp.slice(windowStart, windowEnd).join('');
  const prefix = truncatedBefore ? '…' : '';
  const suffix = truncatedAfter ? '…' : '';

  return {
    snippet: `${prefix}${windowText}${suffix}`,
    matchStart: prefix.length + (prefixCp - windowStart),
    matchLength: matchCp,
  };
}

/** Try one candidate field against `needle` (already lowercased). Redacts first. */
function matchCandidate(
  candidate: Candidate,
  needle: string,
  contextCodePoints: number
): Omit<TranscriptSearchResult, 'id' | 'itemId' | 'turnId'> | null {
  const redacted = redactSecrets(candidate.text);
  const haystack = redacted.toLowerCase();
  const matchIndex = haystack.indexOf(needle);
  if (matchIndex === -1) return null;
  const { snippet, matchStart, matchLength } = buildSnippet(
    redacted,
    matchIndex,
    needle.length,
    contextCodePoints
  );
  return { kind: candidate.kind, snippet, matchStart, matchLength };
}

function matchItem(
  item: TranscriptItem,
  needle: string,
  contextCodePoints: number
): Omit<TranscriptSearchResult, 'turnId'> | null {
  for (const candidate of candidatesForItem(item)) {
    const built = matchCandidate(candidate, needle, contextCodePoints);
    if (built) return { id: item.id, itemId: item.id, ...built };
  }
  return null;
}

// ── searchTranscript ──────────────────────────────────────────────────────────

/**
 * Search loaded canonical transcript state for `rawQuery`. Returns results in
 * chronological, deterministic order (committed turns, then the active turn,
 * then a synthetic entry for an unacknowledged `pendingPrompt` — the same
 * three-way split `deriveTranscriptOutline` reconciles), with at most one
 * result per item id.
 *
 * Returns `[]` for a blank/whitespace-only query rather than every item —
 * an empty query is "no search", not "match everything".
 */
export function searchTranscript(
  committedTurns: readonly TranscriptTurn[],
  activeTurn: TranscriptTurn | null,
  pendingPrompt: PendingPrompt | null,
  rawQuery: string,
  opts: TranscriptSearchOptions = {}
): TranscriptSearchResult[] {
  const query = rawQuery.trim();
  if (query.length === 0) return [];
  const needle = query.toLowerCase();
  const contextCodePoints = opts.contextCodePoints ?? DEFAULT_CONTEXT_CODEPOINTS;

  const results: TranscriptSearchResult[] = [];

  const visitTurn = (turn: TranscriptTurn) => {
    for (const item of turn.items) {
      const built = matchItem(item, needle, contextCodePoints);
      if (built) results.push({ ...built, turnId: turn.id });
    }
  };

  for (const turn of committedTurns) visitTurn(turn);

  if (activeTurn) {
    visitTurn(activeTurn);
  } else if (pendingPrompt) {
    // Mirrors ChatRoot's / deriveTranscriptOutline's synthetic pending-prompt
    // turn: a prompt sent but not yet acknowledged by the agent.
    const built = matchCandidate({ kind: 'prompt', text: pendingPrompt.text }, needle, contextCodePoints);
    if (built) {
      results.push({
        id: pendingPrompt.id,
        itemId: pendingPrompt.id,
        turnId: `pending:${pendingPrompt.id}:turn`,
        ...built,
      });
    }
  }

  return results;
}

// ── Keyboard navigation ───────────────────────────────────────────────────────

/**
 * Compute the next result index to select for Next (`direction: 1`) /
 * Previous (`direction: -1`), wrapping around at either end. Returns `null`
 * when there are no results to navigate to.
 */
export function advanceSearchResultIndex(
  resultCount: number,
  currentIndex: number | null,
  direction: 1 | -1
): number | null {
  if (resultCount === 0) return null;
  if (currentIndex === null) return direction === 1 ? 0 : resultCount - 1;
  return (currentIndex + direction + resultCount) % resultCount;
}

// ── Rendering the match, safely ──────────────────────────────────────────────

/**
 * Split `snippet` into the (before, match, after) text around
 * `matchStart`/`matchLength` for highlighting, without ever bisecting a
 * surrogate pair or otherwise slicing by UTF-16 code unit — mirrors
 * `buildSnippet`'s own code-point windowing above. `matchStart`/`matchLength`
 * are already code-point offsets (see `TranscriptSearchResult`'s field docs),
 * so callers must index with `Array.from`, never `String.prototype.slice`,
 * to stay aligned with them.
 *
 * The three pieces are always plain text: `snippet` itself is never
 * markdown/HTML (see `TranscriptSearchResult.snippet`), so a caller can
 * render `before`/`match`/`after` as separate text nodes (e.g. wrapping
 * `match` in a `<mark>`) without ever interpreting the query or matched
 * content as markup.
 */
export function splitSnippetAtMatch(
  result: Pick<TranscriptSearchResult, 'snippet' | 'matchStart' | 'matchLength'>
): { before: string; match: string; after: string } {
  const codePoints = Array.from(result.snippet);
  const start = Math.min(Math.max(result.matchStart, 0), codePoints.length);
  const end = Math.min(Math.max(start + result.matchLength, start), codePoints.length);
  return {
    before: codePoints.slice(0, start).join(''),
    match: codePoints.slice(start, end).join(''),
    after: codePoints.slice(end).join(''),
  };
}
