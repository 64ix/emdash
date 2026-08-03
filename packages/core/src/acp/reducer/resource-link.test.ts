/**
 * Unit tests for the `resource_link` decode → item-fold pipeline slice
 * (spec #18 ticket #21). Covers decodeSessionUpdate's resource_link branch
 * plus AcpTranscriptParser's materialization into a standalone
 * `TranscriptResourceLink` transcript item.
 */

import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { decodeSessionUpdate } from './decode';
import { AcpTranscriptParser } from './parser';

const CID = 'conv-resource-link';

function resourceLinkChunk(
  sessionUpdate: 'user_message_chunk' | 'agent_message_chunk',
  messageId: string | null,
  link: {
    uri: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
    size?: number;
  }
): SessionUpdate {
  return {
    sessionUpdate,
    sessionId: 'sess-1',
    ...(messageId !== null ? { messageId } : {}),
    content: { type: 'resource_link', ...link },
  } as unknown as SessionUpdate;
}

describe('decodeSessionUpdate — resource_link', () => {
  it('decodes a resource_link content block from an agent_message_chunk', () => {
    const event = decodeSessionUpdate(
      resourceLinkChunk('agent_message_chunk', 'msg-1', {
        uri: 'output/chart.png',
        name: 'chart.png',
        title: 'Sales chart',
        description: 'Q3 sales by region',
        mimeType: 'image/png',
        size: 2048,
      })
    );
    expect(event).toEqual({
      kind: 'resource_link',
      messageId: 'msg-1',
      uri: 'output/chart.png',
      name: 'chart.png',
      title: 'Sales chart',
      description: 'Q3 sales by region',
      mimeType: 'image/png',
      size: 2048,
    });
  });

  it('decodes a resource_link from a user_message_chunk with only required fields', () => {
    const event = decodeSessionUpdate(
      resourceLinkChunk('user_message_chunk', null, {
        uri: 'https://example.com/doc.pdf',
        name: 'doc.pdf',
      })
    );
    expect(event).toEqual({
      kind: 'resource_link',
      messageId: null,
      uri: 'https://example.com/doc.pdf',
      name: 'doc.pdf',
    });
  });

  it('still decodes plain text chunks unaffected by the new branch', () => {
    const event = decodeSessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      sessionId: 'sess-1',
      messageId: 'msg-1',
      content: { type: 'text', text: 'hello' },
    } as unknown as SessionUpdate);
    expect(event).toEqual({
      kind: 'message',
      role: 'assistant',
      messageId: 'msg-1',
      text: 'hello',
    });
  });
});

describe('AcpTranscriptParser — resource_link materialization', () => {
  it('materializes a resource_link chunk as a standalone resource-link item', () => {
    const parser = new AcpTranscriptParser({ conversationId: CID });
    parser.push(
      resourceLinkChunk('agent_message_chunk', 'msg-1', {
        uri: 'output/chart.png',
        name: 'chart.png',
        title: 'Sales chart',
        mimeType: 'image/png',
        size: 2048,
      })
    );
    parser.endTurn();

    const items = parser.history[0].items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'resource-link',
      uri: 'output/chart.png',
      name: 'chart.png',
      title: 'Sales chart',
      mimeType: 'image/png',
      size: 2048,
    });
  });

  it('assigns distinct ids to multiple resource links in the same turn', () => {
    const parser = new AcpTranscriptParser({ conversationId: CID });
    parser.push(
      resourceLinkChunk('agent_message_chunk', 'msg-1', { uri: 'a.png', name: 'a.png' })
    );
    parser.push(
      resourceLinkChunk('agent_message_chunk', 'msg-2', { uri: 'b.png', name: 'b.png' })
    );
    parser.endTurn();

    const items = parser.history[0].items;
    expect(items).toHaveLength(2);
    const ids = items.map((item) => item.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('keeps resource-link rows alongside message text in the same turn', () => {
    const parser = new AcpTranscriptParser({ conversationId: CID });
    parser.push({
      sessionUpdate: 'agent_message_chunk',
      sessionId: 'sess-1',
      messageId: 'msg-1',
      content: { type: 'text', text: 'Here is the chart:' },
    } as unknown as SessionUpdate);
    parser.push(
      resourceLinkChunk('agent_message_chunk', 'msg-2', { uri: 'chart.png', name: 'chart.png' })
    );
    parser.endTurn();

    const items = parser.history[0].items;
    expect(items.map((item) => item.kind)).toEqual(['message', 'resource-link']);
  });

  it('resource-link rows survive turn finalization unchanged', () => {
    const parser = new AcpTranscriptParser({ conversationId: CID });
    parser.push(
      resourceLinkChunk('agent_message_chunk', 'msg-1', { uri: 'chart.png', name: 'chart.png' })
    );
    parser.endTurn();

    const item = parser.history[0].items[0];
    expect(item.kind).toBe('resource-link');
  });
});
