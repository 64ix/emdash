# @emdash/sync-relay

A self-operated [Cloudflare Worker](https://developers.cloudflare.com/workers/) +
[D1](https://developers.cloudflare.com/d1/) sync relay that lets two personal
devices attach to a private space and exchange encrypted row bodies. It is the
server side of the multi-machine sync spec: the client is the source of truth,
the relay is an **ordering relay** — it stores opaque, client-encrypted
payloads, orders them with a per-space monotonic version, and never parses row
bodies.

Fork-owned, free tier, 2 devices. Deployment is manual (see below); there is no
CI pipeline for it.

## Protocol

All requests are JSON. Space-scoped endpoints require
`Authorization: Bearer <device_token>`. The space is derived from the token —
clients never send a space id (except on `POST /v1/join`, which is
unauthenticated by design).

| Endpoint | Auth | Request | Response |
| --- | --- | --- | --- |
| `POST /v1/space` | — | `{name?}` | `{space_id, device_id, device_token, secret}` |
| `POST /v1/join` | — | `{join_hash, space_id, name?}` | `{device_id, device_token, space_id}` |
| `POST /v1/devices/join-secret` | ✓ | `{join_hash}` | `{join_hash}` |
| `GET /v1/devices` | ✓ | — | `{devices: [{device_id, name, created_at, last_seen_at, revoked, revoked_at, self}]}` |
| `POST /v1/devices/revoke` | ✓ | `{device_id}` | `{device_id, revoked: true}` |
| `POST /v1/sync/pull` | ✓ | `{cursor?, limit?}` | `{cursor, patches: [{space, table, pk, version, client_version, op, deleted, body}]}` |
| `POST /v1/sync/push` | ✓ | `{mutations: [{table, pk, client_version?, body?, op}]}` | `{results: [{table, pk, version}]}` |
| `POST /v1/sync/poll` | ✓ | `{cursor?, timeout_ms?}` | same shape as pull |

Errors are `{error: string}` with 400 (malformed input), 401 (bad/revoked
credentials — failures are indistinguishable on purpose), 404 (unknown path or
device), 500 (internal).

### Sync semantics

- **Per-space monotonic version**: each push assigns a fresh version from the
  space's counter row, incremented with `version = version + 1 RETURNING
  version` and stamped in the **same transaction** as the row write
  (`db.batch([counter, upsert])`). No client timestamps, no bare AUTOINCREMENT
  ordering.
- **`client_version` travels with the row**: the value the encrypting client
  bound into its body's AEAD AAD (its last-known version of the row, or 0).
  The relay stores it verbatim and returns it on pull; it is ignored for
  ordering. Because it is bound into the encryption, a body replayed under
  newer metadata fails to decrypt on every other client.
- **Last-write-wins**: rows are keyed by `(space_id, table, pk)`; a push
  overwrites whatever is there in server receipt order and is **never
  rejected**, however stale the client's `client_version` is (it is advisory
  and ignored for ordering).
- **Pull cursor**: `cursor` is a version; pull returns rows with `version >
  cursor` ordered ascending, and echoes the last returned version as the next
  cursor. Tombstones are rows with `deleted: true` / `op: 'delete'`.
- **Long-poll**: `POST /v1/sync/poll` holds the request (re-checking D1 every
  second) until patches for `cursor` exist or `timeout_ms` elapses (clamped to
  25 s). Clients reconnect with backoff.

### Identity & pairing

- Device tokens: 32 random bytes base64url with a prefix and checksum
  (`emdv1_<43 chars>_<6 chars>`). Only **SHA-256 of the token** is stored;
  lookups compare digests, and checksums are verified with a constant-time
  comparison. Revocation sets `revoked_at` and keeps the row for audit
  (revoke token, not remove device).
- Pairing uses the **two-half model**: the pasted secret is
  `emdj1_<space_id 22>_<join half b32 26>_<k0 b32 52>` (base32 is RFC 4648
  lowercase, unpadded). `join half` is 16 random bytes — the only half that
  ever transits to the relay, and only as **SHA-256**; `k0` is the 32-byte
  space data key (AES-256-GCM) that never transits at all and only travels
  machine-to-machine inside the pasted secret.
- `POST /v1/space` returns the first device's token plus a two-half secret
  (the relay mints both halves once, at space creation).
- `POST /v1/join` receives the **join credential** (the base32 join half, 26
  chars) plus the `space_id` the joining client parsed from the secret; the
  relay hashes the presented credential and compares it against the stored
  digests of that space with a constant-time comparison. This keeps failed
  attempts attributable to the space's pending secrets.
- `POST /v1/devices/join-secret` lets an existing device **register a
  client-minted credential**: the client generates a fresh join half, embeds
  it in a new secret alongside the space's unchanged K0, and sends only the
  SHA-256 hex digest of the join credential. The relay never sees K0 and
  never receives the join half itself.
- Secrets are **single-use**, **TTL-bounded (15 minutes)**, and
  **attempt-limited (5 attempts)** — the budget is enforced in the Worker (per
  secret), not via Cloudflare rate-limit rules.

## Storage

Plaintext metadata only — bodies are opaque strings, never read:

- `spaces(space_id, created_at)`
- `tokens(id, space_id, device_id, name, sha256, created_at, last_seen_at, revoked_at)`
- `join_secrets(secret_id, space_id, sha256, created_at, expires_at, attempts_left, used_at)`
- `sync_rows(space_id, table_name, pk, body, version, client_version, deleted, updated_at)`
  with an index on `(space_id, version)`
- `version_counters(space_id, version)`

The schema bootstraps idempotently at worker startup (`CREATE TABLE IF NOT
EXISTS`); there are no numbered migrations to maintain. Because the schema
self-heals and the relay has not been deployed yet, the `client_version`
column and the two-half secret format landed as a protocol change rather than
a migration.

## Local development

```bash
pnpm install                     # from the repo root
pnpm --filter @emdash/sync-relay test
pnpm --filter @emdash/sync-relay typecheck
pnpm --filter @emdash/sync-relay build
```

### Why `node:sqlite` and not miniflare for tests?

Tests run the worker's `handle()` against an in-process D1-compatible harness
(`test/memory-d1.ts`) built on `node:sqlite` (built into Node ≥ 24). The relay
uses a deliberately small SQL surface (parameterised statements, `exec`, and
transactional `batch` with `RETURNING`), so real SQLite semantics — constraints,
`ON CONFLICT`, transactions — are exercised without a workerd binary download.
The only new devDependencies are `wrangler` (deploy tooling) and
`@cloudflare/workers-types` (D1 types); the harness itself adds nothing. If the
SQL surface ever grows beyond the harness's fidelity, switch the harness for
[miniflare](https://miniflare.dev/) without touching the worker code — the seam
is `SqlDb` in `src/db.ts`.

## Deployment (fork owner)

```bash
cd apps/sync-relay
pnpm exec wrangler login

# 1. Create the D1 database and note its id.
pnpm exec wrangler d1 create emdash-sync-relay

# 2. Put that id in wrangler.jsonc (d1_databases[0].database_id).
#    Never commit the id if you consider it sensitive; it is not a secret.

# 3. Deploy. The schema self-bootstraps on first request.
pnpm exec wrangler deploy

# Local smoke test against a local D1:
pnpm exec wrangler dev
curl -X POST http://localhost:8787/v1/space
```

There are no secrets in the worker: tokens are high-entropy client-held values
and only their SHA-256 digests live in D1, so no `wrangler secret` is needed.

## Security notes

- Row bodies arrive E2E-encrypted; the relay stores them verbatim and never
  parses them (push bodies are not JSON-parsed, pull returns them untouched).
- Tokens/secrets are random 32/16-byte values; digests at rest; constant-time
  checksum and digest comparisons in the Worker.
- Join failures all read `401 invalid join secret` (no oracle about expiry,
  single-use, or budget); exhausted or expired secrets are purged.
- Revoked tokens are refused; revocations are kept for audit.
- Not in scope: Durable Objects, WebSockets, rate limiting (the pairing budget
  is app-level), and membership removal (revoke only).

## Not implemented here

The client side (space creation UI, device pairing flow, sync loop with
backoff) lives in the desktop app and consumes this API; the relay is
transport-agnostic and has no client dependencies.
