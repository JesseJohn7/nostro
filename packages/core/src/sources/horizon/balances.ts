/**
 * Horizon as a `BalanceSource`: an account's balances, and when each last
 * changed, for attesting them against recorded movements (I2).
 */
import type { AssetSupply, BalanceLine, BalanceSnapshot, BalanceSource } from '../../invariants/index.js'
import { Money, NATIVE, asset, issuerOf, isNative } from '../../money/index.js'
import type { AssetId } from '../../money/index.js'
import type { HorizonClient } from './client.js'
import { HorizonError } from './client.js'
import type { HorizonAccount, HorizonAssetRecord } from './records.js'

export interface HorizonBalanceSourceOptions {
  readonly client: HorizonClient
  /** The same label the movement sources use, e.g. `public` or `testnet`. */
  readonly network: string
}

export class HorizonBalanceSource implements BalanceSource {
  readonly network: string
  private readonly client: HorizonClient

  constructor(options: HorizonBalanceSourceOptions) {
    this.client = options.client
    this.network = options.network
  }

  async snapshot(account: string): Promise<BalanceSnapshot> {
    let response
    try {
      response = await this.client.resource<HorizonAccount>(`/accounts/${account}`)
    } catch (err) {
      // Never funded, or merged away: it holds nothing.
      if (err instanceof HorizonError && err.status === 404) return { account, ledger: null, balances: [] }
      throw err
    }
    const { body, latestLedger } = response
    const balances: BalanceLine[] = []
    const poolShares: string[] = []
    for (const b of body.balances) {
      // Pool shares are not movements nostro records.
      if (b.asset_type === 'liquidity_pool_shares') {
        poolShares.push(b.liquidity_pool_id ?? b.asset_code ?? 'unknown')
        continue
      }
      const id = b.asset_type === 'native' ? NATIVE : asset(b.asset_code ?? '', b.asset_issuer ?? '')
      balances.push({
        amount: Money.parse(b.balance, id),
        lastModifiedLedger: b.last_modified_ledger ?? body.last_modified_ledger,
      })
    }
    return { account, ledger: latestLedger, balances, poolShares }
  }

  async supply(account: string, assetId: AssetId): Promise<AssetSupply | null> {
    if (isNative(assetId)) return null
    const issuer = issuerOf(assetId)
    if (issuer === null || issuer !== account) return null
    const code = assetId.slice(0, assetId.indexOf(':'))

    const { body, latestLedger } = await this.client.resource<{ _embedded?: { records?: HorizonAssetRecord[] } }>(
      '/assets',
      { asset_code: code, asset_issuer: issuer, limit: '1' },
    )
    const records = body._embedded?.records ?? []
    if (records.length === 0) return null

    const r = records[0]!
    const b = r.balances ?? {}
    const sum = (amount: string | undefined) => Money.parse(amount ?? '0', assetId)
    const outstanding = sum(b.authorized)
      .add(sum(b.authorized_to_maintain_liabilities))
      .add(sum(b.unauthorized))
      .add(sum(r.claimable_balances_amount))
      .add(sum(r.liquidity_pools_amount))
      .add(sum(r.contracts_amount))

    return { asset: assetId, outstanding, ledger: latestLedger }
  }
}
