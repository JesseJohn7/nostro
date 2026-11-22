/**
 * Valuation of movements in a reporting currency (Issue #59).
 *
 * All amounts and prices are exact fractions and bigints. Never floats.
 *
 * ## Rounding rule
 *
 * When converting an amount from base asset to quote (reporting) asset:
 *   quoteRaw = (baseRaw * 10^quoteDecimals * price.n + (10^baseDecimals * price.d) / 2) / (10^baseDecimals * price.d)
 * This is standard integer round-half-up arithmetic.
 */
import type { Movement, Price, PriceFraction, PriceSource } from '../model/index.js'
import type { AssetId } from '../money/index.js'
import { Money, STROOP_DECIMALS, isNative, issuerOf, isContractAsset } from '../money/index.js'
import type { Store } from '../store/index.js'

export function convertAmount(
  amount: Money,
  price: PriceFraction,
  reportingAsset: AssetId,
  reportingDecimals: number = STROOP_DECIMALS,
): Money {
  if (price.d === 0n) throw new Error("Price denominator cannot be zero")
  if (price.n <= 0n || price.d <= 0n) throw new RangeError('Price must be a positive fraction')
  if (amount.asset === reportingAsset && amount.decimals === reportingDecimals) {
    return amount
  }
  const isNeg = amount.raw < 0n
  const absRaw = isNeg ? -amount.raw : amount.raw

  const numScale = 10n ** BigInt(reportingDecimals)
  const denScale = 10n ** BigInt(amount.decimals)
  const num = absRaw * numScale * price.n
  const den = denScale * price.d
  if (den === 0n) throw new Error('Price denominator cannot be zero')

  const rounded = (num + den / 2n) / den
  const finalRaw = isNeg ? -rounded : rounded
  return Money.fromRaw(finalRaw, reportingAsset, reportingDecimals)
}

/**
 * Price source backed by a memory map or list of recorded prices.
 */
export class MapPriceSource implements PriceSource {
  constructor(private readonly prices: readonly Price[]) {}

  async price(base: AssetId, quote: AssetId, instant: Date): Promise<Price | null> {
    const matching = this.prices.filter((p) => p.base === base && p.quote === quote)
    if (matching.length === 0) return null
    // Find price closest to instant
    const target = instant.getTime()
    let closest: Price | null = null
    let minDiff = Number.POSITIVE_INFINITY
    for (const p of matching) {
      const diff = Math.abs(p.timestamp.getTime() - target)
      if (diff < minDiff) {
        minDiff = diff
        closest = p
      }
    }
    return closest
  }
}

/**
 * Price source that queries Horizon trade aggregations endpoint.
 */
export class HorizonPriceSource implements PriceSource {
  private readonly url: string
  private readonly fetch: typeof globalThis.fetch

  constructor(options: { url: string; fetch?: typeof globalThis.fetch }) {
    this.url = options.url.replace(/\/+$/, '')
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  async price(base: AssetId, quote: AssetId, instant: Date): Promise<Price | null> {
    if (isContractAsset(base) || isContractAsset(quote)) return null
    const params = new URLSearchParams()
    this.appendAsset(params, 'base', base)
    this.appendAsset(params, 'counter', quote)

    // Segment resolution: 1 hour (3600000 ms) or 1 minute (60000 ms)
    const resolution = 3600000
    const instantMs = instant.getTime()
    // Window around instant
    const startTime = Math.floor(instantMs / resolution) * resolution
    const endTime = startTime + resolution
    params.set('resolution', String(resolution))
    params.set('start_time', String(startTime))
    params.set('end_time', String(endTime))
    params.set('limit', '10')
    params.set('order', 'asc')

    const reqUrl = `${this.url}/trade_aggregations?${params.toString()}`
    const res = await this.fetch(reqUrl)
    if (!res.ok) {
      if (res.status === 404) return null
      throw new Error(`Horizon trade_aggregations returned HTTP ${res.status}`)
    }
    const data = (await res.json()) as {
      _embedded?: {
        records?: Array<{
          timestamp: string | number
          count: string | number
          close_r: { n: string | number; d: string | number }
        }>
      }
    }
    const records = data._embedded?.records ?? []
    if (records.length === 0) return null

    // Filter segments that had trades
    const withTrades = records.filter((r) => Number(r.count) > 0 && Number(r.timestamp) === startTime)
    if (withTrades.length === 0) return null

    // Pick segment closest to instant
    let chosen = withTrades[0]!
    let minDiff = Math.abs(Number(chosen.timestamp) - instantMs)
    for (const r of withTrades) {
      const diff = Math.abs(Number(r.timestamp) - instantMs)
      if (diff < minDiff) {
        minDiff = diff
        chosen = r
      }
    }

    const n = BigInt(chosen.close_r.n)
    const d = BigInt(chosen.close_r.d)
    return {
      base,
      quote,
      price: { n, d },
      source: 'horizon',
      timestamp: new Date(Number(chosen.timestamp)),
    }
  }

  private appendAsset(params: URLSearchParams, prefix: 'base' | 'counter', assetId: AssetId): void {
    if (isNative(assetId)) {
      params.set(`${prefix}_asset_type`, 'native')
      return
    }
    if (isContractAsset(assetId)) throw new Error('Horizon does not price contract tokens')
    // Classic CODE:ISSUER asset
    const colon = assetId.indexOf(':')
    const code = colon === -1 ? assetId : assetId.slice(0, colon)
    const issuer = issuerOf(assetId) ?? ''
    const type = code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12'
    params.set(`${prefix}_asset_type`, type)
    params.set(`${prefix}_asset_code`, code)
    params.set(`${prefix}_asset_issuer`, issuer)
  }
}

export interface ValueMovementsOptions {
  readonly store: Store
  readonly tenantId: string
  readonly priceSource: PriceSource
  readonly reportingAsset: AssetId
  readonly entityId?: string
  readonly reportingDecimals?: number
  readonly pageSize?: number
  readonly from?: Date
  readonly to?: Date
}

export interface ValueMovementsResult {
  readonly examined: number
  readonly valued: number
  readonly skipped: number
}

/**
 * Sweep movements that do not have a valuation yet and value them.
 * Running the sweep again changes nothing (idempotent).
 */
export async function valueMovements(options: ValueMovementsOptions): Promise<ValueMovementsResult> {
  const { store, tenantId, priceSource, reportingAsset } = options
  const reportingDecimals = options.reportingDecimals ?? STROOP_DECIMALS
  const pageSize = options.pageSize ?? 500

  let examined = 0
  let valued = 0
  let skipped = 0
  let afterSeq: number | undefined

  for (;;) {
    const page: Movement[] = await store.listMovements({
      tenantId,
      limit: pageSize,
      ...(options.entityId === undefined ? {} : { entityId: options.entityId }),
      ...(afterSeq !== undefined ? { afterSeq } : {}),
    })
    if (page.length === 0) break

    for (const m of page) {
      if (options.from !== undefined && m.occurredAt < options.from) continue
      if (options.to !== undefined && m.occurredAt >= options.to) continue
      examined++

      const existing = await store.getValuation(tenantId, m.id)
      if (existing !== null) {
        skipped++
        continue
      }

      // If asset is already the reporting asset, price is 1/1
      let price: Price | null = null
      if (m.amount.asset === reportingAsset) {
        price = {
          base: reportingAsset,
          quote: reportingAsset,
          price: { n: 1n, d: 1n },
          source: 'identity',
          timestamp: m.occurredAt,
        }
      } else {
        price = await priceSource.price(m.amount.asset, reportingAsset, m.occurredAt)
      }

      if (price === null) {
        // Missing price or no trades in segment: leaves unvalued
        continue
      }

      const val = convertAmount(m.amount.abs(), price.price, reportingAsset, reportingDecimals)
      await store.transaction(async (tx) => {
        await tx.insertValuations([
          {
            movementId: m.id,
            tenantId,
            reportingAsset,
            priceNumerator: price!.price.n,
            priceDenominator: price!.price.d,
            priceSource: price!.source,
            priceTimestamp: price!.timestamp,
            value: val,
            valuedAt: new Date(),
          },
        ])
      })
      valued++
    }

    if (page.length < pageSize) break
    afterSeq = page[page.length - 1]!.seq
  }

  return { examined, valued, skipped }
}
