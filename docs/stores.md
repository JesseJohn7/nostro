# The Store contract

`Store` is the boundary between nostro's logic and its databases. `MemoryStore`,
[`@nostro-labs/store-sqlite`](../packages/store-sqlite/README.md) and
[`@nostro-labs/store-postgres`](../packages/store-postgres/README.md) implement the same contract;
the engine never talks to a driver. This document says what that contract is, how the shared suites
check it, and how a new backend joins in.

## What a store must do

- **Writes exist only inside `store.transaction()`.** `StoreTx` is the write handle, and it stops
  working when the transaction settles (`TransactionClosedError`). A successful transaction commits
  its writes together; a thrown error commits nothing, including events and cursors.
- **Every record is scoped by `tenantId`.** Ids from one tenant are absent in another; the only
  exception is an API-key lookup by digest, which is global by design. Dedupe keys, references,
  muxed ids, cursors and posting numbers are unique within their tenant.
- **Facts are append-only.** A re-delivered movement is a duplicate (same facts) or a conflict
  (different facts); neither overwrites what was recorded. Journal entries append at the next posting
  number, and exception and amendment history is kept.
- **Amounts stay exact beyond 64 bits** as `Money` (bigint raw units + decimals). Assets compare on
  `CODE:ISSUER`; a lookalike asset is a different asset. Text from the chain is preserved byte for
  byte, including NUL and replacement characters; text written by a person is validated.
- **Constraints are the store's job.** Refusals have stable names (`ConstraintError.constraint`),
  plus `ValidationError`, `NotFoundError` and friends for other bad input. The same violation must
  have the same name on every store. For example: `allocation_over_movement`,
  `allocation_asset`, `journal_unbalanced`, `expectation_reference_unique`.
- **Returned records are frozen** so callers cannot mutate cached state.

## Locking reads

Two `StoreTx` reads are locking, not ordinary reads: `getCursor(key)` and `getMovement(tenantId, id)`.
Once a transaction has read one, no other transaction can change it until the first ends. Two ingest
workers therefore cannot both believe they own a cursor, and two reconcilers cannot both handle the
same movement: the second sees the first's committed write, or waits for it. The same applies to
expectations when allocating or amending, to a movement's journal posting number, and to the
tenant's close state via `lockJournalPeriod()`.

A SQL store must provide this with locks, not with its default isolation level:

- PostgreSQL uses `SELECT … FOR UPDATE` on the row (creating a cursor row first if it does not exist,
  so the lock has something to hold) and `pg_advisory_xact_lock` where there is no row to lock, such
  as the journal period and per-tenant event ordering. Its usual `READ COMMITTED` is enough once the
  read is locked; statements after a lock see what the lock waited for.
- SQLite takes `BEGIN IMMEDIATE` for every transaction, so all writes in one database file are
  serializable and a read-then-write is safe. One `SqliteStore` instance per file per process.
- `MemoryStore` holds the equivalent per-key gates in code.

Reads outside a transaction see committed data only (`MemoryStore` snapshots records; SQLite uses a
second read-only WAL connection). Writes made in a transaction are visible inside it and nowhere else
until it commits.

## Events are written in the same transaction

The store itself appends the outbox events: `movement.decided`, `expectation.partially_paid`,
`expectation.settled`, `expectation.amended`, `expectation.cancelled`, `exception.opened`,
`exception.resolved`, `exception.dismissed` and so on. There is no second "publish events" step that
can be forgotten. An event records the decision *as it was at that moment* — the previous
disposition, the allocation, the affected record — and gets a per-tenant increasing `seq`.

A decision that changes nothing writes no event; a transaction that rolls back writes none either.
A movement's events form an unbroken chain from `pending` to its current disposition. Consumer
positions are ordinary cursors (`eventCursorKey`), delivery attempts live in a separate prunable
table, and a rewind compares and sets the position in the same transaction as its audit record.
Pruning an old prefix records its high-water mark atomically and refuses a rewind into missing
history. See [webhooks.md](./webhooks.md) for delivery.

## Shared rules

None of these is optional, and each is checked from the stored records rather than from what a
function reported:

- **I1:** every movement is allocated in full, partially allocated with an open exception covering
  the residual, carries an exception, or is ignored with a reason. Nothing is silently dropped.
- **I2:** recorded movements agree with the chain's balance at the ledger it last changed. Checked by
  `doctor()` with `attest`; see [invariants.md](./invariants.md) and [ADR 0008](./adr/0008-balance-attestation-at-a-ledger.md).
- **I3:** every journal entry balances per asset, posting numbers are contiguous per movement, and a
  movement's cash leg equals its movement. See [journal.md](./journal.md).
- The ingest cursor advances in the same transaction as the movements it covers; this is
  effectively-once ingest ([ADR 0005](./adr/0005-cursor-in-transaction.md)).
- An amount alone never settles an invoice: a payment must quote it (muxed id, memo id or text memo),
  or a person must apply it. Fees and clawbacks are never matched automatically.
- Re-running `reconcile()`, `postJournal()` or a whole payment replay changes nothing.

## Migrations

Each store owns its schema. `migrate()` creates or upgrades it and is idempotent; it can be run by
several processes at once (PostgreSQL serialises on an advisory lock). `schemaVersion()` reports the
highest migration applied and the version `migrate()` would bring it to. The CLI exposes the same
operation as `nostro migrate --db <file>` or against PostgreSQL. Call `migrate()` before the first
transaction; a store does not silently migrate on open.

The schema version is local to each backend and can differ between them; it is not the Store
contract version below. Migrations are additive when possible, and a destructive change needs a
documented upgrade path. The suites call `migrate()` in their store factory, but do not verify the
contents of a migration file.

## What the suites prove, and what they cannot

[`@nostro-labs/store-conformance`](../packages/store-conformance/README.md) publishes four suites.
`describeStoreConformance()` registers the movement, allocation, disposition, exception, event,
entity, API-key, cursor, refund and journal suites; `describeJournalConformance()` and
`describeRefundConformance()` can be run alone against a partial implementation.
`describeStoreProperties()` generates random payment histories with `fast-check`, checks every
record after each one, and can compare a store's decisions with `MemoryStore` (`differential: true`).
Run them in the backend's own test suite:

```ts
import { STORE_CONTRACT_VERSION, describeStoreConformance, describeStoreProperties } from '@nostro-labs/store-conformance'

describeStoreConformance('SqliteStore', () => freshStore(), { contractVersion: STORE_CONTRACT_VERSION })
describeStoreProperties('SqliteStore', (now) => freshStore({ now }), {
  contractVersion: STORE_CONTRACT_VERSION,
  runs: 15,
  differential: true,
})
```

They prove that the observable rules hold on a fresh store: constraint names, atomic commits,
locking reads under concurrency, idempotent re-delivery, balanced books, event chains, and identical
decisions to the in-memory reference. They also prove that the published tarballs work together:
`node scripts/check-packages.mjs` installs the packed packages into an empty app and runs the suites
against the installed `MemoryStore`.

They do **not** prove durability after power loss or a replica failover, throughput under production
load, the correctness of a particular SQL migration, protection against direct writes that bypass
nostro, every possible isolation anomaly, or agreement with Horizon ([invariants.md](./invariants.md)
covers that with real fixtures and `doctor --attest`). Property tests sample histories; they are
evidence, not a proof over all inputs. Run them with `NOSTRO_PROPERTY_RUNS` before a release to
search harder.

## Contract version policy

`STORE_CONTRACT_VERSION` is exported by `@nostro-labs/nostro` and follows semantic versioning:

- **Major** — an observable behaviour changes incompatibly (a different constraint name, a changed
  event payload, a changed locking guarantee). Every store must be updated, and the major version in
  the suite and the stores must move together.
- **Minor** — a new operation or guarantee is added; existing stores keep passing, but the suite
  gains tests.
- **Patch** — a clarification or a test fix with no behaviour change.

Every describe suite requires `options.contractVersion`, normally `STORE_CONTRACT_VERSION` from core.
`assertContractVersion()` runs before any test is registered and refuses a different major version,
so a store cannot appear green against the wrong contract. `supportsContract()` is the non-throwing
form. A new backend passes all four suites with the current version before it is published;
store-mysql will be added when it is ready.
