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
| `apps/emdash-desktop/package.json` | `package:fork` script (see "Personal macOS builds") |

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
- `pnpm run package:mac|linux|win` is broken in the monorepo layout: `electron` is a
  range (`^40.7.0`) hoisted to the workspace root, so electron-builder aborts with
  *"Cannot compute electron version from installed node modules"*. Only
  `scripts/release/build.ts` works, because it resolves the version itself and passes
  `electronVersion` into the config (`build.ts:78`). `electron-builder.fork.config.ts`
  does the same resolution inline.
- electron-builder's dependency collector mishandles the `node-linker=hoisted` layout
  in three ways, each of which kills the packaged app at boot while `pnpm dev` works
  fine: (1) a version conflict resolved in the app's or a workspace package's own
  `node_modules` is flattened to the root's (wrong) version — glob 7 shadowing
  glob 13 broke `import { globIterate }` in `@emdash/core` and `import { glob }` in
  `out/main`; (2) nested conflict copies (`node_modules/x/node_modules/y`) are
  dropped — node-fetch 2 lost its whatwg-url 5 and crashed on whatwg-url 16 requiring
  the unpackaged `@exodus/bytes`; (3) a root package whose only consumers are nested
  is never visited — open 11's closure (`default-browser`, …) was absent.
  `electron-builder.fork.config.ts` compensates with generated `files` mappings: it
  walks the runtime graph with Node's real upward resolution, re-adds every non-root
  `node_modules` it traverses, and maps root packages the collector's naive walk
  can't reach. Audit a candidate asar before installing it: extract with
  `pnpm exec asar extract` (beware: `extract-file` writes into the CURRENT directory)
  and check that every packaged package.json's deps resolve at a compatible version
  from its location. Upstream escapes all of this by luck: their root hoist happened
  to resolve glob@10, which still had the named exports.

## Personal macOS builds (auto-update from this fork)

A packaged build is a normal `Emdash.app` you can keep in `/Applications` instead of
living in `pnpm dev`. Two things need care.

**The update feed.** `electron-builder.config.ts` publishes to `generalaction/emdash`
+ `releases.emdash.sh`, and the updater reads that feed from the `app-update.yml`
embedded at packaging time (there is no `setFeedURL` anywhere in the code). A fork
build using it would offer upstream's next stable release and silently replace our
features on install. `electron-builder.fork.config.ts` overrides `publish` to point at
`64ix/emdash` and nothing else.

**Code signing.** On macOS `electron-updater` hands the install to Squirrel.Mac, which
validates the downloaded bundle against the running app's designated requirement. An
unsigned build downloads the update and then fails at install, so a fork build that
wants working auto-updates must be signed — with the *same* identity every time,
starting with the first build you actually install. A self-signed identity is enough
for personal use.

One-time setup (already done on the original machine; `~/.emdash-fork-signing/` holds
the key, so it is per-machine):

```bash
D=~/.emdash-fork-signing && mkdir -p "$D" && chmod 700 "$D"
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$D/signing.key" -out "$D/signing.crt" -config "$D/openssl.cnf"
/usr/bin/openssl pkcs12 -export -inkey "$D/signing.key" -in "$D/signing.crt" \
  -out "$D/signing.p12" -passout pass:emdash-fork -name "Emdash Fork Signing"
security create-keychain -p "$(openssl rand -hex 24 | tee "$D/keychain-password")" \
  "$D/fork-signing.keychain-db"
security import "$D/signing.p12" -k "$D/fork-signing.keychain-db" -P emdash-fork \
  -T /usr/bin/codesign -A
security set-key-partition-list -S apple-tool:,apple:,codesign: \
  -s -k "$(cat "$D/keychain-password")" "$D/fork-signing.keychain-db"
```

`codesign` resolves identities through the user's keychain search list, so the
dedicated keychain has to be appended to it — neither `--keychain` nor `CSC_KEYCHAIN`
is enough on its own. `build-fork.sh` does this idempotently on every run.

`openssl.cnf` must set `extendedKeyUsage = critical,codeSigning` and
`basicConstraints = critical,CA:false`. The certificate is then still
`CSSMERR_TP_NOT_TRUSTED` and `codesign` reports "no identity found" until it is
trusted for code signing — this step needs your login password, so it cannot be
scripted from an agent:

```bash
security add-trusted-cert -r trustRoot -p codeSign \
  -k "$HOME/Library/Keychains/login.keychain-db" ~/.emdash-fork-signing/signing.crt
```

Scope: trust is limited to `codeSign` (not TLS) and to this user account. Anything
signed with that key is treated as validly signed on this machine, so keep
`~/.emdash-fork-signing/` at `chmod 700`.

Then build and, optionally, publish a release on `64ix/emdash`:

```bash
pnpm run package:fork -- --version 1.2.0
pnpm run package:fork -- --version 1.2.0 --publish
```

The version is injected via `extraMetadata`, never committed — `package.json` keeps
upstream's value so rebases stay clean. Rules: plain `x.y.z`, strictly increasing
(`allowDowngrade` is `false`), no prerelease suffix (`allowPrerelease` is `false` off
the canary channel), and above upstream's line — upstream lives in `1.1.x`, so `1.2.0`,
`1.3.0`, … are ours.

**How `--publish` sequences a release.** It mirrors the CI pipeline
(`scripts/release/prepare-release.ts` → build → `finalize-release.ts`): the GitHub
release is created as a **draft** *before* packaging, the two macOS publishers upload
the dmg, the zip, their blockmaps and the `latest-mac.yml` the updater reads into it,
and only then is it published — which is the moment GitHub creates the `v<version>`
tag, from the exact commit that was packaged. Consequences worth knowing:

- An interrupted or failed build leaves a draft and no tag. Re-running the same
  `--version` reuses that draft, so recovery is just running the command again.
- The script refuses to publish from a dirty working tree, or a `HEAD` that is not
  pushed yet: the tag has to describe what was actually built. `EMDASH_FORK_ALLOW_DIRTY=1`
  overrides the first.
- It refuses to touch a version that is already published, so re-releasing is
  deliberate: pass `--republish` to upload into an existing published release.
- Before publishing the draft it asserts `latest-mac.yml` is among the assets, and
  leaves the release as a draft if it is not.

That last guard exists because the failure it prevents is silent. Publishing 1.2.6
without the draft step produced this, twice over:

```text
creating GitHub release  reason=release doesn't exist tag=v1.2.6
creating GitHub release  reason=release doesn't exist tag=v1.2.6
⨯ HttpError: 422 Unprocessable Entity … "Published releases must have a valid tag"
```

Both publishers raced to create the same release; one POST won and the others got a
422 whose message points at the tag, which is not the problem — it is a concurrent
creation conflict. The release existed, but only one blockmap had uploaded and
`latest-mac.yml` was never regenerated (the copy left in `release/` still described
the *previous* version). `electron-updater` resolves such a release as the latest one
and then 404s on the channel manifest, so the update never happens and nothing in the
app reports an error. If you ever see a fork release whose asset list is short, that
is what happened; the fix is to delete the stray assets and re-run with `--republish`.

**Shared state with the official app.** The fork build keeps upstream's identity —
`Emdash.app`, `com.emdash.stable`, data in `~/Library/Application Support/emdash/`.
So it replaces a `/Applications/Emdash.app` installed from emdash.sh and shares its
database, which our migrations will upgrade. Back that directory up before the first
launch. Because the signing identity differs from General Action's, macOS will also
ask once to let the app reach the `emdash Safe Storage` keychain item holding the
encrypted secrets. To run both side by side instead, build the canary variant
(`VITE_BUILD=canary` in `.env.production` + `electron-builder.canary.config.ts`):
separate app name, bundle id and `emdash-canary/` data directory.
