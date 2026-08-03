import { globalStyle, style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import { textShimmer } from '@styles/effects.css';
import { vars } from '@styles/theme.css';
import { createVariableThemeContract } from '@styles/variable-theme-contract.css';

// ── Runtime geometry contract ─────────────────────────────────────────────────

export type DiffStyleVars = {
  height: number;
  headerH: number;
  footerH: number;
};

export const diffCardVars = createVariableThemeContract<DiffStyleVars>({
  height: null,
  headerH: null,
  footerH: null,
});

export const diffRoot = style({ height: diffCardVars.height });

// ── DiffHeader ────────────────────────────────────────────────────────────────

export const diffHeader = recipe({
  base: {
    height: diffCardVars.headerH,
    border: `1px solid ${vars.border}`,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    paddingLeft: '8px',
    paddingRight: '8px',
    cursor: 'pointer',
    fontSize: '0.75rem',
    transition: 'background 150ms',
    selectors: {
      '&:hover': { background: vars.bg3 },
    },
  },
  variants: {
    hasBody: {
      true: {
        borderTopLeftRadius: vars.radiusLg,
        borderTopRightRadius: vars.radiusLg,
        borderBottom: 'none',
      },
      false: {
        borderRadius: vars.radiusLg,
      },
    },
  },
});

export const diffFileName = style({
  color: vars.fgMuted,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: vars.typeBodyFontSize,
});

export const diffAddsCount = style({
  color: vars.diffAdded,
  flexShrink: 0,
  fontSize: vars.typeBodyFontSize,
});
export const diffDelsCount = style({
  color: vars.diffDeleted,
  flexShrink: 0,
  fontSize: vars.typeBodyFontSize,
});
export const diffSpacer = style({ flex: '1 1 0%' });
export const diffStatusIcon = style({
  display: 'flex',
  flexShrink: 0,
});
export const diffPermissionIcon = style([
  diffStatusIcon,
  {
    color: '#eab308',
  },
]);
export const diffErrorIcon = style([
  diffStatusIcon,
  {
    color: vars.fgError,
  },
]);

// ── DiffLines body ────────────────────────────────────────────────────────────

export const diffBodyCard = style({
  border: `1px solid ${vars.border}`,
  borderBottomLeftRadius: vars.radiusLg,
  borderBottomRightRadius: vars.radiusLg,
  overflow: 'hidden',
});

/** Per-row classes — keyed by DiffRow type. */
export const diffRowClasses = {
  add: style({
    display: 'flex',
    background: `color-mix(in srgb, ${vars.diffAdded} 10%, transparent)`,
    borderLeft: `3px solid ${vars.diffAdded}`,
  }),
  remove: style({
    display: 'flex',
    background: `color-mix(in srgb, ${vars.diffDeleted} 10%, transparent)`,
    borderLeft: `3px solid ${vars.diffDeleted}`,
  }),
  context: style({
    display: 'flex',
    borderLeft: '3px solid transparent',
  }),
} as const;

export const diffLineContent = style({
  color: vars.fg,
  flex: '1 1 0%',
  overflow: 'hidden',
  paddingLeft: '12px',
  paddingRight: '12px',
});

// ── Line-number gutter ────────────────────────────────────────────────────────
//
// Two narrow columns (old-side / new-side), numbered relative to the ACP-
// supplied snippet (oldText/newText), not the whole file — see diff-lines.ts.
// Numbers come straight from DiffRow.oldIdx/newIdx, so they cannot drift
// between the collapsed and expanded windows: both slice the same row array.

export const diffGutter = style({
  display: 'flex',
  flexShrink: 0,
  userSelect: 'none',
});

export const diffGutterCell = style({
  width: '2.25em',
  textAlign: 'right',
  paddingRight: '6px',
  color: vars.fgPassive,
  fontSize: vars.typeCodeFontSize,
  fontFamily: vars.typeCodeFontFamily,
  flexShrink: 0,
});

// ── Scrollable expanded body ──────────────────────────────────────────────────
//
// Wraps the row list only while expanded and overflowing its clamp height —
// mirrors the execute card's scroll treatment (execute.css.ts) so a large
// expanded diff scrolls internally instead of growing without bound.

export const diffScrollBody = style({
  position: 'relative',
  boxSizing: 'content-box',
  scrollbarWidth: 'thin',
});

globalStyle(`${diffScrollBody}::-webkit-scrollbar`, {
  width: 'var(--diff-scrollbar-size)',
  height: 'var(--diff-scrollbar-size)',
});

// ── Message body (empty / binary states) ─────────────────────────────────────

export const diffMessageBody = style({
  display: 'flex',
  alignItems: 'center',
  color: vars.fgPassive,
  fontSize: vars.typeBodyFontSize,
  paddingLeft: '12px',
  paddingRight: '12px',
});

// ── Footer bar (truncation summary + copy / open-full-diff / expand-collapse) ─

export const diffFooter = style({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  height: diffCardVars.footerH,
  paddingLeft: '8px',
  paddingRight: '8px',
  borderTop: `1px solid ${vars.border}`,
  fontSize: '0.75rem',
  color: vars.fgPassive,
});

export const diffFooterSummary = style({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const diffFooterSpacer = style({ flex: '1 1 0%' });

export const diffFooterButton = style({
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  color: vars.fgPassive,
  fontSize: '0.75rem',
  selectors: {
    '&:hover': { color: vars.fg },
  },
});

// ── Shiki line styles ─────────────────────────────────────────────────────────

export const pdiffBody = style({
  position: 'relative',
});

export const pdiffLine = style({
  whiteSpace: 'pre',
  fontSize: vars.typeCodeFontSize,
  fontWeight: vars.typeCodeFontWeight,
  fontFamily: vars.typeCodeFontFamily,
  // line-height is set via inline style in Diff.tsx (from theme.fonts.code.lineHeight)
  // so it cannot drift from the measured value via a CSS variable.
});

globalStyle(`${pdiffLine} span`, {
  color: 'var(--shiki-light)',
});

globalStyle(`.emdark ${pdiffLine} span`, {
  color: 'var(--shiki-dark)',
});

export { textShimmer };
