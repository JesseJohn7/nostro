/**
 * `nostro config`: what this command would use, and why. Every row names the
 * source (flag, environment, profile or default) so a person can see which
 * books a command would open before it opens them. Secrets are never printed:
 * URLs are redacted and the API key is shown only as "hidden".
 */
import { COMMON, NETWORK, database, flag, string, tenant } from '../args.js'
import { rawSetting, stringSetting, stringsSetting, numberSetting } from '../config.js'
import type { Command } from '../command.js'
import { json, table, write } from '../io.js'
import { redact } from '../store.js'

/** Strip both username and password from a URL, for display, without otherwise changing it. */
const safeUrl = (url: string): string => {
  try {
    const parsed = new URL(url)
    if (parsed.username === '' && parsed.password === '') return url
  } catch {
    return url
  }
  return redact(url).replace(/\/\/[^@/]*@/, '//***@')
}

const COMMON_HELP_CONFIG = `  --config <file>     Read named profiles from this file (env NOSTRO_CONFIG)
  --profile <name>    Use this profile (env NOSTRO_PROFILE)
  --api <url>         Use the HTTP API instead of the database (env NOSTRO_API_URL)
  --db <path|url>     SQLite file or postgres:// URL (env NOSTRO_DB; default ./nostro.db)
  --tenant <id>       Whose records to use (env NOSTRO_TENANT; default "default")
  --json              Print JSON instead of text
  -h, --help          Show this help`

export const configCommand: Command = {
  name: 'config',
  summary: 'Show every resolved setting and where it came from',
  usage: '[options]',
  help: `Prints the database, tenant, network, accounts, serve and API settings this invocation
would use, each with its source: flag, environment, profile or default. With --json the same
rows are printed as JSON. Passwords in URLs are replaced, and API keys are never printed.

Options:
${COMMON_HELP_CONFIG}`,
  options: {
    ...COMMON,
    ...NETWORK,
    port: { type: 'string' },
    host: { type: 'string' },
    interval: { type: 'string' },
  },
  async run(args, io) {
    const sourceOf = (key: Parameters<typeof rawSetting>[0]) => rawSetting(key, args, io)?.source ?? 'default'
    const net = (() => {
      const name = stringSetting('network', args, io, 'testnet').value!
      const horizon = stringSetting('horizon', args, io).value
      return { name, horizon }
    })()
    const api = stringSetting('api', args, io).value
    const profileSource = args.values.profile !== undefined
      ? 'flag'
      : (io.env.NOSTRO_PROFILE ?? '') !== ''
        ? 'environment'
        : 'default'
    const rows: readonly (readonly string[])[] = [
      ['config', io.config?.path ?? '(none; built-in defaults)', io.config?.pathSource ?? 'default'],
      ['profile', io.config?.selected ?? '(none)', io.config === undefined ? 'default' : profileSource],
      ['db', safeUrl(database(args, io)), sourceOf('db')],
      ['tenant', tenant(args, io), sourceOf('tenant')],
      ['network', net.name, sourceOf('network')],
      ['horizon', net.horizon === undefined ? '(network default)' : safeUrl(net.horizon), sourceOf('horizon')],
      ['accounts', stringsSetting('accounts', args, io).value.join(', ') || '(none)', sourceOf('accounts')],
      ['schema', stringSetting('schema', args, io, 'nostro').value!, sourceOf('schema')],
      ['port', String(numberSetting('port', args, io, 8080, 0, 65_535).value), sourceOf('port')],
      ['host', stringSetting('host', args, io, '127.0.0.1').value!, sourceOf('host')],
      ['interval', String(numberSetting('interval', args, io, 30, 1, 86_400).value), sourceOf('interval')],
      ['api', api === undefined ? '(none; local mode)' : safeUrl(api), api === undefined ? 'default' : string(args, 'api') !== undefined ? 'flag' : 'environment'],
      ['apiKey', (io.env.NOSTRO_API_KEY ?? '') !== '' ? '(set, hidden)' : '(unset)', 'environment'],
    ]
    if (flag(args, 'json')) {
      await write(io.stdout, json(rows.map(([setting, value, source]) => ({ setting, value, source }))))
    } else {
      await write(io.stdout, table([['SETTING', 'VALUE', 'SOURCE'], ...rows]))
    }
    return 0
  },
}
