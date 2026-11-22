import type { JournalEntry } from '../model/index.js'
import { journalCsvCell, journalCsvRow, journalEntries } from './csv.js'
import type { JournalCsvOptions } from './csv.js'

export const JOURNAL_QUICKBOOKS_COLUMNS = [
  'Journal No.',
  'Journal Date',
  'Account Name',
  'Debits',
  'Credits',
  'Description',
] as const

export interface JournalQuickBooksOptions extends JournalCsvOptions {
  readonly accountMap: Readonly<Record<string, string>>
}

interface ExportSnapshot {
  readonly throughSeq: number
}

async function validate(options: JournalQuickBooksOptions): Promise<ExportSnapshot> {
  const assets = new Set<string>()
  let throughSeq = 0
  for await (const entry of journalEntries(options)) {
    throughSeq = entry.seq
    for (const line of entry.lines) {
      if (options.entityId !== undefined && line.entityId !== options.entityId) continue
      assets.add(line.amount.asset)
      const mapped = options.accountMap[line.account]
      if (!Object.hasOwn(options.accountMap, line.account) || typeof mapped !== 'string' || mapped.trim() === '') {
        throw new Error(`No QuickBooks account mapping for ${JSON.stringify(line.account)}.`)
      }
    }
  }
  if (assets.size > 1) {
    throw new Error('QuickBooks export contains multiple assets; export one asset at a time without an exchange rate.')
  }
  return { throughSeq }
}

function entryRows(entry: JournalEntry, accountMap: Readonly<Record<string, string>>, entityId?: string): string[] {
  return entry.lines.filter((line) => entityId === undefined || line.entityId === entityId).map((line) =>
    journalCsvRow([
      journalCsvCell(entry.id),
      journalCsvCell(entry.effectiveAt.toISOString().slice(0, 10)),
      journalCsvCell(accountMap[line.account]!, true),
      journalCsvCell(line.side === 'debit' ? line.amount.toString() : null),
      journalCsvCell(line.side === 'credit' ? line.amount.toString() : null),
      journalCsvCell(entry.description, true),
    ]),
  )
}

/** QuickBooks Online journal-entry CSV, one row per journal line. */
export async function* journalQuickBooksRows(options: JournalQuickBooksOptions): AsyncGenerator<string> {
  const snapshot = await validate(options)
  yield journalCsvRow(JOURNAL_QUICKBOOKS_COLUMNS.map((column) => column))
  for await (const entry of journalEntries({ ...options, throughSeq: snapshot.throughSeq })) {
    yield* entryRows(entry, options.accountMap, options.entityId)
  }
}
