/** Exact, deterministic precision reduction for a journal export. */
import type { JournalEntry, JournalLine } from '../model/index.js'
import { Money } from '../money/index.js'

export const ROUNDING_ACCOUNT = 'Equity:Rounding'

interface Balance {
  exact: bigint
  exported: bigint
}

function rounded(raw: bigint, factor: bigint): bigint {
  const negative = raw < 0n
  const absolute = negative ? -raw : raw
  const units = (absolute + factor / 2n) / factor
  return negative ? -units : units
}

/** Carries fractional balances between entries, separately for each account and asset. */
export class JournalRounder {
  private readonly balances = new Map<string, Balance>()

  constructor(readonly decimals: number) {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
      throw new RangeError('Export decimals must be an integer between 0 and 38.')
    }
  }

  round(entry: JournalEntry): JournalEntry {
    const lines: JournalLine[] = []
    const source: { line: JournalLine; key: string; signed: bigint; index: number }[] = []
    const factors = new Map<string, bigint>()
    for (const [index, line] of entry.lines.entries()) {
      if (this.decimals > line.amount.decimals) {
        throw new RangeError(`Export decimals exceed source precision for ${line.amount.asset}.`)
      }
      const factor = 10n ** BigInt(line.amount.decimals - this.decimals)
      const key = JSON.stringify([line.account, line.amount.asset])
      const previous = this.balances.get(key) ?? { exact: 0n, exported: 0n }
      const signed = line.side === 'debit' ? line.amount.raw : -line.amount.raw
      const exact = previous.exact + signed
      const exported = rounded(exact, factor)
      this.balances.set(key, { exact, exported })
      factors.set(key, factor)
      source.push({ line, key, signed: exported - previous.exported, index })
    }

    // Bring each asset's entry back into balance. Prefer allocating a unit
    // to a line on the short side, ordered by its fractional remainder.
    const assets = [...new Set(source.map((item) => item.line.amount.asset))]
    for (const asset of assets) {
      let imbalance = source.filter((item) => item.line.amount.asset === asset)
        .reduce((sum, item) => sum + item.signed, 0n)
      while (imbalance !== 0n) {
        const adjustment = imbalance > 0n ? -1n : 1n
        const candidates = source.filter((item) => {
          if (item.line.amount.asset !== asset) return false
          const current = this.balances.get(item.key)!
          const factor = factors.get(item.key)!
          const error = current.exact - (current.exported + adjustment) * factor
          return error > -factor && error < factor
        })
        if (candidates.length === 0) break
        candidates.sort((a, b) => {
          const aPreferred = (a.line.side === 'debit' ? 1n : -1n) === adjustment
          const bPreferred = (b.line.side === 'debit' ? 1n : -1n) === adjustment
          if (aPreferred !== bPreferred) return aPreferred ? -1 : 1
          const aBalance = this.balances.get(a.key)!
          const bBalance = this.balances.get(b.key)!
          const aRemainder = aBalance.exact - aBalance.exported * factors.get(a.key)!
          const bRemainder = bBalance.exact - bBalance.exported * factors.get(b.key)!
          if (aRemainder !== bRemainder) return adjustment * aRemainder > adjustment * bRemainder ? -1 : 1
          return a.index - b.index
        })
        const chosen = candidates[0]!
        chosen.signed += adjustment
        this.balances.get(chosen.key)!.exported += adjustment
        imbalance += adjustment
      }
      if (imbalance !== 0n) {
        const original = source.find((item) => item.line.amount.asset === asset)!.line
        lines.push({
          account: ROUNDING_ACCOUNT,
          role: 'conversion',
          side: imbalance > 0n ? 'credit' : 'debit',
          amount: Money.fromRaw(imbalance > 0n ? imbalance : -imbalance, asset, this.decimals),
          expectationId: null,
          exceptionId: null,
        })
      }
    }

    for (const item of source) {
      if (item.signed === 0n) continue
      const { line, signed } = item
      lines.push({
        ...line,
        side: signed > 0n ? 'debit' : 'credit',
        amount: Money.fromRaw(signed > 0n ? signed : -signed, line.amount.asset, this.decimals),
      })
    }
    return { ...entry, lines }
  }
}
