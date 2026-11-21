/**
 * `nostro journal <subcommand> [options]`
 *
 * Supported subcommands:
 *   post   Post a manual journal entry that cannot touch cash (issue #61)
 */
import { Money, NATIVE, parseAsset, postManualEntry } from '@nostro-labs/nostro'
import type { NewJournalLine, Side } from '@nostro-labs/nostro'
import { COMMON, UsageError, date, flag, positionals, string, strings, tenant } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, withStore } from '../command.js'
import { json, write } from '../io.js'

function parseLine(spec: string): NewJournalLine {
  // Format: account:role:side:amount[:asset]
  const parts = spec.split(':')
  if (parts.length < 4) {
    throw new UsageError(`Invalid --line format "${spec}". Expected account:role:side:amount[:asset]`)
  }
  const account = parts[0]!
  const role = parts[1]! as any
  const side = parts[2]! as Side
  const amountStr = parts[3]!
  const assetStr = parts.slice(4).join(':') || 'native'
  const asset = assetStr === 'native' || assetStr.toUpperCase() === 'XLM' ? NATIVE : parseAsset(assetStr)
  const amount = Money.parse(amountStr, asset)

  return { account, role, side, amount }
}

export const journalCommand: Command = {
  name: 'journal',
  summary: 'Post manual journal entries',
  usage: '<post> [options]',
  help: `Post manual entries to the double-entry journal.

Subcommands:
  post   Post a manual journal entry that cannot touch cash.

Options:
  --description <text>   Summary of the manual entry (required)
  --reason <why>         Why this entry is posted (required)
  --note <text>          Additional audit note
  --posted-by <name>     Author or operator posting this entry
  --movement <id>        Link entry to a movement
  --effective-at <date>  Effective accounting date (default: now)
  --line <spec>          account:role:side:amount[:asset] (repeat for each line)
  --lines-json <json>    Lines as a JSON array
${COMMON_HELP}`,
  options: {
    ...COMMON,
    description: { type: 'string' },
    reason: { type: 'string' },
    note: { type: 'string' },
    'posted-by': { type: 'string' },
    movement: { type: 'string' },
    'effective-at': { type: 'string' },
    line: { type: 'string', multiple: true },
    'lines-json': { type: 'string' },
  },
  async run(args, io) {
    const [sub] = positionals(args, 1)
    const tenantId = tenant(args, io)
    const isJson = flag(args, 'json')

    if (sub !== 'post') {
      throw new UsageError(`Unknown journal subcommand ${JSON.stringify(sub)}. Use "post".`)
    }

    const description = string(args, 'description')
    if (description === undefined || description.trim() === '') {
      throw new UsageError('journal post requires --description <text>.')
    }

    const reason = string(args, 'reason') ?? string(args, 'note')
    if (reason === undefined || reason.trim() === '') {
      throw new UsageError('journal post requires --reason <why>.')
    }

    const note = string(args, 'note')
    const postedBy = string(args, 'posted-by')
    const movementId = string(args, 'movement')
    const effectiveAt = date(args, 'effective-at')

    const lines: NewJournalLine[] = []
    const linesJsonRaw = string(args, 'lines-json')
    if (linesJsonRaw) {
      try {
        const parsed = JSON.parse(linesJsonRaw)
        if (!Array.isArray(parsed)) throw new Error('lines-json must be an array')
        for (const item of parsed) {
          const asset = item.asset === 'native' || !item.asset ? NATIVE : parseAsset(item.asset)
          lines.push({
            account: item.account,
            role: item.role,
            side: item.side,
            amount: Money.parse(String(item.amount), asset),
            expectationId: item.expectationId ?? null,
            exceptionId: item.exceptionId ?? null,
          })
        }
      } catch (err: any) {
        throw new UsageError(`Invalid --lines-json: ${err.message}`)
      }
    } else {
      const lineSpecs = strings(args, 'line')
      for (const spec of lineSpecs) {
        lines.push(parseLine(spec))
      }
    }

    if (lines.length < 2) {
      throw new UsageError('journal post requires at least two lines via --line or --lines-json.')
    }

    return withStore(args, io, async (store) => {
      const entry = await postManualEntry({
        store,
        tenantId,
        description,
        reason,
        ...(note !== undefined ? { note } : {}),
        ...(postedBy !== undefined ? { postedBy } : {}),
        ...(movementId !== undefined ? { movementId } : {}),
        ...(effectiveAt !== undefined ? { effectiveAt } : {}),
        lines,
      })

      if (isJson) {
        await write(
          io.stdout,
          json({
            id: entry.id,
            seq: entry.seq,
            tenantId: entry.tenantId,
            movementId: entry.movementId,
            postingNo: entry.postingNo,
            kind: entry.kind,
            effectiveAt: entry.effectiveAt.toISOString(),
            postedAt: entry.postedAt.toISOString(),
            description: entry.description,
            lines: entry.lines.map((l) => ({
              account: l.account,
              role: l.role,
              side: l.side,
              amount: l.amount.toString(),
              asset: l.amount.asset,
            })),
          }),
        )
      } else {
        await write(io.stdout, `Posted manual entry ${entry.id} (seq ${entry.seq}).\n`)
      }
      return 0
    })
  },
}
