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
| `config` | Prints every resolved setting and its source (flag, environment, profile or default), in text or `--json`. |
| `migrate` | Creates the database, or applies the migrations it is missing. The only command that changes the schema; every other one refuses a database that is not exactly at the version it expects. |
| `sync` | Ingests effects and fees for each `--account`, until caught up (or one round with `--once`). |
| `expect` | Records an expectation: a reference, an account, an amount, and optionally a muxed id, a memo, payers, due and expiry dates. Never rounds an amount. |
| `import` | Records many expectations from a CSV or JSON Lines file, all or nothing, with `--dry-run` to check first. Re-running is safe. See [Importing expectations](#importing-expectations). |
| `expectations` | Lists expectations with what has been allocated to each. |
| `reconcile` | Matches pending movements against expectations and posts each decision to the journal. |
| `exceptions` | Lists what reconcile would not decide alone, with the reason (and, in `--json`, the evidence). |
| `review` | Walks through open exceptions one at a time in a terminal: shows the payment and the candidate invoices, then applies, ignores, closes or skips each, with a note. Needs a terminal; scripts use `resolve`. |
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

## Named profiles

For people who switch between a local testnet database and a pubnet database (or two tenants),
put the settings in a JSON file instead of retyping flags or exporting `NOSTRO_*` on every command:

```json
{
  "version": 1,
  "defaultProfile": "testnet",
  "profiles": {
    "testnet": {
      "db": "testnet.db",
      "tenant": "acme",
      "network": "testnet",
      "accounts": ["G..."],
      "port": 8080,
      "host": "127.0.0.1",
      "interval": 30
    },
    "pubnet": {
      "db": "postgres://db.example/pubnet",
      "tenant": "acme",
      "network": "public",
      "accounts": ["G..."],
      "schema": "nostro"
    }
  }
}
```

Select a profile with `--profile pubnet` or `NOSTRO_PROFILE=pubnet`; point at a file with `--config
<file>` or `NOSTRO_CONFIG=<file>`. Without either, `./nostro.json` is used, then
`$XDG_CONFIG_HOME/nostro/nostro.json` (or `~/.config/nostro/nostro.json`); the first file found wins
and files are never merged. A profile sets `db`, `tenant`, `network`, `horizon`, `accounts`, the
PostgreSQL `schema`, and `serve`'s `port`, `host` and `interval`. Precedence is **flag > selected
profile > environment > default**, so a leftover environment variable cannot redirect a profile you
chose on purpose. With no config file, behaviour is exactly as before.

`nostro config` prints every resolved value and where it came from (`flag`, `environment`, `profile`
or `default`), in text or `--json`:

```sh
nostro config --profile pubnet
nostro config --profile pubnet --json
```

URLs are redacted and API keys are never printed. The file is parsed strictly: an unknown key, a
wrong type or a missing profile is an error. Secrets are refused in the file — put a database
password in `NOSTRO_DB` (or the driver's password file), never in the JSON; API keys and webhook
secrets stay in the environment. A `settings` object inside a profile is reserved for future
settings and cannot hold secrets.

## Remote mode

If `nostro serve` is running, a person triaging exceptions does not need database credentials:
they have an API key scoped to one tenant. Select remote mode with `--api <url>` or
`NOSTRO_API_URL`, and supply the key **only** through `NOSTRO_API_KEY` (never a flag):

```sh
export NOSTRO_API_KEY=nstk_...
nostro exceptions --api http://localhost:8080
nostro expectations --api http://localhost:8080 --json
nostro export --api http://localhost:8080 --output journal.csv
```

`expectations`, `expect`, `exceptions`, `resolve` and `export` work against the API; their text and
`--json` output is identical to local mode. Lists follow the API's `next` cursor. `http://` is
allowed only for localhost (or `*.localhost`); use `https://` elsewhere, and do not put credentials
in the URL. `migrate`, `sync`, `reconcile`, `post`, `doctor`, `serve` and the other local commands
refuse in remote mode with a message that says they need the database. RFC 9457 problem codes appear
in error messages (`nostro: resolution_refused: ...`); malformed requests exit 2, other API failures
exit 1. The key and any URL credentials never appear in output, including with `NOSTRO_DEBUG`.
Remote `export` supports `--format csv` only; date range and `--entity` are sent to the API, while
`--decimals`, `--destination` and the other formats need a local database.

Exit status is 0 on success, 1 when the command failed or found a problem, and 2 when the command
line was wrong. A password in a `postgres://` or `mysql://` URL is never printed. Text that came from a payment,
such as a memo, is printed with control characters escaped, so it cannot rewrite your terminal.

nostro never signs a transaction and never needs a secret key.

**Status:** 0.1.0, early: tested, and run against real testnet accounts, but the API may change before 1.0.

## JSON output

With `--json`, a command prints JSON on stdout and nothing else. A failure prints one JSON object on
stderr instead of text:

```json
{"error":{"code":"schema_mismatch","message":"..."}}
```

Codes: `usage` (exit 2), `no_database`, `schema_mismatch`, `horizon`, `failed` and `internal` (exit 1).
Scripts should branch on `code`, not on `message`, which is for people and may change.

Lists take `--after <seq>`, which returns only records after that `seq`. To page through a list, pass
the `seq` of the last record you received; a page shorter than `--limit` is the last one. `exceptions`
and `expectations` also take `--jsonl`, one JSON record per line, for streaming. `--json` and `--jsonl`
cannot be combined.

The shapes are described in `schemas/output.schema.json` (JSON Schema 2020-12, shipped in the package).

What counts as a breaking change: removing or renaming a field, changing an existing field's type, or
renaming an error code. Adding a field or an error code is not breaking. Breaking changes are listed in
CHANGELOG.md.

## Importing expectations

`nostro import <file|->` records many expectations at once, from a CSV file with a header row or from
JSON Lines. Every row goes through the same validation as `nostro expect`.

CSV, with columns `reference`, `account`, `amount`, `asset`, `direction` (`credit` or `debit`),
`muxed_id`, `memo_text`, `memo_id`, `memo_hash`, `payers` (accounts separated by `|`), `due`, `expires`,
and `meta.<key>` for each metadata key:

```csv
reference,account,amount,memo_text,payers,meta.note
INV-1042,GABC...,25,INV-1042,GDEF...|GHIJ...,"paid in two parts, ask finance"
INV-1043,GABC...,10,,,
```

JSON Lines, one object per line with the same names:

```json
{"reference":"INV-1042","account":"GABC...","amount":"25","memo_text":"INV-1042"}
```

Re-running a file is safe. A row whose reference is already recorded with the same fields is skipped. A
row whose reference is recorded with different fields is a conflict: it is reported with its line number,
and the recorded expectation is never changed. If any row is refused, nothing is written. Use
`--dry-run` to check a file first, and `--json` for a full report.

Exit status is 0 when everything was recorded or skipped, 1 when a row was refused or conflicts, and 2 for
a bad command line or a header the importer does not know.

### Events

`nostro events` streams the tenant event log as JSON Lines, using a saved consumer cursor. It supports
`--after`, `--follow`, `--consumer`, `--type`, and `--exec` (child args after `--`). Filtered-out events
still advance the consumer position. With `--exec`, event JSON is sent on stdin and
`NOSTRO_EVENT_ID` / `NOSTRO_EVENT_TYPE` / `NOSTRO_EVENT_SEQ` are set in the environment; the cursor
advances only on exit status 0. Delivery is at-least-once; consumers should dedupe on event `id`.
The `webhook` consumer name is reserved for webhook delivery.
