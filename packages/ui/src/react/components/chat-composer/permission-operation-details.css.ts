import { style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

export const root = style({
  width: '100%',
});

export const panel = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  paddingTop: '0.5rem',
  paddingBottom: '0.25rem',
  fontSize: tokenVars.textXs,
});

export const metaRow = style({
  display: 'flex',
  alignItems: 'baseline',
  gap: '0.375rem',
  minWidth: 0,
});

export const metaLabel = style({
  flexShrink: 0,
  color: vars.foregroundMuted,
  fontWeight: tokenVars.fontWeightMedium,
});

export const inlineCode = style({
  fontFamily: tokenVars.fontMono,
  wordBreak: 'break-all',
  color: vars.foreground,
});

export const paramValue = style({
  fontFamily: tokenVars.fontMono,
  wordBreak: 'break-all',
  color: vars.foreground,
  minWidth: 0,
});

export const textSection = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
});

export const textSectionHeader = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
});

export const textBlock = style({
  margin: 0,
  padding: '0.5rem',
  maxHeight: '9rem',
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  fontFamily: tokenVars.fontMono,
  fontSize: tokenVars.textXs,
  color: vars.foreground,
  backgroundColor: vars.backgroundTertiary,
  borderRadius: tokenVars.radiusMd,
  border: `1px solid ${vars.border}`,
});

export const truncatedNote = style({
  color: vars.foregroundMuted,
  fontStyle: 'italic',
});

export const resourcesList = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
});

export const resourceItem = style({
  fontFamily: tokenVars.fontMono,
  wordBreak: 'break-all',
  color: vars.foreground,
  listStyle: 'none',
});

export const riskCues = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
  margin: 0,
  paddingLeft: '1rem',
  color: vars.foregroundMuted,
});

export const copyButton = style({
  flexShrink: 0,
  width: '1.25rem',
  height: '1.25rem',
});

export const jumpButton = style({
  alignSelf: 'flex-start',
});
