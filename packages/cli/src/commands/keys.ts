import { randomBytes, randomUUID } from 'node:crypto'
import type { ApiKeyRow } from '@nostro-labs/nostro'
import { NotFoundError } from '@nostro-labs/nostro'
import { keyDigest, SCOPES } from '@nostro-labs/server'
import type { Scope } from '@nostro-labs/server'
import { COMMON, CliError, UsageError, database, flag, positionals, string } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP } from '../command.js'
import { clean, json, table, write } from '../io.js'
import { TENANT_ID } from '../serve-tenants.js'
import { assertCurrent, openStore } from '../store.js'

/** A key is `nstk_` and 43 characters of base64url: 256 random bits, and a prefix secret scanners can find. */
const KEY_PREFIX = 'nstk_'
const LABEL_MAX = 80

const HELP = `Manages the API keys that \`nostro serve\` accepts from its store. A key is shown once, when it is
created; only its digest is kept, so a lost key cannot be recovered, only revoked and replaced.
A revoked key is refused on the next request, with no restart.

  nostro keys create --tenant <id> --label <text> --scopes <scope,...>
  nostro keys list [--tenant <id>]
  nostro keys revoke <id>

Scopes: read, events, webhooks, expectations, exceptions, journal (see packages/server/README.md).
Keys from NOSTRO_API_KEYS or --keys-file are not in the store, so this command does not list or
revoke them; change those in the environment and restart.

Options:
  --label <text>    What the key is for, e.g. "reporting dashboard" (required for create)
  --scopes <list>   Comma-separated scopes (required for create; a key is never created with silent full access)
${COMMON_HELP}`

const SUBCOMMANDS = ['create', 'list', 'revoke'] as const

function parseScopes(list: string): Scope[] {
  const names = list.split(',').map((n) => n.trim()).filter((n) => n !== '')
  if (names.length === 0) throw new UsageError(`--scopes needs at least one scope: ${SCOPES.join(', ')}.`)
  for (const name of names) {
    if (!(SCOPES as readonly string[]).includes(name)) throw new UsageError(`Unknown scope ${clean(name)}; scopes are ${SCOPES.join(', ')}.`)
  }
  return [...new Set(names)] as Scope[]
}

const when = (d: Date | null): string => (d === null ? '' : d.toISOString())

export const keys: Command = {
  name: 'keys',
  summary: 'Create, list and revoke the API keys serve accepts from its store',
  usage: '<create|list|revoke> [options]',
  help: HELP,
  options: {
    ...COMMON,
    label: { type: 'string' },
    scopes: { type: 'string' },
  },
  async run(args, io) {
    const [action, ...rest] = positionals(args, 2)
    if (action === undefined || !(SUBCOMMANDS as readonly string[]).includes(action)) {
      throw new UsageError(`keys needs one of: ${SUBCOMMANDS.join(', ')}. See nostro keys --help.`)
    }
    const opened = await openStore(database(args, io), io, { create: false })
    try {
      await assertCurrent(opened)
      const { store } = opened
      if (action === 'create') {
        if (rest.length > 0) throw new UsageError('keys create takes options only.')
        const tenantId = string(args, 'tenant')
        if (tenantId === undefined || !TENANT_ID.test(tenantId)) {
          throw new UsageError('keys create needs --tenant <id>, without spaces, [ ], or :.')
        }
        const label = (string(args, 'label') ?? '').trim()
        if (label === '' || label.length > LABEL_MAX) throw new UsageError(`keys create needs --label <text> of 1 to ${LABEL_MAX} characters.`)
        const scopes = parseScopes(string(args, 'scopes') ?? '')
        const plain = KEY_PREFIX + randomBytes(32).toString('base64url')
        const row = await store.transaction((tx) =>
          tx.insertApiKey({ id: randomUUID(), tenantId, label, digest: keyDigest(plain), scopes, createdAt: new Date() }),
        )
        if (flag(args, 'json')) {
          await write(io.stdout, json({ id: row.id, tenant: tenantId, label, scopes, key: plain }))
        } else {
          await write(
            io.stdout,
            `Created key ${row.id} for tenant ${clean(tenantId)} with scopes ${scopes.join(', ')}.\n` +
              `Key (shown once; store it now):\n${plain}\n`,
          )
        }
        return 0
      }

      if (action === 'list') {
        if (rest.length > 0) throw new UsageError('keys list takes options only.')
        const tenantId = string(args, 'tenant')
        const rows: ApiKeyRow[] = await store.listApiKeys(tenantId)
        if (flag(args, 'json')) {
          await write(
            io.stdout,
            json(rows.map((r) => ({ id: r.id, tenant: r.tenantId, label: r.label, scopes: r.scopes, createdAt: r.createdAt.toISOString(), revokedAt: when(r.revokedAt) || null, lastUsedAt: when(r.lastUsedAt) || null }))),
          )
        } else if (rows.length === 0) {
          await write(io.stdout, 'No keys.\n')
        } else {
          await write(
            io.stdout,
            table([
              ['ID', 'TENANT', 'LABEL', 'SCOPES', 'CREATED', 'REVOKED', 'LAST USED'],
              ...rows.map((r) => [r.id, r.tenantId, r.label, r.scopes.join(','), when(r.createdAt), when(r.revokedAt), when(r.lastUsedAt)]),
            ]),
          )
        }
        return 0
      }

      // revoke
      if (rest.length !== 1) throw new UsageError('keys revoke takes one key id.')
      try {
        const row = await store.transaction((tx) => tx.revokeApiKey(rest[0]!, new Date()))
        await write(io.stdout, `Key ${row.id} is revoked${row.revokedAt ? ` (since ${when(row.revokedAt)})` : ''}.\n`)
        return 0
      } catch (err) {
        if (err instanceof NotFoundError) throw new CliError(`No key with id ${clean(rest[0]!)}.`)
        throw err
      }
    } finally {
      await opened.store.close()
    }
  },
}

