# Implement-spec conventions

This repo uses the `implement-spec` runner. The runner keeps **no config file**:
on every run it derives the base branch and the commands that validate a change
from this project's own docs (`CLAUDE.md` / `AGENTS.md` agent-skills block, the
coding-standards doc, CI workflows, build manifests) and from git, and echoes
what it resolved before it changes anything.

This file records the **spec conventions** — the glue between the `to-spec` /
`to-tickets` skills and the runner — plus any validation note the runner can't
reliably infer on its own.

## How this project is validated

The gate and base branch are stated in the `### Spec implementation runner`
sub-section of `AGENTS.md`. Facts the runner cannot infer from git alone:

- **Base branch is `fork-main`, not `main`.** `origin/HEAD` points at `main`,
  which is a pristine mirror of `upstream/main` and must never receive commits
  (see `FORK.md`). Cut branches from and open PRs onto `fork-main`.

  > [!WARNING]
  > This rule was already documented here when PR #13 ([Spec #11] Auto-generated
  > Conversation Titles) was still merged onto `main` — so **stating the rule is not
  > enough; the runner must verify it.** The failure is silent: nothing errors, the PR
  > reads as merged, and the feature is simply absent from every build.
  >
  > Two checks the runner owes on every spec:
  >
  > ```bash
  > # 1. Before opening the PR — pass the base explicitly, then read it back.
  > gh pr create --base fork-main ...
  > gh pr view <n> --json baseRefName -q .baseRefName     # must print: fork-main
  >
  > # 2. After the PR merges — prove the content reached the working branch.
  > git fetch origin
  > git log --oneline origin/fork-main..origin/main       # MUST be empty
  > ```
  >
  > Never repair this by force-pushing `main` first: cherry-pick the commit onto
  > `fork-main` and push that, and only then restore `main` to the upstream sha —
  > otherwise the only copy of the work is destroyed.
  > `.github/workflows/main-mirror-guard.yml` catches it on every push to `main`.
- **Test command (the gate):** from a fresh worktree, install and build the
  workspace packages first, then run from `apps/emdash-desktop`:
  `pnpm typecheck`, `pnpm exec oxlint .`, and
  `pnpm exec vitest run --project node --project main-db --project migrations --project scripts`.
  Do **not** set `FORK_CI=1` locally: that flag only exists to skip PTY
  integration tests on GitHub runners, which have no real PTY. Locally the PTY
  tests run and must pass.
- **Build / format:** `pnpm exec nx run-many -t build --projects "packages/*"`
  before typechecking (workspace packages must be built first); format with
  `pnpm run format` from the repo root.
- **E2E gates (infra-dependent):** browser tests
  (`@vitest/browser` + Playwright, the `browser` vitest project) and the
  Docker-backed SSH tests (`pnpm run run:docker-ssh` infrastructure). Agents try
  to run them live and report status `not-run` when the infra is unavailable;
  the final review is the last gate expected to run them live.
- **Rebase hotspot:** upstream also generates `drizzle/00NN_*.sql` migrations.
  Any change adding a migration must use `pnpm run db:generate` (never hand-edit
  numbered migrations or `drizzle/meta/`) and watch for numbering collisions
  after upstream rebases.

## Spec conventions

These conventions connect the `to-spec` / `to-tickets` skills to the runner.
Skills that publish or consume specs in this repo follow them:

- A spec issue is titled `[Spec] <feature name>` and carries a
  `## Success Criteria` checklist alongside the usual spec sections.
- A spec is either **autosufficient** (small enough to implement directly) or
  **split** into child tickets. Decide when publishing: apply the agent-ready
  label to an autosufficient spec; when the spec is split, leave the spec
  unlabelled (it is a container) and apply the label to the child tickets
  instead.
- Child tickets are linked to their spec as native GitHub **sub-issues**; where
  sub-issues aren't available, a `## Parent` section naming the spec is the
  fallback. Dependencies between tickets use native **blocked-by**
  relationships, with a `## Blocked by` section as the fallback.
- `/implement-spec` implements exactly one spec: directly when autosufficient,
  through its child tickets otherwise. It never merges the PR it opens.
