/**
 * Tool — the generic inspectable tool-call renderer (ticket #30).
 *
 * Used for ACP tool kinds without a dedicated specialized renderer — today
 * that is search / fetch / MCP / unknown tool calls (see `unit-registry.ts`
 * and `tool.def.tsx#toolFromItem`). Renders a compact one-line summary that
 * expands into normalized inputs, a bounded/redacted result or error preview,
 * affected resources, and a copy action — reusing the same CollapsibleCard
 * shell as Execute so collapse/expand, shimmer, error, and permission chrome
 * behave identically across tool rows.
 *
 * All body content is rendered as plain text (`textContent` children /
 * `white-space: pre`) — tool payloads are untrusted provider output and are
 * never interpreted as markup. Resource links — both workspace files and
 * fetched URLs — go through the single typed `onActivateLink` contract that
 * markdown prose and resource-link rows use (ticket #20), so there is no raw
 * anchor and no `window.open` on this path.
 *
 * Outer card geometry (`toolUnitH`) is the single source of truth for height;
 * Render mirrors the same arithmetic via a memo so measure and paint agree.
 */

import { useCommands } from '@components/contexts/CommandsContext';
import { CollapsibleCard } from '@components/primitives/CollapsibleCard';
import { CopyButton } from '@components/primitives/CopyButton';
import { GenericFileIcon, IconGlobe, IconSearch } from '@components/primitives/icons';
import type { MeasureCtx, RenderCtx } from '@core/define';
import { For, Show, createMemo } from 'solid-js';
import type { ChatToolCall, ToolResource } from '@/model';
import { buildCopyText } from './tool-presentation';
import { structuredLines } from './tool-structured';
import {
  toolActionsRow,
  toolBody,
  toolDetailBlock,
  toolDetailLine,
  toolMutedLine,
  toolName,
  toolParamLabel,
  toolParamRow,
  toolParamValue,
  toolResourceLink,
  toolSection,
  toolSectionLabel,
  toolSummary,
} from './tool.css';

// ── Geometry ──────────────────────────────────────────────────────────────────

export type ToolVars = {
  /** Fixed height (px) of the header row. */
  rowH: number;
  /** Border width (px) on each side of the card. */
  border: number;
  /** Height (px) of one normalized-parameter row. */
  paramRowH: number;
  /** Height (px) of one affected-resource row. */
  resourceRowH: number;
  /** Height (px) of the actions row (Copy button). */
  actionsRowH: number;
  /** Line height (px) used for the result/error text block (estimate fallback). */
  detailLineH: number;
  /** Max visible lines in the result/error block before it scrolls. */
  detailMaxLines: number;
  /** Horizontal padding inside the body. */
  linePadX: number;
};

/** Vertical gap (px) between adjacent present sections inside the body. */
const SECTION_GAP = 6;
/** Vertical padding (px) top+bottom inside the body container. */
const BODY_PAD_Y = 8;
/** 3 borders: top card edge + header-separator + bottom card edge. */
const CHROME_Y_BORDERS = 3;

/** One placeholder line shown in the detail block for a state with no output. */
function detailStatusLine(item: ChatToolCall): string | undefined {
  if (item.presentationStatus === 'empty') return 'No results.';
  if (item.presentationStatus === 'cancelled') return 'Cancelled before completion.';
  return undefined;
}

/**
 * Lines composing the result/error detail block, or []. When the raw output
 * parsed as JSON (`item.structuredResult` — ticket #31), renders the bounded
 * structured tree instead of the flat text so the shape (nesting, keys,
 * omitted-entry counts) is inspectable rather than one unreadable line. Both
 * branches are plain text — `toolDetailLine` never interprets provider output
 * as markup — and the caller (measure + render) always sees the same lines
 * for a given `item`, so no separate height-estimation seam is needed.
 */
function detailLines(item: ChatToolCall): string[] {
  if (item.structuredResult) return structuredLines(item.structuredResult);
  const block = item.errorDetail ?? item.result;
  if (block) {
    const lines = block.text.length > 0 ? block.text.split('\n') : [];
    if (block.truncated) {
      const noun = block.omittedChars === 1 ? 'character' : 'characters';
      lines.push(`… truncated — ${block.omittedChars} ${noun} omitted`);
    }
    return lines;
  }
  const placeholder = detailStatusLine(item);
  return placeholder ? [placeholder] : [];
}

function paramsH(item: ChatToolCall, vars: ToolVars): number {
  return (item.params?.length ?? 0) * vars.paramRowH;
}

function resourcesH(item: ChatToolCall, vars: ToolVars): number {
  return (item.resources?.length ?? 0) * vars.resourceRowH;
}

function detailBlockH(item: ChatToolCall, lineH: number, vars: ToolVars): number {
  const lines = detailLines(item);
  return Math.min(lines.length, vars.detailMaxLines) * lineH;
}

/** Sum of present body sections (params / detail / resources / actions) plus gaps + padding. */
export function toolBodyH(
  item: ChatToolCall,
  vars: ToolVars,
  detailLineH = vars.detailLineH
): number {
  const sections = [
    paramsH(item, vars),
    detailBlockH(item, detailLineH, vars),
    resourcesH(item, vars),
  ];
  const present = sections.filter((h) => h > 0);
  present.push(vars.actionsRowH); // the actions row is always shown once expanded
  const gaps = Math.max(0, present.length - 1) * SECTION_GAP;
  return present.reduce((a, b) => a + b, 0) + gaps + 2 * BODY_PAD_Y;
}

/** Full unit height (header + body when expanded + card chrome borders). */
export function toolUnitH(item: ChatToolCall, ctx: MeasureCtx, vars: ToolVars): number {
  const expanded = ctx.expanded(item.id);
  const lineH = ctx.theme.fonts.code.lineHeight || vars.detailLineH;
  const bodyH = expanded ? toolBodyH(item, vars, lineH) : 0;
  return vars.rowH + bodyH + CHROME_Y_BORDERS * vars.border;
}

// ── Icon ──────────────────────────────────────────────────────────────────────

/** Search/Fetch get a distinct icon; MCP/unknown share the neutral fallback. */
function ToolIcon(props: { item: ChatToolCall }) {
  return (
    <Show
      when={props.item.name === 'Search'}
      fallback={
        <Show when={props.item.name === 'Fetch'} fallback={<GenericFileIcon />}>
          <IconGlobe />
        </Show>
      }
    >
      <IconSearch />
    </Show>
  );
}

// ── Resource link ─────────────────────────────────────────────────────────────

/**
 * One affected-resource row. Both variants activate the single typed
 * link-action contract (`commands().onActivateLink`, ticket #20) — the host
 * classifies and acts (editor / external confirmation / blocked-with-copy).
 * There is deliberately no raw anchor, no `target="_blank"` and no
 * `window.open` here: those were the escape hatches #20 removed. Neither
 * variant interprets the resource label as markup.
 */
function ToolResourceRow(props: { resource: ToolResource; itemId: string; rowH: number }) {
  const commands = useCommands();
  const href = () =>
    props.resource.kind === 'workspace-file' ? props.resource.path : props.resource.url;

  return (
    <button
      type="button"
      class={toolResourceLink}
      style={{ height: `${props.rowH}px` }}
      title={href()}
      onClick={() =>
        commands().onActivateLink?.({
          href: href(),
          itemId: props.itemId,
          source: 'resource-link',
        })
      }
    >
      {props.resource.label}
    </button>
  );
}

// ── Body ──────────────────────────────────────────────────────────────────────

function ToolBody(props: { item: ChatToolCall; vars: ToolVars; lineH: number }) {
  const lines = createMemo(() => detailLines(props.item));
  const hasError = () => !!props.item.errorDetail;
  const hasBlock = () => !!(props.item.result || props.item.errorDetail);
  const copyText = createMemo(() => buildCopyText(props.item));
  const blockH = createMemo(
    () => Math.min(lines().length, props.vars.detailMaxLines) * props.lineH
  );
  const scrolls = () => lines().length > props.vars.detailMaxLines;

  return (
    <div class={toolBody} style={{ padding: `${BODY_PAD_Y}px ${props.vars.linePadX}px` }}>
      <Show when={(props.item.params?.length ?? 0) > 0}>
        <div class={toolSection} style={{ 'margin-bottom': `${SECTION_GAP}px` }}>
          <span class={toolSectionLabel}>Input</span>
          <For each={props.item.params}>
            {(param) => (
              <div class={toolParamRow} style={{ height: `${props.vars.paramRowH}px` }}>
                <span class={toolParamLabel}>{param.label}</span>
                <span class={toolParamValue} title={param.value}>
                  {param.value}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={lines().length > 0}>
        <div class={toolSection} style={{ 'margin-bottom': `${SECTION_GAP}px` }}>
          <span class={toolSectionLabel}>{hasError() ? 'Error' : 'Result'}</span>
          <Show when={hasBlock()} fallback={<div class={toolMutedLine}>{lines()[0]}</div>}>
            <div
              class={toolDetailBlock}
              style={{
                height: `${blockH()}px`,
                'overflow-y': scrolls() ? 'auto' : 'hidden',
                'overflow-x': 'auto',
              }}
            >
              <For each={lines()}>
                {(line) => (
                  <div
                    class={toolDetailLine}
                    style={{ height: `${props.lineH}px`, 'line-height': `${props.lineH}px` }}
                  >
                    {line}
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
      <Show when={(props.item.resources?.length ?? 0) > 0}>
        <div class={toolSection} style={{ 'margin-bottom': `${SECTION_GAP}px` }}>
          <span class={toolSectionLabel}>Resources</span>
          <For each={props.item.resources}>
            {(resource) => (
              <ToolResourceRow
                resource={resource}
                itemId={props.item.id}
                rowH={props.vars.resourceRowH}
              />
            )}
          </For>
        </div>
      </Show>
      <div class={toolActionsRow} style={{ height: `${props.vars.actionsRowH}px` }}>
        <CopyButton text={copyText()} variant="inline" label="Copy details" />
      </div>
    </div>
  );
}

// ── Tool ──────────────────────────────────────────────────────────────────────

export type ToolProps = {
  item: ChatToolCall;
  ctx: RenderCtx;
  vars: ToolVars;
};

export function Tool(props: ToolProps) {
  // Inverted semantics: stored "collapsed" bool = "expanded".
  const isExpanded = () => props.ctx.viewState.isCollapsed(props.item.id);
  const mCtx = () => props.ctx.measureCtx?.();
  const lineH = createMemo(() => mCtx()?.theme.fonts.code.lineHeight || props.vars.detailLineH);

  const totalH = createMemo(() => {
    const m = mCtx();
    if (!m) return props.vars.rowH + CHROME_Y_BORDERS * props.vars.border;
    return toolUnitH(props.item, m, props.vars);
  });

  const isRunning = () => props.item.status === 'running' && !props.item.awaitingPermission;
  const isError = () => (props.item.presentationStatus ?? props.item.status) === 'error';
  // 'success' and 'running'/'permission-pending'/'error' already read distinctly
  // from the header's shimmer/error/permission chrome; 'empty' and 'cancelled'
  // otherwise look identical to 'success' when collapsed, so surface a small
  // badge for them specifically.
  const statusBadge = () => {
    switch (props.item.presentationStatus) {
      case 'empty':
        return 'No results';
      case 'cancelled':
        return 'Cancelled';
      default:
        return undefined;
    }
  };

  return (
    <CollapsibleCard
      id={props.item.id}
      ctx={props.ctx}
      height={totalH()}
      headerH={props.vars.rowH}
      expanded={isExpanded()}
      active={isRunning()}
      error={isError()}
      errorTitle={props.item.error}
      awaitingPermission={props.item.awaitingPermission}
      icon={<ToolIcon item={props.item} />}
      headerRight={
        <Show when={statusBadge()}>
          <span class={toolMutedLine}>{statusBadge()}</span>
        </Show>
      }
      header={
        <>
          <span class={toolName}>{props.item.name}</span>
          <Show when={props.item.inputSummary}>
            <span class={toolSummary}>{props.item.inputSummary}</span>
          </Show>
        </>
      }
    >
      <Show when={isExpanded()}>
        <ToolBody item={props.item} vars={props.vars} lineH={lineH()} />
      </Show>
    </CollapsibleCard>
  );
}
