# Glossary

## Feature Board

The kanban view (fork-only) that shows a project's tasks as cards grouped in
columns by **Workflow Stage**. Project-scoped: every entry point resolves an
explicit project, never an implicit or last-used one. Reached by clicking a
project in the left sidebar, the command palette's Open Feature Board
command, or a task's Workflow Stage chip in its titlebar. Not part of the
settings/options UI.

Navigation into the Feature Board may carry an optional focused task. The
board resolves it against the project's own displayable tasks (the same set
its columns already show), scrolls that card into view, highlights it, and
opens the Task Detail Panel for it. An id that doesn't resolve there
(invalid, archived, or simply absent) is a no-op — the board still renders
normally.

## Global Board

The cross-project view (fork-only) that aggregates the Feature Boards of
every project in the current workspace: all real tasks — Unstaged and Triage
included — as cards in the same **Workflow Stage** columns, each card marked
with its project. The sibling of the Feature Board, not a mode of it: where
the Feature Board resolves one explicit project, the Global Board shows them
all, and every project-scoped rule keeps its per-column meaning across
projects.

Reached from the Board button at the top of the left sidebar (above the
pinned-task list, below the space switcher) and the command palette's Open
Global Board command. Not the app's default landing view.

Ghost Cards and Link Suggestions have no place here — only real tasks are
shown, in every stage.

Display rules match the Feature Board per column: **Shipped Fade** hides old
shipped cards and **Awaiting Input** floats to the top. A card's manual
position is its **Board Rank** in the shared per-stage column — a Global
Board drop may interleave projects, and each project's own board still shows
its cards in the same relative order.

Interactions are the Feature Board's: dragging between columns changes
Workflow Stage, dragging within a column writes Board Rank, both blocked by
stage authority; clicking a card opens the **Task Detail Panel** in place.
There is no column-scoped creation (a new card would have no project), no
focused-task round trip, and no SSH gate — unreachable projects still display
from the database, and their actions fail cleanly.

Above the columns sits the same Board Header as the Feature Board — search,
Needs Attention, and the stage, agent state, linked-issue presence and PR
state filters — plus a project multi-select, the only filter that persists
(per workspace, database-backed). Projects without a single displayable card
are omitted from the board and the filter list until they have one.

## Workflow Stage

The position of a task in the feature delivery pipeline:
`idea → exploring → spec → implementing → review → shipped`, plus the
out-of-flow **Triage** stage. `exploring` is optional — a task may go
straight from `idea` to `spec`. Nullable — a task with no stage is
**Unstaged** and appears in the leading Unstaged column of the Feature
Board.

Stage authority is hybrid: GitHub is authoritative for every stage it can
prove (`exploring` = open Map, `spec` = open Spec issue, `review` = open
PR — the task's [Assigned PR](#assigned-pr) when one is set, else one
referencing the Spec, `shipped` = that PR merged); the agent or user
declares the rest (`idea`, `implementing`). A GitHub fact always wins over
a manual placement.

## Triage

The out-of-flow stage where a card lands when its GitHub facts contradict
or disappear (PR closed without merge, Spec closed mid-flight). GitHub
pushes cards in; only the user or an agent moves a card back out.

## Shipped Fade

A display rule, not a stage: `shipped` cards whose PR merged more than a
fixed window ago are hidden from the Feature Board, the Global Board and
the sidebar's Shipped Stage Group. The task keeps its stage forever and is
never archived or otherwise altered. The Shipped column (and group) disclose
the window so older cards never appear to vanish arbitrarily. A faded task
remains reachable in the project view's task list, where it can be
archived or restored.

## Awaiting Input

The state of a task on a board when at least one of its sessions
has an unseen `awaiting-input` conversation — an agent is waiting on the
user. A display state, not a position: awaiting-input cards float to the
top of their board column (Feature Board, Global Board) and of their
sidebar Stage Group at render time and fall back to their manual place once
handled.

## Board Rank

A task's manually chosen position within a board column (Feature Board or
Global Board; on the Global Board the column is shared across projects) or
sidebar Stage Group. Only ever set by an explicit user gesture (a drop, in
the board or the sidebar); never written by the system. Tasks without a
Board Rank sort after ranked ones, in their existing order.

## Ghost Card

A lightweight candidate card on the Feature Board for a root GitHub issue
(not a Spec, not a sub-issue, not `wayfinder:*`) that no task references
yet. Not a task: adopting it creates a real task with the issue as its
Origin; rejecting it hides it. Nothing is persisted without adoption.
Sourced from the [Issue Tracker Repository](#issue-tracker-repository) only.

## Link Suggestion

An orphan Spec- or Map-shaped GitHub issue — no [Task Marker](#task-marker),
no task linking it — surfaced in the board's Inbox (a compact, count-bearing
summary above the Feature Board that expands on demand) with three answers:
**attach** it to an existing task, **adopt** it into a task of its own (the
issue came from elsewhere and no task covers it), or **dismiss** it. Adoption
sets the issue in its suggested [Linked Issue Role](#linked-issue-role), never
as Origin, and lands the card in the stage that fact implies. Sourced from the
[Issue Tracker Repository](#issue-tracker-repository) only.

## Issue Tracker Repository

The single GitHub repository a project reads inbound issues from: the one
behind its configured base remote, the same one the issue picker lists from.
Ghost Cards and link suggestions come from there and nowhere else — in a fork
checkout the `upstream` remote's issues belong to somebody else. Pull requests
are the exception: they are synced across every remote, since a fork's PRs can
legitimately live on either.

## Linked Issue Role

The typed slot a GitHub issue occupies on a task. A task holds at most one
issue per role: **Origin**, **Map**, **Spec**. A task may have no links at
all — it is then purely local and GitHub has no authority over it.

## Task Marker

The `Emdash-Task: <task-id>` line an agent writes into the body of an
issue it publishes (Spec, Map) for the task it is working in. The inbound
sync reads the marker and sets the corresponding Linked Issue Role
automatically. Orphan Spec/Map issues without a marker surface as
link suggestions instead.

## Origin Issue

The issue a task's idea came from (a bug report, a request, an idea filed
on GitHub). Optional — absent when the idea originates with the user.

## Map

The `wayfinder:map` issue tracking a feature's exploration, when the
feature goes through Wayfinder. Optional.

## Spec

The `[Spec] <feature>` issue for a task — recognized title prefixes are
`[Spec]`, the numbered `[Spec #N]`, and `Spec:`/`Spec :` (see
`issue-shape.ts`). The anchor link:
once a task has a Spec, everything downstream (tickets, PR, shipped) is
derived from GitHub by walking from the Spec. A PR is derived from the Spec
by default — unless the user assigns one explicitly, which overrides
derivation (see [Assigned PR](#assigned-pr)).

## Assigned PR

The Pull Request a user has explicitly attached to a task. Persisted on
the task, at most one per task. When set, it overrides every derived PR
(branch match or Spec reference) for display and for the Workflow Stage:
an open Assigned PR proves `review`, a merged one proves `shipped`, a
closed unmerged one sends the task to Triage — the same semantics as the
Spec-derived PR. Unassigning reverts to derivation. Any PR synced for the
task's project can be assigned; it need not reference the Spec nor match
the task's branch, and it stays displayed even when derivation finds
nothing.

## Unstaged

The state of a task whose Workflow Stage is unset. Displayed as the first
column of the Feature Board, and as ungrouped rows at the top of the
project's sidebar task list (above the Stage Groups);
not itself a Workflow Stage.

## Stage Group

A collapsible sidebar folder containing a project's tasks that share a
Workflow Stage, replacing the project's flat task list. Only non-empty
stages appear, in Feature Board column order, and each group orders its
tasks like its board column (Board Rank first, then unranked, Awaiting
Input elevated at render time). Unstaged tasks are not in a group — they
sit as ungrouped rows above the groups. A group shows only visible tasks:
Shipped Fade hides `shipped` cards past the window, and Hidden Tasks are
absent. A drop inside the sidebar writes the same stage and Board Rank
fields as the board — the sidebar never changes a stage the board would
not honor (ADR 0006).

## Hidden Task

A task the user hid from the sidebar with the context menu's "Hide from
sidebar" action — any task, any stage. Sidebar view state, not task state:
the task is unchanged everywhere else (still a Feature Board card, still in
the project view's task list and search) and is unhidden from the project
view's task list. Distinct from Unstaged (a stage state), from Shipped Fade
(automatic, time-based, applies to the board too), and from archiving (a
task-level state change).

## Task Detail Panel

The side panel that opens on the right of the Feature Board or the Global
Board when a card is clicked, splitting the view: the board stays fully
interactive on the left
(including drag-and-drop), the clicked task's details on the right. Fixed
width, not resizable. Clicking a different card switches its content;
re-clicking the shown card does nothing. Escape and a close button dismiss
it, and the card behind it stays highlighted while it is open. Ephemeral
view state — it does not survive leaving the board it belongs to, adds no
view-registry entry, and writes nothing to the database; a task that stops
being displayable (archived, faded by Shipped Fade) closes the panel rather
than showing stale or missing data. Clicking a Ghost Card opens the same
panel in ghost mode with the issue's details and an Adopt action.

The panel's Conversations section lists one row per Conversation on the
task — provider icon, display title, live agent status and last-active
time — with rename, delete and (for ACP Conversations) transcript export.
A Conversation Awaiting Input is elevated to the top of the section at
render time only, never persisted (ADR 0002's rule, applied to
Conversations); the rest are ordered by most-recent activity. Clicking a
row provisions the workspace first when the task has never been
provisioned, then opens the task view with that Conversation active.
Navigation out of the panel into the task view may carry an optional
focused conversation, the direct mirror of the board's own optional
focused task above; an id that no longer resolves (the Conversation was
deleted) is a no-op — the task view still opens, with nothing focused.
Not shown in ghost mode — a Ghost Card is not a task and has no
Conversations.

The panel shows the task's PR — its [Assigned PR](#assigned-pr) when one
is set, else the derived PR — as a clickable row opening the PR
externally, with the assign and unassign controls.

## Context Usage

The per-conversation measure of how full one agent session's context
window is (tokens used vs. context size, optionally cost). Scoped to a
single conversation and shown in its chat composer. Not to be confused
with **Provider Usage** — how much of the account's quota is consumed at
the provider.

## Provider Usage

The account-level utilization of a provider's rolling rate limits (Claude,
Codex, …) for the account logged in on the local machine. Made of one or
more **Usage Windows**. Independent of any task or conversation — it
reflects everything the account consumed, inside or outside emdash.

## Usage Window

One rolling rate-limit window within a provider's Provider Usage: an
identity (e.g. Claude 5-hour session, 7-day weekly, 7-day Opus; Codex
primary/secondary), a utilization percentage, and a reset time. The
5-hour (or primary) window is the **primary window** — the one the Usage
Gauge displays.

## Usage Gauge

The compact per-provider indicator at the bottom of the left sidebar
showing the primary Usage Window's utilization. Clicking it opens a
detail popover with every Usage Window and its reset time. A gauge
appears only when usage data is obtainable for that provider on the local
machine, and each gauge can be hidden in settings.

## ACP Conversation

A Conversation run over the Agent Client Protocol — the provider's native
chat surface — instead of in a PTY. The runtime renders its turns as a
typed transcript, with per-session model, effort and permission-mode
selectors driven by whatever the provider's ACP server advertises. The
app default whenever the provider declares ACP support and the Chat UI
preference is enabled.

## Auto-approve

The conversation-level setting that lets the agent act without prompting
the user for permission. Set at conversation creation, defaulted from a
per-provider setting. Scoped per conversation — enabling it for one
conversation never affects another, even in the same workspace. Only
meaningful for providers that declare the auto-approve capability.

## Managed Skill

A Skill installed from the emdash Skills library into the shared skills
root. A single copy, not provider-specific: every agent that can read
the root is expected to pick it up through its own discovery mechanism.

## Provider-Native Skill

A Skill that lives in a provider's own skill directory (e.g. `.opencode/skills`,
`.claude/skills`, `.agents/skills`) and is loaded by that provider's CLI
itself. Emdash does not manage it: it is not installed, mirrored, or
tracked by the Skills library.
