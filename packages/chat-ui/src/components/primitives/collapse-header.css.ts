import { style } from '@vanilla-extract/css';
import { resetButton } from '@styles/reset.css';
import { sx } from '@styles/sprinkles.css';
import { vars } from '@styles/theme.css';

export const collapseRow = sx({
  display: 'flex',
  alignItems: 'center',
  gap: '1.5',
  cursor: 'pointer',
  color: 'fgPassive',
  userSelect: 'none',
});

export const collapseRowHover = style({
  selectors: {
    '&:hover': { color: vars.fgMuted },
    '&:focus-visible': {
      color: vars.fgMuted,
      outline: '2px solid currentColor',
      outlineOffset: '-2px',
    },
  },
});

/** Combined class for the header row element (a native <button> — see CollapseHeader.tsx). */
export const collapseHeader = style([
  resetButton,
  collapseRow,
  collapseRowHover,
  { width: '100%', fontSize: vars.typeBodyFontSize },
]);

export const chevron = style({
  display: 'inline-block',
  fontSize: '10px',
  transition: 'transform 150ms ease-out',
});

export const chevronExpanded = style({
  transform: 'rotate(90deg)',
});

export const collapseStatusError = style({
  marginLeft: 'auto',
  display: 'flex',
  color: vars.fgError,
});

export const collapseStatusPermission = style({
  marginLeft: 'auto',
  display: 'flex',
  color: '#eab308',
});
