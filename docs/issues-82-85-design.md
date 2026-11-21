# Design proposals for issues 82–85

These are the proposed designs for #82, #83, #84 and #85, submitted for maintainer review before
any code is written, as the issues ask. Nothing here is implemented yet. Decisions the maintainers
need to make are marked as such.


Cross-issue notes (post these once, on #82 or #84, and link from the others):
- #84 and #85 both change `Authenticate` (auth.ts). They should be designed together: #84
  introduces the principal type, and #85 adds scopes to it. Proposed: one PR for the auth change,
  with #84 first.
- #82 and #83 both touch the serve loop and where the account list lives. #83 depends on the
  watch-list design, referred to in its issue as "the watch-list issue"; this document does not
  restate it.
- Suggest one PR per issue rather than one branch for all four. The PR template is per-issue
  (`Closes #N`), and #84 and #85 are both marked breaking.

---

## #82 Sync and reconcile every tenant in `nostro serve`

**Config format.** A JSON file via `--config <file>` (no new dependency; Node 22 has no TOML
reader). Each tenant lists its own accounts, network and webhook:

```json
{
  "tenants": [
    {
      "id": "acme",
      "network": "testnet",
      "accounts": ["G..."],
      "webhook": { "url": "https://acme.example/nostro", "secretEnv": "NOSTRO_WEBHOOK_SECRET_ACME" }
    },
    { "id": "beta", "network": "pubnet", "accounts": ["G..."] }
  ]
}
```

- The webhook names the environment variable holding its secret, never the secret.
- API keys stay in `NOSTRO_API_KEYS` / `--keys-file`. A key for a tenant with no config entry is
  served read-only from the store but gets no worker.
- Flags and config do not mix. `--config` together with `--tenant`, `--account`, `--webhook-url` or
  `--network` is a UsageError. This avoids deciding which one wins.
- Without `--config`, today's flags build one implicit tenant. A test runs both forms and checks
  the same output.

**Concurrency.** Each tenant runs its own worker, with at most `--concurrency` (default 4) running
at once. A tenant that is waiting for its turn does not block the others.
- SQLite has one writer. Horizon fetches overlap, but store writes are serialised by the single
  connection. Open question for the maintainers: does `store-sqlite` allow concurrent
  `transaction()` calls on one connection, or do they need a queue? This needs checking before
  implementation. If it does not, SQLite runs with concurrency 1, and the docs say so.

**Separate timers.** Each tenant has two loops:
- sync + reconcile, every `--interval` seconds (default 30);
- webhook delivery, every `--delivery-interval` seconds (default 5).

A slow receiver therefore only delays that tenant's delivery, never its sync or another tenant.
Each failing tenant backs off on its own (doubling up to 10 × interval) so it does not spin.

**Hangs.** Horizon calls and webhook POSTs get explicit timeouts (the existing 10 s for webhooks).
Each tenant's failure is caught inside that tenant's loop.

**Logging.** Every line carries `[tenant=<id>]`, and text from outside goes through `clean()`.

**Shutdown.** The abort signal stops every loop. Each finishes its current step, then exits. The
process waits for all of them, bounded by `--shutdown-timeout` (default 30 s), then prints `Stopped.`

**Tests.**
- Two tenants with separate FakeHorizon accounts and separate fake receivers. Each receiver gets
  only its own tenant's events.
- FakeHorizon fails for tenant A (or A's receiver hangs). Tenant B's movements still sync and
  deliver within one interval.
- The single-tenant flag form still works, with a test (the issue's done-when).

---

## #83 Manage watched accounts over the API, and show each one's sync state

**Depends on the watch-list design** (issue number needed). Routes below sit on that stored list.

**Routes.**
- `GET /v1/accounts`: each watched account with its sources' sync state.
- `POST /v1/accounts` with `{ "account": "G..." }`: add (idempotent; 201 or 200).
- `DELETE /v1/accounts/{account}`: remove. Only `G...` accounts (ACCOUNT in schemas.ts).

**Where sync state lives.** A `sync_state` table, written by the worker after each source pull in
each round. Columns: tenant, network, source, account, cursor, last_success_at, last_attempt_at,
caught_up (boolean), last_error (nullable), last_error_at. The server reads it and never runs sync.
- `StoreReader` gets `listSyncState(tenantId)`; the writer side gets `recordSyncAttempt(...)`.
- Memory, SQLite and PostgreSQL all implement it, with a migration and conformance cases.
- In-memory state inside `serve` is not used, because the API and the worker are separate
  processes in the Docker setup.

**Caught up** means the last pull returned fewer than `limit` records and there was no error.

**Flags vs stored list.** Flags and `--config` accounts are upserted into the watch list at
startup and marked `source: "config"`. Removing a config-managed account over the API returns
409 `config_managed`. Stored accounts can be added and removed freely. Config is the seed, the
store is the list.

**Removing an account with open expectations.** Proposed: refuse with 409
`has_open_expectations` unless `?force=true`. Removal keeps movements, expectations and the cursor
either way. Maintainer decision requested.

**Re-adding.** Resumes from the saved cursor, so no history is re-read.

**Tests.**
- Add an account over the API while serve runs; its movements sync on the next round.
- FakeHorizon injects an error. `GET /v1/accounts` shows `last_error`. A good round clears it.
- OpenAPI document covers the routes; contract tests in `openapi.test.ts` pass.

---

## #84 Keep API keys in the database, and add or revoke them live

**Table.** `api_keys(id, tenant_id, label, digest UNIQUE, scopes, created_at, revoked_at NULL,
last_used_at NULL)`. Only the SHA-256 digest is stored.

**Key format.** `nstk_` + 43 base64url characters (32 random bytes from `crypto.randomBytes`). The
prefix lets secret scanners find a leaked key. The total is far above MIN_KEY_LENGTH (32).

**Lookup.** An indexed `WHERE digest = ?` query. Timing reveals nothing useful, because the attacker
does not know any digest, and the digest is of a 256-bit random key, so a timing difference only
says whether a digest exists. Env and file keys keep the constant-time scan in `apiKeys()`.

**Revocation delay.** No cache by default. A revoked key is refused on the very next request. If
load ever needs it, an in-process cache with a TTL of at most 10 s can be added. That is a bounded
delay, and the test asserts it.

**Last-used writes.** Updated in memory, one entry per key id, and flushed every 60 s in a single
batch `UPDATE`. A crash loses at most 60 s of last-used precision. Nothing else depends on it.

**Create and list.**
- `nostro keys create --tenant <id> --label <text> [--scopes read,events]` prints the key once and
  never again.
- `nostro keys list` shows id, tenant, label, scopes, created, revoked and last used. Never a key.
- `nostro keys revoke <id>` sets `revoked_at`.
- `--scopes` is required for new keys (see #85), so no key is created with silent full access.

**Env and file keys.** Still work, unchanged, next to stored ones. They cannot be revoked live
(that is what the environment is for), and `keys list` shows them as `config`.

**Migration.** A schema version bump, so `assertCurrent` refuses an old database until `nostro
migrate` runs. Conformance cases in all three stores.

**Plain key never appears.** Not in a table, a log line or a response after create. Request logs
record the key id, never the key. Tests dump the database, capture the log and check the create
response.

**401 for wrong and revoked.** Identical body and status, so a caller cannot tell them apart.

---

## #85 Give API keys scopes, so a key can be read-only

**Principal.** `Authenticate` returns `{ tenantId, scopes: ReadonlySet<Scope>, keyId?: string }`.
This is the breaking change. #84 introduces it, so it ships with that PR.

**Scope names.**
- `read`: every GET except events and webhook status.
- `events`: `GET /v1/events` (a separate scope, because it exposes the full event stream).
- `expectations`: create, cancel and amend expectations.
- `exceptions`: resolve exceptions.
- `accounts` (#83) and `webhooks` (replay) when those land.

**Default for legacy keys with no scopes.** Proposed: unscoped entries in `NOSTRO_API_KEYS` and
`--keys-file` keep full access, so existing deployments keep working. `serve` logs a warning at
startup that names the unscoped keys, and the CHANGELOG marks it breaking and explains how to
scope them. Stored keys (#84) must be created with explicit scopes. Read-only as the default
would break every current deployment. Maintainer decision requested.

**Keys file syntax.** `tenant:key` stays exactly as today. Scopes go in brackets before the colon:
`tenant[read,expectations]:key`. The key is split at the first colon, so a key containing `:` is
fine. The bracket form is only read if `[` appears before the first colon. That requires tenant
ids to exclude `[`, `]`, `:` and whitespace. Validation is added, and existing ids are checked
against it. Test: legacy entries parse as before, including keys with colons.

**Per-route checks.** Each route declares its scope in one place. The check runs in the same
`onRequest` hook as authentication. Missing scope returns 403 `forbidden` (new code, added to
`ProblemCode`, `PROBLEM_CODES` and `openapi.ts`).

**OpenAPI.** Each operation's `security` requirement lists its scope(s) under the bearer scheme, as
OpenAPI 3.1 allows for non-OAuth schemes.

**Tests.** A table-driven test generated from the OpenAPI document calls every operation with every
scope and checks 403 versus success. The 403 body matches the documented schema in the contract
test.

**Breaking.** CHANGELOG entry marked breaking, with the keys-file syntax and the unscoped default.
