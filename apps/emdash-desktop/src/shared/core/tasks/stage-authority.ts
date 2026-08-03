import type { LinkedIssue, LinkedIssueRoles } from '@shared/core/linked-issue';
import {
  canAdvanceTo,
  isClosedSpecTriageContradiction,
  stageRank,
  type IssueStateFact,
} from '@shared/core/tasks/stage-derivation';
import type { StageHoldingPr, WorkflowStage } from '@shared/core/tasks/tasks';

/**
 * Ticket #48 (CONTEXT.md "Workflow Stage", docs/adr/0003): the explanation
 * contract for a task's current Workflow Stage placement — a single pure
 * function computed from the *same* observable facts and precedence rules
 * board synchronization already uses (`stage-derivation.ts`'s
 * `deriveWorkflowStageFromIssues`, `pr-workflow-derivation.ts`'s
 * `deriveTaskStageAuthorityFact`), so it can never assert an authority the
 * sync itself would not. This module introduces no new declarative source of
 * truth and persists nothing: every value here is derived on read from data
 * already stored on the task (linked issues, PRs, workspace presence).
 *
 * Consumers: the Task Detail Panel (`task-detail-panel-view-model.ts`) for
 * its stage explanation, and the Feature Board (`board-main-panel.tsx`) for
 * disabling cross-stage drag destinations a GitHub fact would silently
 * overwrite.
 */

/** The one governing fact behind a task's current Workflow Stage, or the
 * absence of one. `manual` covers both a genuinely user-placed stage and a
 * stage the board can't yet explain (e.g. a stale/closed link) — ticket #56's
 * "false authority" failure mode is exactly a stage that *looks* like one of
 * the other kinds but the facts don't actually support. */
export type StageAuthorityFact =
  | { kind: 'manual' }
  | { kind: 'open-map'; issue: LinkedIssue }
  | { kind: 'open-spec'; issue: LinkedIssue }
  | { kind: 'provisioned-implementation' }
  | { kind: 'open-pr'; pr: StageHoldingPr }
  | { kind: 'merged-pr'; pr: StageHoldingPr }
  | {
      kind: 'triage-contradiction';
      reason:
        | { kind: 'closed-pr'; pr: StageHoldingPr }
        | { kind: 'closed-spec'; issue: LinkedIssue };
    };

export type StageAuthorityFactKind = StageAuthorityFact['kind'];

export type StageAuthority = {
  fact: StageAuthorityFact;
  /**
   * `true` while `fact` is a GitHub fact the very next sync pass will
   * (re)assert into at least one destination if disturbed — `open-map`,
   * `open-spec`, `open-pr`, `merged-pr`, and `triage-contradiction` (a fact
   * that has not yet swept the persisted stage to `triage`, but will).
   * `manual` and `provisioned-implementation` are always `false`: nothing
   * re-derives either continuously (provisioning runs once; nothing is
   * governed until a link/PR fact exists), so a manual move away from them is
   * never silently overwritten. Callers use `governs` to decide whether a
   * card must consult {@link isStageDestinationSafe} before allowing a
   * cross-stage move; same-column reordering is always safe regardless.
   */
  governs: boolean;
};

/** The one fact about a linked issue every derivation in this contract reads:
 * is it a genuinely open (or closed) *GitHub* issue? A linked issue from any
 * other provider, or one whose status string doesn't map to open/closed, was
 * never a fact the GitHub-only inbound issues sync could have consulted —
 * mirrors `isGithubProvenOpenIssue` in `task-detail-panel-view-model.ts`
 * (spec #12's fix for ticket #56's premise). */
function githubIssueState(issue: LinkedIssue | undefined): 'open' | 'closed' | null {
  if (!issue || issue.provider !== 'github') return null;
  return issue.status === 'open' || issue.status === 'closed' ? issue.status : null;
}

function isGithubProvenOpenIssue(issue: LinkedIssue | undefined): issue is LinkedIssue {
  return githubIssueState(issue) === 'open';
}

/**
 * Structurally identical to `pr-workflow-derivation.ts`'s
 * `TaskStageAuthorityFact<T>`, but without that type's own
 * `T extends PrWorkflowFact` constraint: callers here only ever hand this
 * function an *already-built* authority fact (from `deriveTaskStageAuthorityFact`
 * itself, or the RPC-erased `TaskStageAuthority`), never build one, so the
 * extra fields that constraint exists for (`headRefName`, `description`) are
 * never needed past this point.
 */
export type StageAuthorityPrFact<T extends StageHoldingPr> = {
  holdingPr: T | null;
  isCurrentStageGithubProven: boolean;
};

export type StageAuthorityInput<T extends StageHoldingPr> = {
  currentStage: WorkflowStage | null;
  linkedIssues?: LinkedIssueRoles | null;
  /**
   * The task's Spec-derived PR authority — the exact fact both
   * `BoardSyncService`'s periodic pass and the `tasks.getTaskStageAuthority`
   * RPC compute (`deriveTaskStageAuthorityFact`). `null`/`undefined` reads as
   * "not proven" (no matching PR, or not loaded yet).
   */
  prAuthority?: StageAuthorityPrFact<T> | null;
  /**
   * True once the task has a provisioned workspace (`task.workspaceId != null`)
   * — the fact `BoardSyncService.applyProvisionedStage` reads before setting
   * `implementing` for a Spec-linked task. Purely informational: provisioning
   * runs once and nothing re-derives `implementing` continuously, so it never
   * governs a cross-stage move.
   */
  hasWorkspace: boolean;
};

/**
 * Computes the single fact governing `input.currentStage`, and whether that
 * fact currently governs (see {@link StageAuthority.governs}). Precedence,
 * derived from what `deriveWorkflowStageFromIssues` and
 * `deriveTaskStageAuthorityFact` actually implement, not from a rewritten copy
 * of their rules:
 *
 * 1. A Spec-referencing PR fact always wins when it is proven for a
 *    non-`triage` current stage (`prAuthority.isCurrentStageGithubProven`) —
 *    `BoardSyncService.syncProject` reasserts its derived stage unconditionally
 *    on every non-`triage` stage, regardless of the PR's status or the current
 *    stage's own value.
 * 2. Failing that, an open Map/Spec issue governs whenever
 *    `canAdvanceTo(currentStage, target)` holds — the exact direction guard
 *    `deriveWorkflowStageFromIssues` itself uses, since it only ever
 *    *advances* toward the fact's target or leaves the stage alone, never
 *    regresses an already-advanced one. A Spec link (open or closed) always
 *    pre-empts a Map fact, mirroring that function's own
 *    `if (specIssue) { ...; }` early return.
 * 3. Failing that, a closed Spec issue (no PR fact reached this far, so no
 *    merged PR exists) is the contradiction that would sink the task to
 *    `triage` — unless the current stage is already `triage` (the sync never
 *    re-derives a sink) or `review`/`shipped` (PR-proven stages a closed Spec
 *    can't outrank).
 * 4. Failing that, a provisioned workspace explains — without governing — a
 *    persisted `implementing` stage.
 * 5. Otherwise the placement is manual/unexplained.
 */
export function deriveStageAuthority<T extends StageHoldingPr>(
  input: StageAuthorityInput<T>
): StageAuthority {
  const { currentStage, linkedIssues, prAuthority, hasWorkspace } = input;
  const holdingPr = prAuthority?.holdingPr ?? null;

  if (prAuthority?.isCurrentStageGithubProven && holdingPr) {
    if (holdingPr.status === 'open') {
      return { fact: { kind: 'open-pr', pr: holdingPr }, governs: true };
    }
    if (holdingPr.status === 'merged') {
      return { fact: { kind: 'merged-pr', pr: holdingPr }, governs: true };
    }
    return {
      fact: { kind: 'triage-contradiction', reason: { kind: 'closed-pr', pr: holdingPr } },
      governs: true,
    };
  }

  const specIssue = linkedIssues?.spec;
  const mapIssue = linkedIssues?.map;

  // `!specIssue` mirrors `deriveWorkflowStageFromIssues`'s own
  // `if (specIssue) { ...; }` early return: a Spec link, open or closed,
  // always pre-empts a Map fact, so a Map-only task is the only one this
  // branch may govern.
  if (!specIssue && isGithubProvenOpenIssue(mapIssue) && canAdvanceTo(currentStage, 'exploring')) {
    return { fact: { kind: 'open-map', issue: mapIssue }, governs: true };
  }
  if (isGithubProvenOpenIssue(specIssue) && canAdvanceTo(currentStage, 'spec')) {
    return { fact: { kind: 'open-spec', issue: specIssue }, governs: true };
  }

  // Reached only when no PR fact matched at all (see the exhaustive dispatch
  // above), so `hasMergedPullRequest` is always `false` here — the second
  // argument `isClosedSpecTriageContradiction` needs is structurally
  // guaranteed by this function's own precedence, not re-checked against a
  // fresh PR list.
  if (
    currentStage !== 'triage' &&
    currentStage !== 'review' &&
    currentStage !== 'shipped' &&
    specIssue
  ) {
    const specState = githubIssueState(specIssue);
    const specIssueFact: IssueStateFact | undefined = specState ? { state: specState } : undefined;
    if (isClosedSpecTriageContradiction(specIssueFact, false)) {
      return {
        fact: { kind: 'triage-contradiction', reason: { kind: 'closed-spec', issue: specIssue } },
        governs: true,
      };
    }
  }

  if (currentStage === 'implementing' && hasWorkspace) {
    return { fact: { kind: 'provisioned-implementation' }, governs: false };
  }

  return { fact: { kind: 'manual' }, governs: false };
}

/**
 * True when a manual drag from a card whose current placement is `fact` to
 * `destination` (`null` models Unstaged) is safe — no periodic sync pass
 * would silently overwrite it. `triage` is always safe: every derivation in
 * this contract treats a *persisted* `triage` as a sink it never revisits.
 * Only meaningful when `fact.governs` — callers should treat every
 * destination as safe otherwise (nothing contests a non-governing fact).
 */
export function isStageDestinationSafe(
  fact: StageAuthorityFact,
  destination: WorkflowStage | null
): boolean {
  if (destination === 'triage') return true;
  switch (fact.kind) {
    case 'open-map':
      // `canAdvanceTo` only ever advances toward `exploring` or leaves the
      // stage alone — a destination ranked *above* `exploring` in the
      // pipeline is never regressed back.
      return destination !== null && stageRank(destination) > stageRank('exploring');
    case 'open-spec':
      return destination !== null && stageRank(destination) > stageRank('spec');
    case 'open-pr':
    case 'merged-pr':
      // `BoardSyncService.syncProject` reasserts its derived stage on every
      // non-`triage` current stage, unconditionally — no destination but
      // `triage` escapes it.
      return false;
    case 'triage-contradiction':
      if (fact.reason.kind === 'closed-spec') {
        // `deriveWorkflowStageFromIssues`'s own guard: `review`/`shipped` are
        // PR-proven stages a closed Spec can never outrank, even mid-flight —
        // the issue sync backs off entirely once the task lands on either.
        return destination === 'review' || destination === 'shipped';
      }
      // closed-pr: `BoardSyncService.syncProject` reasserts `triage`
      // unconditionally on every non-`triage` current stage — same as
      // `open-pr`/`merged-pr` above, just aimed at a different destination.
      return false;
    case 'provisioned-implementation':
    case 'manual':
      return true;
  }
}

// ---------------------------------------------------------------------------
// Accessible explanation text
// ---------------------------------------------------------------------------

function prLabel(pr: StageHoldingPr): string {
  return pr.identifier ?? pr.title;
}

function issueLabel(issue: LinkedIssue): string {
  return issue.identifier || issue.title;
}

export type StageAuthorityExplanation = {
  /** Names the governing fact. */
  fact: string;
  /** What must change before a manual move to a different stage sticks. */
  action: string;
  link: { url: string; label: string } | null;
};

/**
 * Builds the accessible explanation for a governing fact: what it is, and
 * what must change to unlock a manual move (ticket #48's disabled-destination
 * criterion). Returns `null` for `manual`/`provisioned-implementation` — a
 * placement with no GitHub fact to explain, or one that already isn't locked.
 */
export function describeStageAuthorityFact(
  fact: StageAuthorityFact
): StageAuthorityExplanation | null {
  switch (fact.kind) {
    case 'open-pr':
      return {
        fact: `Held in Review by an open PR referencing the Spec: ${prLabel(fact.pr)}.`,
        action: `This will remain in Review until ${prLabel(fact.pr)} closes or merges.`,
        link: { url: fact.pr.url, label: prLabel(fact.pr) },
      };
    case 'merged-pr':
      return {
        fact: `Held in Shipped by a merged PR referencing the Spec: ${prLabel(fact.pr)}.`,
        action: 'A merged pull request is permanent — this task will not leave Shipped.',
        link: { url: fact.pr.url, label: prLabel(fact.pr) },
      };
    case 'open-map':
      return {
        fact: `Held in Exploring by its linked Map issue: ${issueLabel(fact.issue)}.`,
        action: `This will remain in Exploring until ${issueLabel(fact.issue)} closes.`,
        link: { url: fact.issue.url, label: issueLabel(fact.issue) },
      };
    case 'open-spec':
      return {
        fact: `Held in Spec by its linked Spec issue: ${issueLabel(fact.issue)}.`,
        action: `This will remain in Spec until ${issueLabel(fact.issue)} closes.`,
        link: { url: fact.issue.url, label: issueLabel(fact.issue) },
      };
    case 'triage-contradiction':
      if (fact.reason.kind === 'closed-pr') {
        return {
          fact: `Held in Triage by a closed PR referencing the Spec: ${prLabel(fact.reason.pr)}.`,
          action: `Reopen or merge ${prLabel(fact.reason.pr)} to move this task out of Triage manually.`,
          link: { url: fact.reason.pr.url, label: prLabel(fact.reason.pr) },
        };
      }
      return {
        fact: `Held in Triage: its linked Spec issue closed without a merged pull request: ${issueLabel(fact.reason.issue)}.`,
        action: `Reopen ${issueLabel(fact.reason.issue)}, or link a merged pull request, to move this task out of Triage manually.`,
        link: { url: fact.reason.issue.url, label: issueLabel(fact.reason.issue) },
      };
    case 'provisioned-implementation':
    case 'manual':
      return null;
  }
}
