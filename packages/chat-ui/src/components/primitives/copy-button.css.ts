/**
 * copy-button.css.ts — styles for CopyButton.
 *
 * Two marker classes are exported so each reveal trigger is scoped to its own
 * context and cannot leak across nesting levels:
 *
 *   messageGroup — applied to the assistant message container; reveals the
 *                  inline footer copy button on hover.
 *   codeGroup    — applied to each code block (BlockFrame); reveals that
 *                  block's overlay copy button on hover, independently of
 *                  any sibling code blocks and of the message body hover.
 *
 * Scope guarantees:
 *   - Hovering the message body reveals only the footer inline button.
 *   - Hovering code block A reveals A's overlay only (not B's).
 *   - Hovering code block A also reveals the same message's footer button
 *     because A is a descendant of messageGroup — this is intentional.
 *   - Hover state is fully isolated between sibling messages and between
 *     sibling code blocks.
 */

import { style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';

/** Apply to the assistant message container to enable inline-button group-hover. */
export const messageGroup = style({});

/** Apply to each code block (BlockFrame) to enable overlay-button group-hover. */
export const codeGroup = style({});

const buttonBase = style({
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  opacity: 0,
  transition: 'opacity 150ms ease',
  userSelect: 'none',
  color: vars.fgPassive,
  selectors: {
    '&:hover': { color: vars.fg },
    '&:focus-visible': { opacity: 1 },
  },
  // Hover has no equivalent on touch, so a purely hover-revealed button is
  // undiscoverable there. Keep it visible by default on devices that report
  // no hover capability at all, instead of relying on a tap that may or may
  // not simulate `:hover`.
  '@media': {
    '(hover: none)': {
      opacity: 1,
    },
  },
});

export const copyButtonOverlay = style([
  buttonBase,
  {
    position: 'absolute',
    top: '6px',
    right: '6px',
    zIndex: 10,
    borderRadius: '4px',
    padding: '2px',
    selectors: {
      [`${codeGroup}:hover &`]: { opacity: 1 },
    },
  },
]);

export const copyButtonInline = style([
  buttonBase,
  {
    gap: '4px',
    fontSize: '0.75rem',
    selectors: {
      [`${messageGroup}:hover &`]: { opacity: 1 },
    },
  },
]);

/**
 * Always-visible inline variant (no group-hover reveal). Used in toolbars
 * where the action is a primary affordance rather than a hover-revealed
 * extra — e.g. the diff card footer.
 */
export const copyButtonToolbar = style([
  buttonBase,
  {
    gap: '4px',
    fontSize: '0.75rem',
    opacity: 1,
  },
]);
