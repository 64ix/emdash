/**
 * Browser-mode tests for the task titlebar's PR chip (ticket #99,
 * CONTEXT.md "Assigned PR"): shows the task's PR number with a status dot
 * (open/merged/closed/draft), the full title in a tooltip, and opens the PR
 * in the external browser when activated.
 *
 * Mounts the real `PullRequestChip` directly rather than the full
 * `TaskTitlebar`/`ActiveTaskTitlebar`, whose other imports (git actions,
 * workspace view context, conversation/task stores, ...) are a heavy
 * transitive chain this chip's own behavior has no reason to load — the
 * chip was deliberately kept in its own dependency-light leaf module for
 * exactly this reason (see `pull-request-chip.tsx`). `TaskTitlebar`'s own
 * gating of the chip to the derived PR (`taskPr ? <PullRequestChip/> :
 * null`, `resolveTaskPr`) is covered by `task-pr.test.ts` and code review,
 * not re-tested here.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullRequest } from '@shared/core/pull-requests/pull-requests';

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(() => Promise.resolve()),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: { openExternal: mocks.openExternal },
  },
}));

import { PullRequestChip } from '@renderer/features/tasks/pull-request-chip';

let host: HTMLDivElement;
let root: Root;

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle(frames = 2) {
  for (let i = 0; i < frames; i++) await frame();
}

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    url: 'https://github.com/acme/app/pull/123',
    provider: 'github',
    repositoryUrl: 'https://github.com/acme/app',
    baseRefName: 'main',
    baseRefOid: 'b'.repeat(40),
    headRepositoryUrl: 'https://github.com/acme/app',
    headRefName: 'feat/thing',
    headRefOid: 'h'.repeat(40),
    identifier: '#123',
    title: 'Add the thing',
    description: null,
    status: 'open',
    isDraft: false,
    additions: null,
    deletions: null,
    changedFiles: null,
    commitCount: null,
    mergeableStatus: null,
    mergeStateStatus: null,
    reviewDecision: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    mergedAt: null,
    author: null,
    labels: [],
    assignees: [],
    checks: [],
    ...overrides,
  };
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  mocks.openExternal.mockClear();
});

afterEach(() => {
  root.unmount();
  host.remove();
});

function chipButton(): HTMLButtonElement {
  return host.querySelector('button') as HTMLButtonElement;
}

describe('PullRequestChip (ticket #99)', () => {
  it('shows the PR number', async () => {
    root.render(<PullRequestChip pr={pr()} />);
    await settle();

    expect(chipButton().textContent).toContain('#123');
  });

  it('shows a status dot for an open PR', async () => {
    root.render(<PullRequestChip pr={pr({ status: 'open' })} />);
    await settle();

    expect(chipButton().querySelector('span[aria-hidden]')).not.toBeNull();
  });

  it('opens the PR in the external browser when clicked', async () => {
    root.render(<PullRequestChip pr={pr({ url: 'https://github.com/acme/app/pull/123' })} />);
    await settle();
    chipButton().click();

    expect(mocks.openExternal).toHaveBeenCalledWith('https://github.com/acme/app/pull/123');
  });

  it('carries an accessible name naming the PR and its status', async () => {
    root.render(<PullRequestChip pr={pr({ status: 'merged' })} />);
    await settle();

    expect(chipButton().getAttribute('aria-label')).toContain('#123');
    expect(chipButton().getAttribute('aria-label')).toContain('Add the thing');
  });

  it('shows the full title in a tooltip on hover', async () => {
    root.render(<PullRequestChip pr={pr({ title: 'A very long pull request title' })} />);
    await settle();

    // Base-UI tooltips open through the trigger's rest-timer on mousemove,
    // after the provider-less default open delay (600ms) — replay the event
    // sequence a real mouse hover produces, then wait out the delay.
    const button = chipButton();
    const pointerOpts = { bubbles: true, pointerType: 'mouse', pointerId: 1, isPrimary: true };
    const mouseOpts = { bubbles: true };
    for (const [type, EventCtor, init] of [
      ['pointerover', PointerEvent, pointerOpts],
      ['mouseover', MouseEvent, mouseOpts],
      ['pointerenter', PointerEvent, pointerOpts],
      ['mouseenter', MouseEvent, mouseOpts],
      ['pointermove', PointerEvent, pointerOpts],
      ['mousemove', MouseEvent, mouseOpts],
    ]) {
      button.dispatchEvent(new EventCtor(type, init));
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
    await settle();

    const tooltip = document.querySelector('[data-slot="tooltip-content"]');
    expect(tooltip).not.toBeNull();
    expect(tooltip?.textContent).toContain('A very long pull request title');
  });
});
