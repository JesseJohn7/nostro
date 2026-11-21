/**
 * Aging report for open expectations and unapplied/unexplained money (Issue #58).
 *
 * All amounts are exact Money, never floats.
 *
 * ## Expectations
 * What is still owed on each open or partially paid expectation, in each asset,
 * grouped by days past `dueAt`. Expectations with no due date go in their own group.
 * Credit expectations (receivables) and debit expectations (payouts) are reported separately.
 *
 * As of a past date:
 * Only expectations and allocations created on or before `asOf` are included.
 *
 * ## Unexplained money
 * The open balance per movement in the `unapplied`, `customer_credit` and `unexplained` roles,
 * grouped by days since the movement, with the exception code that explains why.
 *
 * The report's unexplained totals equal the matching journal balances.
 */
import type { Allocation, Expectation, JournalEntry } from '../model/index.js'
import type { AssetId } from '../money/index.js'
import { Money } from '../money/index.js'
import type { Store } from '../store/index.js'

export const DEFAULT_AGING_BUCKETS = [30, 60, 90] as const

export interface AgingBucketSummary {
  readonly bucket: string
  readonly count: number
  readonly total: Money
}

export interface ExpectationAgingItem {
  readonly expectationId: string
  readonly reference: string
  readonly account: string
  readonly direction: 'credit' | 'debit'
  readonly asset: AssetId
  readonly originalAmount: Money
  readonly remainingAmount: Money
  readonly dueAt: Date | null
  readonly daysPastDue: number | null
  readonly bucket: string
}

export interface UnexplainedAgingItem {
  readonly movementId: string
  readonly occurredAt: Date
  readonly account: string
  readonly role: 'unapplied' | 'customer_credit' | 'unexplained'
  readonly asset: AssetId
  readonly amount: Money
  readonly daysSinceMovement: number
  readonly bucket: string
  readonly exceptionCode: string | null
}

export interface AgingReport {
  readonly tenantId: string
  readonly asOf: Date
  readonly buckets: readonly number[]
  /** Receivables (credit expectations). */
  readonly receivables: {
    readonly items: readonly ExpectationAgingItem[]
    readonly byAsset: readonly {
      readonly asset: AssetId
      readonly totalRemaining: Money
      readonly buckets: readonly AgingBucketSummary[]
    }[]
  }
  /** Payables / payouts (debit expectations). */
  readonly payables: {
    readonly items: readonly ExpectationAgingItem[]
    readonly byAsset: readonly {
      readonly asset: AssetId
      readonly totalRemaining: Money
      readonly buckets: readonly AgingBucketSummary[]
    }[]
  }
  /** Unexplained money: unapplied, customer_credit, unexplained. */
  readonly unexplainedMoney: {
    readonly items: readonly UnexplainedAgingItem[]
    readonly byRoleAndAsset: readonly {
      readonly role: 'unapplied' | 'customer_credit' | 'unexplained'
      readonly asset: AssetId
      readonly total: Money
      readonly buckets: readonly AgingBucketSummary[]
    }[]
  }
}

export interface AgingReportOptions {
  readonly store: Store
  readonly tenantId: string
  readonly asOf?: Date
  readonly buckets?: readonly number[]
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

export function bucketNameForDays(days: number, buckets: readonly number[]): string {
  if (days <= 0) return 'current'
  let lower = 1
  for (const b of buckets) {
    if (days <= b) {
      return lower === 1 && b === 0 ? 'current' : `${lower}-${b}`
    }
    lower = b + 1
  }
  return `>${buckets[buckets.length - 1]}`
}

export async function agingReport(options: AgingReportOptions): Promise<AgingReport> {
  const { store, tenantId } = options
  const asOf = options.asOf ?? new Date()
  const buckets = [...(options.buckets ?? DEFAULT_AGING_BUCKETS)].sort((a, b) => a - b)

  const PAGE = 500

  // 1. Scan expectations
  const expectations: Expectation[] = []
  let afterSeqExp: number | undefined
  for (;;) {
    const page: Expectation[] = await store.listExpectations({
      tenantId,
      limit: PAGE,
      ...(afterSeqExp !== undefined ? { afterSeq: afterSeqExp } : {}),
    })
    for (const e of page) {
      if (e.createdAt <= asOf) expectations.push(e)
    }
    if (page.length < PAGE) break
    afterSeqExp = page[page.length - 1]!.seq
  }

  // 2. Scan allocations
  const allocationsByExpectation = new Map<string, Allocation[]>()
  for (const exp of expectations) {
    const allocs = await store.listAllocations({ tenantId, expectationId: exp.id })
    allocationsByExpectation.set(
      exp.id,
      allocs.filter((a) => a.createdAt <= asOf),
    )
  }

  const receivableItems: ExpectationAgingItem[] = []
  const payableItems: ExpectationAgingItem[] = []

  for (const exp of expectations) {
    // If cancelled before or at asOf, skip
    if (exp.status === 'cancelled' && exp.updatedAt <= asOf) {
      continue
    }

    const allocs = allocationsByExpectation.get(exp.id) ?? []
    let allocatedRaw = 0n
    for (const a of allocs) allocatedRaw += a.amount.raw
    const remainingRaw = exp.amount.raw - allocatedRaw
    if (remainingRaw <= 0n) continue

    const remainingAmount = Money.fromRaw(remainingRaw, exp.amount.asset, exp.amount.decimals)

    let daysPastDue: number | null = null
    let bName: string
    if (exp.dueAt === null) {
      bName = 'no_due_date'
    } else {
      daysPastDue = Math.floor((asOf.getTime() - exp.dueAt.getTime()) / MS_PER_DAY)
      bName = bucketNameForDays(daysPastDue, buckets)
    }

    const item: ExpectationAgingItem = Object.freeze({
      expectationId: exp.id,
      reference: exp.reference,
      account: exp.account,
      direction: exp.direction,
      asset: exp.amount.asset,
      originalAmount: exp.amount,
      remainingAmount,
      dueAt: exp.dueAt,
      daysPastDue,
      bucket: bName,
    })

    if (exp.direction === 'credit') {
      receivableItems.push(item)
    } else {
      payableItems.push(item)
    }
  }

  // 3. Scan unexplained money from journal entries effective on or before asOf
  let afterSeqJrn: number | undefined
  const entries: JournalEntry[] = []
  for (;;) {
    const page: JournalEntry[] = await store.listJournalEntries({
      tenantId,
      limit: PAGE,
      effectiveBefore: new Date(asOf.getTime() + 1),
      ...(afterSeqJrn !== undefined ? { afterSeq: afterSeqJrn } : {}),
    })
    entries.push(...page)
    if (page.length < PAGE) break
    afterSeqJrn = page[page.length - 1]!.seq
  }

  // Group lines by movementId and role (unapplied, customer_credit, unexplained)
  type UnexplainedRole = 'unapplied' | 'customer_credit' | 'unexplained'
  const UNEXPLAINED_ROLES = new Set<string>(['unapplied', 'customer_credit', 'unexplained'])

  interface MovementRoleSlot {
    movementId: string
    role: UnexplainedRole
    asset: AssetId
    decimals: number
    netRaw: bigint
    exceptionId: string | null
  }

  const movementSlots = new Map<string, MovementRoleSlot>()

  for (const entry of entries) {
    if (entry.movementId === null) continue
    for (const line of entry.lines) {
      if (!UNEXPLAINED_ROLES.has(line.role)) continue
      const role = line.role as UnexplainedRole
      const key = `${entry.movementId}:${role}:${line.amount.asset}`
      let slot = movementSlots.get(key)
      if (slot === undefined) {
        slot = {
          movementId: entry.movementId,
          role,
          asset: line.amount.asset,
          decimals: line.amount.decimals,
          netRaw: 0n,
          exceptionId: null,
        }
        movementSlots.set(key, slot)
      }
      if (line.exceptionId !== null) slot.exceptionId = line.exceptionId

      // unapplied & customer_credit are credit-normal: credits add, debits subtract
      // unexplained is suspense asset (debit-normal): debits add, credits subtract
      const sign = role === 'unexplained' ? (line.side === 'debit' ? 1n : -1n) : line.side === 'credit' ? 1n : -1n
      slot.netRaw += sign * line.amount.raw
    }
  }

  const unexplainedItems: UnexplainedAgingItem[] = []
  for (const slot of movementSlots.values()) {
    if (slot.netRaw <= 0n) continue
    const movement = await store.getMovement(tenantId, slot.movementId)
    if (movement === null) continue

    const diffMs = asOf.getTime() - movement.occurredAt.getTime()
    const daysSince = Math.max(0, Math.floor(diffMs / MS_PER_DAY))
    const bucket = bucketNameForDays(daysSince, buckets)

    let exceptionCode: string | null = null
    if (slot.exceptionId !== null) {
      const x = await store.getException(tenantId, slot.exceptionId)
      if (x) exceptionCode = x.code
    }
    if (exceptionCode === null) {
      const openExceptions = await store.listExceptions({ tenantId, movementId: movement.id })
      if (openExceptions.length > 0) exceptionCode = openExceptions[0]!.code
    }

    unexplainedItems.push(
      Object.freeze({
        movementId: slot.movementId,
        occurredAt: movement.occurredAt,
        account: movement.account,
        role: slot.role,
        asset: slot.asset,
        amount: Money.fromRaw(slot.netRaw, slot.asset, slot.decimals),
        daysSinceMovement: daysSince,
        bucket,
        exceptionCode,
      }),
    )
  }

  // Summarize helpers
  function summarizeExpectations(items: readonly ExpectationAgingItem[]) {
    const assets = [...new Set(items.map((i) => i.asset))]
    return assets.map((asset) => {
      const forAsset = items.filter((i) => i.asset === asset)
      const decimals = forAsset[0]!.originalAmount.decimals
      let totalRaw = 0n
      for (const i of forAsset) totalRaw += i.remainingAmount.raw
      const totalRemaining = Money.fromRaw(totalRaw, asset, decimals)

      // Bucket summaries
      const bucketOrder = ['current', ...buckets.map((b, idx) => (idx === 0 ? `1-${b}` : `${buckets[idx - 1]! + 1}-${b}`)), `>${buckets[buckets.length - 1]}`, 'no_due_date']
      const bucketMap = new Map<string, { count: number; raw: bigint }>()
      for (const b of bucketOrder) bucketMap.set(b, { count: 0, raw: 0n })

      for (const i of forAsset) {
        const cur = bucketMap.get(i.bucket) ?? { count: 0, raw: 0n }
        cur.count++
        cur.raw += i.remainingAmount.raw
        bucketMap.set(i.bucket, cur)
      }

      const summaries: AgingBucketSummary[] = []
      for (const [b, data] of bucketMap) {
        if (data.count > 0 || bucketOrder.includes(b)) {
          summaries.push({
            bucket: b,
            count: data.count,
            total: Money.fromRaw(data.raw, asset, decimals),
          })
        }
      }

      return Object.freeze({
        asset,
        totalRemaining,
        buckets: Object.freeze(summaries),
      })
    })
  }

  function summarizeUnexplained(items: readonly UnexplainedAgingItem[]) {
    const pairs = [...new Set(items.map((i) => `${i.role}|${i.asset}`))]
    return pairs.map((pair) => {
      const [role, asset] = pair.split('|') as [UnexplainedRole, AssetId]
      const forGroup = items.filter((i) => i.role === role && i.asset === asset)
      const decimals = forGroup[0]!.amount.decimals
      let totalRaw = 0n
      for (const i of forGroup) totalRaw += i.amount.raw
      const total = Money.fromRaw(totalRaw, asset, decimals)

      const bucketOrder = ['current', ...buckets.map((b, idx) => (idx === 0 ? `1-${b}` : `${buckets[idx - 1]! + 1}-${b}`)), `>${buckets[buckets.length - 1]}`]
      const bucketMap = new Map<string, { count: number; raw: bigint }>()
      for (const b of bucketOrder) bucketMap.set(b, { count: 0, raw: 0n })

      for (const i of forGroup) {
        const cur = bucketMap.get(i.bucket) ?? { count: 0, raw: 0n }
        cur.count++
        cur.raw += i.amount.raw
        bucketMap.set(i.bucket, cur)
      }

      const summaries: AgingBucketSummary[] = []
      for (const [b, data] of bucketMap) {
        summaries.push({
          bucket: b,
          count: data.count,
          total: Money.fromRaw(data.raw, asset, decimals),
        })
      }

      return Object.freeze({
        role,
        asset,
        total,
        buckets: Object.freeze(summaries),
      })
    })
  }

  return {
    tenantId,
    asOf,
    buckets: Object.freeze(buckets),
    receivables: Object.freeze({
      items: Object.freeze(receivableItems),
      byAsset: Object.freeze(summarizeExpectations(receivableItems)),
    }),
    payables: Object.freeze({
      items: Object.freeze(payableItems),
      byAsset: Object.freeze(summarizeExpectations(payableItems)),
    }),
    unexplainedMoney: Object.freeze({
      items: Object.freeze(unexplainedItems),
      byRoleAndAsset: Object.freeze(summarizeUnexplained(unexplainedItems)),
    }),
  }
}
