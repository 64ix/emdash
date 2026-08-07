# Task PRs: user assignment overrides the Spec-derived link

PRs were documented as never stored — always derived from the Spec
(CONTEXT.md, Spec entry). With PRs now surfaced in the task titlebar and
the Task Detail Panel and driving the Workflow Stage, a task carries an
optional persisted **Assigned PR** (`tasks.assigned_pr_url`, at most one
per task): when set it overrides the derived PR (head-branch match, then
Spec-reference match) for display and becomes the stage authority for
`review`/`shipped`/`triage`; unassigning reverts to derivation. Pure
Spec-derived linking was rejected as the only notion of "the task's PR"
because PRs opened from branches that neither match the task's branch nor
reference the Spec (fork flows, agent tooling) stay invisible, and the
user is the best authority on which PR is theirs. GitHub remains the
source of truth whenever no assignment is set, so stages stay
fact-derived (ADR 0003) — an assignment is an explicit user fact like
Board Rank (ADR 0001), not a declaration channel.

## Considered Options

- **Derivation-only (status quo)** — rejected: a wrong or missing match
  could never be corrected in-app, forcing manual hunting.
- **Assignment affects display only** — rejected: two divergent notions
  of "the task's PR" (display vs stage authority) would confuse.
- **Free-form URL input** — rejected: extra validation surface; a picker
  over the project's synced PRs keeps the data consistent.
