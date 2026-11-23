import type { Disposition } from '@nostro-labs/nostro'
import { DISPOSITIONS, movementJson } from '@nostro-labs/nostro'
import { COMMON, UsageError, flag, integer, positionals, string, tenant } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, withStore } from '../command.js'
import { assetLabel, memoLabel, when } from '../format.js'
import { json, table, write } from '../io.js'

export const movements: Command = {
  name: 'movements',
  summary: 'List payments and other movements, newest ledger first',
  usage: '[options]',
  help: `Lists the movements nostro has ingested: each payment or fee on a watched account, with where it
stands (its disposition). Use "nostro show <id>" to see what happened to one.

Options:
  --disposition <d>   pending, allocated, partial, exception or ignored
  --account <G...>    Only this watched account
  --limit <n>         At most this many (default 100)
${COMMON_HELP}`,
  options: { ...COMMON, disposition: { type: 'string' }, account: { type: 'string' }, limit: { type: 'string' } },
  async run(args, io) {
    positionals(args, 0)
    const tenantId = tenant(args, io)
    const limit = integer(args, 'limit', 100, 1, 10_000)
    const disposition = string(args, 'disposition')
    if (disposition !== undefined && !(DISPOSITIONS as readonly string[]).includes(disposition)) {
      throw new UsageError(`--disposition takes ${DISPOSITIONS.join(', ')}; not ${JSON.stringify(disposition)}.`)
    }
    const account = string(args, 'account')

    const list = await withStore(args, io, (store) =>
      store.listMovements({
        tenantId,
        limit,
        ...(disposition === undefined ? {} : { disposition: disposition as Disposition }),
        ...(account === undefined ? {} : { account }),
      }),
    )

    if (flag(args, 'json')) {
      await write(io.stdout, json(list.map(movementJson)))
      return 0
    }
    if (list.length === 0) {
      await write(io.stdout, 'No movements.\n')
      return 0
    }
    await write(
      io.stdout,
      table([
        ['OCCURRED (UTC)', 'DISPOSITION', 'DIRECTION', 'AMOUNT', 'COUNTERPARTY', 'MEMO', 'LEDGER', 'ID'],
        ...list.map((m) => [
          when(m.occurredAt),
          m.disposition,
          m.direction,
          `${m.amount.toString()} ${assetLabel(m.amount.asset)}`,
          m.counterparty ?? '',
          memoLabel(m.memo),
          String(m.ledger),
          m.id,
        ]),
      ]),
    )
    return 0
  },
}
