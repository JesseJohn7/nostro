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
import { JournalRounder } from './round.js'

export const JOURNAL_CSV_COLUMNS = [
  'entry_id',
  'seq',
  'kind',
  'posted_at',
  'effective_at',
  'description',
  'line_no',
  'account',
  'entity',
  'role',
  'asset',
  'debit',
  'credit',
  'movement_id',
  'tx_hash',
  'expectation_reference',
  'exception_id',
  'exception_code',
  'value',
] as const

export interface JournalCsvOptions {
  readonly store: Store
  readonly tenantId: string
  /** Export only lines belonging to this entity. */
  readonly entityId?: string
  /** Entries effective on or after this instant. */
  readonly from?: Date
  /** Entries effective strictly before this instant. */
  readonly to?: Date
  /** Entries read per page. Default 500. */
  readonly pageSize?: number
  /** Internal upper bound used to keep a multi-pass export on one journal snapshot. */
  readonly throughSeq?: number
  /** Export entries with a journal sequence greater than this. */
  readonly afterSeq?: number
  /** Target decimal places for exact, balanced rounding. Omit for unchanged output. */
  readonly decimals?: number
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

async function* journalEntryPages(options: JournalCsvOptions, includeBeforeFrom = false): AsyncGenerator<JournalEntry[]> {
  const { store, tenantId } = options
  const pageSize = options.pageSize ?? 500
  let afterSeq = includeBeforeFrom ? undefined : options.afterSeq
  for (;;) {
    const page = await store.listJournalEntries({
      tenantId,
      ...(options.entityId === undefined ? {} : { entityId: options.entityId }),
      limit: pageSize,
      ...(afterSeq === undefined ? {} : { afterSeq }),
      ...(includeBeforeFrom || options.from === undefined ? {} : { effectiveFrom: options.from }),
      ...(options.to === undefined ? {} : { effectiveBefore: options.to }),
    })
    if (page.length === 0) return
    yield page
    if (page.length < pageSize) return
    afterSeq = page[page.length - 1]!.seq
  }
}

/** Read the matching journal entries in bounded pages. */
export async function* journalEntries(options: JournalCsvOptions, includeBeforeFrom = false): AsyncGenerator<JournalEntry> {
  for await (const page of journalEntryPages(options, includeBeforeFrom)) {
    for (const entry of page) {
      if (options.throughSeq !== undefined && entry.seq > options.throughSeq) return
      yield entry
    }
  }
}

/** The CSV, header first, a row at a time; suitable for streaming large ledgers. */
export async function* journalCsvRows(options: JournalCsvOptions): AsyncGenerator<string> {
  const { store, tenantId } = options
  const dimColumnNames = options.dimensions ?? []
  const allColumns = [...JOURNAL_CSV_COLUMNS, ...dimColumnNames]
  yield journalCsvRow(allColumns.map((c) => c))

  const rounder = options.decimals === undefined ? null : new JournalRounder(options.decimals)

  for await (const originalPage of journalEntryPages(options, rounder !== null)) {
    const page = originalPage.filter((entry) => options.throughSeq === undefined || entry.seq <= options.throughSeq)
    if (page.length === 0) return
    const movementIds = [...new Set(page.flatMap((entry) => entry.movementId === null ? [] : [entry.movementId]))]
    const expectationIds = [...new Set(page.flatMap((entry) => entry.lines.flatMap((line) => line.expectationId === null ? [] : [line.expectationId])))]
    const exceptionIds = [...new Set(page.flatMap((entry) => entry.lines.flatMap((line) => line.exceptionId === null ? [] : [line.exceptionId])))]
    const [movements, expectations, exceptions] = await Promise.all([
      store.listMovements({ tenantId, ids: movementIds }),
      store.listExpectations({ tenantId, ids: expectationIds }),
      store.listExceptions({ tenantId, ids: exceptionIds }),
    ])
    const txHash = new Map(movements.map((movement) => [movement.id, movement.txHash]))
    const reference = new Map(expectations.map((expectation) => [expectation.id, expectation.reference]))
    const codes = new Map(exceptions.map((exception) => [exception.id, exception.code]))
    const valuations = new Map(await Promise.all(movementIds.map(async (id) => [id, (await store.getValuation(tenantId, id))?.value.toString() ?? null] as const)))
    const expectationMetadatas = new Map(expectations.map((expectation) => [expectation.id, expectation.metadata]))

    for (const original of page) {
      const entry = rounder === null ? original : rounder.round(original)
      if (options.afterSeq !== undefined && original.seq <= options.afterSeq) continue
      if (rounder !== null && options.from !== undefined && original.effectiveAt < options.from) continue
      for (const [i, line] of entry.lines.entries()) {
        if (options.entityId !== undefined && line.entityId !== options.entityId) continue
        const expectationId = line.expectationId ?? null
        const amount = line.amount.toString()
        const dimCells: string[] = []
        for (const dim of dimColumnNames) {
          const metadata = (expectationId === null ? undefined : expectationMetadatas.get(expectationId)) ?? {}
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
          journalCsvCell(line.entityId ?? null),
          journalCsvCell(line.role),
          journalCsvCell(line.amount.asset),
          journalCsvCell(line.side === 'debit' ? amount : null),
          journalCsvCell(line.side === 'credit' ? amount : null),
          journalCsvCell(entry.movementId),
          journalCsvCell(entry.movementId === null ? null : (txHash.get(entry.movementId) ?? null)),
          journalCsvCell(line.expectationId === null ? null : (reference.get(line.expectationId) ?? null), true),
          journalCsvCell(line.exceptionId),
          journalCsvCell(line.exceptionId === null ? null : (codes.get(line.exceptionId) ?? null)),
          journalCsvCell(entry.movementId === null ? null : (valuations.get(entry.movementId) ?? null)),
          ...dimCells,
        ])
      }
    }
  }
}

/** The whole CSV as one string. Prefer `journalCsvRows` for large ledgers. */
export async function journalCsv(options: JournalCsvOptions): Promise<string> {
  let out = ''
  for await (const line of journalCsvRows(options)) out += line
  return out
}
