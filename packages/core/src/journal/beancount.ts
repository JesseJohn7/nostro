import type { JournalEntry } from '../model/index.js'
import { journalEntries } from './csv.js'
import type { JournalCsvOptions } from './csv.js'

export interface JournalBeancountOptions extends JournalCsvOptions {
  /** Map each full nostro asset id (including issuer) to a Beancount commodity. */
  readonly commodityMap: Readonly<Record<string, string>>
}

interface ExportSnapshot {
  readonly throughSeq: number
  readonly openDates: ReadonlyMap<string, string>
  readonly accounts: ReadonlyMap<string, string>
}

function beancountAccount(code: string): string {
  const parts = code.split(':')
  if (parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(part))) {
    throw new Error(`Account ${JSON.stringify(code)} cannot be converted to a Beancount account.`)
  }
  const account = parts.map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`).join(':')
  if (!/^(Assets|Liabilities|Equity|Income|Expenses):/.test(account)) {
    throw new Error(`Account ${JSON.stringify(code)} must start with Assets, Liabilities, Equity, Income or Expenses.`)
  }
  return account
}

function commodityFor(asset: string, commodityMap: Readonly<Record<string, string>>): string {
  const commodity = commodityMap[asset]
  if (!Object.hasOwn(commodityMap, asset) || typeof commodity !== 'string' || !/^[A-Z][A-Z0-9]*$/.test(commodity)) {
    throw new Error(`No valid Beancount commodity mapping for asset ${JSON.stringify(asset)}.`)
  }
  return commodity
}

async function validate(options: JournalBeancountOptions): Promise<ExportSnapshot> {
  const assets = new Set<string>()
  const openDates = new Map<string, string>()
  const accounts = new Map<string, string>()
  const commodityAssets = new Map<string, string>()
  let throughSeq = 0

  for await (const entry of journalEntries(options)) {
    throughSeq = entry.seq
    const date = entry.effectiveAt.toISOString().slice(0, 10)
    for (const line of entry.lines) {
      if (options.entityId !== undefined && line.entityId !== options.entityId) continue
      const account = beancountAccount(line.account)
      const priorCode = accounts.get(account)
      if (priorCode !== undefined && priorCode !== line.account) {
        throw new Error(`Accounts ${JSON.stringify(priorCode)} and ${JSON.stringify(line.account)} map to the same Beancount account.`)
      }
      accounts.set(account, line.account)
      if (!openDates.has(account) || date < openDates.get(account)!) openDates.set(account, date)

      assets.add(line.amount.asset)
      const commodity = commodityFor(line.amount.asset, options.commodityMap)
      const priorAsset = commodityAssets.get(commodity)
      if (priorAsset !== undefined && priorAsset !== line.amount.asset) {
        throw new Error(`Assets ${JSON.stringify(priorAsset)} and ${JSON.stringify(line.amount.asset)} cannot share commodity ${commodity}.`)
      }
      commodityAssets.set(commodity, line.amount.asset)
    }
  }
  for (const asset of assets) commodityFor(asset, options.commodityMap)
  return { throughSeq, openDates, accounts }
}

const quoted = (text: string): string => JSON.stringify(text)

function transactionHeader(entry: JournalEntry): string {
  return `${entry.effectiveAt.toISOString().slice(0, 10)} * ${quoted(entry.description)}\n`
}

/** Beancount ledger text, with validated accounts, per-issuer commodities and open directives. */
export async function* journalBeancountRows(options: JournalBeancountOptions): AsyncGenerator<string> {
  const snapshot = await validate(options)
  const accountNames = [...snapshot.accounts.keys()].sort()
  for (const account of accountNames) {
    yield `${snapshot.openDates.get(account)!} open ${account}\n`
  }
  if (accountNames.length > 0) yield '\n'

  const { store, tenantId } = options
  const txHashes = new Map<string, string | null>()
  const references = new Map<string, string | null>()
  for await (const entry of journalEntries({ ...options, throughSeq: snapshot.throughSeq })) {
    const visibleLines = entry.lines.filter((line) => options.entityId === undefined || line.entityId === options.entityId)
    if (visibleLines.length === 0) continue
    yield transactionHeader(entry)
    if (entry.movementId !== null) {
      if (!txHashes.has(entry.movementId)) {
        txHashes.set(entry.movementId, (await store.getMovement(tenantId, entry.movementId))?.txHash ?? null)
      }
      yield `  movement_id: ${quoted(entry.movementId)}\n`
      const txHash = txHashes.get(entry.movementId)
      if (txHash != null) yield `  tx_hash: ${quoted(txHash)}\n`
    }
    for (const line of visibleLines) {
      const account = beancountAccount(line.account)
      const amount = `${line.side === 'debit' ? '' : '-'}${line.amount.toString()}`
      const commodity = commodityFor(line.amount.asset, options.commodityMap)
      yield `  ${account}  ${amount} ${commodity}\n`
      if (line.expectationId !== null) {
        if (!references.has(line.expectationId)) {
          references.set(line.expectationId, (await store.getExpectation(tenantId, line.expectationId))?.reference ?? null)
        }
        const reference = references.get(line.expectationId)
        if (reference != null) yield `    expectation_reference: ${quoted(reference)}\n`
      }
    }
    yield '\n'
  }
}

