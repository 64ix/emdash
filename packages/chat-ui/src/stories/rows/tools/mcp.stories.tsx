/**
 * MCP tool-call stories — ACP mcp-tool-call rendered through the generic tool row.
 */

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import type { ToolNode, ToolStatus } from '@/model';
import { ChatHost, ChatHostExpanded, ScriptedChat } from '@/stories/_harness/chat-host';
import { ToolNodeStateMatrix } from '@/stories/_harness/state-matrix';
import { streamToolNode, toolNodeTurn } from './tool-node-story-helpers';

const meta: Meta = {
  title: 'Rows/Tools/MCP',
  component: ChatHost,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof ChatHost>;

function mcpNode(status: ToolStatus, id = `mcp-${status}`): ToolNode {
  return {
    kind: 'mcp-tool-call',
    id,
    seq: 0,
    toolCallId: id,
    title: 'MCP',
    status,
    server: 'linear',
    tool: 'searchIssues',
  };
}

export const StateMatrix: Story = {
  render: () => <ToolNodeStateMatrix build={(status) => mcpNode(status)} />,
};

export const Streaming: Story = {
  render: () => (
    <ScriptedChat
      height={120}
      script={streamToolNode(mcpNode('running', 'mcp-stream'), [
        { afterMs: 900, inputSummary: 'linear.searchIssues' },
        { afterMs: 900, status: 'done' },
      ])}
    />
  ),
};

// ── Structured output (ticket #31) ────────────────────────────────────────────

function mcpNodeWithOutput(id: string, status: ToolStatus, outputText: string): ToolNode {
  return {
    kind: 'mcp-tool-call',
    id,
    seq: 0,
    toolCallId: id,
    title: 'MCP',
    status,
    server: 'linear',
    tool: 'searchIssues',
    outputText,
  };
}

export const StructuredResult: Story = {
  name: 'Structured result (JSON)',
  render: () => (
    <ChatHostExpanded
      height={260}
      expandId="mcp-structured"
      items={[
        toolNodeTurn(
          mcpNodeWithOutput(
            'mcp-structured',
            'done',
            JSON.stringify({
              issues: [
                { id: 'LIN-1', title: 'Fix flaky test', priority: 'high' },
                { id: 'LIN-2', title: 'Update docs', priority: 'low' },
              ],
              total: 2,
            })
          )
        ),
      ]}
    />
  ),
};

export const StructuredError: Story = {
  name: 'Structured error (JSON)',
  render: () => (
    <ChatHostExpanded
      height={220}
      expandId="mcp-structured-error"
      items={[
        toolNodeTurn(
          mcpNodeWithOutput(
            'mcp-structured-error',
            'error',
            JSON.stringify({ error: { code: 404, message: 'Issue not found' } })
          )
        ),
      ]}
    />
  ),
};

export const MalformedResult: Story = {
  name: 'Malformed (non-JSON) result — plain-text fallback',
  render: () => (
    <ChatHostExpanded
      height={180}
      expandId="mcp-malformed"
      items={[toolNodeTurn(mcpNodeWithOutput('mcp-malformed', 'done', 'issue LINEAR-123 created'))]}
    />
  ),
};

export const LargeResult: Story = {
  name: 'Large result — bounded with an omitted-keys notice',
  render: () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 500; i++) big[`field${i}`] = i;
    return (
      <ChatHostExpanded
        height={320}
        expandId="mcp-large"
        items={[toolNodeTurn(mcpNodeWithOutput('mcp-large', 'done', JSON.stringify(big)))]}
      />
    );
  },
};
