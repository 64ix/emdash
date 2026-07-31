# Fork notes — 64ix/emdash (« fork-main »)

Fork of [generalaction/emdash](https://github.com/generalaction/emdash) carrying the
feature-workflow kanban used by agent-cockpit. Specs and backlog live in the
`agent-cockpit` repo (wayfinder → grill → spec → tickets flow); one feature = one
spec = one PR onto `fork-main`.

## Branch model

- `main` — pristine mirror of `upstream/main`. Never commit here.
- `fork-main` — default working branch: `main` + our commits. Rebase onto upstream
  release tags (`git fetch upstream --tags && git rebase <tag>`).

## Automation

- `.github/workflows/fork-ci.yml` — typecheck + lint + tests on push/PR to `fork-main`.
  Run it after every upstream rebase before pushing.
- `.github/workflows/upstream-sync.yml` — weekly: fast-forwards `main` from upstream and
  opens/updates an issue when upstream commits touch the touchpoint files below.
  Keep its path list in sync with the table below.

## What we add

**Feature workflow board**: `tasks.workflow_stage` column + `workflowStages` enum
(`idea → grilled → spec → tickets → implementing → pr → shipped`, Matt Pocock
pipeline), orthogonal to emdash's own `tasks.status`. Kanban view per project,
reachable via the project titlebar dropdown → "Feature Board". Session counts per
card come from the existing `conversations`-per-task model.

## Core touchpoints (rebase conflict hotspots)

Keep this list current — everything else we write must stay additive.

| File | Change |
|------|--------|
| `apps/emdash-desktop/src/main/db/schema.ts` | `workflowStage` column on `tasks` |
| `apps/emdash-desktop/src/shared/core/tasks/tasks.ts` | `workflowStages` enum, `Task.workflowStage` |
| `apps/emdash-desktop/src/main/core/tasks/utils/utils.ts` | row → Task mapping |
| `apps/emdash-desktop/src/main/core/tasks/task-service.ts` | bind `updateTaskWorkflowStage` |
| `apps/emdash-desktop/src/main/core/tasks/controller.ts` | RPC method |
| `apps/emdash-desktop/src/renderer/features/tasks/stores/task-store.ts` | optimistic `updateWorkflowStage` |
| `apps/emdash-desktop/src/renderer/app/view-registry.ts` | register `board` view |
| `apps/emdash-desktop/src/renderer/features/projects/components/project-titlebar.tsx` | "Feature Board" menu entry |
| `apps/emdash-desktop/src/shared/telemetry.ts` | `FocusView` + `board_viewed` |
| `apps/emdash-desktop/src/renderer/lib/stores/navigation-store.ts` | `viewEvents` map |
| test DDL fixtures (`legacy-port/**/relational.test.ts`, `service.test.ts`, `createTask.test.ts`, `renameTask.test.ts`) | mirror the `tasks` DDL / row shape |

Additive (no conflict risk): `features/board/`, `operations/updateTaskWorkflowStage.ts`,
`drizzle/0020_*.sql`.

⚠️ Migration numbering: upstream also generates `drizzle/00NN_*.sql`. On every rebase,
check for a collision with our migrations and renumber ours (regenerate with
`pnpm db:generate`) if upstream claimed the slot.

## Dev setup gotchas

- Electron postinstall may fail silently (zip extract). Fix: download via
  `@electron/get`, extract with `ditto`, write `node_modules/electron/path.txt`
  containing `Electron.app/Contents/MacOS/Electron`.
- Build workspace packages before typechecking the app:
  `pnpm exec nx run-many -t build --projects "packages/*"`.
- Isolated dev DB: `EMDASH_DB_FILE=<path> pnpm dev` (real emdash data lives in
  `~/Library/Application Support/emdash/`).
