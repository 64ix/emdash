import { useCaches } from '@components/contexts/CachesContext';
import { useCommands } from '@components/contexts/CommandsContext';
import { cancelIdle, scheduleIdle } from '@components/engine/dom-utils';
import { CopyButton } from '@components/primitives/CopyButton';
import {
  GenericFileIcon,
  IconError,
  IconExternalLink,
  IconShieldAlert,
} from '@components/primitives/icons';
import { applyTokensToElement } from '@core/highlight/apply-tokens';
import type { CodeToken } from '@core/highlight/highlighter';
import { resolveFileIconClass } from '@lib/file-icons';
import { basename } from '@lib/path';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import { For, Show, createEffect, onCleanup } from 'solid-js';
import type { ChatDiff, ToolStatus } from '@/model';
import type { DiffRow } from './diff-lines';
import {
  diffAddsCount,
  diffCardVars,
  diffDelsCount,
  diffErrorIcon,
  diffFileName,
  diffFooter,
  diffFooterButton,
  diffFooterSpacer,
  diffFooterSummary,
  diffGutter,
  diffGutterCell,
  diffHeader,
  diffLineContent,
  diffMessageBody,
  diffPermissionIcon,
  diffRowClasses,
  diffScrollBody,
  diffSpacer,
  pdiffBody,
  pdiffLine,
  textShimmer,
} from './diff.css';

// ── DiffHeader ────────────────────────────────────────────────────────────────

export type DiffHeaderProps = {
  item: ChatDiff;
  adds: number;
  dels: number;
  headerH: number;
  /**
   * Whether a diff body is rendered below this header. Controls the border
   * shape: with a body the header owns the top + side edges and the separator
   * (`rounded-t`), standalone it owns the full rounded card border.
   */
  hasBody: boolean;
};

export function DiffHeader(props: DiffHeaderProps) {
  const name = () => basename(props.item.path);
  const iconClass = () => resolveFileIconClass(name());
  const running = () => props.item.status === 'running' && !props.item.awaitingPermission;
  // Stats are meaningless until a diff body exists; hide them while streaming
  // the header alone or when there are genuinely no changes.
  const showStats = () => props.hasBody && (props.adds > 0 || props.dels > 0);
  const commands = useCommands();

  const handleClick = () => {
    commands().onOpenFile?.({ path: props.item.path, itemId: props.item.id, source: 'diff' });
  };

  return (
    <button
      type="button"
      class={diffHeader({ hasBody: props.hasBody })}
      style={assignInlineVars({ [diffCardVars.headerH]: `${props.headerH}px` })}
      onClick={handleClick}
    >
      {iconClass() ? (
        <i
          class={`${iconClass()} shrink-0`}
          style={{ 'font-size': '12px', 'line-height': '1' }}
          aria-hidden="true"
        />
      ) : (
        <GenericFileIcon />
      )}
      <span class={diffFileName} classList={{ [textShimmer]: running() }} title={props.item.path}>
        {name()}
      </span>
      <Show when={showStats()}>
        <span class={diffAddsCount}>+{props.adds}</span>
        <span class={diffDelsCount}>−{props.dels}</span>
      </Show>
      <span class={diffSpacer} />
      <Show
        when={props.item.awaitingPermission}
        fallback={
          <Show when={props.item.status === 'error'}>
            <span class={diffErrorIcon} title={props.item.error ?? 'Failed'} aria-label="error">
              <IconError />
            </span>
          </Show>
        }
      >
        <span
          class={diffPermissionIcon}
          title="Awaiting permission"
          aria-label="awaiting permission"
        >
          <IconShieldAlert />
        </span>
      </Show>
    </button>
  );
}

// ── DiffLines — the row list (gutter + content), reused by streaming/content ──

export type DiffLinesProps = {
  /** Rows to render — already windowed (collapsed/expanded/streaming) by the caller. */
  rows: DiffRow[];
  /** Full (unwindowed) old/new text — used to resolve syntax-highlight tokens by index. */
  oldText: string | null;
  newText: string;
  lang: string | undefined;
  status: ToolStatus;
  codeLineHeight: () => number;
};

export function DiffLines(props: DiffLinesProps) {
  const caches = useCaches();
  const lineEls = new Map<number, HTMLElement>();

  createEffect(() => {
    const { rows, lang } = props;
    if (!rows.length || !lang) return;

    // Skip per-frame highlighting while the diff is still streaming in.
    // The effect tracks `props.status` reactively so it re-runs once when
    // status changes to 'done'/'error', running a single highlight then.
    if (props.status === 'running') return;

    const oldCode = props.oldText ?? '';
    const newCode = props.newText;

    function paint(newLines: CodeToken[][], oldLines: CodeToken[][]): void {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const el = lineEls.get(i);
        if (!row || !el) continue;

        let tokens: CodeToken[] | undefined;
        if (row.type === 'remove' && row.oldIdx !== undefined) {
          tokens = oldLines[row.oldIdx];
        } else if (row.newIdx !== undefined) {
          tokens = newLines[row.newIdx];
        }
        if (tokens) applyTokensToElement(el, tokens);
      }
    }

    const newHl = caches.peekHighlight(newCode, lang);
    const oldHl = props.oldText
      ? caches.peekHighlight(oldCode, lang)
      : { lines: [] as CodeToken[][], rootStyle: '' };
    if (newHl && oldHl) {
      paint(newHl.lines, oldHl.lines);
      return;
    }

    let cancelled = false;
    const handle = scheduleIdle(() => {
      if (cancelled) return;
      const newResult = caches.highlight(newCode, lang);
      const oldResult = props.oldText ? caches.highlight(oldCode, lang) : null;
      if (cancelled) return;
      paint(newResult?.lines ?? [], oldResult?.lines ?? []);
    });

    onCleanup(() => {
      cancelled = true;
      cancelIdle(handle);
    });
  });

  // Geometry source of truth: each row is pinned to the exact line height that
  // diffDef.measure() reserved (theme.fonts.code.lineHeight). Applied inline so
  // the rendered height never drifts from the measured height via a CSS variable.
  const lineH = () => props.codeLineHeight();

  return (
    <div class={pdiffBody}>
      <For each={props.rows}>
        {(row, i) => (
          <div class={diffRowClasses[row.type]} style={{ height: `${lineH()}px` }}>
            <span class={diffGutter} aria-hidden="true">
              <span class={diffGutterCell}>{row.oldIdx !== undefined ? row.oldIdx + 1 : ''}</span>
              <span class={diffGutterCell}>{row.newIdx !== undefined ? row.newIdx + 1 : ''}</span>
            </span>
            <span
              ref={(el) => {
                lineEls.set(i(), el);
                onCleanup(() => lineEls.delete(i()));
              }}
              class={`${pdiffLine} ${diffLineContent}`}
              style={{ 'line-height': `${lineH()}px` }}
            >
              {row.text}
            </span>
          </div>
        )}
      </For>
    </div>
  );
}

// ── DiffScrollBody — wraps DiffLines with internal scroll while expanded ──────

export type DiffScrollBodyProps = {
  rows: DiffRow[];
  oldText: string | null;
  newText: string;
  lang: string | undefined;
  status: ToolStatus;
  codeLineHeight: () => number;
  bodyH: number;
  contentH: number;
  scrollbarSize: number;
};

export function DiffScrollBody(props: DiffScrollBodyProps) {
  const overflows = () => props.contentH > props.bodyH;

  return (
    <div
      class={diffScrollBody}
      style={{
        height: `${props.bodyH}px`,
        'overflow-y': overflows() ? 'auto' : 'hidden',
        '--diff-scrollbar-size': `${props.scrollbarSize}px`,
      }}
    >
      <DiffLines
        rows={props.rows}
        oldText={props.oldText}
        newText={props.newText}
        lang={props.lang}
        status={props.status}
        codeLineHeight={props.codeLineHeight}
      />
    </div>
  );
}

// ── DiffMessageBody — empty / binary states ───────────────────────────────────

export type DiffMessageBodyProps = {
  text: string;
  height: number;
};

export function DiffMessageBody(props: DiffMessageBodyProps) {
  return (
    <div class={diffMessageBody} style={{ height: `${props.height}px` }}>
      {props.text}
    </div>
  );
}

// ── DiffFooter — truncation summary + copy / open-full-diff / expand-collapse ─

export type DiffFooterProps = {
  /** ChatDiff.id — wired to data-collapse-id so ChatRoot's delegation toggles it. */
  itemId: string;
  height: number;
  /** Human-readable "N lines hidden" summary, or null when nothing is hidden. */
  summary: string | null;
  /** Whether an expand/collapse affordance should render at all. */
  canToggle: boolean;
  expanded: boolean;
  /** Full (untruncated) patch text for the Copy button. */
  patchText: string;
  onOpenFullDiff: () => void;
};

export function DiffFooter(props: DiffFooterProps) {
  return (
    <div class={diffFooter} style={{ height: `${props.height}px` }}>
      <Show when={props.summary}>
        <span class={diffFooterSummary}>{props.summary}</span>
      </Show>
      <span class={diffFooterSpacer} />
      <Show when={props.canToggle}>
        <button
          type="button"
          class={diffFooterButton}
          data-collapse-id={props.itemId}
          aria-expanded={props.expanded ? 'true' : 'false'}
        >
          {props.expanded ? 'Show less' : 'Show more'}
        </button>
      </Show>
      <CopyButton text={props.patchText} variant="toolbar" label="Copy diff" />
      <button type="button" class={diffFooterButton} onClick={props.onOpenFullDiff}>
        <IconExternalLink />
        <span>Open full diff</span>
      </button>
    </div>
  );
}
