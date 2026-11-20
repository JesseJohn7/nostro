/**
 * The journal as CSV: one row per line, RFC 4180, CRLF line endings.
 *
 * Amounts are exact decimal strings in the debit or credit column, never
 * floats. Text cells that a spreadsheet would treat as a formula (starting
 * with `=`, `+`, `-`, `@`, tab or carriage return) are prefixed with `'`,
 * because references and account codes come from users and these files are
 * opened in spreadsheets. Payer-controlled memo text is never written.
 */
import type { JournalEntry } from '../model/index.js'
import type { Store } from '../store/index.js'

export const JOURNAL_CSV_COLUMNS = [
  'entry_id',
  'seq',
  'kind',
  'posted_at',
  'effective_at',
  'description',
  'line_no',
  'account',
  'role',
  'asset',
  'debit',
  'credit',
  'movement_id',
  'tx_hash',
  'expectation_reference',
  'exception_id',
  'exception_code',
] as const

export interface JournalCsvOptions {
  readonly store: Store
  readonly tenantId: string
  /** Entries effective on or after this instant. */
  readonly from?: Date
  /** Entries effective strictly before this instant. */
  readonly to?: Date
  /** Entries read per page. Default 500. */
  readonly pageSize?: number
  /** Internal upper bound used to keep a multi-pass export on one journal snapshot. */
  readonly throughSeq?: number
  /** Metadata keys to read as dimensions. Each key becomes a column named after it. */
  readonly dimensions?: readonly string[]
}

const FORMULA = /^[=+\-@\t\r]/

/** One CSV cell. `text` cells get the formula guard; numbers and ids do not need it. */
export function journalCsvCell(value: string | number | null, text = false): string {
  if (value === null) return ''
  let s = String(value)
  if (text && FORMULA.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

export const journalCsvRow = (cells: readonly string[]) => `${cells.join(',')}\r\n`

/** Read the matching journal entries in bounded pages. */
export async function* journalEntries(options: JournalCsvOptions): AsyncGenerator<JournalEntry> {
  const { store, tenantId } = options
  const pageSize = options.pageSize ?? 500
  let afterSeq: number | undefined
  for (;;) {
    const page: JournalEntry[] = await store.listJournalEntries({
      tenantId,
      limit: pageSize,
      ...(afterSeq === undefined ? {} : { afterSeq }),
      ...(options.from === undefined ? {} : { effectiveFrom: options.from }),
      ...(options.to === undefined ? {} : { effectiveBefore: options.to }),
    })
    for (const entry of page) {
      if (options.throughSeq !== undefined && entry.seq > options.throughSeq) return
      yield entry
    }
    if (page.length < pageSize) return
    afterSeq = page[page.length - 1]!.seq
  }
}

/** The CSV, header first, a row at a time; suitable for streaming large ledgers. */
export async function* journalCsvRows(options: JournalCsvOptions): AsyncGenerator<string> {
  const { store, tenantId } = options
  const txHash = new Map<string, string | null>()
  const reference = new Map<string, string | null>()
  const code = new Map<string, string | null>()
  const dimensionValues = new Map<string, Map<string, string | null>>()

  if (options.dimensions) {
    for (const dim of options.dimensions) {
      dimensionValues.set(dim, new Map())
    }
  }

  const dimColumnNames = options.dimensions ?? []
  const allColumns = [...JOURNAL_CSV_COLUMNS, ...dimColumnNames]
  yield journalCsvRow(allColumns.map((c) => c))

  const expectationMetadatas = new Map<string, Record<string, string | null>>()

  for await (const entry of journalEntries(options)) {
    if (entry.movementId !== null && !txHash.has(entry.movementId)) {
      txHash.set(entry.movementId, (await store.getMovement(tenantId, entry.movementId))?.txHash ?? null)
    }
    for (const [i, line] of entry.lines.entries()) {
      if (line.expectationId !== null && !reference.has(line.expectationId)) {
        reference.set(line.expectationId, (await store.getExpectation(tenantId, line.expectationId))?.reference ?? null)
      }
      if (line.exceptionId !== null && !code.has(line.exceptionId)) {
        code.set(line.exceptionId, (await store.getException(tenantId, line.exceptionId))?.code ?? null)
      }
      const expectationId = line.expectationId ?? null
      if (expectationId && !expectationMetadatas.has(expectationId) && options.dimensions) {
        const expectation = await store.getExpectation(tenantId, expectationId)
        expectationMetadatas.set(expectationId, expectation ? expectation.metadata : {})
      }
      const amount = line.amount.toString()
      const dimCells: string[] = []
      for (const dim of dimColumnNames) {
        const metadata = expectationMetadatas.get(expectationId) ?? {}
        const val = metadata[dim] ?? ''
        dimCells.push(journalCsvCell(val, true))
      }
      yield journalCsvRow([
        journalCsvCell(entry.id),
        journalCsvCell(entry.seq),
        journalCsvCell(entry.kind),
        journalCsvCell(entry.postedAt.toISOString()),
        journalCsvCell(entry.effectiveAt.toISOString()),
        journalCsvCell(entry.description, true),
        journalCsvCell(i + 1),
        journalCsvCell(line.account, true),
        journalCsvCell(line.role),
        journalCsvCell(line.amount.asset),
        journalCsvCell(line.side === 'debit' ? amount : null),
        journalCsvCell(line.side === 'credit' ? amount : null),
        journalCsvCell(entry.movementId),
        journalCsvCell(entry.movementId === null ? null : (txHash.get(entry.movementId) ?? null)),
        journalCsvCell(line.expectationId === null ? null : (reference.get(line.expectationId) ?? null), true),
        ...dimCells,
        journalCsvCell(line.exceptionId),
        journalCsvCell(line.exceptionId === null ? null : (code.get(line.exceptionId) ?? null)),
      ])
    }
  }
}

/** The whole CSV as one string. Prefer `journalCsvRows` for large ledgers. */
export async function journalCsv(options: JournalCsvOptions): Promise<string> {
  let out = ''
  for await (const line of journalCsvRows(options)) out += line
  return out
}
