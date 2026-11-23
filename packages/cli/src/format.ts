/** How records are shown as text. JSON comes from nostro's own wire format. */
import type { AssetId, Expectation, ExpectationJson, Memo, Money } from '@nostro-labs/nostro'
import { NATIVE, expectationJson } from '@nostro-labs/nostro'

/** `XLM` for the native asset, else the full `CODE:ISSUER`: a code alone is not an asset. */
export const assetLabel = (asset: AssetId): string => (asset === NATIVE ? 'XLM' : asset)

export const money = (m: Money): string => `${m.toString()} ${assetLabel(m.asset)}`

/** To the minute, in UTC. */
export const when = (d: Date | null): string => (d === null ? '' : d.toISOString().slice(0, 16).replace('T', ' '))

/** An expectation, with how much has been allocated to it. */
export const expectationWithPaid = (e: Expectation, paid: Money): ExpectationJson & { paid: string } => ({
  ...expectationJson(e),
  paid: paid.toString(),
})

/** A memo as one text cell, e.g. `text: INV-1042`; empty when there is none. */
export const memoLabel = (memo: Memo | null): string => (memo === null ? '' : `${memo.type}: ${String(memo.value)}`)
