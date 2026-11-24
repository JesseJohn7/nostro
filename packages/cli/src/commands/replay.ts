import { explainMovement, replayDecisions } from '@nostro-labs/nostro'
import { COMMON, UsageError, date, flag, integer, positionals, string, strings, tenant } from '../args.js'
import type { Args } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, withStore } from '../command.js'
import { json, table, write } from '../io.js'
import { DEFAULT_STRATEGIES } from '@nostro-labs/nostro'

export const replay: Command = {
  name: 'replay',
  summary: 'Replay recorded matching decisions under proposed options',
  usage: '[movement-id] [options]',
  help: `Replays recorded matching decisions read-only. Without a movement id, replays a range and reports
differences against the recorded outcomes. With a movement id, explains that movement.

Options:
  --from <date>       Only decisions decided on or after this instant/day
  --to <date>         Only decisions decided strictly before this instant/day
  --threshold <n>     Proposed threshold (0-1)
  --margin <n>        Proposed margin (0-1)
  --strategy <name>   Proposed strategy; repeat or pass a comma-separated list
  --limit <n>         Maximum decisions to replay (default 1000)
${COMMON_HELP}`,
  options: {
    ...COMMON,
    from: { type: 'string' },
    to: { type: 'string' },
    threshold: { type: 'string' },
    margin: { type: 'string' },
    strategy: { type: 'string', multiple: true },
    limit: { type: 'string' },
  },
  async run(args, io) {
    const [movementId] = positionals(args, 1)
    const tenantId = tenant(args, io)
    const from = date(args, 'from')
    const to = date(args, 'to')
    const limit = integer(args, 'limit', 1000, 1, 5000)
    const threshold = numberOpt(args, 'threshold')
    const margin = numberOpt(args, 'margin')
    const strategyNames = strings(args, 'strategy').flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean)
    const strategies = strategyNames.length === 0 ? undefined : strategyNames.map((name) => {
      const strategy = DEFAULT_STRATEGIES.find((s) => s.name === name)
      if (strategy === undefined) throw new UsageError(`Unknown strategy: ${name}`)
      return strategy
    })

    if (movementId !== undefined) {
      const report = await withStore(args, io, (store) => explainMovement({ store, tenantId, movementId, ...(strategies ? { strategies } : {}) }))
      if (flag(args, 'json')) {
        await write(io.stdout, json(report))
        return report.status === 'disagree' ? 1 : 0
      }
      await write(io.stdout, `Movement ${report.movementId}: ${report.status}\n`)
      if (report.reason) await write(io.stdout, `${report.reason}\n`)
      return report.status === 'disagree' ? 1 : 0
    }

    const report = await withStore(args, io, (store) =>
      replayDecisions({
        store,
        tenantId,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        limit,
        options: {
          ...(threshold !== undefined ? { threshold } : {}),
          ...(margin !== undefined ? { margin } : {}),
          ...(strategies ? { strategies } : {}),
        },
      }),
    )

    if (flag(args, 'json')) {
      await write(io.stdout, json(report))
      return report.wouldSettle + report.wouldGoToPerson + report.wouldChangeExpectation + report.unreplayable > 0 ? 1 : 0
    }

    const rows = [
      ['movement', 'change', 'recorded', 'proposed', 'manual'],
      ...report.rows.map((row) => [
        row.movementId,
        row.change,
        outcome(row.recorded),
        row.proposed ? outcome(row.proposed) : '-',
        row.laterManual ? `${row.laterManual.agrees ? 'agrees' : 'differs'}:${row.laterManual.expectationId}` : '-',
      ]),
    ]
    let out = table(rows)
    out += `Replayed ${report.replayed}: unchanged ${report.unchanged}, would settle ${report.wouldSettle}, would go to person ${report.wouldGoToPerson}, would change expectation ${report.wouldChangeExpectation}, unreplayable ${report.unreplayable}.\n`
    await write(io.stdout, out)
    return report.wouldSettle + report.wouldGoToPerson + report.wouldChangeExpectation + report.unreplayable > 0 ? 1 : 0
  },
}

function numberOpt(args: Args, name: string): number | undefined {
  const raw = string(args, name)
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new UsageError(`--${name} must be a number from 0 to 1.`)
  return n
}

function outcome(value: any): string {
  if (!value || typeof value !== 'object') return String(value)
  if (value.outcome === 'allocate') return `allocate ${value.expectationId}`
  if (value.outcome === 'exception') return `exception ${value.code}`
  if (value.outcome === 'ignore') return `ignore ${value.reason}`
  return JSON.stringify(value)
}
