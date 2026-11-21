/**
 * How a movement should be accounted for, and what to post to get there.
 * Pure functions: no store, no clock.
 *
 * Cash is posted once, when a movement is first decided. Anything decided
 * later (an exception resolved by a manual allocation, an ignored movement
 * reclassified) is posted as an adjustment: the difference between how the
 * movement should now be accounted for and how it already is. Nothing is
 * ever edited, and cash is never re-posted, so the cash account reads like
 * the chain.
 */
import type {
  Allocation,
  ExceptionRecord,
  JournalEntry,
  JournalEntryKind,
  LineRole,
  Movement,
  NewJournalEntry,
  NewJournalLine,
  Side,
} from '../model/index.js'
import type { RefundLink } from '../store/index.js'
import { refundCoverage } from '../store/refunds.js'
import { Money, issuerOf } from '../money/index.js'
import type { ChartOfAccounts, PostingRule } from './chart.js'
import { DEFAULT_CHART, accountFor, applyRules } from './chart.js'

/** A line before an account code is chosen for it. */
export interface DesiredLine {
  readonly role: LineRole
  readonly side: Side
  readonly amount: Money
  readonly expectationId: string | null
  readonly exceptionId: string | null
}

/** Exceptions after which leftover money is owed back to a known payer. */
const OWED_BACK = new Set(['OVERPAYMENT', 'DUPLICATE_PAYMENT'])

/**
 * How a movement should be accounted for now, or `null` while it is still
 * pending (undecided movements are not posted).
 *
 * The movement's own side is the full amount: cash for a wallet, `issued`
 * when the account issues the asset. The other side is one line per
 * allocation, plus whatever is left over: owed back, unapplied, unexplained,
 * a fee, or uncategorized if the movement was ignored. Leftovers are always
 * the amount minus allocations, never an exception's amount.
 */
export function desiredLines(
  movement: Movement,
  allocations: readonly Allocation[],
  exceptions: readonly ExceptionRecord[],
  refunds: readonly RefundLink[] = [],
): DesiredLine[] | null {
  if (movement.disposition === 'pending') return null

  const credit = movement.direction === 'credit'
  const own: Side = credit ? 'debit' : 'credit'
  const other: Side = credit ? 'credit' : 'debit'

  const latest = exceptions[exceptions.length - 1] ?? null

  const lines: DesiredLine[] = [
    {
      role: issuerOf(movement.amount.asset) === movement.account ? 'issued' : 'cash',
      side: own,
      amount: movement.amount,
      expectationId: null,
      exceptionId: null,
    },
  ]
  const refund = refunds.find(link => link.refundMovementId === movement.id)
  if (refund) {
    if (refund.residualAmount.isPositive()) lines.push({role:'refund_clearing',side:'debit',amount:refund.residualAmount,expectationId:null,exceptionId:null})
    const expense=refund.amount.subtract(refund.residualAmount)
    if (expense.isPositive()) lines.push({role:'uncategorized_expense',side:'debit',amount:expense,expectationId:null,exceptionId:null})
    return lines
  }
  const returned=refundCoverage(movement,refunds)
  if (returned.isPositive()) lines.push({role:'refund_clearing',side:other,amount:returned,expectationId:null,exceptionId:null})
  let left = movement.amount.subtract(returned)
  for (const a of allocations) {
    lines.push({
      role: credit ? 'receivable' : 'payable',
      side: other,
      amount: a.amount,
      expectationId: a.expectationId,
      exceptionId: null,
    })
    left = left.subtract(a.amount)
  }
  if (left.isPositive()) {
    let role: LineRole
    if (movement.disposition === 'ignored') {
      role = movement.kind === 'fee' ? 'network_fees' : credit ? 'uncategorized_income' : 'uncategorized_expense'
    } else if (credit) {
      role = latest !== null && OWED_BACK.has(latest.code) ? 'customer_credit' : 'unapplied'
    } else {
      role = 'unexplained'
    }
    lines.push({ role, side: other, amount: left, expectationId: null, exceptionId: latest?.id ?? null })
  }
  return lines
}

const keyOf = (l: { role: LineRole; amount: Money; expectationId: string | null }) =>
  `${l.role}|${l.amount.asset}|${l.expectationId ?? ''}`

/**
 * What to post so the movement's entries add up to `desired`: per (role,
 * asset, expectation), the desired balance minus the posted one. Empty when
 * the books already say the right thing.
 */
export function diffLines(desired: readonly DesiredLine[], existing: readonly JournalEntry[]): DesiredLine[] {
  interface Slot {
    role: LineRole
    like: Money
    expectationId: string | null
    exceptionId: string | null
    want: bigint
    have: bigint
  }
  const slots = new Map<string, Slot>()
  const slot = (l: DesiredLine | JournalEntry['lines'][number]): Slot => {
    const k = keyOf(l)
    let s = slots.get(k)
    if (s === undefined) {
      s = { role: l.role, like: l.amount, expectationId: l.expectationId, exceptionId: null, want: 0n, have: 0n }
      slots.set(k, s)
    }
    return s
  }
  const signed = (side: Side, raw: bigint) => (side === 'debit' ? raw : -raw)
  for (const l of desired) {
    const s = slot(l)
    s.want += signed(l.side, l.amount.raw)
    s.exceptionId = l.exceptionId
  }
  for (const e of existing) {
    for (const l of e.lines) {
      const s = slot(l)
      s.have += signed(l.side, l.amount.raw)
      s.exceptionId ??= l.exceptionId
    }
  }
  const out: DesiredLine[] = []
  for (const s of slots.values()) {
    const delta = s.want - s.have
    if (delta === 0n) continue
    out.push({
      role: s.role,
      side: delta > 0n ? 'debit' : 'credit',
      amount: Money.fromRaw(delta > 0n ? delta : -delta, s.like.asset, s.like.decimals),
      expectationId: s.expectationId,
      exceptionId: s.exceptionId,
    })
  }
  return out
}

function label(m: Money): string {
  const asset = m.asset === 'native' ? 'XLM' : m.asset.slice(0, m.asset.indexOf(':'))
  return `${m.toString()} ${asset}`
}

function describe(kind: JournalEntryKind, movement: Movement): string {
  const what =
    movement.kind === 'fee'
      ? `Network fee ${label(movement.amount)}`
      : `${movement.direction === 'credit' ? 'Received' : 'Sent'} ${label(movement.amount)}`
  if (kind === 'initial') return what
  return `${kind === 'reclass' ? 'Reclassified' : 'Corrected'}: ${what}`
}

export interface PostingPlanOptions {
  readonly refunds?: readonly RefundLink[]
  readonly chart?: ChartOfAccounts
  /**
   * Ordered posting rules checked before the chart. The first matching rule
   * wins. Rules never move an existing slot: `planPosting` already keeps each
   * slot in the account it was first posted to.
   */
  readonly rules?: readonly PostingRule[]
}

/**
 * The next journal entry for a movement, or `null` if none is needed.
 *
 * - `initial` (no entries yet): dated when the money moved.
 * - `reclass` (cash untouched): dated by the store's clock, because applying
 *   cash happens when it is applied, and back-dating would rewrite what the
 *   books said for a period that may already be closed.
 * - `correction` (the cash leg changes): dated like the original entry, so
 *   cash by date still matches the chain.
 *
 * A line keeps the account its slot was first posted to, so a later chart
 * change cannot strand a balance in an account nothing reverses.
 */
export function planPosting(
  movement: Movement,
  allocations: readonly Allocation[],
  exceptions: readonly ExceptionRecord[],
  existing: readonly JournalEntry[],
  options: PostingPlanOptions = {},
): NewJournalEntry | null {
  const desired = desiredLines(movement, allocations, exceptions, options.refunds)
  if (desired === null) return null

  const delta = diffLines(desired, existing)
  if (delta.length === 0) return null

  const chart = options.chart ?? DEFAULT_CHART
  const rules = options.rules ?? []
  const posted = new Map<string, string>()
  for (const e of existing) for (const l of e.lines) posted.set(keyOf(l), l.account)

  // Build a lookup of expectation refs / metadata for rule matching.
  // We carry expectationId on each desired line; the caller passes allocations
  // which we can use to find the expectation. For the metadata we need the
  // allocations object — but planPosting receives allocations already. We
  // build a simple id→allocation map so we can reach expectation refs.
  const allocByExpectation = new Map<string, Allocation>()
  for (const a of allocations) allocByExpectation.set(a.expectationId, a)

  const pickAccount = (l: DesiredLine): string => {
    // If this slot was already posted, keep its original account unchanged.
    const prior = posted.get(keyOf(l))
    if (prior !== undefined) return prior

    // Try posting rules first.
    if (rules.length > 0) {
      const ctx = {
        role: l.role,
        asset: l.amount.asset,
        account: movement.account,
        network: movement.network,
        direction: movement.direction,
        kind: movement.kind,
        counterparty: movement.counterparty,
        // Expectation context — only available when the line is linked to one.
        expectationRef: null as string | null,
        expectationMetadata: null as Readonly<Record<string, string>> | null,
      }
      if (l.expectationId !== null) {
        const alloc = allocByExpectation.get(l.expectationId)
        if (alloc !== undefined) {
          // We don't have the full expectation object here, so we surface what
          // we can from the allocation. The expectation reference and metadata
          // must be passed in via options when needed; for now we pass the
          // expectationId as a ref so prefix rules can still match on it.
          ctx.expectationRef = l.expectationId
        }
      }
      const match = applyRules(rules, ctx)
      if (match !== null) return match.account
    }

    return accountFor(chart, l.role, movement.network, movement.account)
  }

  const lines: NewJournalLine[] = delta.map((l) => ({
    account: pickAccount(l),
    role: l.role,
    side: l.side,
    amount: l.amount,
    expectationId: l.expectationId,
    exceptionId: l.exceptionId,
  }))

  const kind: JournalEntryKind =
    existing.length === 0
      ? 'initial'
      : delta.some((l) => l.role === 'cash' || l.role === 'issued')
        ? 'correction'
        : 'reclass'
  const base = {
    tenantId: movement.tenantId,
    movementId: movement.id,
    postingNo: existing.length + 1,
    kind,
    description: describe(kind, movement),
    lines,
  }
  if (kind === 'initial') return { ...base, effectiveAt: movement.occurredAt }
  if (kind === 'correction') return { ...base, effectiveAt: existing[0]!.effectiveAt }
  return base
}
