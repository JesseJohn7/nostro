/**
 * `nostro <command> [options]`. Exit status: 0 when the command did what was
 * asked and found nothing wrong, 1 when it could not or found a problem, 2
 * when the command line itself was wrong.
 */
import { readFileSync } from 'node:fs'
import { HorizonError } from '@nostro-labs/nostro'
import { CliError, UsageError, parse, string } from './args.js'
import type { ErrorCode } from './args.js'
import { loadConfig } from './config.js'
import { REMOTE_COMMANDS, problemError, remote } from './backend.js'
import type { Command } from './command.js'
import { chart } from './commands/chart.js'
import { configCommand } from './commands/config.js'
import { doctor } from './commands/doctor.js'
import { entity } from './commands/entity.js'
import { keys } from './commands/keys.js'
import { importCommand } from './commands/import.js'
import { events } from './commands/events.js'
import { exceptions } from './commands/exceptions.js'
import { expect } from './commands/expect.js'
import { expectations } from './commands/expectations.js'
import { cancel } from './commands/cancel.js'
import { amend } from './commands/amend.js'
import { exportJournal } from './commands/export.js'
import { journalCommand } from './commands/journal.js'
import { migrate } from './commands/migrate.js'
import { movements } from './commands/movements.js'
import { open } from './commands/open.js'
import { post } from './commands/post.js'
import { pruneEventsCommand } from './commands/prune-events.js'
import { period } from './commands/period.js'
import { reconcile } from './commands/reconcile.js'
import { replay } from './commands/replay.js'
import { schedule } from './commands/schedule.js'
import { report } from './commands/report.js'
import { resolve } from './commands/resolve.js'
import { review } from './commands/review.js'
import { serve } from './commands/serve.js'
import { show } from './commands/show.js'
import { sync } from './commands/sync.js'
import type { Io } from './io.js'
import { clean, write } from './io.js'

export const COMMANDS: readonly Command[] = [
  migrate,
  keys,
  sync,
  entity,
  open,
  expect,
  expectations,
  importCommand,
  cancel,
  amend,
  reconcile,
  replay,
  schedule,
  events,
  exceptions,
  review,
  movements,
  show,
  resolve,
  post,
  period,
  chart,
  report,
  doctor,
  exportJournal,
  journalCommand,
  pruneEventsCommand,
  serve,
  configCommand,
]

export function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  return pkg.version
}

function overview(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length))
  const lines = COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`)
  return `nostro: payment reconciliation and ledger-to-accounting for Stellar

Usage: nostro <command> [options]

Commands:
${lines.join('\n')}

Run "nostro <command> --help" for a command's options. Every command reads its database from
--db or NOSTRO_DB (a SQLite file, or a postgres:// URL; default ./nostro.db).

nostro never signs a transaction and never needs a secret key.
`
}

/** The stable code a script can branch on. See the CLI README for the list. */
function errorCode(error: Error): ErrorCode {
  if (error instanceof UsageError) return 'usage'
  if (error instanceof CliError) return error.code
  if (error instanceof HorizonError) return 'horizon'
  return 'internal'
}

const helpFor = (c: Command) => `Usage: nostro ${c.name} ${c.usage}\n\n${c.summary}.\n\n${c.help}\n`

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const [name, ...rest] = argv
  // Read before parsing, so a usage error in --json mode is still reported as JSON.
  const wantsJson = rest.includes('--json')
  try {
    if (name === undefined) {
      await write(io.stderr, overview())
      return 2
    }
    if (name === '--help' || name === '-h' || (name === 'help' && rest.length === 0)) {
      await write(io.stdout, overview())
      return 0
    }
    if (name === 'help') {
      const topic = COMMANDS.find((c) => c.name === rest[0])
      if (topic === undefined) throw new UsageError(`Unknown command ${JSON.stringify(rest[0])}.`)
      await write(io.stdout, helpFor(topic))
      return 0
    }
    if (name === '--version' || name === '-v') {
      await write(io.stdout, `${version()}\n`)
      return 0
    }
    const command = COMMANDS.find((c) => c.name === name)
    if (command === undefined) throw new UsageError(`Unknown command ${JSON.stringify(name)}.`)
    const args = parse(rest, command.options)
    if (args.values.help === true) {
      await write(io.stdout, helpFor(command))
      return 0
    }
    // Load the config once, after parsing: a bad file or a missing profile is
    // a usage error, and every command sees the same resolved values.
    const path = string(args, 'config') ?? io.env.NOSTRO_CONFIG
    const profile = string(args, 'profile') ?? io.env.NOSTRO_PROFILE
    const loaded = loadConfig(io, path, profile)
    const resolvedIo = loaded === undefined ? io : { ...io, config: loaded }
    if (command.name !== 'config') {
      const mode = remote(args, resolvedIo)
      if (mode !== undefined && !REMOTE_COMMANDS.has(command.name)) {
        throw new CliError(`${command.name} needs a local database; --api is a remote connection without one.`)
      }
    }
    return await command.run(args, resolvedIo)
  } catch (err) {
    const mapped = problemError(err)
    const error = mapped instanceof Error ? mapped : new Error(String(mapped))
    if (wantsJson) {
      await write(io.stderr, `${JSON.stringify({ error: { code: errorCode(error), message: error.message } })}
`)
      return error instanceof UsageError ? 2 : 1
    }
    // A message may span lines; anything else that could drive the terminal is escaped.
    const lines = (text: string) => text.split('\n').map(clean).join('\n')
    const message = lines(error.message)
    if (error instanceof UsageError) {
      const hint = COMMANDS.some((c) => c.name === name) ? `nostro ${name} --help` : 'nostro --help'
      await write(io.stderr, `nostro: ${message}\nRun "${hint}" for usage.\n`)
      return 2
    }
    const detail = io.env.NOSTRO_DEBUG !== undefined && !(error instanceof CliError) ? error.stack : undefined
    await write(io.stderr, `nostro: ${message}\n${detail === undefined ? '' : `${lines(detail)}\n`}`)
    return 1
  }
}
