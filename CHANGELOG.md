# Changelog

All five packages share a version. This project follows [Semantic Versioning](https://semver.org/);
before 1.0, a minor version may change the API.

## Unreleased

- **CLI errors have a JSON form.** With `--json`, a failing command prints one JSON object on stderr,
  `{"error":{"code","message"}}`, instead of text. Exit codes are unchanged, and text errors without
  `--json` are unchanged. `exceptions` and `expectations` take `--after <seq>` for paging and `--jsonl`
  for one record per line. The contract is documented in `packages/cli/README.md`.
- **API keys live in the database.** `nostro keys create --tenant <id> --label <text> --scopes <list>`
  prints a new key once; `nostro keys list` shows ids, labels, scopes and last use, never keys; and
  `nostro keys revoke <id>` revokes one. A revoked key is refused on its next request, with no
  restart. Only a SHA-256 digest is stored. Keys from `NOSTRO_API_KEYS` and `--keys-file` still work
  next to stored ones. **Run `nostro migrate` before upgrading**: the store gains an `api_keys` table.
  Keys from the store look like `nstk_` followed by 43 characters, so secret scanners can find a leak.
- **Watched accounts over the API.** `GET /v1/accounts` lists the accounts a tenant syncs, with each
  one's sync state: the saved cursor, when it last synced, whether it is caught up, and the last
  error (cleared by the next good round). `POST /v1/accounts` starts syncing an account on the next
  round, with no restart, and `DELETE /v1/accounts/{account}` stops it. Removing keeps its movements,
  expectations and cursor, and adding it again resumes from that cursor. An account from the
  service configuration cannot be removed over the API (`config_managed`), and one with open
  expectations needs `?force=true` (`has_open_expectations`). The `accounts` scope covers writes.
  The watch list and sync state are kept in the store, so they work across processes. **Run
  `nostro migrate` before upgrading.**
- **Breaking: API keys have scopes.** `apiKeys()` now returns a `Principal` (tenant, scopes and key
  id) where it returned a tenant id, and `Authenticate` follows. A route the key lacks the scope for
  answers `403 forbidden`, a new problem code. Keys written without scopes keep every scope, so
  existing deployments keep working, but `serve` warns about each one at startup. To narrow a key,
  write `tenant[read,events]:key` in `NOSTRO_API_KEYS` or `--keys-file`; brackets are only read
  before the first colon, so existing keys, including keys that contain colons, parse as they did.
  Tenant ids may not contain `[`, `]`, `:` or whitespace.
- Webhook delivery is observable and replayable. Every POST is recorded in a bounded, prunable
  attempt log, and consumers can be listed and inspected before their first delivery round.
- `GET /v1/webhooks`, `GET /v1/webhooks/{consumer}/status`,
  `GET /v1/webhooks/{consumer}/attempts` and `POST /v1/webhooks/{consumer}/replay` join the HTTP
  API; replay is a compare-and-set on the consumer's position and is recorded with its actor.
- The deliverer stops before a POST, as well as at its cursor compare, when a replay has moved the
  consumer underneath it.
- `nostro serve --config <file>` serves every tenant in a JSON file, each with its own accounts,
  network and webhook. Each tenant runs a sync loop and a delivery loop on their own timers
  (`--interval`, `--delivery-interval`), and a failing tenant backs off without holding up the
  others. `--concurrency` bounds the rounds that run at once; `--shutdown-timeout` bounds the wait
  on Ctrl-C. A webhook names the environment variable that holds its secret. The single-tenant flags
  keep working unchanged. Log lines carry `[tenant=<id>]`.

## 0.1.0 (2026-11-06)

The first usable release: ingest a Stellar account, reconcile it against what you are owed, keep a
double-entry journal, check the books against the chain, and serve all of it over HTTP with signed
webhooks.

### `@nostro-labs/nostro`

- **Money and assets.** Exact bigint amounts that are never floats and never rounded. Assets are
  identified as `CODE:ISSUER`, so a lookalike issuer is a different asset.
- **Model and stores.** Movements, expectations, allocations, exceptions, journal entries and
  events. A transactional `Store` contract, with `MemoryStore` and a conformance suite every store
  must pass.
- **Ingestion.** `HorizonEffectsSource` and `HorizonFeesSource` read every credit, debit, trade,
  pool movement, SAC transfer and fee (fees are not effects). `sync()` is bounded and resumable, and
  advances its cursor in the same transaction as the movements it covers
  ([ADR 0005](./docs/adr/0005-cursor-in-transaction.md),
  [ADR 0006](./docs/adr/0006-normalising-horizon-effects.md)).
- **Matching.** `reconcile()` matches by muxed id, id memo and text memo (normalised). An amount
  alone is only ever a suggestion. Overpayments, duplicates, wrong assets, late payments and
  ambiguous matches become exceptions with evidence ([docs/matching.md](./docs/matching.md)).
- **Deciding by hand.** `applyMovement()`, `ignoreMovement()` and `closeException()`, or
  `decideException()` by reference, answer an exception. The movement, its exceptions and the
  journal change together, and what an application leaves over stays open.
- **Journal.** Double-entry, posted in the same transaction as each decision. Cash is posted once,
  and later changes are adjustment entries. The chart of accounts is configurable, and the journal
  exports to CSV ([docs/journal.md](./docs/journal.md),
  [ADR 0007](./docs/adr/0007-journal-adjustments.md)).
- **Invariants.** `doctor()` checks I1 (total disposition) and I3 (balanced journal). With `attest`
  it also checks I2: recorded movements against on-chain balances, per asset, at the ledger each
  balance last changed in ([docs/invariants.md](./docs/invariants.md),
  [ADR 0008](./docs/adr/0008-balance-attestation-at-a-ledger.md)).
- **Events and webhooks.** Every store writes an event in the same transaction as each decision.
  `deliverWebhooks()` posts them in order, signed with HMAC-SHA256, and `verifyWebhook()` checks
  the signature, with replay protection ([docs/webhooks.md](./docs/webhooks.md)).
- **JSON.** A JSON form for every record: amounts as decimal strings, uint64s as strings.

### `@nostro-labs/store-sqlite`, `@nostro-labs/store-postgres`

- Both pass the shared conformance suite and keep amounts exact beyond 64 bits.
- Only `migrate()` changes the schema. `schemaVersion()` reports where a database is, without
  changing it.
- PostgreSQL also checks journal balance itself, at commit. Writers serialise per tenant, so events
  commit in order.

### `@nostro-labs/server`

- An HTTP API: movements, expectations (list and create), exceptions (list and resolve), the
  journal (JSON and CSV), and the event log.
- Each API key belongs to a tenant. Keys are stored as hashes and compared in constant time.
- RFC 9457 problem details, and paging by `seq`. Request bodies containing JSON numbers are
  refused, because a number may already have been rounded by the time it is parsed.
- An OpenAPI 3.1 document at `/v1/openapi.json`, tested against real responses.

### `@nostro-labs/cli`

- `nostro migrate`, `sync`, `expect`, `expectations`, `reconcile`, `exceptions`, `resolve`, `post`,
  `doctor`, `export` and `serve`. `serve` runs the API, syncs and reconciles on an interval, and delivers
  webhooks. Exit codes suit cron and CI.
- A container image (`Dockerfile`) and a Docker Compose example with PostgreSQL and a webhook
  receiver.

### Examples

- `examples/before-after` runs a careful hand-rolled watcher and nostro over the same payments and
  scores both.

### Not handled yet

- **Refunds** are not linked to the payment they refund. A person can ignore both, with reasons.
- **Money paid into another of your own wallets** cannot be applied to an invoice on the wallet it
  should have gone to: allocations stay on one account.
- **Matching:** truncated text memos, `MEMO_HASH` references, known-payer corroboration, amount
  fingerprints, claimable-balance lifecycles, several payments in one transaction, path-payment
  slippage, and one payment covering several invoices with no per-invoice reference.
- **Balance attestation** does not cover issuer accounts or liquidity pool shares, nor history
  that Horizon no longer keeps.
- **Sources:** Horizon only. There is no Stellar RPC source, and no SEP-41 contract tokens.
- **Accounting:** generic CSV export only, with no accounting periods.
