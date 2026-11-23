# The journal

nostro turns every decided movement into double-entry journal entries. `reconcile()` posts them in the
same transaction as each decision; `postJournal()` sweeps anything decided another way (by hand,
or before the journal existed). Running either again posts nothing new.

## Accounts

Every line has a role. The chart of accounts maps roles to account codes; pass your own to
`reconcile({ chart })` or `postJournal({ chart })`.

| Role | Default account | Posted when |
|---|---|---|
| `cash` | `assets:stellar:<network>:<G...>` | every movement on a wallet, for its full amount |
| `issued` | `liabilities:issued` | instead of cash, when the watched account issues the asset |
| `receivable` | `assets:receivable` | an incoming payment is applied to an expectation |
| `payable` | `liabilities:payable` | an outgoing payment is applied to a payout |
| `customer_credit` | `liabilities:customer-credit` | overpaid, or paid twice: owed back to a known payer |
| `unapplied` | `liabilities:unapplied-receipts` | money in that nobody has explained yet |
| `unexplained` | `assets:suspense` | money out that nobody has explained yet |
| `network_fees` | `expenses:network-fees` | transaction fees |
| `uncategorized_income` | `income:uncategorized` | an incoming movement deliberately ignored |
| `uncategorized_expense` | `expenses:uncategorized` | an outgoing movement deliberately ignored |
| `deposit_clearing` | `liabilities:deposits-received` | a mint, against issued supply or wallet cash |
| `redemption_payable` | `liabilities:redemptions-payable` | a burn, against issued supply or wallet cash |
| `clawback` | `equity:clawback` | a clawback, against issued supply or wallet cash |
| `due_to` | `liabilities:due-to` | an intercompany receipt |
| `due_from` | `assets:due-from` | an intercompany payment |
| `in_transit` | `assets:in-transit` | an internal transfer within one entity |
| `opening_balance` | `equity:opening-balances` | an account's opening balance |

Unexplained money out is a suspense *asset*, not a liability: it was usually exchanged for something
(a DEX trade, a bill booked elsewhere), and sharing an account with unexplained receipts would let
unrelated flows cancel out.

**`receivable` runs a credit balance inside nostro.** nostro does not book your invoices; your
accounting system does. nostro's receivable lines are the payment side of that receivable, linked to
each invoice by its expectation, so an exporter can match them up. The same goes for `payable`.

## Entities and internal transfers

One tenant can hold several legal entities. `nostro entity create --id <id> --name <name>` creates an
entity; `nostro entity assign --account <G...> --entity-id <id>` says which entity owns a watched
account, and `nostro entity list` / `nostro entity accounts` show the ownership map. Assigning an
account again changes future stamps only: a movement inherits the entity of its account at ingest,
and its journal lines keep that entity forever, so books do not rewrite themselves.

Every journal query and report option accepts `entityId`; the CLI exposes it as `--entity`, and HTTP
exposes it as `?entityId=`. The `entity` column in the CSV identifies the owning entity, or is empty
for pre-entity history and manual entries.

A transfer is internal when two movements in the same tenant and network have the same `txHash`,
opposite directions, equal amounts and assets, and each account is the other's `counterparty`. Only
`transfer` movements qualify. If both legs are present, both are reclassed in one transaction; if one
arrives first, the partner's arrival reclasses both, dismissing any exception opened meanwhile. A leg
already applied to an expectation stays on the normal matching path: applying a receipt on one
wallet to an invoice on another remains out of scope, and `checkAllocation()` still refuses it with
`allocation_account`.

Between different entities, the payer posts Dr `due_from` · Cr cash and the recipient posts Dr cash
· Cr `due_to`. Within one entity, the payer posts Dr `in_transit` · Cr cash and the recipient posts
Dr cash · Cr `in_transit`; the clearing account nets to zero. Both legs are `ignored` with reason
`internal transfer between watched accounts`, and `doctor` replays the same entity and transfer
context so it does not report a stale journal.

## Examples

| What happened | Entry |
|---|---|
| 25 USDC paid INV-2 in full | Dr cash 25 · Cr receivable 25 (INV-2) |
| 10 USDC paid from Alpha to Beta | Dr due from 10 · Cr cash 10; Dr cash 10 · Cr due to 10 |
| 10 USDC moved between two Alpha wallets | Dr in transit 10 · Cr cash 10; Dr cash 10 · Cr in transit 10 |
| 30 USDC paid INV-2 (25 owed) | Dr cash 30 · Cr receivable 25 (INV-2) · Cr customer credit 5 |
| 7 USDC arrived with no memo | Dr cash 7 · Cr unapplied 7 |
| 0.00001 XLM network fee | Dr network fees · Cr cash |
| Later, a person applies the 7 USDC to INV-3 | **reclass:** Dr unapplied 7 · Cr receivable 7 (INV-3) |
| Issuer mints 100 USDC to a customer | issuer: Dr deposits received 100 · Cr issued 100; customer: Dr cash 100 · Cr deposits received 100 |
| A customer redeems 100 USDC to the issuer | customer: Dr redemptions payable 100 · Cr cash 100; issuer: Dr issued 100 · Cr redemptions payable 100 |
| Issuer claws back 100 USDC from a holder | holder: Dr clawback 100 · Cr cash 100; issuer: Dr issued 100 · Cr clawback 100 |

Mints and burns stay matchable, so an anchor can still apply a fiat deposit expectation to a mint.
Clawbacks are ignored by matching and posted to their own account. Entries posted before these roles
existed are reclassed by the next `postJournal()` sweep; cash and issued supply are never touched by
that reclass.

## Opening an existing account

An account with history before nostro was installed starts from a snapshot, not from invented
movements:

```sh
nostro open --account G... --network public --note 'Books opened at ledger 123'
```

The command reads every Horizon balance line, requires native XLM to be present, and refuses an
account holding liquidity pool shares rather than dropping them. It stores the opening balances,
posts one `opening` entry (Dr cash, Cr `equity:opening-balances` for each asset), and seeds both
Horizon cursors after the snapshot ledger. The next `nostro sync` therefore sees only later ledger
activity. An account that already has movements, or a second opening for the same account, is
refused. From code, the same operation is `openAccount({ store, tenantId, network, account, ledger,
balances, note })`.

`doctor --attest` starts I2 from the opening balances and ignores movements through the opening
ledger, so an old account attests without replaying its pre-history.

## Entries are adjusted, never edited

Cash is posted once. When a decision changes later, nostro posts only the difference between how the
movement should now be accounted for and how it already is ([ADR 0007](./adr/0007-journal-adjustments.md)):

- **initial** — dated when the money moved;
- **reclass** — cash untouched; dated when posted, because applying cash happens when it is applied;
- **correction** — changes the cash leg (a source correction); dated like the original.

An accounting-period close is a per-tenant inclusive effective-date cutoff. Explicit entries into a
closed period are refused. If an automatic initial entry or correction would be backdated into a
closed period, nostro posts it at the first open millisecond and records the original effective date
in the entry description; the linked movement/original entry retains the source context. Reopening
requires a reason.

## Guarantees, and who enforces them

| Guarantee | Every store (shared rule, before writing) | PostgreSQL itself | SQLite itself |
|---|---|---|---|
| Each entry balances per asset (I3) | yes | yes, at COMMIT (deferred trigger) | yes, at entry completion (triggers) |
| Entries are never edited or deleted | yes | yes (triggers) | yes (triggers) |
| One entry per posting number per movement | yes (compare-and-set) | yes (unique index) | yes (unique index) |
| A movement's cash nets to 0 or its exact amount | yes | yes, at COMMIT | yes, at entry completion |

SQLite stores amounts as decimal text beyond 64 bits, so its triggers call the registered bigint
aggregates `nostro_signed_sum` and `nostro_cash_sum`. An entry is complete only when its
`journal_entries` row is inserted: lines go in first against a deferrable foreign key, and the AFTER
INSERT trigger then checks the whole entry. A raw writer must use the same order and call
`registerJournalFunctions()` on its own connection; without them the triggers fail closed.
PostgreSQL runs the equivalent cash check with `numeric(40, 0)` at COMMIT, so a deferred trigger sees
the movement's final cash across all its entries.

## Export

```ts
import { journalCsv, journalCsvRows, journalBeancountRows } from '@nostro-labs/nostro'

const october = await journalCsv({ store, tenantId: 'acme', from: new Date('2026-10-01'), to: new Date('2026-11-01') })
for await (const row of journalCsvRows({ store, tenantId: 'acme' })) process.stdout.write(row) // streams
for await (const line of journalBeancountRows({ store, tenantId: 'acme', commodityMap })) process.stdout.write(line)
```

One row per journal line, RFC 4180 with CRLF line endings. Columns: `entry_id`, `seq`, `kind`,
`posted_at`, `effective_at`, `description`, `line_no`, `account`, `entity`, `role`, `asset`, `debit`, `credit`,
`movement_id`, `tx_hash`, `expectation_reference`, `exception_id`, `exception_code`, `value`.

- Amounts are exact decimal strings, never floats, even beyond 64 bits.
- `from` / `to` select by effective date: `from` inclusive, `to` exclusive.
- Text that a spreadsheet would run as a formula (starting with `=`, `+`, `-`, `@` or a tab) is
  prefixed with `'`. References and account codes come from users, and these files get opened in
  spreadsheets. Payment memo text, which the payer controls, is never written.

`nostro export --format ofx --account assets:stellar:public:G... --asset USDC:GA5Z... --currency USD
--from 2026-10-01 --to 2026-11-01` writes an OFX 2.2 bank statement for one wallet and asset. It
contains only cash lines on that account, with credits positive and debits negative. `FITID` is a
stable SHA-256 of tenant, account, asset, entry and line number, so importing the same range twice
does not duplicate rows. `CURDEF` must be an ISO 4217 code; pass `--currency` unless the asset code
itself is one. The same statement is available from code as `walletStatement()` and `renderOfx()`.

`nostro export --format quickbooks --account-map accounts.json` writes the QuickBooks Online
journal-entry columns `Journal No.`, `Journal Date`, `Account Name`, `Debits`, `Credits` and
`Description`. Each entry has one journal number, and every account code must be mapped to an
existing QuickBooks account name. Since nostro has no price feed, the export refuses more than one
asset; use an organisation whose home currency treats the exported asset 1:1.

`nostro export --format xero --account-map accounts.json` writes manual-journal rows grouped by a
unique `Narration` and `Date`, with `AccountCode`, `Description`, `TaxRate`, `Debit` and `Credit`.
It refuses unmapped accounts, mixed assets and files over 300 lines. The account map targets
existing Xero account codes. `--tax-rate` selects a tax-rate name already configured in Xero
(default `No Tax`); nostro does not infer tax treatment. Export one asset at a time to an
organisation whose base currency treats it 1:1.

`nostro export --format beancount --commodity-map assets.json` writes Beancount ledger text.
Account codes are converted to Beancount capitalization only when every component is valid;
unconvertible custom codes are errors. The commodity map must use each full asset id, including
issuer, as its key, and must map distinct assets to distinct uppercase commodity names. The output
includes one `open` directive per used account and keeps exact amounts and movement, transaction
hash and expectation references as metadata.

For QuickBooks and Xero, `--account-map` names a JSON object mapping nostro account codes to the
external account names or codes. For example:

```json
{
  "assets:stellar:testnet:G...": "Checking",
  "liabilities:unapplied-receipts": "Unapplied Receipts"
}
```

For Beancount, `--commodity-map` is a JSON object keyed by the exact asset id (for example
`USDC:GA5Z...`) and valued by a unique uppercase commodity such as `USDCISSUERA`.

## Accounting periods

```sh
nostro period close --through 2026-10-31 --note "October reported"
nostro period reopen --reason "Correcting a source statement"
```

A date-only close cutoff covers that entire UTC day; an instant cutoff is inclusive. Closes and
reopens are tenant-scoped and recorded in an append-only audit table. Stores reject entries with an
effective date on or before the active cutoff using `journal_period_closed`. A later close or reopen
is serialized with posting, so a concurrent entry cannot slip into the closed range.

## Checked against the network

`node scripts/check-balances.mjs --journal <G…>` ingests an account's whole history, reconciles it
(posting the journal), and checks per asset that the journal's cash for the account equals the
Horizon balance, that debits equal credits, and that running everything again posts nothing.

## Not handled yet

(Nothing outstanding — posting rules, account migration, trial balance/ledger reports, and balance-sheet/income-statement reports are all implemented.)

## Posting rules

Ordered posting rules let you map a line to an account based on facts known at posting time, without
changing the chart for all roles. The chart remains the fallback; the first matching rule wins.

```ts
import { reconcile } from '@nostro-labs/nostro'
import type { PostingRule } from '@nostro-labs/nostro'

const rules: PostingRule[] = [
  // USDC receipts go to a dedicated USDC receivable account
  { role: 'receivable', asset: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', account_code: 'assets:receivable-usdc' },
  // Payments from a known processor go to a clearing account
  { role: 'unapplied', counterparty: 'GCLEAR...', account_code: 'liabilities:clearing' },
  // Expectations with metadata department=support go to a dedicated account
  { role: 'receivable', metadataKey: 'department', metadataValue: 'support', account_code: 'assets:receivable-support' },
]

await reconcile({ store, tenantId: 'acme', rules })
```

A rule can match on:

| Field | Matches |
|---|---|
| `role` | Line role (e.g. `receivable`) |
| `asset` | Full asset id (e.g. `USDC:GA5Z...`) |
| `account` | The watched Stellar account |
| `counterparty` | The other side of the payment |
| `direction` | `credit` or `debit` |
| `kind` | Movement kind (`transfer`, `fee`, …) |
| `expectationRefPrefix` | The expectation's reference starts with this string |
| `metadataKey` + `metadataValue` | The expectation has this metadata entry |

All specified fields must match (AND semantics). An empty rule matches everything and returns
`account_code` for every line — useful as an explicit fallback.

**Rules never move an existing balance.** `planPosting()` keeps every (role, asset, expectation) slot in
the account it was first posted to. Adding or changing a rule after lines were posted does not re-post
anything.

## Moving account balances

When you rename an account code, existing balances stay in the old code until old movements are resolved
one by one. `moveAccount()` migrates the balance in one auditable step:

```ts
import { moveAccount } from '@nostro-labs/nostro'

const result = await moveAccount({
  store,
  tenantId: 'acme',
  from: 'assets:suspense',
  to: 'assets:suspense-stellar',
  note: 'Rename: suspense → suspense-stellar',
})
console.log(result.moved, 'entries posted for', result.assets)
```

After the move:

- `from` has a zero balance in every asset.
- Subsequent adjustments for old movements clear from `to`.
- Cash accounts (`assets:stellar:*`) are refused: the cash leg is tied to the chain.

From the command line: `nostro chart move --from assets:suspense --to assets:suspense-stellar`.

The move is dated at the current time (like a reclass), so it never back-dates into a closed period.

## Reports

### Trial balance

```ts
import { trialBalance } from '@nostro-labs/nostro'

const report = await trialBalance({ store, tenantId: 'acme', asOf: new Date('2026-10-31T23:59:59Z') })
console.log(report.balanced) // true when every asset balances
for (const line of report.lines) {
  console.log(line.account, line.asset, line.netBalance)
}
```

Returns per-account, per-asset totals and net balances. `balanced` is `true` when the sum of all net
balances is zero for every asset (I3).

Amounts are computed with exact bigint arithmetic across all stores — including SQLite, where `SUM`
cannot add amounts beyond 64 bits exactly, so the store and its triggers use registered aggregates.

### Account ledger

```ts
import { accountLedger } from '@nostro-labs/nostro'

const ledger = await accountLedger({
  store,
  tenantId: 'acme',
  account: 'assets:receivable',
  asset: 'native',
  from: new Date('2026-10-01'),
  to: new Date('2026-11-01'),
})
console.log(ledger.openingBalance) // bigint, debit-positive
for (const line of ledger.lines) {
  console.log(line.effectiveAt, line.side, line.amount.toString(), '→', line.runningBalance)
}
```

Returns an opening balance before `from`, each line in the range with its entry and running balance,
and a closing balance.

**CLI:** `nostro report trial-balance`, `nostro report ledger --account assets:receivable --asset native`.
**HTTP:** `GET /v1/reports/trial-balance`, `GET /v1/reports/ledger?account=...&asset=...`.

## Account kinds and financial statements

Every account code belongs to one of five kinds: `asset`, `liability`, `equity`, `income`, `expense`.
Codes with a standard prefix (`assets:`, `liabilities:`, `equity:`, `income:`, `expenses:`) inherit their
kind automatically. Custom codes need an explicit entry in an `AccountKindMap`:

```ts
import { resolveKind } from '@nostro-labs/nostro'
import type { AccountKindMap } from '@nostro-labs/nostro'

const kindMap: AccountKindMap = { '1200-receivable': 'asset', '4000-income': 'income' }
resolveKind('1200-receivable', kindMap) // → 'asset'
```

A code with no recognisable prefix and no entry in the map throws a clear error.

### Balance sheet

```ts
import { balanceSheet } from '@nostro-labs/nostro'

const bs = await balanceSheet({ store, tenantId: 'acme', asOf: new Date('2026-10-31T23:59:59Z') })
for (const section of bs.sections) {
  console.log(section.kind, section.accounts)
}
console.log('Current earnings:', bs.currentEarnings)
console.log('Balanced:', bs.balanced)
```

Groups accounts by kind (asset, liability, equity) and adds a `currentEarnings` computed line
(income − expenses per asset). The sheet balances when assets = liabilities + equity + currentEarnings
for every asset. nostro has no exchange rates, so there is one column per asset — no cross-asset totals.

**`receivable` and `payable` caveat.** nostro books the payment side of your receivables.
`receivable` normally runs a credit balance inside nostro. The balance sheet shows this correctly, but
it looks "negative" if you expect debit-normal receivables. See the Accounts table above for the
explanation. A separate "Payments applied" section with a note would avoid confusion; this can be
added as a view over the data.

**Current earnings** is a computed line; nostro does not close income/expense to equity (closing entries
are planned for a future issue, after period management).

### Income statement

```ts
import { incomeStatement } from '@nostro-labs/nostro'

const stmt = await incomeStatement({
  store,
  tenantId: 'acme',
  from: new Date('2026-10-01'),
  to: new Date('2026-11-01'),
})
for (const line of stmt.lines) {
  console.log(line.account, line.kind, line.asset, line.amount)
}
console.log('Net result:', stmt.netResult)
```

Lists income and expense accounts for the period and computes a net result per asset.

**CLI:** `nostro report balance-sheet`, `nostro report income [--from ...] [--to ...]`.
**HTTP:** `GET /v1/reports/balance-sheet`, `GET /v1/reports/income`.

## Manual journal entries

Some journal entries have no on-chain movement behind them: writing off unrecoverable suspense, reclassifying rent or expenses, or correcting balances.

`postManualEntry({ store, tenantId, description, reason, lines, note?, postedBy?, effectiveAt? })` creates an entry with `kind: 'manual'`.
Reversing a manual entry is performed via `reverseManualEntry({ store, tenantId, entryId, reason, postedBy? })`, which posts equal and opposite lines.

**Rules:**
- Manual entries **cannot** touch `cash` or `issued` roles. Cash lines only change when money moves on the chain.
- Entries must balance per asset (I3).
- A non-empty `reason` is required.
- Manual entries cannot name a movement or use `unapplied`, `customer_credit`, or `unexplained`. Use the `other` role for independent adjustments. Use `applyMovement` or `ignoreMovement` for movement balances; they serialize with reconciliation.

**CLI:** `nostro journal post --description "..." --reason "..." --line "<account>:<role>:<side>:<amount>[:<asset>]"`
**HTTP:** `POST /v1/journal`

## Movement valuations

Valuations express the value of movements in a reporting currency (such as USD or EUR) at the time they occurred, using external price feeds or Horizon DEX trade aggregations:

```ts
import { valueMovements, HorizonPriceSource, MapPriceSource } from '@nostro-labs/nostro'

const priceSource = new HorizonPriceSource({ url: 'https://horizon.stellar.org' })
await valueMovements({ store, tenantId: 'acme', priceSource, reportingAsset: USDC })
```

- **Price sources:** `PriceSource` interface provides `price(base, quote, timestamp)`. `HorizonPriceSource` fetches one-hour trade aggregations from Horizon. `MapPriceSource` uses an in-memory price map.
- **Integer arithmetic:** Fractional prices `PriceFraction` (`{ n: bigint, d: bigint }`) and round-half-up integer arithmetic prevent float drift.
- **CSV export:** `journalCsv` includes a `value` column populated from recorded valuations.
- Only the segment containing the movement is eligible; empty segments and contract tokens remain unvalued. A classic asset used as the reporting currency is explicit: USDC is never silently treated as USD.
- Movements without a price are skipped (not guessed).

## Cost basis and realised gains

Track acquisition costs and compute capital gains or losses on asset disposals:

```ts
import { costBasis } from '@nostro-labs/nostro'

const report = await costBasis({ store, tenantId: 'acme', asset: NATIVE, method: 'fifo' })
```

- **Methods:** Supports FIFO (first-in, first-out) and LIFO (last-in, first-out).
- Unknown acquisition costs remain listed in `unvaluedCredits`; affected disposals expose `missingCostAmount` and have no calculated gain. Lots are isolated by wallet. Internal transfers are currently reported as separate credit/debit legs, so select and reconcile transfers explicitly before using gains reports.
- The chosen FIFO/LIFO method must be kept consistent by the caller; method policy is not persisted per tenant. Mixed reporting currencies are rejected.
- **Proportional cost splitting:** Disposing of part of a lot divides cost with round-half-up integer arithmetic, preserving conservation of total cost without rounding residue.
- **Notice:** This is internal bookkeeping and ledger reconciliation, **not tax advice**. Consult a qualified professional for statutory tax reporting.

**CLI:** `nostro report gains --asset native [--method fifo|lifo]`

## Aging reports

`agingReport({ store, tenantId, asOf, buckets })` reports open balances across aging buckets (default: `[30, 60, 90]` days):

- **Expectations:** Amounts still owed on open or partially paid invoices (receivables) and payouts (payables), grouped by days past `dueAt`. Items with no due date are grouped under `no_due_date`.
- **Unexplained money:** Unapplied receipts, customer credit, and suspense (`unexplained`), grouped by days since the movement occurred, alongside the exception code.
- **Journal reconciliation:** Unexplained money totals equal the matching ledger balances in the journal.

**CLI:** `nostro report aging [--as-of YYYY-MM-DD] [--buckets 30,60,90] [--json] [--csv]`


## Refunds

A return-memo debit is linked to its original credit in the same transaction as reconciliation.
Returned unallocated money moves the original credit's `customer_credit` or `unapplied` slot to
`refund_clearing`; the outgoing debit clears that role against cash. `refund_clearing` uses
`liabilities:refund-clearing` by default and nets to zero when both movements are posted.

Example: 15 XLM paid a 10 XLM invoice, then 7 XLM was returned. The original receipt remains
Dr cash 15 / Cr receivable 10, with its remaining Cr customer credit 5 reclassified to
Cr refund clearing 5. The return is Dr refund clearing 5 / Dr uncategorized expense 2 / Cr cash 7.
The invoice stays settled. Partial returns clear only their exact portion; a larger return than the
original credit permits becomes `REFUND_UNLINKED` and is left for a person.

Links and journal entries are append-only. Repeated reconciliation and journal sweeps change
nothing, I1 includes the recorded returned amount, I3 balances each entry per asset, and aging
reports exclude the returned residual. [Matching policy](./matching.md#refunds-recorded-by-return-memo).
