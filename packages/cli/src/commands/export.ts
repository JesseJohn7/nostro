import { createWriteStream } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { resolve } from 'node:path'
import {
  allocationCsvRows,
  exceptionCsvRows,
  expectationCsvRows,
  journalBeancountRows,
  journalCsvRows,
  journalQuickBooksRows,
  journalXeroRows,
  movementCsvRows,
  parseAsset,
  renderOfx,
  walletStatement,
} from '@nostro-labs/nostro'
import { COMMON, CliError, UsageError, date, flag, integer, positionals, string, tenant } from '../args.js'
import { remote, withBackend } from '../backend.js'
import type { Command } from '../command.js'
import { withStore } from '../command.js'
import { write } from '../io.js'

// Export formats are files or text streams; --json does not apply.
const { json: _json, ...options } = COMMON

const RECORD_KINDS = ['movements', 'expectations', 'exceptions', 'allocations'] as const
type RecordKind = (typeof RECORD_KINDS)[number]
type ExportKind = 'journal' | RecordKind
const JOURNAL_ONLY_OPTIONS = [
  'format',
  'decimals',
  'account',
  'asset',
  'currency',
  'entity',
  'account-map',
  'commodity-map',
  'tax-rate',
  'destination',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function readMap(path: string, cwd: string, label: string): Promise<Readonly<Record<string, string>>> {
  const resolved = resolve(cwd, path)
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(resolved, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new UsageError(`Cannot read ${label} JSON map ${resolved}: ${message}`)
  }
  if (!isRecord(parsed) || Object.entries(parsed).some(([key, value]) => key === '' || typeof value !== 'string' || value.trim() === '')) {
    throw new UsageError(`${label} map must be a JSON object of non-empty string keys and values.`)
  }
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw new UsageError(`${label} map values must be strings.`)
    result[key] = value
  }
  return result
}

export const exportJournal: Command = {
  name: 'export',
  summary: 'Export the journal, movements, expectations, exceptions or allocations',
  usage: '[movements|expectations|exceptions|allocations] [--from <date>] [--to <date>] [--output <file>] [options]',
  help: `With no record type, writes journal entries effective in the range as CSV (RFC 4180, CRLF).
Pass movements, expectations, exceptions or allocations to export those records as CSV instead.
Spreadsheet exports guard text cells against formulas. To stdout unless --output is given.
Payer-written memo text is never written unless --include-memo is given with movements.

Options:
  --format <format>   journal only: csv (default), ofx, quickbooks, xero or beancount
  --decimals <n>     Journal only: round CSV amounts to n decimal places (0–38)
  --from <date>       On or after this (journal effective date; movements occurred_at;
                      expectations/allocations created_at; exceptions opened_at)
  --to <date>         Strictly before this, using the same field as --from
  --include-memo      Add the memo_value column to movements (default: omitted)
  --account <G...>    Journal only: wallet account to export; required with --format ofx
  --asset <id>        Full asset id (CODE:ISSUER, or native); required with ofx
  --currency <code>   ISO 4217 code for the OFX CURDEF; required unless the asset code is one
  --entity <id>       Only lines belonging to this entity
  --output <file>     Write to this file; it must not exist, unless --force
  --force             Overwrite --output if it exists
  --account-map <file> JSON map from nostro account codes to QuickBooks names or Xero codes
  --commodity-map <file> JSON map from full asset ids (CODE:ISSUER) to Beancount commodities
  --tax-rate <name>   Xero tax rate already configured in the organisation (default "No Tax")
  --db <path|url>     SQLite file, or a postgres:// URL (env NOSTRO_DB; default ./nostro.db)
  --tenant <id>       Whose records to use (env NOSTRO_TENANT; default "default")
  --destination       Name of the export destination high-water mark to use (default: none)
  -h, --help          Show this help

Dates are 2026-10-31 (midnight UTC) or an instant with its offset, 2026-10-31T17:00:00+01:00.`,
  options: {
    ...options,
    format: { type: 'string' },
    decimals: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    account: { type: 'string' },
    asset: { type: 'string' },
    currency: { type: 'string' },
    entity: { type: 'string' },
    output: { type: 'string' },
    force: { type: 'boolean' },
    'include-memo': { type: 'boolean' },
    'account-map': { type: 'string' },
    'commodity-map': { type: 'string' },
    'tax-rate': { type: 'string' },
    destination: { type: 'string' },
  },
  async run(args, io) {
    const kindArg = positionals(args, 1)[0]
    if (kindArg !== undefined && !(RECORD_KINDS as readonly string[]).includes(kindArg)) {
      throw new UsageError(`Unknown export type ${JSON.stringify(kindArg)}; use movements, expectations, exceptions or allocations.`)
    }
    const kind = (kindArg ?? 'journal') as ExportKind
    const recordExport = kind !== 'journal'
    if (recordExport) {
      for (const name of JOURNAL_ONLY_OPTIONS) {
        if (string(args, name) !== undefined) throw new UsageError(`--${name} only applies to journal exports.`)
      }
      if (kind !== 'movements' && flag(args, 'include-memo')) {
        throw new UsageError('--include-memo only applies to movements exports.')
      }
    } else if (flag(args, 'include-memo')) {
      throw new UsageError('--include-memo only applies to movements exports.')
    }
    const tenantId = tenant(args, io)
    const from = date(args, 'from')
    const to = date(args, 'to')
    if (from !== undefined && to !== undefined && from >= to) throw new UsageError('--from must be before --to.')
    const format = string(args, 'format') ?? 'csv'
    const decimals = string(args, 'decimals') === undefined ? undefined : integer(args, 'decimals', 7, 0, 38)
    if (decimals !== undefined && format !== 'csv') throw new UsageError('--decimals only applies to CSV exports.')
    if (!['csv', 'ofx', 'quickbooks', 'xero', 'beancount'].includes(format)) {
      throw new UsageError('--format must be csv, ofx, quickbooks, xero or beancount.')
    }
    const ofxAccount = string(args, 'account')
    const ofxAsset = string(args, 'asset')
    const ofxCurrency = string(args, 'currency')
    const entityId = string(args, 'entity')
    if (format === 'ofx') {
      if (ofxAccount === undefined) throw new UsageError('--format ofx requires --account <G...>.')
      if (ofxAsset === undefined) throw new UsageError('--format ofx requires --asset <id>.')
      if (from === undefined || to === undefined) throw new UsageError('--format ofx requires --from and --to.')
    } else if (ofxAccount !== undefined || ofxAsset !== undefined || ofxCurrency !== undefined) {
      throw new UsageError('--account, --asset and --currency only apply to OFX exports.')
    }
    const accountMapPath = string(args, 'account-map')
    const commodityMapPath = string(args, 'commodity-map')
    const taxRate = string(args, 'tax-rate')
    if ((format === 'quickbooks' || format === 'xero') && accountMapPath === undefined) {
      throw new UsageError(`--format ${format} requires --account-map <file>.`)
    }
    if (format !== 'quickbooks' && format !== 'xero' && accountMapPath !== undefined) {
      throw new UsageError('--account-map only applies to quickbooks and xero exports.')
    }
    if (format === 'beancount' && commodityMapPath === undefined) {
      throw new UsageError('--format beancount requires --commodity-map <file>.')
    }
    if (format !== 'beancount' && commodityMapPath !== undefined) {
      throw new UsageError('--commodity-map only applies to beancount exports.')
    }
    if (format !== 'xero' && taxRate !== undefined) {
      throw new UsageError('--tax-rate only applies to xero exports.')
    }
    const output = string(args, 'output')
    if (output === undefined && flag(args, 'force')) throw new UsageError('--force only applies with --output.')

    const destination = string(args, 'destination')
    const showBatches = flag(args, 'batches')
    let ofxContent: string | undefined
    let throughSeq = 0
    let afterSeq: number | undefined

    // Remote mode has only journal.csv on the API. Other formats need the
    // store, and the export high-water mark lives in the store too.
    if (remote(args, io) !== undefined) {
      if (format !== 'csv') throw new UsageError(`--format ${format} needs a local database; --api can export csv only.`)
      if (decimals !== undefined) throw new UsageError('--decimals needs a local database; --api exports exact amounts.')
      if (destination !== undefined || showBatches) throw new UsageError('--destination and --batches need a local database.')
      const text = await withBackend(args, io, (backend) =>
        backend.journalCsv({
          tenantId,
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          ...(entityId === undefined ? {} : { entityId }),
        }),
      )
      if (output === undefined) {
        await write(io.stdout, text)
      } else {
        const path = resolve(io.cwd, output)
        await writeFile(path, text, { encoding: 'utf8', flag: flag(args, 'force') ? 'w' : 'wx' })
        await write(io.stdout, `Wrote journal line(s) to ${path}.\n`)
      }
      return 0
    }

    return withStore(args, io, async (store) => {
      let rows: AsyncGenerator<string>
      let rowNoun: string
      if (recordExport) {
        const range = {
          store,
          tenantId,
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
        }
        if (kind === 'movements') {
          rows = movementCsvRows({ ...range, ...(flag(args, 'include-memo') ? { includeMemo: true } : {}) })
          rowNoun = 'movement row(s)'
        } else if (kind === 'expectations') {
          rows = expectationCsvRows(range)
          rowNoun = 'expectation row(s)'
        } else if (kind === 'exceptions') {
          rows = exceptionCsvRows(range)
          rowNoun = 'exception row(s)'
        } else {
          rows = allocationCsvRows(range)
          rowNoun = 'allocation row(s)'
        }
      } else {
        const mark = destination ? await store.exportGetMark(tenantId, destination) : null
        afterSeq = mark === null ? undefined : Number(mark)
        throughSeq = afterSeq ?? 0
        let cursor = afterSeq
        for (;;) {
          if (io.signal?.aborted === true) throw new CliError('Export aborted.')
          const page = await store.listJournalEntries({ tenantId, limit: 500,
            ...(cursor === undefined ? {} : { afterSeq: cursor }),
            ...(from === undefined ? {} : { effectiveFrom: from }),
            ...(to === undefined ? {} : { effectiveBefore: to }),
            ...(entityId === undefined ? {} : { entityId }),
          })
          if (page.length === 0) break
          throughSeq = page[page.length - 1]!.seq
          cursor = throughSeq
          if (page.length < 500) break
        }
        const base = { store, tenantId, throughSeq,
          ...(afterSeq === undefined ? {} : { afterSeq }),
          ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }),
          ...(entityId === undefined ? {} : { entityId }) }

        const accountMap = accountMapPath === undefined ? undefined : await readMap(accountMapPath, io.cwd, 'account')
        const commodityMap = commodityMapPath === undefined ? undefined : await readMap(commodityMapPath, io.cwd, 'commodity')
        rowNoun = 'journal line(s)'
        if (format === 'ofx') {
          const statement = await walletStatement({
            store,
            tenantId,
            account: ofxAccount!,
            asset: parseAsset(ofxAsset!),
            from: from!,
            to: to!,
            ...(entityId === undefined ? {} : { entityId }),
            ...(ofxCurrency === undefined ? {} : { currencyCode: ofxCurrency }),
          })
          ofxContent = renderOfx(statement)
          rows = (async function* () { yield ofxContent! })()
        } else if (format === 'quickbooks' || format === 'xero') {
          if (accountMap === undefined) throw new UsageError(`--format ${format} requires --account-map <file>.`)
          rows =
            format === 'quickbooks'
              ? journalQuickBooksRows({ ...base, accountMap })
              : journalXeroRows({ ...base, accountMap, ...(taxRate === undefined ? {} : { taxRate }) })
        } else if (format === 'beancount') {
          if (commodityMap === undefined) throw new UsageError('--format beancount requires --commodity-map <file>.')
          rows = journalBeancountRows({ ...base, commodityMap })
        } else {
          rows = journalCsvRows({ ...base, ...(decimals === undefined ? {} : { decimals }) })
        }
      }
      if (output === undefined) {
        for await (const row of rows) await write(io.stdout, row)
      } else {
        const path = resolve(io.cwd, output)
        const file = createWriteStream(path, { flags: flag(args, 'force') ? 'w' : 'wx' })
        try {
          await once(file, 'open')
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError(`${path} exists; pass --force to overwrite it.`)
          throw err
        }
        let chunks = 0
        async function* counted() {
          for await (const row of rows) {
            chunks += 1
            yield row
          }
        }
        try {
          // pipeline() waits for drain, and destroys the file on an error at either end.
          await pipeline(Readable.from(counted()), file)
        } catch (err) {
          // Half a ledger is worse than none: leave no partial file behind.
          await rm(path, { force: true })
          throw err
        }
        const message =
          format === 'beancount'
            ? `Wrote Beancount ledger to ${path}.\n`
            : format === 'ofx'
              ? `Wrote OFX statement to ${path}.\n`
              : `Wrote ${Math.max(0, chunks - 1)} ${rowNoun} to ${path}.\n`
        await write(io.stdout, message)
      }

      if (destination && throughSeq > (afterSeq ?? 0)) {
        await store.exportSetMark(tenantId, destination, throughSeq)
      }

      // List batches if requested
      if (showBatches) {
        const batches = await store.exportListBatches(tenantId)
        const header = 'destination,last_seq,last_exported_at,control_totals,checksum'
        await write(io.stdout, header + '\r\n')
        for (const b of batches) {
          await write(io.stdout, `${b.destination},${b.last_seq},${b.last_exported_at},${b.control_totals},${b.checksum}\r\n`)
        }
      }

      return 0
    })
  },
}
