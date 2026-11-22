import type { JournalEntry } from '../model/index.js'
import { journalCsvCell, journalCsvRow, journalEntries } from './csv.js'
import type { JournalCsvOptions } from './csv.js'

export const JOURNAL_XERO_COLUMNS = [
  'Narration',
  'Date',
  'AccountCode',
  'Description',
  'TaxRate',
  'Debit',
  'Credit',
] as const

const XERO_LINE_LIMIT = 300

export interface JournalXeroOptions extends JournalCsvOptions {
  readonly accountMap: Readonly<Record<string, string>>
  /** The tax rate name already configured in Xero. Defaults to "No Tax". */
  readonly taxRate?: string
}

interface ExportSnapshot {
  readonly throughSeq: number
}

async function validate(options: JournalXeroOptions): Promise<ExportSnapshot> {
  const assets = new Set<string>()
  let throughSeq = 0
  let lines = 0
  for await (const entry of journalEntries(options)) {
    throughSeq = entry.seq
    for (const line of entry.lines) {
      if (options.entityId !== undefined && line.entityId !== options.entityId) continue
      lines += 1
      assets.add(line.amount.asset)
      const mapped = options.accountMap[line.account]
      if (!Object.hasOwn(options.accountMap, line.account) || typeof mapped !== 'string' || mapped.trim() === '') {
        throw new Error(`No Xero account mapping for ${JSON.stringify(line.account)}.`)
      }
    }
  }
  if (assets.size > 1) {
    throw new Error('Xero export contains multiple assets; export one asset at a time without an exchange rate.')
  }
  if (lines > XERO_LINE_LIMIT) {
    throw new Error(`Xero manual journal imports are limited to ${XERO_LINE_LIMIT} lines per file; split this export.`)
  }
  if (options.taxRate !== undefined && options.taxRate.trim() === '') {
    throw new Error('Xero tax rate must not be empty.')
  }
  return { throughSeq }
}

function entryRows(
  entry: JournalEntry,
  accountMap: Readonly<Record<string, string>>,
  taxRate: string,
  entityId?: string,
): string[] {
  const narration = `${entry.id} ${entry.description}`
  return entry.lines.filter((line) => entityId === undefined || line.entityId === entityId).map((line) =>
    journalCsvRow([
      journalCsvCell(narration, true),
      journalCsvCell(entry.effectiveAt.toISOString().slice(0, 10)),
      journalCsvCell(accountMap[line.account]!, true),
      journalCsvCell(entry.description, true),
      journalCsvCell(taxRate, true),
      journalCsvCell(line.side === 'debit' ? line.amount.toString() : null),
      journalCsvCell(line.side === 'credit' ? line.amount.toString() : null),
    ]),
  )
}

/** Xero manual-journal CSV, grouped by a unique narration and effective date. */
export async function* journalXeroRows(options: JournalXeroOptions): AsyncGenerator<string> {
  const snapshot = await validate(options)
  yield journalCsvRow(JOURNAL_XERO_COLUMNS.map((column) => column))
  const taxRate = options.taxRate ?? 'No Tax'
  for await (const entry of journalEntries({ ...options, throughSeq: snapshot.throughSeq })) {
    yield* entryRows(entry, options.accountMap, taxRate, options.entityId)
  }
}
