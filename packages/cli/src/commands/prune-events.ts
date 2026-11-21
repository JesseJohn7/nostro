import { pruneEvents } from '@nostro-labs/nostro'
import { COMMON, UsageError, positionals, string, tenant } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, withStore } from '../command.js'
import { json, write } from '../io.js'

export const pruneEventsCommand: Command = {
  name: 'prune-events',
  summary: 'Prune old events already delivered to every registered webhook consumer',
  usage: '--older-than <date-time> [options]',
  help: `Removes only an old prefix of the tenant's event log, and only through the slowest
registered webhook consumer's saved position. A consumer that has not advanced holds pruning back.
Use an explicit UTC date-time cutoff; pruning is irreversible. Clients paging from an older
sequence receive an event_history_pruned problem and must resume after the reported position.

Options:
  --older-than <date-time> ISO-8601 cutoff; events newer than this are retained
${COMMON_HELP}`,
  options: { ...COMMON, 'older-than': { type: 'string' } },
  async run(args, io) {
    positionals(args, 0)
    const tenantId = tenant(args, io)
    const raw = string(args, 'older-than')
    if (raw === undefined) throw new UsageError('--older-than is required.')
    const olderThan = new Date(raw)
    if (!Number.isFinite(olderThan.getTime())) throw new UsageError('--older-than must be a valid ISO-8601 date-time.')

    const result = await withStore(args, io, (store) => pruneEvents({ store, tenantId, olderThan }))
    if (args.values.json === true) {
      await write(io.stdout, json({ tenantId, olderThan: olderThan.toISOString(), ...result }))
    } else {
      await write(
        io.stdout,
        `Pruned ${result.deleted} event(s) for tenant ${tenantId}; retained position is ${result.prunedThrough}.\n`,
      )
    }
    return 0
  },
}
