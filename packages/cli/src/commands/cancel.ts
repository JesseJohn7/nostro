import { ConstraintError, Money, NotFoundError, ValidationError } from '@nostro-labs/nostro'
import { COMMON, CliError, UsageError, flag, positionals, string, tenant } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, withStore } from '../command.js'
import { expectationWithPaid } from '../format.js'
import { clean, json, write } from '../io.js'

export const cancel: Command = {
  name: 'cancel',
  summary: 'Cancel an open expectation that has no allocations',
  usage: '<reference> --reason <why> [options]',
  help: `Cancels an expectation by reference. Refused once anything has been allocated to it.

Options:
  --reason <why>      Required. Kept with the cancellation
${COMMON_HELP}`,
  options: { ...COMMON, reason: { type: 'string' } },
  async run(args, io) {
    const [reference] = positionals(args, 1)
    if (reference === undefined) throw new UsageError('Give the expectation reference, e.g. nostro cancel INV-1042 --reason "..."')
    const reason = string(args, 'reason')
    if (reason === undefined || reason.trim() === '') throw new UsageError('--reason is required.')
    const tenantId = tenant(args, io)

    const cancelled = await withStore(args, io, async (store) => {
      const e = await store.getExpectationByReference(tenantId, reference)
      if (e === null) throw new CliError(`No expectation ${reference}.`)
      try {
        return await store.transaction((tx) => tx.cancelExpectation(tenantId, e.id, reason))
      } catch (err) {
        if (err instanceof NotFoundError) throw new CliError(`No expectation ${reference}.`)
        if (err instanceof ConstraintError) throw new CliError(err.message)
        if (err instanceof ValidationError) throw new UsageError(err.message)
        throw err
      }
    })

    if (flag(args, 'json')) {
      await write(io.stdout, json(expectationWithPaid(cancelled, Money.zero(cancelled.amount.asset, cancelled.amount.decimals))))
    } else {
      await write(io.stdout, `Cancelled ${clean(cancelled.reference)}.\n`)
    }
    return 0
  },
}
