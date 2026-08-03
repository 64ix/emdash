import { describe, expect, it, vi } from 'vitest';
import type { ChatView } from '@renderer/lib/chat/chat-transcript';
import {
  chatViewCommandForShortcut,
  executeChatViewCommand,
  isOpenSearchShortcut,
} from './acp-chat-view-commands';

describe('acp chat view commands', () => {
  it('maps host-owned shortcuts to chat command ids', () => {
    expect(
      chatViewCommandForShortcut({
        key: 'ArrowUp',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: false,
      })
    ).toBe('chat.scrollToTop');
    expect(
      chatViewCommandForShortcut({
        key: 'ArrowDown',
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        isComposing: false,
      })
    ).toBe('chat.scrollToBottom');
  });

  it('ignores modified or composing shortcut events', () => {
    expect(
      chatViewCommandForShortcut({
        key: 'ArrowDown',
        metaKey: true,
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
        isComposing: false,
      })
    ).toBeNull();
    expect(
      chatViewCommandForShortcut({
        key: 'ArrowDown',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: true,
      })
    ).toBeNull();
  });

  it('executes scroll commands against the active view', () => {
    const view = {
      scrollToTop: vi.fn(),
      scrollToBottom: vi.fn(),
    } as unknown as ChatView;

    expect(executeChatViewCommand(view, 'chat.scrollToTop')).toBe(true);
    expect(view.scrollToTop).toHaveBeenCalledWith({ behavior: 'smooth' });

    expect(executeChatViewCommand(view, 'chat.scrollToBottom')).toBe(true);
    expect(view.scrollToBottom).toHaveBeenCalledWith({ behavior: 'smooth' });
  });
});

describe('isOpenSearchShortcut', () => {
  it('matches Mod+F (either metaKey or ctrlKey)', () => {
    expect(
      isOpenSearchShortcut({
        key: 'f',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: false,
      })
    ).toBe(true);
    expect(
      isOpenSearchShortcut({
        key: 'F',
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        isComposing: false,
      })
    ).toBe(true);
  });

  it('ignores plain "f" with no modifier', () => {
    expect(
      isOpenSearchShortcut({
        key: 'f',
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: false,
      })
    ).toBe(false);
  });

  it('ignores a different key, and modified/composing variants of Mod+F', () => {
    expect(
      isOpenSearchShortcut({
        key: 'g',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: false,
      })
    ).toBe(false);
    expect(
      isOpenSearchShortcut({
        key: 'f',
        metaKey: true,
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
        isComposing: false,
      })
    ).toBe(false);
    expect(
      isOpenSearchShortcut({
        key: 'f',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: true,
      })
    ).toBe(false);
  });
});
