/**
 * Accounting reports (issues #56 and #57).
 *
 * All amounts are computed with exact bigint arithmetic, so they are correct
 * on every store — including SQLite, where `journal_lines.amount` is TEXT and
 * SQL SUM cannot add it up exactly.
 *
 * ## Trial balance (issue #56)
 *
 * `trialBalance({ store, tenantId, asOf? })` returns, per account and asset:
 *   - total debits
 *   - total credits
 *   - net balance (debits − credits, as a signed bigint)
 * plus an overall check that every asset balances across all accounts.
 *
 * ## Account ledger (issue #56)
 *
 * `accountLedger({ store, tenantId, account, asset, from?, to? })` returns:
 *   - an opening balance (net before `from`)
 *   - each line within the range, with its entry, movement id and tx hash
 *   - a running balance after each line
 *
 * ## Balance sheet (issue #57)
 *
 * `balanceSheet({ store, tenantId, asOf?, kindMap? })` groups accounts by
 * kind (asset, liability, equity) and adds a "current earnings" computed line
 * (income − expenses) so the sheet balances. One column per asset — no cross-
 * asset arithmetic, as nostro has no exchange rates.
 *
 * ## Income statement (issue #57)
 *
 * `incomeStatement({ store, tenantId, from?, to?, kindMap? })` groups income
 * and expense accounts. One column per asset.
 *
 * ## Date semantics
 *
 * All reports work by `effectiveAt`. `correction` entries take the original
 * entry's effective date, so a report as of 31 October can change if a
 * correction is later posted with that original date. This is consistent with
 * standard accrual-basis accounting.
 */
import type { JournalEntry } from '../model/index.js'
import { Money } from '../money/index.js'
import type { Store } from '../store/index.js'
import type { AccountKind, AccountKindMap } from './chart.js'
import { resolveKind } from './chart.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAGE = 500

/** Scan every journal entry for a tenant, paged. */
async function* scanEntries(
  store: Store,
  tenantId: string,
  effectiveBefore?: Date,
  entityId?: string,
): AsyncGenerator<JournalEntry> {
  let afterSeq: number | undefined
  for (;;) {
    const page = await store.listJournalEntries({
      tenantId,
      ...(entityId === undefined ? {} : { entityId }),
      limit: PAGE,
      ...(afterSeq !== undefined ? { afterSeq } : {}),
      ...(effectiveBefore !== undefined ? { effectiveBefore } : {}),
    })
    for (const e of page) yield e
    if (page.length < PAGE) break
    afterSeq = page[page.length - 1]!.seq
  }
}

/** Signed raw unit balance of a line: debit = positive, credit = negative. */
const signedRaw = (side: 'debit' | 'credit', raw: bigint): bigint => (side === 'debit' ? raw : -raw)

const linesFor = (entry: JournalEntry, entityId?: string) =>
  entityId === undefined ? entry.lines : entry.lines.filter((line) => line.entityId === entityId)

// ---------------------------------------------------------------------------
// Trial balance (issue #56)
// ---------------------------------------------------------------------------

export interface TrialBalanceLine {
  /** Account code. */
  readonly account: string
  /** Asset id (e.g. "native", "USDC:GA5Z…"). */
  readonly asset: string
  readonly decimals: number
  /** Sum of all debit amounts (always ≥ 0). */
  readonly totalDebits: bigint
  /** Sum of all credit amounts (always ≥ 0). */
  readonly totalCredits: bigint
  /** Net balance = totalDebits − totalCredits. Positive = debit balance. */
  readonly netBalance: bigint
}

export interface TrialBalanceReport {
  readonly lines: readonly TrialBalanceLine[]
  /**
   * Whether the trial balance balances: per asset, the sum of all net balances
   * must be zero (every debit has a corresponding credit). `true` = balanced.
   */
  readonly balanced: boolean
  /** The asset-level totals used in the balance check. */
  readonly assetTotals: readonly { readonly asset: string; readonly net: bigint }[]
}

export interface TrialBalanceOptions {
  readonly store: Store
  readonly tenantId: string
  readonly entityId?: string
  /**
   * Balance as of this instant (exclusive upper bound on effectiveAt).
   * Omit for a balance that includes everything posted so far.
   */
  readonly asOf?: Date
}

export async function trialBalance(options: TrialBalanceOptions): Promise<TrialBalanceReport> {
  const { store, tenantId, asOf, entityId } = options

  // key: `account\0asset/decimals`
  interface Slot { totalDebits: bigint; totalCredits: bigint; account: string; asset: string; decimals: number }
  const slots = new Map<string, Slot>()

  for await (const entry of scanEntries(store, tenantId, asOf, entityId)) {
    for (const line of linesFor(entry, entityId)) {
      const key = `${line.account}\0${line.amount.asset}/${line.amount.decimals}`
      let slot = slots.get(key)
      if (slot === undefined) {
        slot = { totalDebits: 0n, totalCredits: 0n, account: line.account, asset: line.amount.asset, decimals: line.amount.decimals }
        slots.set(key, slot)
      }
      if (line.side === 'debit') slot.totalDebits += line.amount.raw
      else slot.totalCredits += line.amount.raw
    }
  }

  const lines: TrialBalanceLine[] = []
  const assetNetMap = new Map<string, bigint>()

  for (const slot of slots.values()) {
    const netBalance = slot.totalDebits - slot.totalCredits
    lines.push({ account: slot.account, asset: slot.asset, decimals: slot.decimals, totalDebits: slot.totalDebits, totalCredits: slot.totalCredits, netBalance })
    const assetKey = slot.asset
    assetNetMap.set(assetKey, (assetNetMap.get(assetKey) ?? 0n) + netBalance)
  }

  lines.sort((a, b) => a.account.localeCompare(b.account) || a.asset.localeCompare(b.asset))

  const assetTotals = [...assetNetMap.entries()]
    .map(([asset, net]) => ({ asset, net }))
    .sort((a, b) => a.asset.localeCompare(b.asset))

  const balanced = assetTotals.every((t) => t.net === 0n)
  return { lines, balanced, assetTotals }
}

// ---------------------------------------------------------------------------
// Account ledger (issue #56)
// ---------------------------------------------------------------------------

export interface LedgerEntryLine {
  readonly entryId: string
  readonly seq: number
  readonly kind: string
  readonly effectiveAt: Date
  readonly postedAt: Date
  readonly description: string
  readonly side: 'debit' | 'credit'
  readonly amount: Money
  readonly movementId: string | null
  readonly txHash: string | null
  /** Running balance after this line (debit-positive). */
  readonly runningBalance: bigint
}

export interface AccountLedgerReport {
  readonly account: string
  readonly asset: string
  /** Opening balance (debit-positive) before `from`. */
  readonly openingBalance: bigint
  readonly lines: readonly LedgerEntryLine[]
  /** Closing balance after the last line. */
  readonly closingBalance: bigint
}

export interface AccountLedgerOptions {
  readonly store: Store
  readonly tenantId: string
  readonly entityId?: string
  readonly account: string
  /** The full asset id to report on (e.g. "native" or "USDC:GA5Z…"). */
  readonly asset: string
  /** Start of the range (inclusive). Opening balance is computed before this. */
  readonly from?: Date
  /** End of the range (exclusive). */
  readonly to?: Date
}

export async function accountLedger(options: AccountLedgerOptions): Promise<AccountLedgerReport> {
  const { store, tenantId, entityId, account, asset } = options

  // --- Opening balance: sum everything before `from` ---
  let openingBalance = 0n
  if (options.from !== undefined) {
    for await (const entry of scanEntries(store, tenantId, options.from, entityId)) {
      for (const line of linesFor(entry, entityId)) {
        if (line.account !== account || line.amount.asset !== asset) continue
        openingBalance += signedRaw(line.side, line.amount.raw)
      }
    }
  }

  // --- Lines within the range ---
  const ledgerLines: LedgerEntryLine[] = []
  let runningBalance = openingBalance

  for await (const entry of scanEntries(store, tenantId, options.to, entityId)) {
    if (options.from !== undefined && entry.effectiveAt.getTime() < options.from.getTime()) continue
    for (const line of linesFor(entry, entityId)) {
      if (line.account !== account || line.amount.asset !== asset) continue
      runningBalance += signedRaw(line.side, line.amount.raw)
      ledgerLines.push({
        entryId: entry.id,
        seq: entry.seq,
        kind: entry.kind,
        effectiveAt: entry.effectiveAt,
        postedAt: entry.postedAt,
        description: entry.description,
        side: line.side,
        amount: line.amount,
        movementId: entry.movementId,
        txHash: null, // txHash lives on movement; not on the entry
        runningBalance,
      })
    }
  }

  return { account, asset, openingBalance, lines: ledgerLines, closingBalance: runningBalance }
}

// ---------------------------------------------------------------------------
// Balance sheet (issue #57)
// ---------------------------------------------------------------------------

export interface BalanceSheetSection {
  readonly kind: AccountKind
  /** Per account, per asset: net balance (debit-positive). */
  readonly accounts: readonly { readonly account: string; readonly asset: string; readonly balance: bigint; readonly decimals: number }[]
}

export interface BalanceSheetReport {
  readonly asOf: Date | null
  readonly sections: readonly BalanceSheetSection[]
  /**
   * Current earnings per asset (income − expenses, positive = profit).
   * This is a computed line, not from an equity account, since nostro does
   * not close income/expense to equity.
   */
  readonly currentEarnings: readonly { readonly asset: string; readonly amount: bigint; readonly decimals: number }[]
  /**
   * Whether the sheet balances per asset:
   * assets = liabilities + equity + currentEarnings (after sign conventions).
   */
  readonly balanced: boolean
}

export interface BalanceSheetOptions {
  readonly store: Store
  readonly tenantId: string
  readonly entityId?: string
  /** Balance as of this instant. Omit for all-time. */
  readonly asOf?: Date
  /**
   * Explicit kind map for account codes without a standard prefix.
   * Codes that have a standard prefix (assets:, liabilities:, etc.) do not
   * need an entry here.
   */
  readonly kindMap?: AccountKindMap
}

export async function balanceSheet(options: BalanceSheetOptions): Promise<BalanceSheetReport> {
  const { store, tenantId, kindMap = {} } = options
  const tb = await trialBalance({
    store,
    tenantId,
    ...(options.entityId === undefined ? {} : { entityId: options.entityId }),
    ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
  })

  // Group by kind
  interface AccountAssetBalance { account: string; asset: string; balance: bigint; decimals: number }
  const byKind = new Map<AccountKind, AccountAssetBalance[]>()
  const incomeNet = new Map<string, { amount: bigint; decimals: number }>() // asset → net

  for (const line of tb.lines) {
    let kind: AccountKind
    try {
      kind = resolveKind(line.account, kindMap)
    } catch {
      // Skip accounts we can't classify — caller should provide a kindMap for customs.
      continue
    }

    if (kind === 'income' || kind === 'expense') {
      // Accumulate for currentEarnings: income credits are positive earnings,
      // expense debits are negative earnings. Use the convention that
      // income accounts normally have credit balances (netBalance < 0 in our
      // debit-positive scheme), so we negate them for the earnings line.
      const existing = incomeNet.get(line.asset)
      // income: credit normal → netBalance = debits - credits, normally negative → earnings += -netBalance
      // expense: debit normal → netBalance = debits - credits, normally positive → earnings += -netBalance
      const earningsContrib = -line.netBalance
      if (existing === undefined) {
        incomeNet.set(line.asset, { amount: earningsContrib, decimals: line.decimals })
      } else {
        existing.amount += earningsContrib
      }
      continue
    }

    if (!byKind.has(kind)) byKind.set(kind, [])
    byKind.get(kind)!.push({ account: line.account, asset: line.asset, balance: line.netBalance, decimals: line.decimals })
  }

  const sections: BalanceSheetSection[] = []
  for (const kind of ['asset', 'liability', 'equity'] as const) {
    sections.push({ kind, accounts: byKind.get(kind) ?? [] })
  }

  const currentEarnings = [...incomeNet.entries()]
    .map(([asset, v]) => ({ asset, amount: v.amount, decimals: v.decimals }))
    .sort((a, b) => a.asset.localeCompare(b.asset))

  // Balance check: total assets = total liabilities + equity + currentEarnings (per asset)
  const assetSums = new Map<string, bigint>()
  const liabEquitySums = new Map<string, bigint>()
  for (const section of sections) {
    for (const row of section.accounts) {
      if (section.kind === 'asset') {
        assetSums.set(row.asset, (assetSums.get(row.asset) ?? 0n) + row.balance)
      } else {
        // liabilities and equity: credit normal → stored as negative in debit-positive
        liabEquitySums.set(row.asset, (liabEquitySums.get(row.asset) ?? 0n) + row.balance)
      }
    }
  }
  for (const e of currentEarnings) {
    // currentEarnings is credit-normal (positive earnings = more liabilities side)
    // In debit-positive, liabilities have negative net; earnings add to that side
    liabEquitySums.set(e.asset, (liabEquitySums.get(e.asset) ?? 0n) - e.amount)
  }

  const allAssets = new Set([...assetSums.keys(), ...liabEquitySums.keys()])
  let balanced = true
  for (const asset of allAssets) {
    const a = assetSums.get(asset) ?? 0n
    const l = liabEquitySums.get(asset) ?? 0n
    if (a + l !== 0n) { balanced = false; break }
  }

  return { asOf: options.asOf ?? null, sections, currentEarnings, balanced }
}

// ---------------------------------------------------------------------------
// Income statement (issue #57)
// ---------------------------------------------------------------------------

export interface IncomeStatementLine {
  readonly account: string
  readonly kind: 'income' | 'expense'
  readonly asset: string
  readonly decimals: number
  /**
   * Net amount for this account in the period.
   * Positive = net income for income accounts; net expense for expense accounts.
   * Both use natural sign (income accounts credit-normal → positive = credits > debits).
   */
  readonly amount: bigint
}

export interface IncomeStatementReport {
  readonly from: Date | null
  readonly to: Date | null
  readonly lines: readonly IncomeStatementLine[]
  /**
   * Net result per asset: income − expenses.
   * Positive = net profit.
   */
  readonly netResult: readonly { readonly asset: string; readonly amount: bigint; readonly decimals: number }[]
}

export interface IncomeStatementOptions {
  readonly store: Store
  readonly tenantId: string
  readonly entityId?: string
  /** Start of period (inclusive). */
  readonly from?: Date
  /** End of period (exclusive). */
  readonly to?: Date
  readonly kindMap?: AccountKindMap
}

export async function incomeStatement(options: IncomeStatementOptions): Promise<IncomeStatementReport> {
  const { store, tenantId, kindMap = {} } = options
  const tb = await trialBalance({
    store,
    tenantId,
    ...(options.entityId === undefined ? {} : { entityId: options.entityId }),
    ...(options.to === undefined ? {} : { asOf: options.to }),
  })

  // For income accounts we also need to subtract anything before `from` to get
  // just the period. We do this by computing a "before" trial balance and diffing.
  let tbBefore: TrialBalanceReport | null = null
  if (options.from !== undefined) {
    tbBefore = await trialBalance({
      store,
      tenantId,
      ...(options.entityId === undefined ? {} : { entityId: options.entityId }),
      asOf: options.from,
    })
  }

  const beforeMap = new Map<string, bigint>()
  if (tbBefore !== null) {
    for (const line of tbBefore.lines) {
      beforeMap.set(`${line.account}\0${line.asset}`, line.netBalance)
    }
  }

  const statLines: IncomeStatementLine[] = []
  const netResultMap = new Map<string, { amount: bigint; decimals: number }>()

  for (const line of tb.lines) {
    let kind: AccountKind
    try {
      kind = resolveKind(line.account, kindMap)
    } catch {
      continue
    }
    if (kind !== 'income' && kind !== 'expense') continue

    const beforeNet = beforeMap.get(`${line.account}\0${line.asset}`) ?? 0n
    const periodNet = line.netBalance - beforeNet

    // For income: credit-normal, so positive amount = -periodNet (credits > debits)
    // For expense: debit-normal, so positive amount = periodNet
    const amount = kind === 'income' ? -periodNet : periodNet

    statLines.push({ account: line.account, kind, asset: line.asset, decimals: line.decimals, amount })

    // Net result: income contributes positively, expense negatively
    const contribution = kind === 'income' ? amount : -amount
    const existing = netResultMap.get(line.asset)
    if (existing === undefined) netResultMap.set(line.asset, { amount: contribution, decimals: line.decimals })
    else existing.amount += contribution
  }

  statLines.sort((a, b) => a.kind.localeCompare(b.kind) || a.account.localeCompare(b.account) || a.asset.localeCompare(b.asset))

  const netResult = [...netResultMap.entries()]
    .map(([asset, v]) => ({ asset, amount: v.amount, decimals: v.decimals }))
    .sort((a, b) => a.asset.localeCompare(b.asset))

  return { from: options.from ?? null, to: options.to ?? null, lines: statLines, netResult }
}
