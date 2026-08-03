import { style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import { resetButton } from '@styles/reset.css';
import { sx } from '@styles/sprinkles.css';
import { vars } from '@styles/theme.css';
import { createVariableThemeContract } from '@styles/variable-theme-contract.css';

// ── Runtime geometry contract ─────────────────────────────────────────────────

/**
 * Contract for the file-op card vars. `height` is set on the root by the def;
 * `padY` is set locally by FileOpList / FileOpPreviewBody where it is consumed
 * via `padding-block`.
 */
export type FileOpStyleVars = {
  height: number;
  padY: number;
};

export const fileOpCardVars = createVariableThemeContract<FileOpStyleVars>({
  height: null,
  padY: null,
});

export const fileOpRoot = style({ height: fileOpCardVars.height });

/**
 * clickable:true renders as a native <button> (FileRowItem in
 * FileOperation.tsx); clickable:false stays a plain <div> for the
 * non-interactive streaming-preview case. resetButton is harmless on the
 * div variant (all no-ops there) and required for the button variant.
 */
export const fileRow = recipe({
  base: [
    resetButton,
    sx({
      display: 'flex',
      alignItems: 'center',
      gap: '1.5',
      color: 'fgPassive',
      fontSize: 'sm',
    }),
  ],
  variants: {
    clickable: {
      true: {
        width: '100%',
        cursor: 'pointer',
        selectors: {
          '&:hover': { color: vars.fgMuted },
          '&:focus-visible': {
            color: vars.fgMuted,
            outline: '2px solid currentColor',
            outlineOffset: '-2px',
          },
        },
      },
      false: {},
    },
  },
});

// A native <button> (see FileOperation.tsx's deprecated FileOperation
// component) — resetButton strips native button chrome.
export const fileOpHeader = style([
  resetButton,
  {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    gap: '6px',
    cursor: 'pointer',
    color: vars.fgPassive,
    fontSize: vars.typeBodyFontSize,
    userSelect: 'none',
    selectors: {
      '&:hover': { color: vars.fgMuted },
      '&:focus-visible': {
        color: vars.fgMuted,
        outline: '2px solid currentColor',
        outlineOffset: '-2px',
      },
    },
  },
]);

export const monoRunning = style({
  fontFamily: 'monospace',
  fontSize: vars.typeBodyFontSize,
  color: vars.fgPassive,
});

/** Single-file op wrapper — flex row, full height. */
export const singleOpRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
});

export const fileOpStatusIcon = style({
  marginLeft: 'auto',
  display: 'inline-flex',
  flexShrink: 0,
});

export const fileOpPermissionIcon = style([
  fileOpStatusIcon,
  {
    color: '#eab308',
  },
]);

export const fileOpErrorIcon = style([
  fileOpStatusIcon,
  {
    color: vars.fgError,
  },
]);

export const chevronSm = recipe({
  base: {
    display: 'inline-block',
    fontSize: '10px',
    transition: 'transform 150ms ease-out',
  },
  variants: {
    expanded: {
      true: { transform: 'rotate(90deg)' },
      false: {},
    },
  },
});
