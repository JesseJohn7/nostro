# @nostro-labs/cli

The command line for [nostro](https://github.com/nostro-labs/nostro): ingest a Stellar account's
history from Horizon and reconcile it, from a shell or a cron job, against a SQLite file,
PostgreSQL or MySQL.

```sh
npm install -g @nostro-labs/cli
```

```sh
nostro migrate                                       # create ./nostro.db
nostro migrate --db mysql://localhost/nostro         # or a MySQL 8 database named in the URL
nostro sync --account G...                           # ingest every effect and fee Horizon keeps
nostro expect INV-1042 --account G... --amount 25    # record what you are owed
nostro reconcile                                     # decide every pending movement, and post it
nostro exceptions                                    # what needs a person, and why
nostro resolve <id> --apply INV-1042 --note "..."    # that payment was for this invoice
nostro doctor --attest --account G...                # check the books, and the balances on chain
nostro export --output journal.csv                   # the journal, a row per line
```

| Command | What it does |
|---|---|
| `migrate` | Creates the database, or applies the migrations it is missing. The only command that changes the schema; every other one refuses a database that is not exactly at the version it expects. |
| `sync` | Ingests effects and fees for each `--account`, until caught up (or one round with `--once`). |
| `expect` | Records an expectation: a reference, an account, an amount, and optionally a muxed id, a memo, payers, due and expiry dates. Never rounds an amount. |
| `expectations` | Lists expectations with what has been allocated to each. |
| `reconcile` | Matches pending movements against expectations and posts each decision to the journal. |
| `exceptions` | Lists what reconcile would not decide alone, with the reason (and, in `--json`, the evidence). |
| `resolve` | Answers an exception: `--apply <reference[=amount]>` (this payment was for that invoice), `--ignore` (not something to reconcile) or `--close`, with a required `--note`. Moves the movement, its exceptions and the journal together. |
| `post` | Posts to the journal any decision it does not reflect yet, such as one made outside `reconcile`. Idempotent. |
| `doctor` | Checks invariants I1 and I3 over every record, and with `--attest` I2: each account's recorded movements against its on-chain balance in every asset. Exits 1 if any does not hold. |
| `export` | Writes the journal as CSV (RFC 4180) or, with `movements`, `expectations`, `exceptions` or `allocations`, those records as CSV. Supports a date range; to stdout, or to `--output`, which it will not overwrite without `--force` and never leaves half-written. |
| `keys` | Creates (`keys create --tenant <id> --label <text> --scopes <list>`, printing the key once), lists (`keys list`, never keys) and revokes (`keys revoke <id>`) the API keys `serve` accepts from the store. A revoked key is refused on its next request, with no restart. |
| `serve` | Runs the HTTP API ([@nostro-labs/server](../server/README.md)). With `--account`s to watch, syncs and reconciles them every `--interval` seconds; with `--webhook-url`, delivers each decision there, signed ([docs/webhooks.md](../../docs/webhooks.md)). Stops cleanly on Ctrl-C or SIGTERM. |

### Record CSV exports

Bare `nostro export` still writes the journal. Pass a record type to export the underlying records:

```sh
nostro export movements --from 2026-10-01 --to 2026-11-01 --include-memo --output payments.csv
```

All record exports use RFC 4180 quoting (CRLF), guard text cells against spreadsheet formulas, write
to stdout unless `--output` is given, refuse to overwrite without `--force`, and leave no partial
file on failure. `--from`/`--to` filter in the stream on `occurred_at` for movements, `created_at`
for expectations and allocations, and `opened_at` for exceptions. Journal-only options (`--format`,
`--decimals`, the OFX and mapping flags, `--entity` and `--destination`) are refused for these
exports. Amounts are exact `Money.toString()` strings; `asset` applies to `amount`, `amount_paid`
and `amount_outstanding` on expectations.

| Export | Columns |
|---|---|
| `movements` | `id, seq, external_id, revision, network, source, account, entity_id, direction, kind, amount, asset, counterparty, muxed_id, memo_type, ledger, tx_hash, operation_id, occurred_at, disposition, ignored_reason, created_at`, plus `memo_value` with `--include-memo` |
| `expectations` | `id, seq, reference, account, direction, amount, asset, amount_paid, amount_outstanding, muxed_id, payers, due_at, expires_at, status, cancel_reason, fingerprint_suffix, metadata, created_at, updated_at` |
| `exceptions` | `id, seq, code, status, movement_id, expectation_id, account, amount, asset, detail, resolution_note, opened_at, resolved_at` |
| `allocations` | `id, movement_id, expectation_id, amount, asset, strategy, score, created_at` |

`payers` and `metadata` are JSON arrays/objects in one cell. Memo text is omitted by default;
`--include-memo` adds the formula-guarded `memo_value` column, with non-printing control characters
escaped. Movements, expectations and exceptions page by `afterSeq` in bounded reads. Allocations
have no `seq` or cursor in the store contract, so that export reads the tenant's allocations in one
list; it cannot be bounded by a resume point.

`serve` accepts keys from the store (`nostro keys create`), and also reads `tenant:key` pairs from
`NOSTRO_API_KEYS` (comma-separated) or
`--keys-file` (one per line), never from the command line, where `ps` would show them. To narrow a key,
write its scopes in brackets: `tenant[read,events]:key` (scopes: `read`, `events`, `webhooks`,
`expectations`, `exceptions`, `journal`, `accounts`). A key written without brackets keeps every scope, and `serve`
warns at startup about each such key by its number and tenant, never by its value. It listens on
127.0.0.1:8080 unless told otherwise (`--host`, `--port`, or `NOSTRO_HOST`, `NOSTRO_PORT`). With
`--config <file>` it serves several tenants, each with its own accounts, network and webhook; each
tenant syncs and delivers on its own timers, so one failing tenant does not hold up the others. Without
`--config`, the single-tenant flags describe one tenant (`--tenant`, default `default`). The API serves
every tenant that has a key.

Every command takes `--db` (a SQLite file, `sqlite:<path>`, a `postgres://` URL or a `mysql://` URL
with a database name; default `./nostro.db`) and `--tenant` (default `default`), and all but `export` take `--json`. `nostro <command> --help` lists the
rest. Options can also come from the environment:

| Variable | Option |
|---|---|
| `NOSTRO_DB` | `--db` |
| `NOSTRO_TENANT` | `--tenant` |
| `NOSTRO_ACCOUNTS` | `--account`, comma or space separated |
| `NOSTRO_NETWORK` | `--network` (`testnet`, the default, or `public`) |
| `NOSTRO_HORIZON_URL` | `--horizon` |
| `NOSTRO_PG_SCHEMA` | the PostgreSQL schema to use (default `nostro`) |
| `NOSTRO_API_KEYS` | `serve`: `tenant:key` pairs, comma separated |
| `NOSTRO_WEBHOOK_URL` | `serve`: `--webhook-url` |
| `NOSTRO_WEBHOOK_SECRET` | `serve`: the webhook signing secret; never a flag |
| `NOSTRO_PORT`, `NOSTRO_HOST` | `serve`: `--port`, `--host` |

Exit status is 0 on success, 1 when the command failed or found a problem, and 2 when the command
line was wrong. A password in a `postgres://` or `mysql://` URL is never printed. Text that came from a payment,
such as a memo, is printed with control characters escaped, so it cannot rewrite your terminal.

nostro never signs a transaction and never needs a secret key.

**Status:** 0.1.0, early: tested, and run against real testnet accounts, but the API may change before 1.0.

### Events

`nostro events` streams the tenant event log as JSON Lines, using a saved consumer cursor. It supports
`--after`, `--follow`, `--consumer`, `--type`, and `--exec` (child args after `--`). Filtered-out events
still advance the consumer position. With `--exec`, event JSON is sent on stdin and
`NOSTRO_EVENT_ID` / `NOSTRO_EVENT_TYPE` / `NOSTRO_EVENT_SEQ` are set in the environment; the cursor
advances only on exit status 0. Delivery is at-least-once; consumers should dedupe on event `id`.
The `webhook` consumer name is reserved for webhook delivery.
