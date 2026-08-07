import { describe, expect, it, vi } from 'vitest';

// `globalBoardView` pulls in `GlobalBoardMainPanel` (dnd-kit, task stores,
// telemetry...) purely for the component reference, which `canActivate`
// never touches. Mocking the panel keeps this suite scoped to the guard
// itself — the same pattern `view.test.ts` uses for the Feature Board
// (ticket #44).
vi.mock('@renderer/features/board/global-board-main-panel', () => ({
  GlobalBoardMainPanel: () => null,
}));

import { globalBoardView } from './global-board-view';

describe('globalBoardView.canActivate (spec #104, ticket #107)', () => {
  it('grants activation with no params at all — the view needs no project', () => {
    expect(globalBoardView.canActivate(undefined)).toEqual({ ok: true });
    expect(globalBoardView.canActivate({})).toEqual({ ok: true });
  });

  it('grants activation even when stale persisted params carry a projectId — the Global Board is projectless by design', () => {
    expect(globalBoardView.canActivate({ projectId: 'proj-1' })).toEqual({ ok: true });
    expect(globalBoardView.canActivate({ focusTaskId: 'task-1' })).toEqual({ ok: true });
  });

  it('defines a MainPanel (the view renders a full working screen)', () => {
    expect(globalBoardView.MainPanel).toBeDefined();
  });
});
