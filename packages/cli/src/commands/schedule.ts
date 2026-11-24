import type { AssetId, NewSchedule } from '@nostro-labs/nostro'
import { ConstraintError, Money, NATIVE, ValidationError, parseAsset, scheduleJson } from '@nostro-labs/nostro'
import { COMMON, CliError, UsageError, date, flag, positionals, string, tenant } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, withStore } from '../command.js'
import { money } from '../format.js'
import { json, table, write } from '../io.js'

function assetOf(raw: string): AssetId {
  if (raw === 'native' || raw.toUpperCase() === 'XLM') return NATIVE
  try { return parseAsset(raw) } catch { throw new UsageError(`--asset must be native (or XLM) or CODE:ISSUER, not ${JSON.stringify(raw)}.`) }
}

function parseCadence(raw: string): NewSchedule['cadence'] {
  if (raw === 'daily') return { type: 'daily' }
  const m = /^(weekly|monthly):(\d+)$/.exec(raw)
  if (!m) throw new UsageError('--cadence must be daily, weekly:<0-6>, or monthly:<1-28>')
  const day = Number(m[2])
  if (m[1] === 'weekly') {
    if (day < 0 || day > 6) throw new UsageError('weekly cadence day must be 0-6')
    return { type: 'weekly', dayOfWeek: day }
  }
  if (day < 1 || day > 28) throw new UsageError('monthly cadence day must be 1-28')
  return { type: 'monthly', dayOfMonth: day }
}

const create: Command = {
  name: 'create',
  summary: 'Create an expectation schedule',
  usage: '<reference-pattern> --account <G...> --amount <amount> --cadence <cadence> --start-at <date> [options]',
  help: `Create a schedule that generates expectations. Use {period} in reference pattern.

Options:
  --account <G...>    Destination account
  --amount <amount>   Amount
  --asset <asset>     native (default) or CODE:ISSUER
  --direction <dir>   credit (default) or debit
  --cadence <c>       daily, weekly:<0-6>, monthly:<1-28>
  --start-at <date>   Start date/time (UTC recommended)
  --end-at <date>     Optional end date/time
${COMMON_HELP}`,
  options: { ...COMMON, account: { type: 'string' }, amount: { type: 'string' }, asset: { type: 'string' }, direction: { type: 'string' }, cadence: { type: 'string' }, 'start-at': { type: 'string' }, 'end-at': { type: 'string' } },
  async run(args, io) {
    const [referencePattern] = positionals(args, 1)
    if (!referencePattern || !referencePattern.includes('{period}')) throw new UsageError('reference pattern is required and must include {period}')
    const account = string(args, 'account')
    if (!account) throw new UsageError('--account is required')
    const rawAmount = string(args, 'amount')
    if (!rawAmount) throw new UsageError('--amount is required')
    const asset = assetOf(string(args, 'asset') ?? 'native')
    let amount: Money
    try { amount = Money.parse(rawAmount, asset) } catch (err) { throw new UsageError(`--amount: ${(err as Error).message}`) }
    const cadenceRaw = string(args, 'cadence')
    if (!cadenceRaw) throw new UsageError('--cadence is required')
    const startAt = date(args, 'start-at')
    if (!startAt) throw new UsageError('--start-at is required')
    const endAt = date(args, 'end-at')
    const direction = (string(args, 'direction') ?? 'credit') as 'credit' | 'debit'
    if (direction !== 'credit' && direction !== 'debit') throw new UsageError('--direction must be credit or debit')
    const n: NewSchedule = { tenantId: tenant(args, io), referencePattern, account, amount, direction, cadence: parseCadence(cadenceRaw), startAt, ...(endAt ? { endAt } : {}) }
    try {
      const created = await withStore(args, io, (store) => store.transaction((tx) => tx.insertSchedule(n)))
      if (flag(args, 'json')) { await write(io.stdout, json(scheduleJson(created))); return 0 }
      await write(io.stdout, `${created.id}\n`)
      return 0
    } catch (err) {
      if (err instanceof ValidationError || err instanceof ConstraintError) throw new CliError(err.message)
      throw err
    }
  },
}

const list: Command = {
  name: 'list',
  summary: 'List schedules',
  usage: '[options]',
  help: `List schedules.\n\nOptions:\n  --active-only  Only active schedules\n${COMMON_HELP}`,
  options: { ...COMMON, 'active-only': { type: 'boolean' } },
  async run(args, io) {
    const rows = await withStore(args, io, (store) => store.listSchedules({ tenantId: tenant(args, io), ...(flag(args, 'active-only') ? { activeOnly: true } : {}) }))
    if (flag(args, 'json')) { await write(io.stdout, json(rows.map(scheduleJson))); return 0 }
    await write(io.stdout, table([['id', 'reference', 'account', 'amount', 'cadence', 'ended'], ...rows.map((s) => [s.id, s.referencePattern, s.account, money(s.amount), s.cadence.type, s.endedAt ? 'yes' : 'no'])]))
    return 0
  },
}

const end: Command = {
  name: 'end',
  summary: 'End a schedule',
  usage: '<id>',
  help: `End a schedule.\n\n${COMMON_HELP}`,
  options: { ...COMMON },
  async run(args, io) {
    const [id] = positionals(args, 1)
    if (!id) throw new UsageError('schedule id is required')
    const ended = await withStore(args, io, (store) => store.transaction((tx) => tx.endSchedule(tenant(args, io), id, new Date())))
    if (flag(args, 'json')) { await write(io.stdout, json(scheduleJson(ended))); return 0 }
    await write(io.stdout, `${ended.id}\n`)
    return 0
  },
}

const SUBCOMMANDS = [create, list, end]

export const schedule: Command = {
  name: 'schedule',
  summary: 'Create, list and end expectation schedules',
  usage: '<create|list|end> [options]',
  help: `A schedule generates one expectation a period; "nostro serve" records them as they come due.

Subcommands:
  create <reference-pattern> --account <G...> --amount <amount> --cadence <cadence> --start-at <date>
                      Prints the new schedule's id. The pattern must include {period}
  list                Every schedule, earliest start first
  end <id>            Generate no more. What is already recorded stays owed

Options for create:
  --account <G...>    Destination account
  --amount <amount>   Amount
  --asset <asset>     native (default) or CODE:ISSUER
  --direction <dir>   credit (default) or debit
  --cadence <c>       daily, weekly:<0-6>, monthly:<1-28>
  --start-at <date>   First period's date
  --end-at <date>     Generate nothing from this date on

Options for list:
  --active-only       Only schedules that have not been ended
${COMMON_HELP}`,
  options: Object.assign({}, ...SUBCOMMANDS.map((c) => c.options)) as Command['options'],
  async run(args, io) {
    const [name, ...rest] = args.positionals
    const command = SUBCOMMANDS.find((c) => c.name === name)
    if (command === undefined) throw new UsageError('Use "nostro schedule create", "nostro schedule list" or "nostro schedule end".')
    for (const option of Object.keys(args.values)) {
      if (!(option in command.options)) throw new UsageError(`--${option} does not apply to schedule ${command.name}.`)
    }
    return command.run({ ...args, positionals: rest }, io)
  },
}
