/**
 * Browser-mode tests for the task titlebar's Workflow Stage chip (ticket
 * #50): reuses the board's own `STAGE_LABELS` (including its explicit
 * "Unstaged" entry, so the chip is never hidden for a task with no
 * Workflow Stage), and activating it navigates to the project's board with
 * this task carried as `focusTaskId` — the entry point `BoardMainPanel`'s
 * focused-task navigation (`board-detail-panel.test.tsx`) resolves.
 *
 * Mounts the real `WorkflowStageChip` directly rather than the full
 * `TaskTitlebar`/`ActiveTaskTitlebar`, whose other imports (git actions,
 * workspace view context, conversation/task stores, `rpc`, ...) are a heavy
 * transitive chain this chip's own behavior has no reason to load — the
 * chip was deliberately kept in its own dependency-light leaf module for
 * exactly this reason (see `workflow-stage-chip.tsx`). `TaskTitlebar`'s own
 * gating of the chip to registered tasks (`taskPayload.type === 'task'`) is
 * a plain conditional render verified by `pnpm typecheck` and code review,
 * not re-tested here.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  captureTelemetry: vi.fn(),
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: mocks.navigate }),
}));

vi.mock('@renderer/utils/telemetryClient', () => ({
  captureTelemetry: mocks.captureTelemetry,
}));

import { WorkflowStageChip } from '@renderer/features/tasks/workflow-stage-chip';

let host: HTMLDivElement;
let root: Root;

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle(frames = 2) {
  for (let i = 0; i < frames; i++) await frame();
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  mocks.navigate.mockClear();
  mocks.captureTelemetry.mockClear();
});

afterEach(() => {
  root.unmount();
  host.remove();
});

function chipButton(): HTMLButtonElement {
  return host.querySelector('button') as HTMLButtonElement;
}

describe('WorkflowStageChip (ticket #50)', () => {
  it("shows the board's own stage label for a staged task", async () => {
    root.render(<WorkflowStageChip projectId="p1" taskId="t1" workflowStage="implementing" />);
    await settle();

    expect(chipButton().textContent).toBe('Implementing');
  });

  it('shows "Unstaged" explicitly, rather than hiding the chip, for a task with no stage', async () => {
    root.render(<WorkflowStageChip projectId="p1" taskId="t1" workflowStage={null} />);
    await settle();

    expect(chipButton()).not.toBeNull();
    expect(chipButton().textContent).toBe('Unstaged');
  });

  it('navigates to the project board with this task carried as focusTaskId when activated', async () => {
    root.render(<WorkflowStageChip projectId="p1" taskId="t1" workflowStage="spec" />);
    await settle();
    chipButton().click();

    expect(mocks.navigate).toHaveBeenCalledWith('board', {
      projectId: 'p1',
      focusTaskId: 't1',
    });
  });

  // Integration-review regression: the chip is a fourth board entry point
  // (alongside tickets #43/#44's sidebar/command-palette/work-mode-switcher
  // sites) but shipped with no `board_opened` telemetry at all — leaving
  // `BoardEntrySource` uncovered for a real navigation path.
  it("fires board_opened with source 'stage_chip' when activated", async () => {
    root.render(<WorkflowStageChip projectId="p1" taskId="t1" workflowStage="spec" />);
    await settle();
    chipButton().click();

    expect(mocks.captureTelemetry).toHaveBeenCalledWith('board_opened', {
      source: 'stage_chip',
      project_id: 'p1',
    });
  });

  it('carries an accessible name naming the current stage', async () => {
    root.render(<WorkflowStageChip projectId="p1" taskId="t1" workflowStage="review" />);
    await settle();

    expect(chipButton().getAttribute('aria-label')).toContain('Review');
  });
});
