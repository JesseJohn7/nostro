/**
 * Bounded loops over `sync()`, `reconcile()`, `postJournal()` and
 * `deliverWebhooks()`. Each is the loop a product writes around the bounded
 * call, moved into the library so it is written once: stop on a signal,
 * between batches, with totals and whether it was stopped.
 *
 * The CLI commands (`nostro sync`, `reconcile`, `post`, `serve`) all use these,
 * so a library user gets the same stop conditions without rewriting them.
 */
import type { ExceptionCode, JournalEntryKind } from '../model/index.js'
import type { Store } from '../store/index.js'
import type { MovementSource } from './source.js'
import { sync } from './sync.js'
import { reconcile } from '../matching/reconcile.js'
import { sweepExpectations } from '../matching/sweep.js'
import type { AccountSyncReport } from './sync.js'
import { postJournal } from '../journal/index.js'
import type { PostOptions } from '../journal/index.js'
import { deliverWebhooks } from '../webhooks/index.js'
import type { DeliverOptions } from '../webhooks/index.js'

// ---------------------------------------------------------------------------
// syncUntilCaughtUp
// ---------------------------------------------------------------------------

export interface StreamProgress {
  readonly account: string
  readonly source: string
  inserted: number
  duplicates: number
  conflicts: number
  gaps: number
  cursor: string | null
  caughtUp: boolean
  /** Another process advanced the cursor first; it is syncing this stream. */
  contended: boolean
  error: Error | null
}

function addStream(p: StreamProgress, r: AccountSyncReport): void {
  p.inserted += r.inserted
  p.duplicates += r.duplicates
  p.conflicts += r.conflicts
  p.gaps += r.gaps
  p.cursor = r.cursor
  p.caughtUp = r.caughtUp
  p.contended = r.contended
  p.error = r.error
}

export interface SyncUntilCaughtUpOptions {
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

export interface SyncUntilCaughtUpReport {
  readonly streams: readonly StreamProgress[]
  /** True when the signal fired before every stream was done. */
  readonly aborted: boolean
}

/** Sync every account from every source until caught up, or the signal fires. */
export async function syncUntilCaughtUp(options: SyncUntilCaughtUpOptions): Promise<SyncUntilCaughtUpReport> {
  const { store, tenantId } = options
  const results: StreamProgress[] = []
  let aborted = false
  for (const source of options.sources) {
    const rows: StreamProgress[] = options.accounts.map((account) => ({
      account,
      source: source.name,
      inserted: 0,
      duplicates: 0,
      conflicts: 0,
      gaps: 0,
      cursor: null,
      caughtUp: false,
      contended: false,
      error: null,
    }))
    results.push(...rows)
    let remaining = rows
    while (remaining.length > 0) {
      if (options.signal?.aborted === true) {
        aborted = true
        break
      }
      const report = await sync({
        store,
        source,
        tenantId,
        accounts: remaining.map((r) => r.account),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      report.accounts.forEach((r, i) => addStream(remaining[i]!, r))
      await options.onRound?.(source, remaining)
      if (options.once === true) break
      remaining = remaining.filter((r) => !r.caughtUp && !r.contended && r.error === null)
    }
    if (aborted) break
  }
  return { streams: results, aborted }
}

// ---------------------------------------------------------------------------
// reconcileUntilDone
// ---------------------------------------------------------------------------

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

export interface ReconcileUntilDoneOptions {
  readonly store: Store
  readonly tenantId: string
  /** Movements per round. Default 100. */
  readonly limit?: number
  /** Abort between rounds; the current round finishes first. */
  readonly signal?: AbortSignal
}

export interface ReconcileUntilDoneReport extends ReconcileTotals {
  /** True when the signal fired before everything was decided. */
  readonly aborted: boolean
}

/** Reconcile until nothing pending is left that can be decided, or the signal fires. */
export async function reconcileUntilDone(options: ReconcileUntilDoneOptions): Promise<ReconcileUntilDoneReport> {
  const { store, tenantId } = options
  const limit = options.limit ?? 100
  const totals: ReconcileTotals = {
    decided: 0,
    allocated: 0,
    partial: 0,
    ignored: 0,
    journalEntries: 0,
    exceptions: {},
    errors: new Map(),
  }
  await sweepExpectations({ store, tenantId })
  for (;;) {
    if (options.signal?.aborted === true) return { ...totals, aborted: true }
    const report = await reconcile({ store, tenantId, limit })
    totals.decided += report.processed
    totals.allocated += report.allocated
    totals.partial += report.partial
    totals.ignored += report.ignored
    totals.journalEntries += report.journalEntries
    for (const [code, n] of Object.entries(report.exceptions) as [ExceptionCode, number][]) {
      totals.exceptions[code] = (totals.exceptions[code] ?? 0) + n
    }
    for (const { movementId, error } of report.errors) totals.errors.set(movementId, error.message)
    // A movement that failed stays pending, so stop once a round decides nothing new.
    if (report.processed + report.skipped === 0) return { ...totals, aborted: false }
  }
}

// ---------------------------------------------------------------------------
// postUntilDone
// ---------------------------------------------------------------------------

export interface PostUntilDoneOptions extends PostOptions {
  readonly store: Store
  readonly tenantId: string
  /** Movements to examine per call. Default 500. */
  readonly limit?: number
  /** Abort between pages; the current page finishes first. */
  readonly signal?: AbortSignal
}

export interface PostUntilDoneReport {
  readonly examined: number
  readonly posted: Readonly<Record<JournalEntryKind, number>>
  readonly errors: readonly { readonly movementId: string; readonly error: string }[]
  /** True when the signal fired before everything was posted. */
  readonly aborted: boolean
}

/** Post to the journal until every decision is reflected, or the signal fires. */
export async function postUntilDone(options: PostUntilDoneOptions): Promise<PostUntilDoneReport> {
  const { store, tenantId } = options
  const posted: Record<JournalEntryKind, number> = { initial: 0, reclass: 0, correction: 0, conversion: 0, manual: 0, opening: 0 }
  const errors = new Map<string, string>()
  let examined = 0
  for (let afterSeq: number | undefined; ; ) {
    if (options.signal?.aborted === true) {
      return {
        examined,
        posted,
        errors: [...errors].map(([movementId, error]) => ({ movementId, error })),
        aborted: true,
      }
    }
    const report = await postJournal({
      store,
      tenantId,
      ...(afterSeq === undefined ? {} : { afterSeq }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    })
    examined += report.examined
    for (const kind of Object.keys(posted) as JournalEntryKind[]) posted[kind] += report.posted[kind]
    for (const { movementId, error } of report.errors) errors.set(movementId, error.message)
    if (report.lastSeq === null) {
      return {
        examined,
        posted,
        errors: [...errors].map(([movementId, error]) => ({ movementId, error })),
        aborted: false,
      }
    }
    afterSeq = report.lastSeq
  }
}

// ---------------------------------------------------------------------------
// deliverUntilDone
// ---------------------------------------------------------------------------

export interface DeliverUntilDoneOptions extends Omit<DeliverOptions, 'store' | 'tenantId'> {
  readonly store: Store
  readonly tenantId: string
  /** Abort between rounds; the current round finishes first. */
  readonly signal?: AbortSignal
}

export interface DeliverUntilDoneReport {
  readonly delivered: number
  readonly failure: { readonly eventId: string; readonly reason: string } | null
  readonly contended: boolean
  /** True when the signal fired before everything was delivered. */
  readonly aborted: boolean
}

/** Deliver events until caught up, a delivery fails, or the signal fires. */
export async function deliverUntilDone(options: DeliverUntilDoneOptions): Promise<DeliverUntilDoneReport> {
  let total = 0
  let lastFailure: { eventId: string; reason: string } | null = null
  let lastContended = false
  for (;;) {
    if (options.signal?.aborted === true) {
      return { delivered: total, failure: lastFailure, contended: lastContended, aborted: true }
    }
    const { store, tenantId, ...rest } = options
    const report = await deliverWebhooks({ store, tenantId, ...rest })
    total += report.delivered
    lastFailure = report.failure
    lastContended = report.contended
    if (report.delivered === 0 || report.failure !== null || report.contended) break
  }
  return { delivered: total, failure: lastFailure, contended: lastContended, aborted: false }
}
