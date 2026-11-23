import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Expectation, NewExpectation } from '@nostro-labs/nostro'
import { ConstraintError, ValidationError } from '@nostro-labs/nostro'
import type { Args } from '../args.js'
import { COMMON, CliError, UsageError, flag, positionals, string, tenant } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, withStore } from '../command.js'
import { parseCsv } from '../csv.js'
import { expectationOf, recordExpectation } from './expect.js'
import { clean, json, write } from '../io.js'

/** Column name in the file, mapped to the `expect` option it sets. */
const OPTION_OF: Readonly<Record<string, string>> = {
  account: 'account',
  amount: 'amount',
  asset: 'asset',
  muxed_id: 'muxed-id',
  memo_text: 'memo-text',
  memo_id: 'memo-id',
  memo_hash: 'memo-hash',
  due: 'due',
  expires: 'expires',
}
const REQUIRED = ['reference', 'account', 'amount'] as const
const SPECIAL = ['reference', 'direction', 'payers'] as const

/** Every column the file may have. `meta.<key>` is also allowed, for any key. */
function knownColumn(name: string): boolean {
  if (name.startsWith('meta.')) return name.length > 'meta.'.length
  return name in OPTION_OF || (SPECIAL as readonly string[]).includes(name)
}

/** One row as `expect` would see it: the reference, then its options. Throws a UsageError for a bad direction. */
function rowArgs(row: ReadonlyMap<string, string>): Args {
  const values: Record<string, string | boolean | string[]> = {}
  const payers: string[] = []
  const meta: string[] = []
  for (const [column, raw] of row) {
    if (raw === '' || column === 'reference') continue
    if (column === 'direction') {
      if (raw === 'debit') values.debit = true
      else if (raw !== 'credit') throw new UsageError(`direction must be credit or debit, not ${JSON.stringify(raw)}.`)
    } else if (column === 'payers') {
      payers.push(...raw.split('|').filter((p) => p !== ''))
    } else if (column.startsWith('meta.')) {
      meta.push(`${column.slice('meta.'.length)}=${raw}`)
    } else {
      values[OPTION_OF[column]!] = raw
    }
  }
  if (payers.length > 0) values.payer = payers
  if (meta.length > 0) values.meta = meta
  return { values, positionals: [row.get('reference') ?? ''], argv: [] }
}

/** The fields two expectations are compared on. Equal fields mean the same expectation. */
function fieldsOf(e: NewExpectation | Expectation): Record<string, string> {
  // Optional fields take the store's defaults, so an omitted field and its default compare equal.
  const memo = e.memo ?? null
  const dueAt = e.dueAt ?? null
  const expiresAt = e.expiresAt ?? null
  const metadata = e.metadata ?? {}
  const payers = e.payers ?? []
  const muxedId = e.muxedId ?? null
  return {
    account: e.account,
    direction: e.direction ?? 'credit',
    amount: e.amount.toString(),
    asset: e.amount.asset,
    muxedId: muxedId === null ? '' : String(muxedId),
    memo: memo === null ? '' : `${memo.type}:${String(memo.value)}`,
    payers: [...payers].sort().join('|'),
    dueAt: dueAt === null ? '' : dueAt.toISOString(),
    expiresAt: expiresAt === null ? '' : expiresAt.toISOString(),
    metadata: JSON.stringify(Object.keys(metadata).sort().map((k) => [k, metadata[k]])),
  }
}

/** The first field on which two expectations differ, or null when they are the same. */
function firstDifference(a: NewExpectation | Expectation, b: NewExpectation | Expectation): string | null {
  const x = fieldsOf(a)
  const y = fieldsOf(b)
  for (const key of Object.keys(x)) if (x[key] !== y[key]) return key
  return null
}

interface RowOutcome {
  readonly line: number
  readonly reference: string
  readonly kind: 'create' | 'skip' | 'conflict'
  readonly expectation?: NewExpectation
  readonly reason?: string
}
interface Refusal {
  readonly line: number
  readonly error: string
}

/** A table of rows, each with the line it came from and its named cells. */
interface Rows {
  readonly rows: readonly { line: number; cells: ReadonlyMap<string, string> }[]
  readonly refused: Refusal[]
}

function fromCsv(text: string): Rows {
  const [header, ...records] = parseCsv(text)
  if (header === undefined) return { rows: [], refused: [] }
  const names = header.cells.map((c) => c.trim())
  for (const name of names) {
    if (!knownColumn(name)) throw new UsageError(`Unknown column ${JSON.stringify(name)} in the header.`)
  }
  for (const required of REQUIRED) {
    if (!names.includes(required)) throw new UsageError(`The header must have a ${required} column.`)
  }
  const rows: { line: number; cells: Map<string, string> }[] = []
  const refused: Refusal[] = []
  for (const record of records) {
    if (record.cells.length !== names.length) {
      refused.push({ line: record.line, error: `expected ${names.length} cells, found ${record.cells.length}.` })
      continue
    }
    rows.push({ line: record.line, cells: new Map(names.map((name, i) => [name, record.cells[i]!])) })
  }
  return { rows, refused }
}

function fromJsonLines(text: string): Rows {
  const rows: { line: number; cells: Map<string, string> }[] = []
  const refused: Refusal[] = []
  const lines = text.split('\n')
  lines.forEach((raw, index) => {
    const line = index + 1
    if (raw.trim() === '') return
    let object: unknown
    try {
      object = JSON.parse(raw)
    } catch {
      refused.push({ line, error: 'not valid JSON.' })
      return
    }
    if (typeof object !== 'object' || object === null || Array.isArray(object)) {
      refused.push({ line, error: 'each line must be a JSON object.' })
      return
    }
    const cells = new Map<string, string>()
    for (const [key, value] of Object.entries(object as Record<string, unknown>)) {
      if (!knownColumn(key)) throw new UsageError(`Unknown field ${JSON.stringify(key)} on line ${line}.`)
      if (value === null) cells.set(key, '')
      else if (typeof value === 'string' || typeof value === 'number') cells.set(key, String(value))
      else {
        refused.push({ line, error: `${key} must be a string or number.` })
        return
      }
    }
    rows.push({ line, cells })
  })
  return { rows, refused }
}

export const importCommand: Command = {
  name: 'import',
  summary: 'Record many expectations from a CSV or JSON Lines file, all or nothing',
  usage: '<file|-> [options]',
  help: `Reads expectations from a file (or standard input, with -) and records each one, as \`nostro expect\`
does, using the same validation.

CSV has a header row. Columns: reference, account, amount, asset, direction (credit or debit),
muxed_id, memo_text, memo_id, memo_hash, payers (G... accounts separated by |), due, expires, and
meta.<key> for each metadata key. JSON Lines has the same names as fields, one object per line.

Re-running is safe. A row whose reference is already recorded with the same fields is skipped. A row
whose reference is recorded with different fields is a conflict: it is reported and the recorded
expectation is never changed.

If any row is refused, nothing is written, and each refused row is listed with its line number. Use
--dry-run to check a file without writing.

Options:
  --format <f>        csv or jsonl (default: jsonl for .jsonl and .ndjson files, else csv)
  --dry-run           Check every row; write nothing
${COMMON_HELP}`,
  options: { ...COMMON, format: { type: 'string' }, 'dry-run': { type: 'boolean' } },
  async run(args, io) {
    const [source] = positionals(args, 1)
    if (source === undefined) throw new UsageError('Give the file to import, or - for standard input.')
    const tenantId = tenant(args, io)
    const dryRun = flag(args, 'dry-run')

    let text: string
    if (source === '-') {
      if (io.readStdin === undefined) throw new UsageError('Standard input is not available here.')
      text = await io.readStdin()
    } else {
      try {
        text = readFileSync(resolve(io.cwd, source), 'utf8')
      } catch (err) {
        throw new CliError(`Cannot read ${source}: ${(err as NodeJS.ErrnoException).code ?? 'unknown error'}.`)
      }
    }
    text = text.replace(/^﻿/, '')

    const format = string(args, 'format') ?? (source.endsWith('.jsonl') || source.endsWith('.ndjson') ? 'jsonl' : 'csv')
    if (format !== 'csv' && format !== 'jsonl') throw new UsageError(`--format takes csv or jsonl, not ${JSON.stringify(format)}.`)

    let parsed: Rows
    try {
      parsed = format === 'csv' ? fromCsv(text) : fromJsonLines(text)
    } catch (err) {
      if (err instanceof UsageError) throw err
      throw new UsageError((err as Error).message)
    }

    const outcomes: RowOutcome[] = []
    const refused: Refusal[] = [...parsed.refused]
    const seen = new Map<string, NewExpectation>()

    await withStore(args, io, async (store) => {
      for (const row of parsed.rows) {
        let expectation: NewExpectation
        try {
          expectation = expectationOf(rowArgs(row.cells), tenantId)
        } catch (err) {
          if (err instanceof UsageError) {
            refused.push({ line: row.line, error: err.message })
            continue
          }
          throw err
        }
        const earlier = seen.get(expectation.reference) ?? (await store.getExpectationByReference(tenantId, expectation.reference)) ?? null
        if (earlier === null) {
          seen.set(expectation.reference, expectation)
          outcomes.push({ line: row.line, reference: expectation.reference, kind: 'create', expectation })
          continue
        }
        const difference = firstDifference(earlier, expectation)
        if (difference === null) {
          outcomes.push({ line: row.line, reference: expectation.reference, kind: 'skip' })
        } else {
          outcomes.push({
            line: row.line,
            reference: expectation.reference,
            kind: 'conflict',
            reason: `differs in ${difference}; the recorded expectation is unchanged`,
          })
        }
      }

      const creates = outcomes.filter((o) => o.kind === 'create' && o.expectation !== undefined)
      if (dryRun || refused.length > 0 || creates.length === 0) return
      try {
        await store.transaction(async (tx) => {
          for (const o of creates) await recordExpectation(tx, o.expectation!)
        })
      } catch (err) {
        if (err instanceof ValidationError) throw new UsageError(`Nothing was written: ${err.message}`)
        if (err instanceof ConstraintError) {
          throw new CliError(`Nothing was written: ${err.message}`)
        }
        throw err
      }
    })

    const created = outcomes.filter((o) => o.kind === 'create').length
    const skipped = outcomes.filter((o) => o.kind === 'skip').length
    const conflicts = outcomes.filter((o) => o.kind === 'conflict')
    const wrote = !dryRun && refused.length === 0

    if (flag(args, 'json')) {
      await write(
        io.stdout,
        json({
          dryRun,
          created: wrote ? created : 0,
          wouldCreate: created,
          skipped,
          conflicts: conflicts.map((c) => ({ line: c.line, reference: c.reference, reason: c.reason })),
          refused: refused.map((r) => ({ line: r.line, error: r.error })),
        }),
      )
    } else {
      const problems = [
        ...refused.map((r) => `line ${r.line}: ${clean(r.error)}`),
        ...conflicts.map((c) => `line ${c.line}: ${clean(c.reference)} ${clean(c.reason ?? '')}`),
      ]
      const summary = dryRun
        ? `Dry run: ${created} would be created, ${skipped} already recorded, ${conflicts.length} conflict(s), ${refused.length} refused. Nothing was written.`
        : refused.length > 0
          ? `Refused ${refused.length} row(s); nothing was written.`
          : `Imported: ${created} created, ${skipped} already recorded, ${conflicts.length} conflict(s).`
      await write(io.stdout, `${summary}\n${problems.slice(0, 10).map((p) => `${p}\n`).join('')}`)
      if (problems.length > 10) await write(io.stdout, `... and ${problems.length - 10} more (use --json for all)\n`)
    }
    return refused.length > 0 || conflicts.length > 0 ? 1 : 0
  },
}
