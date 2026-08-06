/**
 * Browser-mode tests for the sidebar task context menu's "Move to stage…"
 * submenu (spec #85, ticket #88): mounts the real `TaskContextMenu` — the
 * exact component the sidebar's `SidebarTaskItem` renders — and drives the
 * submenu through the board's authority-gated stage destinations.
 *
 * The menu is a leaf: the pure gating (which destinations are blocked, and
 * the feedback text) is covered in `stage-group-row-model.test.ts`; this
 * suite proves the submenu renders those options, disables the blocked ones
 * with the explanation visible, and reports a pick to `onMoveToStage`.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { SidebarStageMoveOption } from '@renderer/features/sidebar/stage-group-row-model';
import { TaskContextMenu } from '@renderer/features/tasks/components/task-context-menu';
import type { WorkflowStage } from '@shared/core/tasks/tasks';

const mocks = vi.hoisted(() => ({
  onMoveToStage: vi.fn(),
  onPin: vi.fn(),
  onUnpin: vi.fn(),
  onRename: vi.fn(),
  onArchive: vi.fn(),
  onDelete: vi.fn(),
}));

/** All seven Workflow Stages plus Unstaged, unblocked — the acceptance set. */
const ALL_STAGES: SidebarStageMoveOption[] = [
  { stage: 'idea', label: 'Idea', blocked: false },
  { stage: 'exploring', label: 'Exploring', blocked: false },
  { stage: 'spec', label: 'Spec', blocked: false },
  { stage: 'implementing', label: 'Implementing', blocked: false },
  { stage: 'review', label: 'Review', blocked: false },
  { stage: 'shipped', label: 'Shipped', blocked: false },
  { stage: 'triage', label: 'Triage', blocked: false },
  { stage: null, label: 'Unstaged', blocked: false },
];

let host: HTMLDivElement;
let root: Root;

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle(frames = 2) {
  for (let i = 0; i < frames; i++) await frame();
}

async function mount(stageMoveOptions: SidebarStageMoveOption[], explanation: string | null) {
  root.render(
    <TaskContextMenu
      isPinned={false}
      canPin
      isArchived={false}
      onPin={mocks.onPin}
      onUnpin={mocks.onUnpin}
      onRename={mocks.onRename}
      onArchive={mocks.onArchive}
      onDelete={mocks.onDelete}
      stageMoveOptions={stageMoveOptions}
      stageMoveExplanation={explanation}
      onMoveToStage={mocks.onMoveToStage}
    >
      <div data-row="trigger">Task row</div>
    </TaskContextMenu>
  );
  await settle();
}

function openRootMenu() {
  const trigger = host.querySelector('[data-slot="context-menu-trigger"]');
  if (!trigger) throw new Error('no context menu trigger');
  trigger.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
  );
}

function subTrigger() {
  return document.querySelector('[data-slot="context-menu-sub-trigger"]');
}

function subContent() {
  return document.querySelector('[data-slot="context-menu-sub-content"]');
}

/**
 * Opens the "Move to stage…" submenu. Base UI's submenu opens on hover only
 * after a mouse-like `pointerenter` (sets the pointer type), then
 * `mouseenter` + `mousemove` (the rest-delay path), then the ~100ms rest
 * delay — the exact interaction sequence a real pointer produces.
 */
async function openStageSubmenu() {
  openRootMenu();
  await settle(3);
  const sub = subTrigger();
  if (!sub) throw new Error('no stage submenu trigger');
  sub.dispatchEvent(
    new PointerEvent('pointerenter', {
      bubbles: true,
      pointerType: 'mouse',
      clientX: 120,
      clientY: 120,
    })
  );
  sub.dispatchEvent(
    new MouseEvent('mouseenter', { bubbles: true, cancelable: true, clientX: 120, clientY: 120 })
  );
  sub.dispatchEvent(
    new MouseEvent('mousemove', {
      bubbles: true,
      cancelable: true,
      clientX: 125,
      clientY: 125,
      movementX: 5,
      movementY: 5,
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  await settle();
}

function stageItems() {
  return Array.from(subContent()!.querySelectorAll<HTMLElement>('[data-slot="context-menu-item"]'));
}

describe('task context menu — Move to stage… (spec #85, ticket #88)', () => {
  beforeEach(async () => {
    await page.viewport(600, 600);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.onMoveToStage.mockClear();
  });

  afterEach(() => {
    root.unmount();
    host.remove();
  });

  it('offers all seven stages plus Unstaged', async () => {
    await mount(ALL_STAGES, null);
    await openStageSubmenu();
    expect(stageItems().map((item) => item.textContent)).toEqual([
      'Idea',
      'Exploring',
      'Spec',
      'Implementing',
      'Review',
      'Shipped',
      'Triage',
      'Unstaged',
    ]);
  });

  it('reports a permitted pick to onMoveToStage', async () => {
    await mount(ALL_STAGES, null);
    await openStageSubmenu();
    stageItems()
      .find((item) => item.textContent === 'Spec')!
      .click();
    expect(mocks.onMoveToStage).toHaveBeenCalledWith('spec');
  });

  it('reports Unstaged as a null stage', async () => {
    await mount(ALL_STAGES, null);
    await openStageSubmenu();
    stageItems()
      .find((item) => item.textContent === 'Unstaged')!
      .click();
    expect(mocks.onMoveToStage).toHaveBeenCalledWith(null);
  });

  it('disables destinations a GitHub fact would overwrite, and never reports them', async () => {
    const options: SidebarStageMoveOption[] = ALL_STAGES.map((option) =>
      option.label === 'Spec' ? { ...option, blocked: true } : option
    );
    await mount(options, null);
    await openStageSubmenu();
    const blocked = stageItems().find((item) => item.textContent === 'Spec')!;
    expect(blocked.getAttribute('data-disabled')).not.toBeNull();
    blocked.click();
    expect(mocks.onMoveToStage).not.toHaveBeenCalled();
  });

  it('shows the authority explanation as feedback inside the submenu while something is blocked', async () => {
    const options: SidebarStageMoveOption[] = ALL_STAGES.map((option) =>
      option.label === 'Spec' ? { ...option, blocked: true } : option
    );
    await mount(
      options,
      'Held in Spec by its linked Spec issue: #56. This will remain in Spec until #56 closes.'
    );
    await openStageSubmenu();
    expect(subContent()!.textContent).toContain('Held in Spec by its linked Spec issue: #56.');
  });
});
