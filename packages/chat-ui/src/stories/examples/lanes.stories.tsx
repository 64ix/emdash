/**
 * Prose vs artifact lane examples (spec #18, ticket #27).
 *
 * The message row keeps the existing readable prose measure; the diff row
 * declares the artifact lane (`diffUnitDef.lane = 'artifact'`) and widens up
 * to the bounded artifact lane. At each viewport the panel must show no
 * page-level horizontal overflow — the diff scrolls only within its own
 * chrome, never the transcript.
 *
 * Widths mirror the AC's representative breakpoints: a wide desktop panel
 * (1440), a narrower split-pane width (800), and a narrow/mobile-ish width
 * (480) where the artifact lane has no room to grow past prose.
 */

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { ChatHost } from '@/stories/_harness/chat-host';

const meta: Meta = {
  title: 'Examples/Lanes',
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj;

const OLD_TS = `export function formatUser(user: User): string {
  return user.name;
}`;

const NEW_TS = `export function formatUser(user: User): string {
  if (!user.name) return user.email ?? 'Unknown user';
  return \`\${user.name} <\${user.email}>\`;
}`;

const LANE_ITEMS = [
  {
    kind: 'message' as const,
    id: 'u1',
    role: 'user' as const,
    text: 'Update formatUser to fall back to the email address when the name is missing.',
  },
  {
    kind: 'diff' as const,
    id: 'diff-1:src/format-user.ts',
    path: 'src/format-user.ts',
    oldText: OLD_TS,
    newText: NEW_TS,
    status: 'done' as const,
  },
  {
    kind: 'message' as const,
    id: 'a1',
    role: 'assistant' as const,
    text: 'Done — `formatUser` now falls back to the email address, matching the existing empty-name handling elsewhere in the file.',
  },
];

/** 1440px panel — the diff visibly widens past the prose column. */
export const Wide1440: Story = {
  render: () => <ChatHost items={LANE_ITEMS} width={1440} height={420} />,
};

/** 800px panel — the diff still widens, bounded by the available panel width. */
export const Medium800: Story = {
  render: () => <ChatHost items={LANE_ITEMS} width={800} height={420} />,
};

/**
 * 480px panel — no room to grow past the prose column; both lanes render at
 * the same width and the panel shows no horizontal overflow.
 */
export const Narrow480: Story = {
  render: () => <ChatHost items={LANE_ITEMS} width={480} height={480} />,
};
