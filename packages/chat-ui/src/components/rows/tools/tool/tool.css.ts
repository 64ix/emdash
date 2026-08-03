import { style } from '@vanilla-extract/css';
import { sx } from '@styles/sprinkles.css';
import { vars } from '@styles/theme.css';

// ── Header content ────────────────────────────────────────────────────────────

export const toolName = style({
  fontSize: vars.typeBodyFontSize,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flexShrink: 1,
  minWidth: 0,
});

export const toolSummary = style([
  {
    marginLeft: '6px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    opacity: 0.75,
  },
  toolName,
]);

// ── Body ──────────────────────────────────────────────────────────────────────

export const toolBody = style({
  boxSizing: 'border-box',
});

export const toolSection = style({
  display: 'flex',
  flexDirection: 'column',
});

export const toolSectionLabel = style([
  sx({ color: 'fgPassive', fontSize: '11', fontWeight: 'medium' }),
  { textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '2px' },
]);

// ── Params ────────────────────────────────────────────────────────────────────

export const toolParamRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  minWidth: 0,
});

export const toolParamLabel = style([
  sx({ color: 'fgMuted', fontSize: '12' }),
  { flexShrink: 0, minWidth: '64px' },
]);

export const toolParamValue = style({
  fontSize: vars.typeBodyFontSize,
  color: vars.fg,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
});

// ── Result / error detail ─────────────────────────────────────────────────────

export const toolDetailBlock = style({
  boxSizing: 'border-box',
  fontSize: vars.typeCodeFontSize,
  fontWeight: vars.typeCodeFontWeight,
  fontFamily: vars.typeCodeFontFamily,
  color: vars.fg,
});

export const toolDetailLine = style({
  whiteSpace: 'pre',
});

export const toolMutedLine = sx({ color: 'fgMuted', fontSize: '12' });

// ── Resources ─────────────────────────────────────────────────────────────────

export const toolResourceLink = style([
  sx({ color: 'link', fontSize: '13' }),
  {
    display: 'flex',
    alignItems: 'center',
    background: 'none',
    border: 'none',
    padding: 0,
    textAlign: 'left',
    cursor: 'pointer',
    textDecoration: 'none',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    width: '100%',
    selectors: {
      '&:hover': { textDecoration: 'underline' },
    },
  },
]);

// ── Actions ───────────────────────────────────────────────────────────────────

export const toolActionsRow = style({
  display: 'flex',
  alignItems: 'center',
});
