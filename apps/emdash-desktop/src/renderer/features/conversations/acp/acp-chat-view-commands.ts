import type { ChatView, ChatViewCommandId } from '@renderer/lib/chat/chat-transcript';

type ChatShortcutEvent = Pick<
  KeyboardEvent,
  'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing'
>;

export function chatViewCommandForShortcut(event: ChatShortcutEvent): ChatViewCommandId | null {
  if (event.isComposing || event.altKey || event.shiftKey || (!event.metaKey && !event.ctrlKey)) {
    return null;
  }

  switch (event.key) {
    case 'ArrowUp':
      return 'chat.scrollToTop';
    case 'ArrowDown':
      return 'chat.scrollToBottom';
    default:
      return null;
  }
}

export function executeChatViewCommand(
  view: ChatView | null,
  commandId: ChatViewCommandId
): boolean {
  if (!view) return false;

  switch (commandId) {
    case 'chat.scrollToTop':
      view.scrollToTop({ behavior: 'smooth' });
      return true;
    case 'chat.scrollToBottom':
      view.scrollToBottom({ behavior: 'smooth' });
      return true;
  }
}

/**
 * Mod+F opens transcript search (ticket #36, spec #18). Deliberately not a
 * `ChatViewCommandId`: opening the search bar is panel-level UI state
 * (`AcpChatStore.openSearch()`), not a `ChatView` scroll action, so it does
 * not belong in `@emdash/chat-ui`'s `ChatViewCommand` contract the way
 * scroll-to-top/bottom do.
 *
 * Checked against the app's global shortcut registry
 * (`src/shared/shortcuts.ts`'s `APP_SHORTCUTS`) and the existing
 * `SearchInput` `Mod+F` convention (`src/renderer/lib/ui/search-input.tsx`)
 * before adding this: neither reserves `Mod+F` anywhere a mounted ACP chat
 * panel could also be visible, so this cannot hijack a shortcut the composer,
 * command palette, or another `Mod+F`-bound search input already owns.
 */
export function isOpenSearchShortcut(event: ChatShortcutEvent): boolean {
  if (event.isComposing || event.altKey || event.shiftKey || (!event.metaKey && !event.ctrlKey)) {
    return false;
  }
  return event.key.toLowerCase() === 'f';
}
