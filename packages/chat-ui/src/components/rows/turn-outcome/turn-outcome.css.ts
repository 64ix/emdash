import { style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import { vars } from '@styles/theme.css';

export const turnFooterRoot = style({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  fontSize: '0.75rem',
});

/** Status text tone: 'error' covers both failed and interrupted outcomes. */
export const turnFooterStatus = recipe({
  base: {},
  variants: {
    tone: {
      neutral: { color: vars.fgMuted },
      error: { color: vars.fgError },
    },
  },
  defaultVariants: { tone: 'neutral' },
});

/** Secondary meta text (duration / context / cost) — never shown today, see turn-footer.ts. */
export const turnFooterMeta = style({
  color: vars.fgPassive,
});

export const turnFooterSpacer = style({ flex: '1 1 0%' });
