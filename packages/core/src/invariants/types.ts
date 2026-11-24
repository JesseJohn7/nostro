/**
 * What checking the invariants reports.
 *
 * - **I1, total disposition:** every movement is fully allocated, partially
 *   allocated with an open exception covering the rest, carries an
 *   exception, or is ignored with a reason.
 * - **I2, balance attestation:** a watched account's movements add up to the
 *   balance the chain reports for it.
 * - **I3, journal balance:** every journal entry balances per asset, and a
 *   movement's entries agree with the movement.
 */
import type { AssetId } from '../money/index.js'

export type Invariant = 'I1' | 'I2' | 'I3' | 'I4'

export type FindingCode =
  // I1
  | 'disposition_unsupported'
  | 'allocation_asset'
  | 'allocation_over_movement'
  | 'muxed_id_duplicate'
  | 'expectation_status_mismatch'
  | 'allocation_over_expectation'
  | 'allocation_account_mismatch'
  | 'allocation_direction_mismatch'
  | 'expectation_cancelled_with_allocations'
  // I2
  | 'balance_mismatch'
  // I3
  | 'journal_unbalanced'
  | 'journal_posting_sequence'
  | 'journal_asset'
  | 'journal_cash_mismatch'
  | 'journal_stale'
  | 'manual_entry_touches_cash'
  // I4 — event log integrity
  | 'event_missing'
  | 'event_chain_broken'

/**
 * `error`: the invariant does not hold. `warning`: it holds, but something
 * is waiting to be done, such as posting a decision to the journal.
 */
export type Severity = 'error' | 'warning'

export interface Finding {
  readonly invariant: Invariant
  readonly severity: Severity
  readonly code: FindingCode
  readonly detail: string
  readonly movementId: string | null
  readonly entryId: string | null
  readonly account: string | null
  readonly asset: AssetId | null
}
