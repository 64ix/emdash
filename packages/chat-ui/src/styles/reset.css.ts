/**
 * reset.css.ts — minimal CSS reset to replace the box-sizing + element resets
 * that Tailwind's preflight provided.
 *
 * KEY RISK: this reset must NOT change any element heights that pretext measures.
 * Run prose/diff/table/execute contract tests after any edit here.
 *
 * We intentionally do NOT include a full Tailwind preflight equivalent — only
 * the rules that chat-ui components actually rely on:
 *   - box-sizing: border-box on all elements
 *   - margin: 0 on block elements used in chat (p, h1-h6, etc.)
 *   - list-style: none on ul/ol
 * These are the rules Tailwind's preflight sets that affect layout height.
 *
 * Font-face @imports stay in chat.module.css (to be renamed chat-fonts.css).
 */

import { globalStyle, style } from '@vanilla-extract/css';

// Border-box sizing — prevents padding from bloating element dimensions.
globalStyle('*, *::before, *::after', {
  boxSizing: 'border-box',
});

// Zero out default browser margins on block elements used inside chat.
globalStyle('p, h1, h2, h3, h4, h5, h6, ul, ol, li, blockquote, pre, table, figure', {
  margin: 0,
  padding: 0,
});

// Remove bullet points that would shift list geometry.
globalStyle('ul, ol', {
  listStyle: 'none',
});

// Tables use border-collapse + border-spacing:0 inline; ensure no extra gaps.
globalStyle('table', {
  borderCollapse: 'separate',
  borderSpacing: 0,
});

/**
 * resetButton — baseline reset for native <button> elements used as
 * clickable transcript rows/headers (collapse headers, diff/file-op
 * open-in-editor rows, resource-link rows). These previously rendered as
 * `<div role="button">` with no native button chrome to fight; converting
 * them to real buttons (ticket #26) needs the subset of Tailwind preflight's
 * button reset this file otherwise deliberately skips — the desktop app
 * happens to load Tailwind globally (which already resets these), but
 * chat-ui's own Storybook/browser tests do not, so the reset belongs here.
 *
 * Compose as the FIRST entry in `style([resetButton, ...])` so a component's
 * own declarations (color, cursor, gap, etc.) still win on any overlap.
 * Intentionally does not touch `outline` — the browser's default
 * `:focus-visible` ring (or a component's own explicit one) must keep
 * showing focus.
 */
export const resetButton = style({
  appearance: 'none',
  WebkitAppearance: 'none',
  background: 'none',
  border: 'none',
  margin: 0,
  padding: 0,
  textAlign: 'left',
  fontFamily: 'inherit',
  fontWeight: 'inherit',
  lineHeight: 'inherit',
  letterSpacing: 'inherit',
  color: 'inherit',
});
