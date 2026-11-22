/**
 * Cost basis tracking and realised gains on disposals (Issue #60).
 *
 * All amounts are exact bigints and Money, never floats.
 *
 * ## How it works
 *
 * - Each credit opens a lot at the value it had when it arrived (from its valuation).
 * - Credits without a valuation cannot open a lot and are reported in `unvaluedCredits`.
 * - Each debit, including fees, consumes lots according to the chosen method (FIFO / LIFO).
 * - Splitting a lot's cost across a partial disposal uses integer round-half-up arithmetic:
 *     proportionalCost = (takeRaw * originalCostRaw + originalAmountRaw / 2n) / originalAmountRaw
 *   When the remainder of a lot is consumed, the exact remaining cost is taken.
 *   This guarantees that open lots plus disposals always add up to the movements in amount and cost.
 *
 * Bookkeeping only — not tax advice. Local rules and tax treatments differ.
 */
import type { Movement } from '../model/index.js'
import type { AssetId } from '../money/index.js'
import { Money, STROOP_DECIMALS } from '../money/index.js'
import type { Store } from '../store/index.js'

export type CostBasisMethod = 'fifo' | 'lifo'

export interface LotSlice {
  readonly lotMovementId: string
  readonly amount: Money
  readonly cost: Money
}

export interface Disposal {
  readonly movementId: string
  readonly occurredAt: Date
  readonly account: string
  readonly asset: AssetId
  readonly amount: Money
  readonly proceeds: Money | null
  readonly cost: Money
  readonly gain: Money | null
  readonly missingCostAmount: Money
  readonly lotsUsed: readonly LotSlice[]
}

export interface OpenLot {
  readonly movementId: string
  readonly occurredAt: Date
  readonly account: string
  readonly asset: AssetId
  readonly originalAmount: Money
  readonly remainingAmount: Money
  readonly originalCost: Money
  readonly remainingCost: Money
}

export interface CostBasisOptions {
  readonly store: Store
  readonly tenantId: string
  readonly entityId?: string
  readonly account?: string
  readonly asset: AssetId
  readonly method?: CostBasisMethod
  readonly from?: Date
  readonly to?: Date
  readonly asOf?: Date
  readonly reportingAsset?: AssetId
}

export interface CostBasisReport {
  readonly tenantId: string
  readonly entityId: string | null
  readonly account: string | null
  readonly asset: AssetId
  readonly reportingAsset: AssetId
  readonly method: CostBasisMethod
  readonly from: Date | null
  readonly to: Date | null
  readonly asOf: Date | null
  readonly openLots: readonly OpenLot[]
  readonly disposals: readonly Disposal[]
  readonly totalProceeds: Money | null
  readonly totalCost: Money
  readonly realizedGain: Money | null
  readonly unvaluedCredits: readonly Movement[]
}

interface MutableLot {
  movementId: string
  occurredAt: Date
  account: string
  asset: AssetId
  originalAmount: Money
  remainingAmountRaw: bigint
  originalCost: Money
  unknownCost: boolean
  remainingCostRaw: bigint
}

export async function costBasis(options: CostBasisOptions): Promise<CostBasisReport> {
  const { store, tenantId, entityId, account, asset } = options
  const method = options.method ?? 'fifo'
  if (method !== 'fifo' && method !== 'lifo') throw new RangeError('Unknown cost basis method')
  const cutoff = options.to ?? options.asOf ?? null

  // Collect all movements for the tenant and asset
  const PAGE = 500
  let afterSeq: number | undefined
  const allMovements: Movement[] = []
  for (;;) {
    const page = await store.listMovements({
      tenantId,
      limit: PAGE,
      ...(entityId !== undefined ? { entityId } : {}),
      ...(account !== undefined ? { account } : {}),
      ...(afterSeq !== undefined ? { afterSeq } : {}),
    })
    for (const m of page) {
      if (m.amount.asset === asset) allMovements.push(m)
    }
    if (page.length < PAGE) break
    afterSeq = page[page.length - 1]!.seq
  }

  // Sort by occurredAt asc, then seq asc
  allMovements.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.seq - b.seq)

  const lots: MutableLot[] = []
  const allDisposals: Disposal[] = []
  const unvaluedCredits: Movement[] = []

  let repAsset: AssetId = options.reportingAsset ?? ('USD' as AssetId)
  let repDecimals = STROOP_DECIMALS
  let repDetermined = options.reportingAsset !== undefined

  for (const m of allMovements) {
    if (cutoff !== null && m.occurredAt >= cutoff) break

    const val = await store.getValuation(tenantId, m.id)
    if (val !== null && repDetermined && val.reportingAsset !== repAsset) throw new Error('Mixed reporting currencies in cost basis')
    if (!repDetermined && val !== null) {
      repAsset = val.reportingAsset
      repDecimals = val.value.decimals
      repDetermined = true
    }

    if (m.direction === 'credit') {
      if (val === null) {
        unvaluedCredits.push(m)
      }
      lots.push({
        movementId: m.id,
        occurredAt: m.occurredAt,
        account: m.account,
        asset: m.amount.asset,
        originalAmount: m.amount,
        remainingAmountRaw: m.amount.raw,
        originalCost: val?.value ?? Money.fromRaw(0n, repAsset, repDecimals),
        unknownCost: val === null,
        remainingCostRaw: val?.value.raw ?? 0n,
      })
    } else {
      // Debit or fee
      let neededRaw = m.amount.raw
      const slices: LotSlice[] = []
      let totalDisposalCostRaw = 0n
      let unknownRaw = 0n

      // Method determines iteration order
      const candidateIndices =
        method === 'fifo'
          ? Array.from({ length: lots.length }, (_, i) => i)
          : Array.from({ length: lots.length }, (_, i) => lots.length - 1 - i)

      for (const idx of candidateIndices) {
        const lot = lots[idx]!
        if (lot.account !== m.account || lot.remainingAmountRaw <= 0n) continue
        const takeRaw = lot.remainingAmountRaw < neededRaw ? lot.remainingAmountRaw : neededRaw

        let costTakenRaw: bigint
        if (takeRaw === lot.remainingAmountRaw) {
          costTakenRaw = lot.remainingCostRaw
        } else {
          // Integer round-half-up:
          // (takeRaw * originalCostRaw + originalAmountRaw / 2n) / originalAmountRaw
          const num = takeRaw * lot.originalCost.raw + lot.originalAmount.raw / 2n
          costTakenRaw = num / lot.originalAmount.raw
          if (costTakenRaw > lot.remainingCostRaw) costTakenRaw = lot.remainingCostRaw
        }

        if (lot.unknownCost) unknownRaw += takeRaw
        lot.remainingAmountRaw -= takeRaw
        lot.remainingCostRaw -= costTakenRaw
        neededRaw -= takeRaw
        totalDisposalCostRaw += costTakenRaw

        slices.push({
          lotMovementId: lot.movementId,
          amount: Money.fromRaw(takeRaw, asset, m.amount.decimals),
          cost: Money.fromRaw(costTakenRaw, repAsset, repDecimals),
        })

        if (neededRaw === 0n) break
      }

      const cost = Money.fromRaw(totalDisposalCostRaw, repAsset, repDecimals)
      const proceeds = val !== null ? val.value : null
      const missingCostAmount = Money.fromRaw(unknownRaw + neededRaw, asset, m.amount.decimals)
      const gain = proceeds !== null && missingCostAmount.isZero() ? proceeds.subtract(cost) : null

      allDisposals.push({
        movementId: m.id,
        occurredAt: m.occurredAt,
        account: m.account,
        asset: m.amount.asset,
        amount: m.amount,
        proceeds,
        cost,
        gain,
        missingCostAmount,
        lotsUsed: Object.freeze(slices),
      })
    }
  }

  // Filter disposals for period [from, to)
  const reportDisposals = allDisposals.filter((d) => {
    if (options.from !== undefined && d.occurredAt < options.from) return false
    if (options.to !== undefined && d.occurredAt >= options.to) return false
    return true
  })

  // Open lots: remainingAmountRaw > 0
  const openLots: OpenLot[] = lots
    .filter((l) => l.remainingAmountRaw > 0n && !l.unknownCost)
    .map((l) =>
      Object.freeze({
        movementId: l.movementId,
        occurredAt: l.occurredAt,
        account: l.account,
        asset: l.asset,
        originalAmount: l.originalAmount,
        remainingAmount: Money.fromRaw(l.remainingAmountRaw, l.asset, l.originalAmount.decimals),
        originalCost: l.originalCost,
        remainingCost: Money.fromRaw(l.remainingCostRaw, repAsset, repDecimals),
      }),
    )

  // Compute total proceeds, total cost and realized gains for reported disposals
  let totalCostRaw = 0n
  let totalProceedsRaw: bigint | null = 0n
  let realizedGainRaw: bigint | null = 0n

  for (const d of reportDisposals) {
    totalCostRaw += d.cost.raw
    if (d.proceeds !== null && totalProceedsRaw !== null) {
      totalProceedsRaw += d.proceeds.raw
    } else {
      totalProceedsRaw = null
    }
    if (d.gain !== null && realizedGainRaw !== null) {
      realizedGainRaw += d.gain.raw
    } else {
      realizedGainRaw = null
    }
  }

  const totalCost = Money.fromRaw(totalCostRaw, repAsset, repDecimals)
  const totalProceeds = totalProceedsRaw !== null ? Money.fromRaw(totalProceedsRaw, repAsset, repDecimals) : null
  const realizedGain = realizedGainRaw !== null ? Money.fromRaw(realizedGainRaw, repAsset, repDecimals) : null

  return {
    tenantId,
    entityId: entityId ?? null,
    account: account ?? null,
    asset,
    reportingAsset: repAsset,
    method,
    from: options.from ?? null,
    to: options.to ?? null,
    asOf: options.asOf ?? null,
    openLots: Object.freeze(openLots),
    disposals: Object.freeze(reportDisposals),
    totalProceeds,
    totalCost,
    realizedGain,
    unvaluedCredits: Object.freeze(unvaluedCredits),
  }
}
