# Fork notes — 64ix/emdash (« fork-main »)

Fork of [generalaction/emdash](https://github.com/generalaction/emdash) carrying the
feature-workflow kanban used by agent-cockpit. Specs and backlog live in the
`agent-cockpit` repo (wayfinder → grill → spec → tickets flow); one feature = one
spec = one PR onto `fork-main`.

## Branch model

- `main` — pristine mirror of `upstream/main`. Never commit here.
- `fork-main` — default working branch: `main` + our commits. Rebase onto upstream
  release tags (`git fetch upstream --tags && git rebase <tag>`).

> [!WARNING]
> **Every fork PR must target `fork-main`.** Merging onto `main` is a silent failure
> mode, not a loud one — nothing errors. The PR shows as merged, but the code never
> reaches the branch the app is built from, so the feature is simply absent at runtime,
> and the weekly Upstream Sync's `git merge --ff-only upstream/main` starts failing
> because `main` can no longer fast-forward.
>
> Before opening a PR, check the base:
>
> ```bash
> gh pr create --base fork-main   # never rely on the default
> gh pr view <n> --json baseRefName -q .baseRefName   # must print: fork-main
> ```
>
> After merging anything, confirm it actually landed:
>
> ```bash
> git fetch origin && git log --oneline origin/main..origin/fork-main | head
> git log --oneline origin/fork-main..origin/main   # MUST be empty
> ```
>
> `.github/workflows/main-mirror-guard.yml` checks this **daily** (and on
> `workflow_dispatch`), opening an issue with remediation commands when `main` drifts.
> It cannot be push-triggered: for push events GitHub loads the workflow file from the
> pushed branch, and `main` mirrors upstream, so it will never carry the guard. The
> daily run is therefore a safety net, not a merge-time gate — **the base check above
> is still yours to do.**
>
> **Happened once:** PR #13 ([Spec #11] Auto-generated Conversation Titles) was merged
> to `main`. The feature was missing from every build for a day with no error anywhere;
> the fix was a cherry-pick onto `fork-main` plus restoring `main` to the upstream sha.

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
| `apps/emdash-desktop/vitest.config.ts` | `FORK_CI` exclude for PTY integration tests |

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
