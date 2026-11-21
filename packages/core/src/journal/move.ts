/**
 * Account balance migration (issue #55).
 *
 * `moveAccount()` moves every open balance from one account code to another
 * in one auditable step. After the move:
 *
 *   - The `from` account has a zero balance in every asset.
 *   - Subsequent adjustments for old movements clear from the `to` account.
 *
 * ## How it works
 *
 * The function scans all journal entries for the tenant, computes the net
 * balance per (asset, slot) in the `from` account, and posts one manual
 * journal entry per affected asset that:
 *
 *   - Credits `from` to zero it out.
 *   - Debits `to` by the same amount (or the reverse for a credit balance).
 *
 * Each such entry has `movementId: null`, so it is a manual entry and is
 * never counted against a movement's postingNo sequence. `effectiveAt` is
 * the current clock time (like a reclass), so a closed period is never
 * back-dated into.
 *
 * ## Concurrency
 *
 * The function runs entirely inside a single `store.transaction()`, which
 * takes a locking read on the journal period. A reconcile that posts to
 * `from` while this runs will simply observe its result on commit.
 *
 * ## Cash accounts
 *
 * Cash accounts (`assets:stellar:*`) are refused: the cash leg is tied to
 * the chain and must not be moved independently.
 *
 * ## Idempotency
 *
 * If `from` already has a zero balance in every asset, the call posts
 * nothing and returns `{ moved: 0 }`.
 */
import type { JournalEntry, NewJournalLine, Side } from '../model/index.js'
import { Money } from '../money/index.js'
import type { AssetId } from '../money/index.js'
import type { Store } from '../store/index.js'

export interface MoveAccountOptions {
  readonly store: Store
  readonly tenantId: string
  /** Account code to move balances away from. */
  readonly from: string
  /** Account code to receive the balances. */
  readonly to: string
  /**
   * Optional note included in the entry description.
   * Defaults to `"Account migration: {from} → {to}"`.
   */
  readonly note?: string
  /**
   * When to date the move. Defaults to the current time.
   * The store will refuse a date that falls inside a closed accounting period.
   */
  readonly effectiveAt?: Date
}

export interface MoveAccountResult {
  /** Number of journal entries posted (one per asset that had a non-zero balance). */
  readonly moved: number
  /** The assets that had balances moved, in the order they were encountered. */
  readonly assets: readonly string[]
}

/** Signed raw unit balance of `account` across all entries, keyed by `asset/decimals`. */
interface AssetBalance {
  raw: bigint
  asset: AssetId
  decimals: number
}

function collectBalances(entries: readonly JournalEntry[], account: string): Map<string, AssetBalance> {
  const map = new Map<string, AssetBalance>()
  for (const entry of entries) {
    for (const line of entry.lines) {
      if (line.account !== account) continue
      const key = `${line.amount.asset}/${line.amount.decimals}`
      const existing = map.get(key)
      const signed = line.side === 'debit' ? line.amount.raw : -line.amount.raw
      if (existing === undefined) {
        map.set(key, { raw: signed, asset: line.amount.asset, decimals: line.amount.decimals })
      } else {
        existing.raw += signed
      }
    }
  }
  return map
}

const CASH_PREFIX_RE = /^assets:stellar:/

export async function moveAccount(options: MoveAccountOptions): Promise<MoveAccountResult> {
  const { store, tenantId, from, to } = options

  if (from === to) throw new Error('moveAccount: "from" and "to" must be different account codes.')
  if (CASH_PREFIX_RE.test(from)) {
    throw new Error(
      `moveAccount: "${from}" is a cash account. Cash legs are tied to the chain and cannot be moved.`,
    )
  }

  return store.transaction(async (tx) => {
    // Lock the period so we date correctly.
    const period = await tx.lockJournalPeriod(tenantId)
    const effectiveAt = options.effectiveAt ?? new Date()
    if (period !== null && effectiveAt.getTime() <= period.through.getTime()) {
      throw new Error(
        `moveAccount: effective date ${effectiveAt.toISOString()} is inside the closed period (through ${period.through.toISOString()}). ` +
          `Pass an effectiveAt after the close, or reopen the period first.`,
      )
    }

    // Page through all journal entries for this tenant.
    const PAGE = 500
    let afterSeq: number | undefined
    const allEntries: JournalEntry[] = []
    for (;;) {
      const page = await tx.listJournalEntries({ tenantId, limit: PAGE, ...(afterSeq !== undefined ? { afterSeq } : {}) })
      allEntries.push(...page)
      if (page.length < PAGE) break
      afterSeq = page[page.length - 1]!.seq
    }

    const balances = collectBalances(allEntries, from)
    const description =
      options.note !== undefined
        ? options.note
        : `Account migration: ${from} → ${to}`

    const movedAssets: string[] = []
    let moved = 0

    for (const bal of balances.values()) {
      if (bal.raw === 0n) continue

      // `from` has a net debit balance (positive raw) → credit `from`, debit `to`.
      // `from` has a net credit balance (negative raw) → debit `from`, credit `to`.
      const fromSide: Side = bal.raw > 0n ? 'credit' : 'debit'
      const toSide: Side = bal.raw > 0n ? 'debit' : 'credit'
      const absRaw = bal.raw > 0n ? bal.raw : -bal.raw
      const amount = Money.fromRaw(absRaw, bal.asset, bal.decimals)

      const lines: NewJournalLine[] = [
        { account: from, role: 'other', side: fromSide, amount, expectationId: null, exceptionId: null },
        { account: to, role: 'other', side: toSide, amount, expectationId: null, exceptionId: null },
      ]

      await tx.postJournalEntry({
        tenantId,
        movementId: null,
        postingNo: null,
        kind: 'reclass',
        effectiveAt,
        description,
        lines,
      })

      movedAssets.push(bal.asset)
      moved += 1
    }

    return { moved, assets: movedAssets }
  })
}
