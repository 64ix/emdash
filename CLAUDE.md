# READ FIRST — this checkout is a fork

Applies to **every** task in this repo, however small. Two remotes:

| Remote | Repo | Rule |
|--------|------|------|
| `origin` | `64ix/emdash` | **ours** — branches, PRs, issues, releases all live here |
| `upstream` | `generalaction/emdash` | **read-only** — `git fetch` for rebases, `gh ... view/list/diff` to look. Never push, never open a PR or issue, never comment. Its push URL is set to `DISABLED` and `.claude/hooks/guard-fork-remote.sh` blocks the rest. |

Two branches:

| Branch | Rule |
|--------|------|
| `fork-main` | **the working branch.** Cut every branch from it, open every PR onto it. |
| `main` | pristine mirror of `upstream/main`. Never commit, never merge onto it. |

Before you edit anything, confirm you are standing on the fork's code — a worktree
cut from `main` has none of our features, so you will "fix" upstream code that our
version already handles differently:

```bash
git merge-base --is-ancestor origin/fork-main HEAD && echo OK || echo "WRONG BASE — stop, rebase onto origin/fork-main"
```

Opening a PR — always both flags, `gh` defaults a fork's base repo to the **parent**:

```bash
gh pr create --repo 64ix/emdash --base fork-main --title ... --body ...
gh pr view <n> --json baseRefName -q .baseRefName     # must print: fork-main
```

Fresh clone or new machine? The enforcement above lives outside the repo — apply it with
`sh scripts/fork-setup.sh` (idempotent).

Full rationale and the failures that motivated each rule: [FORK.md](FORK.md).

@AGENTS.md
