# Matching

`reconcile()` takes movements still `pending` after `sync()` and decides each one with a pure
function, `decide(movement, candidates, options)`. Same inputs, same decision: no I/O, no clock, no
randomness, and every decision records its reasons as evidence.

## How a decision is made

1. **Fees are never matched.** They are ignored with a reason and belong to the journal as expense.
2. **Every strategy scores every candidate.** Candidates are the account's open and part-paid
   expectations in the same direction, plus any expectation (settled included) whose muxed id the
   movement carries or whose normalised reference or requested text memo equals the movement's
   normalised text memo. This is what catches a second payment quoting a settled invoice.
3. **Scores combine by family.** Within a family only the strongest signal counts; across families
   they combine as `1 − Π(1 − sᵢ)`. A muxed id and a memo both identify the expectation, so finding
   both is not twice the evidence. A memo plus a unique amount is.
4. **A match needs confidence and a clear winner:** a combined score of at least **0.70** and a lead
   of at least **0.15** over the runner-up. Anything else goes to a person as `AMBIGUOUS_MATCH`, with
   every candidate's signals attached.
5. **A confident match can still be refused** (see below).
6. **Otherwise allocate** `min(amount, remaining)`. Anything left over is an overpayment.

## Strategies

| Strategy | Family | Score | Fires when | False-positive risk |
|---|---|---|---|---|
| `muxed_id` | identifier | 1.00 | paid to the `M…` address issued for the expectation | none if ids are issued uniquely |
| `memo_id` | identifier | 0.95 | `MEMO_ID` equals the memo id asked for, or the expectation's muxed id | payer typo or a reused old invoice id |
| `memo_hash` | identifier | 0.95 | `MEMO_HASH` equals the 64-hex hash asked for, compared exactly | payer typo or a reused old hash |
| `memo_text` | identifier | 0.85 | normalised text memo equals the normalised reference or requested memo | normalisation is deliberately loose |
| `memo_cross_type` | identifier | 0.75 | id memo sent for a text reference, or text memo sent for an id; see below | any integer reference that happens to equal a pending memo id |
| `memo_contained` | identifier | 0.60 | a text memo contains the reference as a token or inside a longer normalised run | a memo that merely quotes the reference |
| `memo_truncated` | identifier | 0.60 | a 28-byte text memo is a proper prefix of the normalised reference | long references often share a prefix; corroboration only |
| `memo_near_miss` | identifier | 0.50 | a text-memo token is one edit from the reference after normalisation | a different reference one character away |
| `exact_amount` | amount | 0.60 unique / 0.20 shared | exactly the amount still owed, same asset, inside the window | any two invoices for the same amount |
| `known_payer` | payer | 0.40 | `counterparty` is an account listed in `payers` | accounts are shared and reused; corroboration only, never an identifier |

**An amount alone never settles anything:** 0.60 is below the 0.70 threshold, so a unique-amount match
without a memo becomes a suggestion in the exceptions queue. Lowering `threshold` changes that, and
should be a deliberate decision.

### Cross-type memo matching (`memo_cross_type`)

Payers often send the right reference in the wrong kind of memo field. This strategy covers two cases:

- **Id memo for a text reference.** The payer sends `MEMO_ID 1042` for `INV-1042`. The id is
  converted to its decimal string (`"1042"`) and compared against the expectation's normalised
  reference and any normalised text memo it asked for.
- **Text memo for an id expectation.** The expectation asked for `MEMO_ID 9001`, or the account
  carries `muxedId 9001`, and the payer typed `"9001"` as a text memo. The normalised text is
  compared against the decimal string of the requested id and of the muxed id.

Leading zeros keep their meaning: `MEMO_ID 123` never matches reference `00123`, because the payer
who meant that would have sent the text `"00123"`. Hash and return memos are not candidates for
cross-type matching.

`memo_contained` and `memo_near_miss` are corroborating identifier signals. Both use
`normalizeReference`, skip a memo equal to the reference or the requested memo, and require a reference
of at least four characters after trimming and three after normalisation: `INV-123` (normalised `123`)
and `INV-1O42` (one edit from `INV-1042`) qualify, while `AB1` (only three raw characters) and
`REF-12` (normalised `12`) do not. `memo_contained` finds the reference among the memo's tokens, or as
a substring of the whole normalised memo; `memo_near_miss` accepts one substitution, insertion,
deletion or adjacent transposition. They share the identifier family, so only the stronger of the two
counts, and neither reaches 0.70 alone: both need evidence from another family, usually a unique
amount. A reference quoted in an unrelated memo, or a second invoice whose reference differs by one
character, can score here; with two close candidates the result is `AMBIGUOUS_MATCH`, not a silent
settlement.

Text memos are normalised before comparison (NFKC, zero-width and control characters removed,
upper-cased, `INVOICE` / `INV` / `REF` / `NO` / `#` prefixes dropped at a word boundary, separators
dropped). `INV-00123`, `inv #00123`, `Invoice 00123` and `ＩＮＶ００１２３` are the same reference;
`INVENTORY-5` keeps its word, and `00123` is not `123`.

A wallet cuts a text memo at 28 **bytes**, so a long reference can arrive as a prefix. A cut inside
a multi-byte character may decode as U+FFFD and appear longer than 28 bytes; that is treated as the
same signal. It is scored 0.60: alone it raises `MEMO_TRUNCATED` naming the likely expectation, two
candidates sharing the prefix stay `AMBIGUOUS_MATCH`, and a unique exact amount takes it to 0.84 so
the payment settles.

To add a strategy, see [CONTRIBUTING](../CONTRIBUTING.md#adding-a-matching-strategy).

## Outcomes

| Situation | Disposition | Exception |
|---|---|---|
| Matched, paid in full or in part | `allocated` | none |
| Matched, paid more than was owed | `partial` | `OVERPAYMENT` for the residual |
| Matched an expectation with nothing left owing | `exception` | `DUPLICATE_PAYMENT` |
| Matched, but in another asset (incl. same code, other issuer) | `exception` | `WRONG_ASSET` |
| Matched, but paid after the expectation expired | `exception` | `LATE_BEYOND_WINDOW` |
| Best candidate below 0.70, or two within 0.15 | `exception` | `AMBIGUOUS_MATCH` |
| Best evidence is a 28-byte prefix of one reference | `exception` | `MEMO_TRUNCATED` |
| Credit with no memo or muxed id, while something is owed | `exception` | `MEMO_MISSING` |
| Credit with no memo or muxed id, nothing owed | `exception` | `UNEXPECTED_CREDIT` |
| Credit whose memo or muxed id matches nothing | `exception` | `UNMATCHED_NO_CANDIDATE` |
| Credit with a return memo (refund signal) | `exception` | `MEMO_MALFORMED` |
| Credit with a text memo that normalises to nothing (`INV`, `#`) | `exception` | `MEMO_MALFORMED` |
| Credit whose source enrichment is missing | `exception` | `ENRICHMENT_MISSING` |
| Debit that matches no payout | `exception` | `UNEXPECTED_DEBIT` |
| Network fee | `ignored` | none |

Every case above has a test in `packages/core/test/matching.test.ts` or `reconcile.test.ts`.

## When a person decides

An exception is a question for a person. These answer it, each in one transaction with the journal
adjustment it causes, and every event it means:

```ts
import { applyMovement, closeException, ignoreMovement } from '@nostro-labs/nostro'

// "That payment was for INV-1042." Applied by hand, it takes what is left of the movement and still
// owing, unless you give an amount; several expectations split it.
await applyMovement({ store, tenantId, movementId, allocations: [{ expectationId }], note: 'customer called' })

// "That is not something to reconcile." Whatever was already allocated stays allocated.
await ignoreMovement({ store, tenantId, movementId, reason: 'our own top-up' })

// For an exception no movement depends on.
await closeException({ store, tenantId, exceptionId, status: 'dismissed', note: 'checked' })
```

| What the person decides | Disposition after | Journal adjustment (reclass, cash untouched) |
|---|---|---|
| A payment with no match was for an invoice | `allocated` | Dr unapplied · Cr receivable |
| It was only partly for one | `partial`, with `PARTIAL_UNRESOLVED` for exactly what is left | Dr unapplied · Cr receivable, for the part applied |
| An overpayment's residual goes to another invoice | `allocated`, or `partial` with `OVERPAYMENT` for what is left | Dr customer credit · Cr receivable |
| Money in that is not to be reconciled | `ignored`, with the reason | Dr unapplied · Cr uncategorized income |
| Money out that is not to be reconciled | `ignored`, with the reason | Dr uncategorized expense · Cr suspense |
| An overpayment is kept | `ignored`; the invoice stays settled | Dr customer credit · Cr uncategorized income |

The rules hold for a person too: a lookalike asset cannot settle an invoice, money on one account
cannot settle an invoice on another, nothing can be over-allocated, and a cancelled invoice cannot be
paid. An invoice past its expiry can, because deciding that is what the person is there for. A
movement with nothing left to decide is refused with `movement_not_open`, which is also what the
second of two people deciding at once receives.

Closing the last open exception of an undecided movement is refused, because it would leave the
movement's disposition with nothing to support it (I1). Apply or ignore the movement instead.

## Expectation lifecycle

### Muxed ids

An expectation can reserve a muxed id when it is created, with `nostro expect INV-1042 ... --muxed-id 7`
(or `muxedId: "7"` over HTTP). `--issue-muxed-id` (or `muxedId: "issue"`) asks the store for the next
id: one above the highest muxed id currently recorded for that tenant and account, starting at 1.
Ids must be unique per account within a tenant; an explicit id already held by another expectation
there is refused with `expectation_muxed_id_unique` (HTTP 409 `muxed_id_taken`). Settled and cancelled
expectations keep their ids, so issuing does not take one they still hold. `nostro doctor` reports
duplicates as an I1 `muxed_id_duplicate` finding.

Ids are not permanent: `nostro amend ... --muxed-id none` (or `muxedId: null`) clears one, and an id
can be reassigned. Uniqueness is checked against current rows, not a high-water mark, so clearing the
highest id can make a later issue reuse it.

### Amend and cancel

`nostro amend <reference> --reason <why> ...` (or `POST /v1/expectations/:id/amend`) calls the store
operation `amendExpectation(tenantId, id, changes, reason)`. Only `amount`, `muxedId`, `memo`, `payers`,
`dueAt`, `expiresAt` and `metadata` may change. Open and partially paid expectations are amendable;
settled and cancelled ones are not. At least one field and a non-empty reason are required. Reference,
account, asset and direction are immutable, and an amount cannot change asset or decimals. The amount
also cannot be lowered below what is already allocated: lowering it to exactly that allocation settles
the expectation. A new muxed id must still be unique on the account. Payers and metadata are replaced,
not merged. The amendment writes `expectation.amended` with `{ expectation, previous, reason }`: the
reason is required and stored in that event, not on the expectation itself.

`nostro cancel <reference> --reason <why>` (or `POST /v1/expectations/:id/cancel`) works only on an
expectation with no allocations. The reason is kept as `cancelReason` and the store writes
`expectation.cancelled`. A cancelled expectation is never a match candidate and cannot receive an
allocation.

### Expiry sweep

`EXPECTATION_EXPIRED` is an expectation-level exception, not a movement disposition.
`sweepExpectations({ store, tenantId, asOf?, limit? })` pages through open and part-paid expectations
(500 at a time by default) and opens one exception for each whose `expiresAt` is on or before `asOf`
(default now). The exception carries the expectation id, account, current amount, a detail with the
reference and expiry, and evidence `{ asOf, status }`. The sweep is idempotent: an expectation with
any earlier `EXPECTATION_EXPIRED` exception, open, resolved or dismissed, is left alone. It does not
settle, cancel or otherwise change the expectation. The sweep treats expiry as inclusive; matching's
late exception is a separate, strict past-due-window check that refuses only payments made after the
expiry instant with `LATE_BEYOND_WINDOW`. Both can legitimately produce an exception for the same truly
late, unpaid expectation: the sweep raises `EXPECTATION_EXPIRED` against the expectation and matching
raises `LATE_BEYOND_WINDOW` against the payment. A person can still apply either by hand. `nostro serve`
calls the sweep each round, through `reconcileAll()` before reconciliation when a network is
configured and directly otherwise.

The report is `{ scanned, expired, skipped }`: `scanned` counts expired candidates found, not every
expectation visited; `expired` counts exceptions actually opened; and `skipped` covers expectations
already carrying the exception or lost to a race with payment or cancellation.

## Not handled yet

These are known gaps, each planned as its own self-contained piece of work:

- **Amount fingerprints**, a unique sub-unit suffix per invoice for payers who cannot send memos.
- **Claimable balances** as a two-step create-then-claim lifecycle.
- **Several payments in one transaction** sharing a memo.
- **Slippage tolerance** for path payments delivering slightly less than asked.
- **One payment covering several invoices** with no per-invoice reference. Today this is an
  exception for a person to split.
- **Return memos on credits.** A `MEMO_RETURN` currently raises `MEMO_MALFORMED`. Pairing it with
  the original payment is left for the refunds work (#15).
