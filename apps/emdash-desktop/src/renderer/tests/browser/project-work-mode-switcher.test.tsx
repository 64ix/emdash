/**
 * Browser-mode tests for the project workspace's work-mode switcher (ticket
 * #44): Board, List, and Pull Requests render as visible primary tabs, while
 * Settings is reachable through a separate, secondary control rather than a
 * work-mode peer. Also covers the switcher's navigation/telemetry behavior
 * for Board versus in-place List/Pull Requests toggling.
 *
 * Mounts the real `ProjectWorkModeSwitcher` in Chromium with the navigation
 * provider and project selectors mocked -- this suite exercises the
 * switcher's own rendered affordances and click behavior, not the full
 * project/board render trees (those are #45/#46/#47/#48 territory).
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectView } from '@renderer/features/projects/stores/project-view';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  captureTelemetry: vi.fn(),
  currentView: 'project' as string,
  activeView: 'tasks' as ProjectView,
  setProjectView: vi.fn((v: ProjectView) => {
    mocks.activeView = v;
  }),
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: mocks.navigate }),
  useWorkspaceSlots: () => ({ currentView: mocks.currentView }),
}));

vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  asMounted: (store: unknown) => store,
  getProjectStore: () => ({
    get view() {
      return {
        get activeView() {
          return mocks.activeView;
        },
        setProjectView: mocks.setProjectView,
      };
    },
  }),
}));

vi.mock('@renderer/utils/telemetryClient', () => ({
  captureTelemetry: mocks.captureTelemetry,
}));

import { ProjectWorkModeSwitcher } from '@renderer/features/projects/components/project-work-mode-switcher';

let host: HTMLDivElement;
let root: Root;

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle(frames = 2) {
  for (let i = 0; i < frames; i++) await frame();
}

async function mount() {
  root.render(<ProjectWorkModeSwitcher projectId="proj-1" />);
  await settle();
}

function tabButton(label: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label
  );
  if (!button) throw new Error(`Expected a "${label}" button`);
  return button;
}

describe('ProjectWorkModeSwitcher (ticket #44)', () => {
  beforeEach(() => {
    host = document.createElement('div');
    host.id = 'work-mode-switcher-host';
    document.body.appendChild(host);
    root = createRoot(host);

    mocks.navigate.mockClear();
    mocks.captureTelemetry.mockClear();
    mocks.setProjectView.mockClear();
    mocks.currentView = 'project';
    mocks.activeView = 'tasks';
  });

  afterEach(() => {
    root.unmount();
    host.remove();
  });

  it('renders Board, List, and Pull Requests as visible primary work-mode tabs', async () => {
    await mount();
    expect(tabButton('Board')).toBeTruthy();
    expect(tabButton('List')).toBeTruthy();
    expect(tabButton('Pull Requests')).toBeTruthy();
  });

  it('does not present Settings as a work-mode tab peer', async () => {
    await mount();
    const tabLabels = ['Board', 'List', 'Pull Requests', 'Settings'];
    const rendered = tabLabels.filter((label) =>
      Array.from(host.querySelectorAll('button')).some((b) => b.textContent?.trim() === label)
    );
    expect(rendered).toEqual(['Board', 'List', 'Pull Requests']);
    // Settings is still reachable, just through a distinct icon-only control.
    expect(host.querySelector('button[aria-label="Project settings"]')).toBeTruthy();
  });

  it('navigates to the full-width board view and records the switcher entry source', async () => {
    await mount();
    tabButton('Board').click();

    expect(mocks.navigate).toHaveBeenCalledWith('board', { projectId: 'proj-1' });
    expect(mocks.captureTelemetry).toHaveBeenCalledWith('board_opened', {
      source: 'work_mode_switcher',
      project_id: 'proj-1',
    });
    // Selecting Board never writes the persisted work mode directly from the
    // switcher -- that choke point lives in `boardView.canActivate` once the
    // navigation actually lands (see `board/view.test.ts`).
    expect(mocks.setProjectView).not.toHaveBeenCalled();
  });

  it('toggles List/Pull Requests in place without navigating away from an already-mounted project view', async () => {
    mocks.currentView = 'project';
    await mount();
    tabButton('Pull Requests').click();

    expect(mocks.setProjectView).toHaveBeenCalledWith('pull-request');
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('navigates back to `project` when switching List/Pull Requests from the board view', async () => {
    mocks.currentView = 'board';
    await mount();
    tabButton('List').click();

    expect(mocks.setProjectView).toHaveBeenCalledWith('tasks');
    expect(mocks.navigate).toHaveBeenCalledWith('project', { projectId: 'proj-1' });
  });

  it('opens Settings through the gear control and navigates back to `project` from the board view', async () => {
    mocks.currentView = 'board';
    await mount();
    (host.querySelector('button[aria-label="Project settings"]') as HTMLButtonElement).click();

    expect(mocks.setProjectView).toHaveBeenCalledWith('settings');
    expect(mocks.navigate).toHaveBeenCalledWith('project', { projectId: 'proj-1' });
  });
});
