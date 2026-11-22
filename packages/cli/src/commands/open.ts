import { HorizonBalanceSource, NATIVE, openAccount } from '@nostro-labs/nostro'
import { COMMON, NETWORK, RATE_LIMIT, UsageError, accounts, flag, network, positionals, rateLimit, string, tenant } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, NETWORK_HELP, RATE_LIMIT_HELP, horizonClient, withStore } from '../command.js'
import { assetLabel } from '../format.js'
import { json, table, write } from '../io.js'

export const open: Command = {
  name: 'open',
  summary: 'Start a wallet\'s books at its current on-chain balances',
  usage: '--account <G...> [--network <name>] [--note <text>] [options]',
  help: `Reads the account's balances from Horizon and posts the opening entry, then seeds both
Horizon cursors after that ledger so sync starts from there instead of inventing history. The
account must have no movements recorded yet. Pool shares are refused rather than silently
dropped. A native XLM balance must be present.

Options:
  --note <text>       Description for the opening journal entry
${NETWORK_HELP}
${RATE_LIMIT_HELP}
${COMMON_HELP}`,
  options: { ...COMMON, ...NETWORK, ...RATE_LIMIT, note: { type: 'string' } },
  async run(args, io) {
    positionals(args, 0)
    const list = accounts(args, io)
    if (list.length !== 1) throw new UsageError('open takes exactly one --account.')
    const account = list[0]!
    const tenantId = tenant(args, io)
    const net = network(args, io)
    const client = horizonClient(net, io, rateLimit(args))
    const snapshot = await new HorizonBalanceSource({ client, network: net.name }).snapshot(account)
    if (snapshot.ledger === null || snapshot.balances.length === 0) {
      throw new UsageError(`${account} has no on-chain balances to open from.`)
    }
    if (snapshot.poolShares !== undefined && snapshot.poolShares.length > 0) {
      throw new UsageError(`${account} holds liquidity pool shares, which nostro cannot open from.`)
    }
    if (!snapshot.balances.some((b) => b.amount.asset === NATIVE)) {
      throw new UsageError(`${account} has no native XLM balance in Horizon's response; refusing an incomplete snapshot.`)
    }
    const opening = await withStore(args, io, (store) => openAccount(store, {
      tenantId,
      network: net.name,
      account,
      ledger: snapshot.ledger!,
      balances: snapshot.balances.map((b) => ({ amount: b.amount, lastModifiedLedger: b.lastModifiedLedger })),
      note: string(args, 'note') ?? null,
    }))
    if (flag(args, 'json')) {
      await write(io.stdout, json({
        account: opening.account,
        network: opening.network,
        ledger: opening.ledger,
        occurredAt: opening.occurredAt.toISOString(),
        balances: opening.balances.map((b) => ({
          asset: b.amount.asset,
          amount: b.amount.toString(),
          lastModifiedLedger: b.lastModifiedLedger,
        })),
      }))
      return 0
    }
    await write(io.stdout, table([
      ['ACCOUNT', 'NETWORK', 'LEDGER', 'ASSET', 'BALANCE', 'LAST CHANGED'],
      ...opening.balances.map((b) => [
        opening.account,
        opening.network,
        String(opening.ledger),
        assetLabel(b.amount.asset),
        b.amount.toString(),
        b.lastModifiedLedger === null ? '' : String(b.lastModifiedLedger),
      ]),
    ]))
    return 0
  },
}
