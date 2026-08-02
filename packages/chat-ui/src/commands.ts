/**
 * ChatCommands and ScrollToItemOptions — host-injectable callback contracts.
 *
 * Extracted from index.tsx so that internal modules (chat-view, ChatRoot,
 * CommandsContext) can import these types without creating a circular
 * dependency through the package entry point.
 */

import type { ChatImageAttachment } from './model';

export type ChatViewCommandId = 'chat.scrollToTop' | 'chat.scrollToBottom';

export type ChatViewCommand = {
  id: ChatViewCommandId;
  label: string;
  defaultKeybinding?: string;
};

export const CHAT_VIEW_COMMANDS = [
  {
    id: 'chat.scrollToTop',
    label: 'Scroll to top',
    defaultKeybinding: 'Mod+ArrowUp',
  },
  {
    id: 'chat.scrollToBottom',
    label: 'Scroll to bottom',
    defaultKeybinding: 'Mod+ArrowDown',
  },
] as const satisfies readonly ChatViewCommand[];

/**
 * Typed callbacks that host apps inject to respond to user actions inside the
 * chat transcript. Pass via `createChatView({ commands })` or update later
 * via `view.setCommands(commands)`.
 */
export type ChatCommands = {
  /**
   * Called when the user clicks a file path in a diff header, file-op row,
   * resource-link card, or inline prose link.
   */
  onOpenFile?: (arg: { path: string; itemId: string; source: 'diff' | 'file-op' }) => void;

  /**
   * Called when the user clicks an image attachment thumbnail inside a user
   * message bubble.
   */
  onViewImage?: (arg: {
    attachment: ChatImageAttachment;
    itemId: string;
    source: 'user-message';
  }) => void;

  /**
   * Resolve an attachment id to a displayable data URL. Used for committed
   * messages whose transcript stores attachment metadata but not bytes.
   */
  resolveAttachment?: (attachment: { id: string; name: string }) => Promise<string | null>;

  /**
   * Called when the user clicks the stop button on the current user message
   * while the agent is generating.
   */
  onStop?: (arg: { itemId: string }) => void;

  /**
   * Called when the user activates a chat-authored link — a rendered
   * Markdown prose link or a resource-link row's URI alike. The host
   * classifies `href` through its own typed link-action taxonomy (workspace
   * file / external http(s) / blocked) and performs the resulting action
   * itself (open the editor, run the external-link confirmation flow, or
   * report a blocked target). There is no default here and no raw anchor or
   * `window.open` fallback in the renderers that call this — an unhandled
   * `href` is the host's responsibility to resolve to an explicit action,
   * never to navigate.
   */
  onActivateLink?: (arg: {
    href: string;
    itemId: string;
    source: 'prose-link' | 'resource-link';
  }) => void;

  /**
   * Called when the user clicks a Mermaid diagram block preview.
   */
  onViewMermaid?: (arg: { chart: string; blockId: string; source: 'mermaid-block' }) => void;

  /**
   * Called when the user clicks a resolved @-mention chip in the transcript.
   * `id` is the stable identifier (e.g. a file path); `label` is the raw @-token text.
   */
  onClickMention?: (arg: {
    id: string;
    label: string;
    kind: 'file' | 'issue' | 'symbol' | 'custom';
    itemId: string;
    source: 'prose-mention';
  }) => void;
};

export type ScrollToItemOptions = {
  /** Where to align the row within the viewport. Default: 'start'. */
  align?: 'start' | 'center' | 'end';
  /** Additional pixel offset applied after alignment. Default: 0. */
  offset?: number;
  /** Native scroll behavior. Default: 'auto'. */
  behavior?: ScrollBehavior;
};
