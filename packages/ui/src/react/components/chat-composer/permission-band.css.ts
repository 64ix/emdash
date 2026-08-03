import { globalStyle, keyframes, style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

export const bandContainer = style({
  display: 'flex',
  flexDirection: 'column',
  borderRadius: `${tokenVars.radiusXl} ${tokenVars.radiusXl} 0 0`,
  border: `1px solid ${vars.border}`,
  borderBottomWidth: 0,
  backgroundColor: `var(--composer-bg, ${vars.surfaceBaseEmphasis})`,
  color: vars.foreground,
  fontSize: tokenVars.textXs,
});

export const band = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
  paddingLeft: '0.75rem',
  paddingRight: '0.75rem',
  paddingTop: '0.5rem',
  paddingBottom: '0.5rem',
});

export const bandSection = style({
  paddingLeft: '0.75rem',
  paddingRight: '0.75rem',
  paddingBottom: '0.5rem',
});

export const bandSectionDivider = style({
  borderTop: `1px solid ${vars.border}`,
  paddingTop: '0.5rem',
});

export const bandIcon = style({
  flexShrink: 0,
  width: '0.875rem',
  height: '0.875rem',
  color: vars.foregroundMuted,
});

export const bandLabel = style({
  flex: 1,
  minWidth: 0,
  display: '-webkit-box',
  overflow: 'hidden',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  lineHeight: 1.375,
  color: vars.foregroundMuted,
});

export const bandLabelStrong = style({
  fontWeight: 500,
  color: vars.foreground,
});

export const bandCounter = style({
  marginLeft: '0.375rem',
  opacity: 0.6,
});

export const bandAction = style({
  flexShrink: 0,
});

globalStyle(`${bandAction} button`, {
  backgroundColor: vars.surfaceElevated,
  color: vars.foreground,
  borderColor: `color-mix(in srgb, ${vars.foreground} 12%, transparent)`,
});

globalStyle(`${bandAction} button:hover`, {
  backgroundColor: vars.surfaceElevatedHover,
  color: vars.foreground,
});

globalStyle(`${bandAction} button[aria-expanded="true"]`, {
  backgroundColor: vars.surfaceElevatedSelected,
  color: vars.foreground,
});

globalStyle(`${bandAction} button[data-popup-open]`, {
  backgroundColor: vars.surfaceElevatedSelected,
  color: vars.foreground,
});

// ── Resolution states ─────────────────────────────────────────────────────────

const spinKeyframes = keyframes({
  from: { transform: 'rotate(0deg)' },
  to: { transform: 'rotate(360deg)' },
});

export const resolvingIconSpin = style({
  animationName: spinKeyframes,
  animationDuration: '1s',
  animationTimingFunction: 'linear',
  animationIterationCount: 'infinite',
  width: '0.875rem',
  height: '0.875rem',
  color: vars.foregroundMuted,
});

export const resolvingRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  color: vars.foregroundMuted,
});

export const errorRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
});

export const errorMessage = style({
  flex: 1,
  minWidth: 0,
  color: vars.foregroundDestructive,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});
