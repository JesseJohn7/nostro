import { createWriteStream } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { resolve } from 'node:path'
import {
  journalBeancountRows,
  journalCsvRows,
  journalQuickBooksRows,
  journalXeroRows,
} from '@nostro-labs/nostro'
import { COMMON, CliError, UsageError, date, flag, positionals, string, tenant } from '../args.js'
import type { Command } from '../command.js'
import { withStore } from '../command.js'
import { write } from '../io.js'

// Export formats are files or text streams; --json does not apply.
const { json: _json, ...options } = COMMON

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
  summary: 'Export the journal as CSV, QuickBooks, Xero or Beancount',
  usage: '[--format <format>] [--from <date>] [--to <date>] [--output <file>] [options]',
  help: `Writes journal entries effective in the range. CSV is RFC 4180 with CRLF line endings;
Beancount is ledger text. Spreadsheet exports guard text cells against formulas. To stdout unless
--output is given. Payer-written memo text is never written.

Options:
  --format <format>   csv (default), quickbooks, xero or beancount
  --from <date>       Entries effective on or after this
  --to <date>         Entries effective before this
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
    from: { type: 'string' },
    to: { type: 'string' },
    output: { type: 'string' },
    force: { type: 'boolean' },
    'account-map': { type: 'string' },
    'commodity-map': { type: 'string' },
    'tax-rate': { type: 'string' },
    destination: { type: 'string' },
  },
  async run(args, io) {
    positionals(args, 0)
    const tenantId = tenant(args, io)
    const from = date(args, 'from')
    const to = date(args, 'to')
    if (from !== undefined && to !== undefined && from >= to) throw new UsageError('--from must be before --to.')
    const format = string(args, 'format') ?? 'csv'
    if (!['csv', 'quickbooks', 'xero', 'beancount'].includes(format)) {
      throw new UsageError('--format must be csv, quickbooks, xero or beancount.')
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

    return withStore(args, io, async (store) => {
      const base = { store, tenantId, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) }
      if (destination) {
        const mark = await store.exportGetMark(tenantId, destination)
        base.afterSeq = mark !== undefined ? Number(mark) : undefined
      }
      const accountMap = accountMapPath === undefined ? undefined : await readMap(accountMapPath, io.cwd, 'account')
      const commodityMap = commodityMapPath === undefined ? undefined : await readMap(commodityMapPath, io.cwd, 'commodity')
      let rows: AsyncGenerator<string>
      if (format === 'quickbooks' || format === 'xero') {
        if (accountMap === undefined) throw new UsageError(`--format ${format} requires --account-map <file>.`)
        rows =
          format === 'quickbooks'
            ? journalQuickBooksRows({ ...base, accountMap })
            : journalXeroRows({ ...base, accountMap, ...(taxRate === undefined ? {} : { taxRate }) })
      } else if (format === 'beancount') {
        if (commodityMap === undefined) throw new UsageError('--format beancount requires --commodity-map <file>.')
        rows = journalBeancountRows({ ...base, commodityMap })
      } else {
        rows = journalCsvRows(base)
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
            : `Wrote ${Math.max(0, chunks - 1)} journal line(s) to ${path}.\n`
        await write(io.stdout, message)
      }

      // Update the high-water mark for the destination after export
      if (destination) {
        // Track the last seq exported by scanning the rows output
        let lastSeq = 0
        // Re-consume: if output went to stdout, we already wrote it; if to a file, re-read
        // For simplicity, we'll query the store for the max seq in the range
        const entries = await store.listJournalEntries({
          tenantId,
          ...(from !== undefined ? { effectiveFrom: from } : {}),
          ...(to !== undefined ? { effectiveBefore: to } : {}),
          ...(afterSeq !== undefined ? { afterSeq: Number(afterSeq) } : {}),
        })
        for (const entry of entries) {
          if (entry.seq > lastSeq) lastSeq = entry.seq
        }
        if (entries.length > 0) {
          await store.exportSetMark(tenantId, destination, lastSeq)
        }
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
