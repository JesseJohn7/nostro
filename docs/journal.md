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
| `customer_credit` (refund) | `liabilities:customer-credit` | a refund debit linked to the credit it returns clears the customer credit it was owed from |

Unexplained money out is a suspense *asset*, not a liability: it was usually exchanged for something
(a DEX trade, a bill booked elsewhere), and sharing an account with unexplained receipts would let
unrelated flows cancel out.

**`receivable` runs a credit balance inside nostro.** nostro does not book your invoices; your
accounting system does. nostro's receivable lines are the payment side of that receivable, linked to
each invoice by its expectation, so an exporter can match them up. The same goes for `payable`.

## Examples

| What happened | Entry |
|---|---|
| 25 USDC paid INV-2 in full | Dr cash 25 · Cr receivable 25 (INV-2) |
| 30 USDC paid INV-2 (25 owed) | Dr cash 30 · Cr receivable 25 (INV-2) · Cr customer credit 5 |
| 7 USDC arrived with no memo | Dr cash 7 · Cr unapplied 7 |
| 0.00001 XLM network fee | Dr network fees · Cr cash |
| Later, a person applies the 7 USDC to INV-3 | **reclass:** Dr unapplied 7 · Cr receivable 7 (INV-3) |

## Refunds

A debit whose `MEMO_RETURN` equals the transaction hash of a recorded credit on the same account is
recorded as a refund of that credit, and the link is stored. The refund reverses what the credit
posted, rather than leaving an `unexplained` debit behind:

| What happened | Entry |
|---|---|
| 30 USDC overpayment refunded in full (5 owed as credit) | Dr customer credit 5 · Cr cash 5 (refund of the 5 excess) |
| INV-2 paid 25, then the payment refunded in full | the payment's receivable reverses; INV-2 reopens |

A refund of a settled invoice's payment reopens the invoice in part or in full, matching the amount
returned. A debit with no return memo that looks like a refund raises `REFUND_UNLINKED` for a person
to resolve; nothing is guessed.

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
| Each entry balances per asset (I3) | yes | yes, at COMMIT (deferred trigger) | no: amounts beyond 64 bits are text it cannot sum |
| Entries are never edited or deleted | yes | yes (triggers) | yes (triggers) |
| One entry per posting number per movement | yes (compare-and-set) | yes (unique index) | yes (unique index) |
| A movement's cash nets to 0 or its exact amount | yes | no | no |

## Export

```ts
import { journalCsv, journalCsvRows, journalBeancountRows } from '@nostro-labs/nostro'

const october = await journalCsv({ store, tenantId: 'acme', from: new Date('2026-10-01'), to: new Date('2026-11-01') })
for await (const row of journalCsvRows({ store, tenantId: 'acme' })) process.stdout.write(row) // streams
for await (const line of journalBeancountRows({ store, tenantId: 'acme', commodityMap })) process.stdout.write(line)
```

One row per journal line, RFC 4180 with CRLF line endings. Columns: `entry_id`, `seq`, `kind`,
`posted_at`, `effective_at`, `description`, `line_no`, `account`, `role`, `asset`, `debit`, `credit`,
`movement_id`, `tx_hash`, `expectation_reference`, `exception_id`, `exception_code`.

- Amounts are exact decimal strings, never floats, even beyond 64 bits.
- `from` / `to` select by effective date: `from` inclusive, `to` exclusive.
- Text that a spreadsheet would run as a formula (starting with `=`, `+`, `-`, `@` or a tab) is
  prefixed with `'`. References and account codes come from users, and these files get opened in
  spreadsheets. Payment memo text, which the payer controls, is never written.

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

Amounts are computed with exact bigint arithmetic across all stores — including SQLite, where SQL `SUM`
cannot add amounts beyond 64 bits exactly.

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
