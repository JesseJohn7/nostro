import type { ExceptionDecision } from '@nostro-labs/nostro'
import { resolutionJson } from '@nostro-labs/nostro'
import type { Args } from '../args.js'
import { COMMON, UsageError, flag, positionals, string, strings, tenant } from '../args.js'
import { withBackend } from '../backend.js'
import { readFileSync } from 'node:fs'
import type { Command } from '../command.js'
import { COMMON_HELP } from '../command.js'
import { assetLabel } from '../format.js'
import { clean, json, write } from '../io.js'

const AMOUNT = /^[0-9]+(\.[0-9]+)?$/

/** `INV-1042` or `INV-1042=2.5`. A reference may itself contain `=`; only a number after the last one is an amount. */
function allocation(spec: string): { reference: string; amount?: string } {
  const at = spec.lastIndexOf('=')
  const amount = spec.slice(at + 1)
  return at > 0 && AMOUNT.test(amount) ? { reference: spec.slice(0, at), amount } : { reference: spec }
}

function decision(args: Args): ExceptionDecision {
  const apply = strings(args, 'apply')
  const ignore = flag(args, 'ignore')
  const close = flag(args, 'close')
  if ((apply.length > 0 ? 1 : 0) + (ignore ? 1 : 0) + (close ? 1 : 0) !== 1) {
    throw new UsageError('Say what to do: one of --apply <reference[=amount]>, --ignore or --close.')
  }
  if (flag(args, 'dismiss') && !close) throw new UsageError('--dismiss only applies with --close.')
  const note = string(args, 'note')
  if (note === undefined || note.trim() === '') throw new UsageError('--note is required: say why, for whoever reads this later.')
  if (ignore) return { action: 'ignore', note }
  if (close) return { action: 'close', status: flag(args, 'dismiss') ? 'dismissed' : 'resolved', note }
  return { action: 'apply', allocations: apply.map(allocation), note }
}

export const resolve: Command = {
  name: 'resolve',
  summary: 'Decide an exception: apply its payment to invoices, ignore it, or close it',
  usage: '<exception-id> (--apply <reference[=amount]>... | --ignore | --close) --note <why> [options] | --file <decisions.csv> [--mode atomic|row] [options]',
  help: `Answers what "nostro exceptions" asks. The movement, its exceptions and the journal change
together, in one transaction, and the journal adjustment leaves cash untouched.

Whatever an application leaves over stays open, under an exception for exactly that amount. The rules
hold for a person too: a lookalike asset, another account's invoice, too much or a cancelled invoice
is refused. An invoice past its expiry can be paid. A movement already decided cannot be changed.

Options:
  --apply <ref[=n]>   This payment was for this invoice; with =amount, for that much of it. Without
                      one: what is left of the payment and still owing. Repeat to split a payment
  --ignore            This is not something to reconcile. What was allocated stays allocated
  --close             The exception is dealt with. Refused if an undecided movement depends on it
  --dismiss           With --close: dismissed, rather than resolved
  --file <path>       CSV with columns: exception id,action,reference[=amount],note
  --mode <mode>       Batch mode: atomic or row (default atomic)
  --note <why>        Required. Kept with what this closes
${COMMON_HELP}`,
  options: {
    ...COMMON,
    apply: { type: 'string', multiple: true },
    ignore: { type: 'boolean' },
    close: { type: 'boolean' },
    dismiss: { type: 'boolean' },
    file: { type: 'string' },
    mode: { type: 'string' },
    note: { type: 'string' },
  },
  async run(args, io) {
    const file = string(args, 'file')
    const tenantId = tenant(args, io)
    if (file !== undefined) {
      const mode = (string(args, 'mode') ?? 'atomic') as 'atomic' | 'row'
      if (mode !== 'atomic' && mode !== 'row') throw new UsageError('--mode must be atomic or row.')
      const rows = parseBatchCsv(readFileSync(file, 'utf8'))
      const report = await withBackend(args, io, (backend) =>
        backend.resolveExceptions(tenantId, rows, mode),
      )
      if (flag(args, 'json')) { await write(io.stdout, json(report)); return report.errors > 0 ? 1 : 0 }
      let out = ''
      for (const r of report.results) {
        if (r.error) out += `${r.index}: ${r.exceptionId} ERROR ${r.error.code} ${clean(r.error.detail)}\n`
        else out += `${r.index}: ${r.exceptionId} ok${r.result?.alreadyApplied ? ' (already applied)' : ''}\n`
      }
      out += `Applied ${report.applied}, errors ${report.errors}.\n`
      await write(io.stdout, out)
      return report.errors > 0 ? 1 : 0
    }

    const [exceptionId] = positionals(args, 1)
    if (exceptionId === undefined) throw new UsageError('Give the exception id, from "nostro exceptions".')
    const what = decision(args)

    const report = await withBackend(args, io, (backend) =>
      backend.resolveException(tenantId, exceptionId, what),
    )

    if (flag(args, 'json')) {
      await write(io.stdout, json(resolutionJson(report)))
      return 0
    }
    let out = ''
    if (what.action === 'apply') {
      report.allocations.forEach((a, i) => {
        out += `Applied ${a.amount.toString()} ${assetLabel(a.amount.asset)} to ${clean(what.allocations[i]!.reference)}.\n`
      })
    }
    if (report.movement !== null && what.action !== 'close') out += `Movement ${report.movement.id} is now ${report.movement.disposition}.\n`
    for (const x of report.closed) out += `Exception ${x.id} (${x.code}) is ${x.status}.\n`
    if (report.opened !== null) {
      out += `Still open: ${report.opened.code} for ${report.opened.amount!.toString()} ${assetLabel(report.opened.amount!.asset)} (exception ${report.opened.id}).\n`
    }
    if (report.journalEntry !== null) out += `Posted a ${report.journalEntry.kind} entry to the journal.\n`
    await write(io.stdout, out)
    return 0
  },
}


function parseBatchCsv(text: string): { exceptionId: string; decision: ExceptionDecision }[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length === 0) throw new UsageError('The batch file is empty.')
  const header = splitCsv(lines[0]!).map((s) => s.trim().toLowerCase())
  const start = header[0] === 'exception id' ? 1 : 0
  const rows: { exceptionId: string; decision: ExceptionDecision }[] = []
  for (let i = start; i < lines.length; i++) {
    const cols = splitCsv(lines[i]!)
    const exceptionId = cols[0]?.trim() ?? ''
    const action = (cols[1]?.trim() ?? '') as ExceptionDecision['action']
    const ref = cols[2]?.trim() ?? ''
    const note = cols.slice(3).join(',').trim() || cols[2]?.trim() || ''
    if (!exceptionId || !action) throw new UsageError(`Bad batch row ${i + 1}: need exception id and action.`)
    if (action === 'apply') {
      const refs = cols.slice(2, -1).map((s) => s.trim()).filter(Boolean)
      const n = cols[cols.length - 1]?.trim() ?? ''
      rows.push({ exceptionId, decision: { action: 'apply', allocations: refs.map(allocation), note: n } as ExceptionDecision })
    } else if (action === 'ignore') {
      rows.push({ exceptionId, decision: { action: 'ignore', note: ref || note } as ExceptionDecision })
    } else if (action === 'close') {
      rows.push({ exceptionId, decision: { action: 'close', note: ref || note } as ExceptionDecision })
    } else {
      throw new UsageError(`Bad batch row ${i + 1}: unknown action ${action}.`)
    }
  }
  return rows
}

function splitCsv(line: string): string[] {
  const out: string[] = []; let cur = ''; let q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ } else if (c === '"') q = false; else cur += c }
    else { if (c === ',') { out.push(cur); cur = '' } else if (c === '"') q = true; else cur += c }
  }
  out.push(cur); return out
}
