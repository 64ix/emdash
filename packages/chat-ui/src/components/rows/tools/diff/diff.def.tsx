import { useCommands } from '@components/contexts/CommandsContext';
import type { MeasureCtx, RenderCtx } from '@core/define';
import type { SegmentCtx } from '@core/units';
import { defineUnit } from '@core/units';
import { pxTokens } from '@styles/px-tokens';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import { Match, Show, Switch, createMemo } from 'solid-js';
import type { ChatDiff, ToolNode } from '@/model';
import { DiffFooter, DiffHeader, DiffLines, DiffMessageBody, DiffScrollBody } from './Diff';
import {
  countChanges,
  formatOmittedSummary,
  formatPatchText,
  resolveDiffGeometry,
  type DiffGeometry,
  type DiffRow,
} from './diff-lines';
import { langFromPath } from './lang';
import { diffBodyCard, diffCardVars, diffRoot, type DiffStyleVars } from './diff.css';

export type DiffVars = {
  /** Style-relevant: consumed by diffCardVars contract. */
  headerH: number;
  /** Style-relevant: consumed by diffCardVars contract. */
  footerH: number;
  /** Measure-only: height of the empty/binary single-line message body. */
  messageH: number;
  /** Measure-only: max rows shown in the collapsed preview window. */
  collapsedMaxLines: number;
  /** Measure-only: leading context rows before the first change (collapsed). */
  collapsedContext: number;
  /** Measure-only: rows visible before the expanded body scrolls internally. */
  expandedMaxVisibleLines: number;
  /** Measure-only: hard cap on rows rendered even when expanded — the
   *  explicit, discoverable safety net for pathologically large diffs. */
  expandedRowCap: number;
  /** Measure-only: width/height of the expanded body's scrollbar. */
  scrollbarSize: number;
  /** Measure-only: border width on each side of the diff block. */
  border: number;
};

const DIFF_VARS: DiffVars = {
  headerH: 32,
  footerH: 28,
  messageH: 32,
  collapsedMaxLines: 8,
  collapsedContext: 1,
  expandedMaxVisibleLines: 24,
  expandedRowCap: 2000,
  scrollbarSize: 8,
  border: 1,
};

export function createFileDiffFromItem(
  item: Extract<ToolNode, { kind: 'create-file-tool-call' }>,
  ctx: SegmentCtx
): ChatDiff {
  return {
    kind: 'diff',
    id: item.id,
    path: item.path,
    oldText: null,
    newText: item.content,
    status: item.status,
    awaitingPermission: ctx.pendingToolCallIds().has(item.toolCallId),
  };
}

export function modifyFileDiffFromItem(
  item: Extract<ToolNode, { kind: 'modify-file-tool-call' }>,
  ctx: SegmentCtx
): ChatDiff {
  return {
    kind: 'diff',
    id: item.id,
    path: item.path,
    oldText: item.oldText,
    newText: item.newText,
    status: item.status,
    awaitingPermission: ctx.pendingToolCallIds().has(item.toolCallId),
  };
}

// ── Geometry helpers ────────────────────────────────────────────────────────
//
// resolveDiffGeometry (diff-lines.ts) is the single source of truth for which
// of the five review states applies. Everything below turns that decision
// into pixel heights — shared between measure() and Render() so they can
// never disagree about the rendered shape.

function computeGeometry(
  item: ChatDiff,
  rows: DiffRow[],
  expanded: boolean,
  vars: DiffVars
): DiffGeometry {
  return resolveDiffGeometry({
    isRunning: item.status === 'running',
    oldText: item.oldText,
    newText: item.newText,
    rows,
    expanded,
    collapsedMaxLines: vars.collapsedMaxLines,
    collapsedContext: vars.collapsedContext,
    expandedRowCap: vars.expandedRowCap,
  });
}

function geometryBodyHeight(
  geometry: DiffGeometry,
  codeLineH: number,
  vars: DiffVars
): { bodyH: number; contentH: number } {
  switch (geometry.kind) {
    case 'loading':
      return { bodyH: 0, contentH: 0 };
    case 'streaming': {
      const h = geometry.window.rows.length * codeLineH;
      return { bodyH: h, contentH: h };
    }
    case 'binary':
    case 'empty':
      return { bodyH: vars.messageH, contentH: vars.messageH };
    case 'content': {
      const contentH = geometry.window.rows.length * codeLineH;
      if (!geometry.expanded) return { bodyH: contentH, contentH };
      return { bodyH: Math.min(contentH, vars.expandedMaxVisibleLines * codeLineH), contentH };
    }
  }
}

/** Every settled state (everything but 'loading') gets the footer bar. */
function hasFooter(geometry: DiffGeometry): boolean {
  return geometry.kind !== 'loading' && geometry.kind !== 'streaming';
}

function diffUnitH(item: ChatDiff, ctx: MeasureCtx, vars: DiffVars): number {
  const rows = ctx.caches.computeDiff(item.oldText, item.newText);
  const geometry = computeGeometry(item, rows, ctx.expanded(item.id), vars);
  if (geometry.kind === 'loading') return vars.headerH;

  const codeLineH = ctx.theme.fonts.code.lineHeight;
  const { bodyH } = geometryBodyHeight(geometry, codeLineH, vars);
  const footerH = hasFooter(geometry) ? vars.footerH : 0;
  return vars.headerH + bodyH + 2 * vars.border + footerH;
}

// ── Render ────────────────────────────────────────────────────────────────────

function DiffUnitRender(props: { data: ChatDiff; ctx: RenderCtx; vars: DiffVars }) {
  const mCtx = () => props.ctx.measureCtx?.();
  const commands = useCommands();

  // Inverted semantics: stored "collapsed" bool = "expanded" (matches
  // execute/file-op/tool-group — see core/define.ts's Lane A/B doc comment).
  const isExpanded = () => props.ctx.viewState.isCollapsed(props.data.id);

  const rows = createMemo<DiffRow[]>(() => {
    const ctx = mCtx();
    if (!ctx) return [];
    return ctx.caches.computeDiff(props.data.oldText, props.data.newText);
  });

  const counts = createMemo(() => countChanges(rows()));

  const geometry = createMemo<DiffGeometry | null>(() => {
    const ctx = mCtx();
    if (!ctx) return null;
    return computeGeometry(props.data, rows(), isExpanded(), props.vars);
  });

  const lang = () => langFromPath(props.data.path);
  const codeLineH = () => mCtx()?.theme.fonts.code.lineHeight ?? 0;

  const bodyGeometry = createMemo(() => {
    const g = geometry();
    if (!g) return { bodyH: 0, contentH: 0 };
    return geometryBodyHeight(g, codeLineH(), props.vars);
  });

  const totalH = createMemo(() => {
    const ctx = mCtx();
    if (!ctx) return props.vars.headerH;
    return diffUnitH(props.data, ctx, props.vars);
  });

  const patchText = createMemo(() => formatPatchText(rows()));

  const summary = createMemo(() => {
    const g = geometry();
    if (!g || g.kind !== 'content') return null;
    return formatOmittedSummary(g.window.omittedBefore, g.window.omittedAfter);
  });

  const canToggle = createMemo(() => {
    const g = geometry();
    if (!g || g.kind !== 'content') return false;
    return g.expanded || g.window.omittedBefore + g.window.omittedAfter > 0;
  });

  const styleVars = (): DiffStyleVars => ({
    height: totalH(),
    headerH: props.vars.headerH,
    footerH: props.vars.footerH,
  });

  const handleOpenFullDiff = () => {
    commands().onOpenDiff?.({ path: props.data.path, itemId: props.data.id, source: 'diff' });
  };

  return (
    <div class={diffRoot} style={assignInlineVars(diffCardVars, pxTokens(styleVars()))}>
      <Show when={geometry()}>
        {(g) => (
          <>
            <DiffHeader
              item={props.data}
              adds={counts().adds}
              dels={counts().dels}
              headerH={props.vars.headerH}
              hasBody={g().kind !== 'loading'}
            />
            <Show when={g().kind !== 'loading'}>
              <div class={diffBodyCard}>
                <Switch>
                  <Match when={g().kind === 'streaming'}>
                    <DiffLines
                      rows={(g() as Extract<DiffGeometry, { kind: 'streaming' }>).window.rows}
                      oldText={props.data.oldText}
                      newText={props.data.newText}
                      lang={lang()}
                      status={props.data.status}
                      codeLineHeight={codeLineH}
                    />
                  </Match>
                  <Match when={g().kind === 'binary'}>
                    <DiffMessageBody
                      text="Binary content — open the full diff to review it."
                      height={props.vars.messageH}
                    />
                  </Match>
                  <Match when={g().kind === 'empty'}>
                    <DiffMessageBody text="No changes to preview." height={props.vars.messageH} />
                  </Match>
                  <Match when={g().kind === 'content'}>
                    <Show
                      when={(g() as Extract<DiffGeometry, { kind: 'content' }>).expanded}
                      fallback={
                        <DiffLines
                          rows={(g() as Extract<DiffGeometry, { kind: 'content' }>).window.rows}
                          oldText={props.data.oldText}
                          newText={props.data.newText}
                          lang={lang()}
                          status={props.data.status}
                          codeLineHeight={codeLineH}
                        />
                      }
                    >
                      <DiffScrollBody
                        rows={(g() as Extract<DiffGeometry, { kind: 'content' }>).window.rows}
                        oldText={props.data.oldText}
                        newText={props.data.newText}
                        lang={lang()}
                        status={props.data.status}
                        codeLineHeight={codeLineH}
                        bodyH={bodyGeometry().bodyH}
                        contentH={bodyGeometry().contentH}
                        scrollbarSize={props.vars.scrollbarSize}
                      />
                    </Show>
                  </Match>
                </Switch>
                <Show when={hasFooter(g())}>
                  <DiffFooter
                    itemId={props.data.id}
                    height={props.vars.footerH}
                    summary={summary()}
                    canToggle={canToggle()}
                    expanded={isExpanded()}
                    patchText={patchText()}
                    onOpenFullDiff={handleOpenFullDiff}
                  />
                </Show>
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

// ── UnitDef ───────────────────────────────────────────────────────────────────

export const diffUnitDef = defineUnit<ChatDiff, DiffVars>({
  kind: 'diff',
  margin: { top: 2, bottom: 6 },
  vars: DIFF_VARS,
  // Diffs read poorly compressed into the prose column — declare the wider
  // artifact lane (ticket #27). The layout resolves this to an exact width;
  // diffUnitH/DiffUnitRender never branch on width themselves.
  lane: 'artifact',

  estimate(item, ctx, vars): number {
    if (item.status === 'running' && item.newText.length === 0) return vars.headerH;
    return (
      vars.headerH +
      vars.collapsedMaxLines * ctx.theme.fonts.code.lineHeight +
      2 * vars.border +
      vars.footerH
    );
  },

  measure(item, ctx, vars): number {
    return diffUnitH(item, ctx, vars);
  },

  Render: DiffUnitRender,
});
