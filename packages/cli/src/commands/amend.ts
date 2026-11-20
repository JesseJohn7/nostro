import type { ExpectationChanges, Memo } from '@nostro-labs/nostro'
import { ConstraintError, Money, NotFoundError, ValidationError, sumAmounts } from '@nostro-labs/nostro'
import type { Args } from '../args.js'
import { COMMON, CliError, UsageError, date, flag, positionals, string, strings, tenant } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, withStore } from '../command.js'
import { expectationWithPaid } from '../format.js'
import { clean, json, write } from '../io.js'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const UINT64 = /^\d{1,20}$/
const UINT64_MAX = (1n << 64n) - 1n
function uint64Opt(args: Args, name: string): bigint | null | undefined {
  const raw = string(args, name)
  if (raw === undefined) return undefined
  if (raw === 'none' || raw === 'null') return null
  if (!UINT64.test(raw) || BigInt(raw) > UINT64_MAX) throw new UsageError(`--${name} must be a whole number below 2^64, or "none".`)
  return BigInt(raw)
}
function memoOf(args: Args): Memo | null | undefined {
  const text = string(args, 'memo-text')
  const id = string(args, 'memo-id')
  const clear = flag(args, 'clear-memo')
  if (clear && (text !== undefined || id !== undefined)) throw new UsageError('Use --clear-memo alone, not with memo flags.')
  if (clear) return null
  if (text !== undefined && id !== undefined) throw new UsageError('Give --memo-text or --memo-id, not both.')
  if (id !== undefined) {
    if (!UINT64.test(id) || BigInt(id) > UINT64_MAX) throw new UsageError('--memo-id must be a whole number below 2^64.')
    return { type: 'id', value: BigInt(id) }
  }
  if (text !== undefined) {
    if (text === '' || Buffer.byteLength(text, 'utf8') > 28) throw new UsageError('--memo-text must be 1 to 28 bytes.')
    return { type: 'text', value: text }
  }
  return undefined
}
function metadataOf(args: Args): Record<string, string> | undefined {
  const pairs = strings(args, 'meta')
  if (pairs.length === 0) return undefined
  const out: Record<string, string> = {}
  for (const pair of pairs) {
    const at = pair.indexOf('=')
    if (at < 1) throw new UsageError(`--meta must be key=value, not ${JSON.stringify(pair)}.`)
    out[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return out
}

export const amend: Command = {
  name: 'amend',
  summary: 'Change an open or part-paid expectation',
  usage: '<reference> --reason <why> [--amount <amount>] [options]',
  help: `Amends an expectation by reference. Amount cannot be lowered below what is already allocated;
lowering it to exactly what is allocated settles it. Reference, account, asset and direction cannot change.

Options:
  --reason <why>      Required. Kept with the amendment
  --amount <amount>   New amount in the expectation's asset
  --muxed-id <n|none> New muxed id, or "none" to clear
  --memo-text <text>  New text memo
  --memo-id <n>       New id memo
  --clear-memo        Remove the memo
  --payer <G...>      Replace payers (repeatable). Omit to leave unchanged
  --due <date>        New due date
  --clear-due         Remove the due date
  --expires <date>    New expiry
  --clear-expires     Remove the expiry
  --meta <key=value>  Replace metadata (repeatable). Omit to leave unchanged
${COMMON_HELP}`,
  options: {
    ...COMMON,
    reason: { type: 'string' },
    amount: { type: 'string' },
    'muxed-id': { type: 'string' },
    'memo-text': { type: 'string' },
    'memo-id': { type: 'string' },
    'clear-memo': { type: 'boolean' },
    payer: { type: 'string', multiple: true },
    due: { type: 'string' },
    'clear-due': { type: 'boolean' },
    expires: { type: 'string' },
    'clear-expires': { type: 'boolean' },
    meta: { type: 'string', multiple: true },
  },
  async run(args, io) {
    const [reference] = positionals(args, 1)
    if (reference === undefined) throw new UsageError('Give the expectation reference, e.g. nostro amend INV-1042 --reason "..."')
    const reason = string(args, 'reason')
    if (reason === undefined || reason.trim() === '') throw new UsageError('--reason is required.')
    const tenantId = tenant(args, io)

    const { amended, paid } = await withStore(args, io, async (store) => {
      const e = await store.getExpectationByReference(tenantId, reference)
      if (e === null) throw new CliError(`No expectation ${reference}.`)
      const changes: Mutable<ExpectationChanges> = {}
      const rawAmount = string(args, 'amount')
      if (rawAmount !== undefined) {
        try { changes.amount = Money.parse(rawAmount, e.amount.asset, e.amount.decimals) } catch (err) { throw new UsageError(`--amount: ${(err as Error).message}`) }
      }
      const muxedId = uint64Opt(args, 'muxed-id')
      if (muxedId !== undefined) changes.muxedId = muxedId
      const memo = memoOf(args)
      if (memo !== undefined) changes.memo = memo
      const payers = strings(args, 'payer')
      if (payers.length > 0) changes.payers = payers
      if (flag(args, 'clear-due')) changes.dueAt = null
      else { const d = date(args, 'due'); if (d !== undefined) changes.dueAt = d }
      if (flag(args, 'clear-expires')) changes.expiresAt = null
      else { const d = date(args, 'expires'); if (d !== undefined) changes.expiresAt = d }
      const meta = metadataOf(args)
      if (meta !== undefined) changes.metadata = meta
      try {
        return await store.transaction(async (tx) => {
          const current = await tx.getExpectation(tenantId, e.id)
          if (current === null) throw new NotFoundError('expectation', e.id)
          const amended = await tx.amendExpectation(tenantId, e.id, changes, reason)
          const allocations = await tx.listAllocations({ tenantId, expectationId: e.id })
          return { amended, paid: sumAmounts(allocations.map((a) => a.amount), amended.amount) }
        })
      } catch (err) {
        if (err instanceof NotFoundError) throw new CliError(`No expectation ${reference}.`)
        if (err instanceof ConstraintError) throw new CliError(err.message)
        if (err instanceof ValidationError) throw new UsageError(err.message)
        throw err
      }
    })

    if (flag(args, 'json')) {
      await write(io.stdout, json(expectationWithPaid(amended, paid)))
    } else {
      await write(io.stdout, `Amended ${clean(amended.reference)} (${amended.status}).\n`)
    }
    return 0
  },
}
