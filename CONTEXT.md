# Glossary

## Feature Board

The kanban view (fork-only) that shows a project's tasks as cards grouped in
columns by **Workflow Stage**. Reached from the project titlebar dropdown.
Not part of the settings/options UI.

## Workflow Stage

The position of a task in the feature delivery pipeline:
`idea → exploring → spec → implementing → review → shipped`, plus the
out-of-flow **Triage** stage. `exploring` is optional — a task may go
straight from `idea` to `spec`. Nullable — a task with no stage is
**Unstaged** and appears in the leading Unstaged column of the Feature
Board.

Stage authority is hybrid: GitHub is authoritative for every stage it can
prove (`exploring` = open Map, `spec` = open Spec issue, `review` = open
PR referencing the Spec, `shipped` = that PR merged); the agent or user
declares the rest (`idea`, `implementing`). A GitHub fact always wins over
a manual placement.

## Triage

The out-of-flow stage where a card lands when its GitHub facts contradict
or disappear (PR closed without merge, Spec closed mid-flight). GitHub
pushes cards in; only the user or an agent moves a card back out.

## Shipped Fade

A display rule, not a stage: `shipped` cards whose PR merged more than a
fixed window ago are hidden from the Feature Board. The task keeps its
stage forever.

## Awaiting Input

The state of a task on the Feature Board when at least one of its sessions
has an unseen `awaiting-input` conversation — an agent is waiting on the
user. A display state, not a position: awaiting-input cards float to the
top of their column at render time and fall back to their manual place
once handled.

## Board Rank

A task's manually chosen position within a Feature Board column. Only ever
set by an explicit user gesture (a drop); never written by the system.
Tasks without a Board Rank sort after ranked ones, in their existing order.

## Ghost Card

A lightweight candidate card on the Feature Board for a root GitHub issue
(not a Spec, not a sub-issue, not `wayfinder:*`) that no task references
yet. Not a task: adopting it creates a real task with the issue as its
Origin; rejecting it hides it. Nothing is persisted without adoption.
Sourced from the [Issue Tracker Repository](#issue-tracker-repository) only.

## Link Suggestion

An orphan Spec- or Map-shaped GitHub issue — no [Task Marker](#task-marker),
no task linking it — surfaced above the Feature Board with three answers:
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

The `[Spec] <feature>` issue for a task. The anchor link: once a task has
a Spec, everything downstream (tickets, PR, shipped) is derived from
GitHub by walking from the Spec. A PR is never a stored link — it is
always derived from the Spec.

## Unstaged

The state of a task whose Workflow Stage is unset. Displayed as the first
column of the Feature Board; not itself a Workflow Stage.

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
