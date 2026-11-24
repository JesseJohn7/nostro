/**
 * The two loops behind `nostro sync`, `nostro reconcile` and the worker in
 * `nostro serve`: catch every stream up, then decide everything pending.
 *
 * Thin adapters over the library functions `syncUntilCaughtUp` and
 * `reconcileUntilDone` in `@nostro-labs/nostro`. The library owns the loop
 * logic; the CLI adds the `signal` from Ctrl-C.
 */
import type { ExceptionCode, MovementSource, Store } from '@nostro-labs/nostro'
import { reconcileUntilDone, syncUntilCaughtUp } from '@nostro-labs/nostro'

export type { StreamProgress } from '@nostro-labs/nostro'
import type { StreamProgress } from '@nostro-labs/nostro'

export interface SyncAllOptions {
  readonly store: Store
  readonly tenantId: string
  readonly accounts: readonly string[]
  readonly sources: readonly MovementSource[]
  /** One round of pages per stream, rather than until caught up. */
  readonly once?: boolean
  /** Abort between rounds; the current round finishes first. */
  readonly signal?: AbortSignal
  /** After each round, with the streams that round read. */
  readonly onRound?: (source: MovementSource, streams: readonly StreamProgress[]) => Promise<void>
}

/** Sync every account from every source; one entry per (source, account). */
export async function syncAll(options: SyncAllOptions): Promise<StreamProgress[]> {
  const { streams } = await syncUntilCaughtUp(options)
  return [...streams]
}

export interface ReconcileTotals {
  decided: number
  allocated: number
  partial: number
  ignored: number
  journalEntries: number
  readonly exceptions: Partial<Record<ExceptionCode, number>>
  /** Movement id → why it could not be decided. */
  readonly errors: Map<string, string>
}

/** Reconcile until nothing pending is left that can be decided. */
export async function reconcileAll(store: Store, tenantId: string, limit: number, signal?: AbortSignal): Promise<ReconcileTotals> {
  const { aborted, ...totals } = await reconcileUntilDone({ store, tenantId, limit, ...(signal === undefined ? {} : { signal }) })
  return totals
}
