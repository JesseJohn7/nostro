import { ConstraintError } from '@nostro-labs/nostro'
import { COMMON, CliError, UsageError, flag, positionals, string, tenant } from '../args.js'
import type { Args } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, withStore } from '../command.js'
import type { Io } from '../io.js'
import { json, table, write } from '../io.js'

const networkName = (args: Args, io: Io): string => {
  const name = string(args, 'network') ?? io.env.NOSTRO_NETWORK ?? 'testnet'
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new UsageError('--network must be a lowercase label such as testnet or public.')
  return name
}

const entityJson = (entity: { id: string; name: string; createdAt: Date }) => ({
  id: entity.id,
  name: entity.name,
  createdAt: entity.createdAt.toISOString(),
})

const assignmentJson = (assignment: { tenantId: string; network: string; account: string; entityId: string; createdAt: Date }) => ({
  tenantId: assignment.tenantId,
  network: assignment.network,
  account: assignment.account,
  entityId: assignment.entityId,
  createdAt: assignment.createdAt.toISOString(),
})

async function withConstraintMessages<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ConstraintError) throw new CliError(err.message)
    throw err
  }
}

export const entity: Command = {
  name: 'entity',
  summary: 'Manage entities and the accounts they own',
  usage: '<create|list|assign|accounts> [options]',
  help: `Entities divide one tenant's books. A movement inherits the entity assigned to its
account at ingest; later account moves do not rewrite history.

Subcommands:
  create            Create an entity with --id and --name
  list              List entities
  assign            Assign one --account to --entity-id on --network
  accounts          List account ownership, optionally for --entity-id

Options:
  --id <id>         Entity id (create)
  --name <text>     Entity name (create)
  --entity-id <id>  Entity id (assign, accounts)
  --account <G...>  Account to assign (assign)
  --network <name>  Network label (assign and accounts with --account; default testnet)
${COMMON_HELP}`,
  options: {
    ...COMMON,
    id: { type: 'string' },
    name: { type: 'string' },
    'entity-id': { type: 'string' },
    account: { type: 'string' },
    network: { type: 'string' },
  },
  async run(args, io) {
    const [sub] = positionals(args, 1)
    const tenantId = tenant(args, io)
    const isJson = flag(args, 'json')

    return withStore(args, io, async (store) => {
      if (sub === 'create') {
        const id = string(args, 'id')
        const name = string(args, 'name')
        if (id === undefined || id.trim() === '') throw new UsageError('create requires --id <id>.')
        if (name === undefined || name.trim() === '') throw new UsageError('create requires --name <text>.')
        const created = await withConstraintMessages(() => store.transaction((tx) => tx.insertEntity({ tenantId, id, name })))
        if (isJson) await write(io.stdout, json(entityJson(created)))
        else await write(io.stdout, table([['ID', 'NAME', 'CREATED'], [created.id, created.name, created.createdAt.toISOString()]]))
        return 0
      }

      if (sub === 'list') {
        const entities = await store.listEntities({ tenantId })
        if (isJson) await write(io.stdout, json(entities.map(entityJson)))
        else await write(io.stdout, table([['ID', 'NAME', 'CREATED'], ...entities.map((e) => [e.id, e.name, e.createdAt.toISOString()])]))
        return 0
      }

      if (sub === 'assign') {
        const account = string(args, 'account')
        const entityId = string(args, 'entity-id')
        if (account === undefined || account.trim() === '') throw new UsageError('assign requires --account <G...>.')
        if (entityId === undefined || entityId.trim() === '') throw new UsageError('assign requires --entity-id <id>.')
        const assignment = await withConstraintMessages(() =>
          store.transaction((tx) => tx.assignAccountEntity({ tenantId, network: networkName(args, io), account, entityId })),
        )
        if (isJson) await write(io.stdout, json(assignmentJson(assignment)))
        else await write(io.stdout, table([['NETWORK', 'ACCOUNT', 'ENTITY'], [assignment.network, assignment.account, assignment.entityId]]))
        return 0
      }

      if (sub === 'accounts') {
        const entityId = string(args, 'entity-id')
        const account = string(args, 'account')
        const assignments = await store.listAccountEntities({
          tenantId,
          ...(entityId === undefined ? {} : { entityId }),
          ...(account === undefined ? {} : { account }),
        })
        if (isJson) await write(io.stdout, json(assignments.map(assignmentJson)))
        else await write(io.stdout, table([
          ['NETWORK', 'ACCOUNT', 'ENTITY'],
          ...assignments.map((a) => [a.network, a.account, a.entityId]),
        ]))
        return 0
      }

      throw new UsageError(`Unknown entity subcommand ${JSON.stringify(sub)}.`)
    })
  },
}
