# Nostro design comments for maintainer review

## Issue #70 — rounding for CSV export

I propose a pure `packages/core/src/journal/` transformer that processes journal entries in `seq` order, independently per full asset ID and account. It uses bigint arithmetic only. For each account/asset it keeps the exact cumulative signed balance and the cumulative exported balance at the requested precision. For each entry it allocates the available target minor units among its lines by largest remainder, with deterministic ties by line number, then carries sub-unit differences into later entries. If the account-balance bounds and per-entry balance cannot both be met by line allocation, a visible line in a named rounding account closes the entry; the helper reports its cumulative balance. I will define a deterministic debit/credit convention for that line and test the per-prefix account bound (at most one target minor unit) and per-asset entry balance.

`--decimals <n>` will be explicit, restricted to CSV and to 0 through the asset's source precision; there is no target-system default. Without the flag, the current CSV path remains byte-for-byte unchanged. For `--from`, the helper will scan entries from the start (or a future persisted checkpoint) to compute the carry, then emit only entries in range. This is slower for late ranges but reproducible and correct. Tests will cover tiny fees, a three-way split, amounts over 2^64, deterministic re-export, and the unchanged default path. I will document the rounding account in `docs/journal.md`.

Does this carry/post rule and the full-history scan for partial exports match what you want?

## Issue #71 — PostgreSQL writer deadlocks

I propose transaction-level retry for PostgreSQL SQLSTATE `40P01` only, with a small bounded exponential backoff and fresh connection/transaction for each attempt. The callback passed to `Store.transaction()` will run again after a deadlock, so I will update its doc comment to require replay-safe callbacks with no irreversible external effects. This works for transactions touching more than one tenant without requiring an upfront tenant list or changing the API. It leaves existing per-tenant event ordering intact. After the retry limit, the original typed database error is returned rather than hiding persistent contention.

I will add controlled-interleaving tests for both `applyMovement()` and multi-conflict `sync()` against PostgreSQL, plus a case where the callback is retried and a case where repeated deadlocks exhaust retries. A small concurrent-writer benchmark will record latency/throughput before and after; the expected normal-path cost is the retry wrapper only, while contended transactions pay for re-execution. The store README will explain ordering, retries, and callback replay. If you prefer strict prevention rather than retrying, an upfront transaction tenant scope would need an API change; please confirm which direction you prefer.

## Issue #72 — extensible closed value sets

I propose lookup tables with foreign keys for exception codes, journal line roles, journal entry kinds, and event types. The core arrays remain the source of truth; an append-only migration adds rows for new values in both stores. Existing shipped migration text stays frozen, and a conformance assertion compares the latest database lookup rows with the core arrays. A test-only migration inserts one new value into each lookup table on populated databases, then checks writes and `doctor()`.

The one-time SQLite conversion will use the documented 12-step rebuild, temporarily disabling foreign-key enforcement outside the transaction, preserving indexes and append-only triggers, copying rows, running `foreign_key_check`, then restoring enforcement. SQLite documents that `DROP TABLE` removes triggers before its implicit delete, so `BEFORE DELETE` triggers do not fire, although foreign-key actions can; the rebuild must still disable/check FKs. For PostgreSQL, I will query `pg_constraint` for each target table/column rather than assume generated names: the initial column CHECKs have generated names such as `journal_lines_role_check`, and the current later migration explicitly names `exceptions_code_check` and `events_type_check`. The migration will remove only the matching value-list CHECKs before adding FKs, and tests will verify the discovered constraints on a fresh and an upgraded database.

Is the lookup-table design acceptable for the one-time rebuild cost?

## Issue #73 — migration integrity and real 0.1.0 upgrades

I propose SHA-256 checksums of each migration's exact SQL. For PostgreSQL, render the migration function with one fixed valid quoted schema placeholder before hashing, so hashes do not depend on a user's schema name. Store per-version checksums beside PostgreSQL migration rows and in a new SQLite migration-history table, while retaining `PRAGMA user_version`. Both `schemaVersion()` and `migrate()` will reject a newer database and any recorded checksum mismatch with typed errors. Future migrations may append only; historical SQL text and its hash manifest remain frozen, including the value-set migration in #72.

For databases made by 0.1.0 before checksums existed, the first migration will recognise the legacy version range, validate the known schema shape and run integrity checks before recording the published 0.1.0 manifest hashes. `schemaVersion()` will report the legacy state without writing. Unknown or partially populated histories will fail closed. I will commit a SQLite 0.1.0 fixture and a portable PostgreSQL SQL dump, both generated by a documented script from the `v0.1.0` tag with a reconciled history; tests will upgrade them and run `doctor()`.

For file-backed SQLite, backup will be on by default before pending migrations, to a unique sibling file with a timestamp and source version using `better-sqlite3`'s online `backup()` API. Backup failure aborts migration. The CLI will report the backup path or why none was needed (already current or new database), in text and JSON; the library will return that metadata. I do not propose opt-out for this first implementation. Both store READMEs will explain checks, legacy adoption, and backup handling.

Does this legacy adoption rule, fixture format, and default backup location work for you?
