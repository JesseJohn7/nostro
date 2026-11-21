/**
 * Delivery observability and replay for webhook consumers.
 *
 * A consumer's position is an ordinary outbox cursor (see `eventCursorKey`).
 * Status is derived from that cursor, the tail of the event log and a bounded,
 * prunable log of delivery attempts. The event log itself stays append-only;
 * none of the writes below touch it.
 *
 * Rewinding is a compare-and-set on the same cursor `deliverWebhooks()` uses.
 * A deliverer that reads the old position and a rewind cannot both win: one
 * of their compares fails, so a running deliverer never advances a rewound
 * position over an event it has not sent.
 */
import type { Store } from './store.js'
import { EventHistoryPrunedError, eventCursorKey } from './events.js'

/** Keep the newest 1,000 attempts per consumer; drop anything older than 30 days. */
export const DELIVERY_ATTEMPT_LIMIT = 1000
export const DELIVERY_ATTEMPT_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type DeliveryOutcome = 'success' | 'failure'

/** One POST, written by the deliverer whether it worked or not. */
export interface NewDeliveryAttempt {
  readonly tenantId: string
  readonly consumer: string
  readonly eventId: string
  readonly eventSeq: number
  readonly at: Date
  /** Null when the request never got an HTTP response (DNS, timeout, abort). */
  readonly httpStatus: number | null
  /** The failure reason; null on success. */
  readonly error: string | null
  readonly durationMs: number
  readonly outcome: DeliveryOutcome
}

export interface DeliveryAttempt extends NewDeliveryAttempt {
  readonly id: string
  /** Monotonic per tenant, for paging; independent of the event `seq`. */
  readonly seq: number
}

export interface DeliveryAttemptQuery {
  readonly tenantId: string
  readonly consumer: string
  /** Attempts with `seq` lower than this: the `next` of the previous page. */
  readonly beforeSeq?: number
  readonly limit?: number
  readonly outcome?: DeliveryOutcome
}

/** A named destination and how far behind it is. */
export interface ConsumerStatus {
  readonly tenantId: string
  readonly consumer: string
  /** The seq of the last event this consumer acknowledged. */
  readonly position: number
  /** The highest seq written for the tenant. */
  readonly latestSeq: number
  /** `latestSeq - position`, never negative. */
  readonly lag: number
  readonly lastAttempt: DeliveryAttempt | null
  readonly lastSuccess: DeliveryAttempt | null
  readonly lastFailure: DeliveryAttempt | null
}

/** Who moved a consumer back, from where to where, and when. */
export interface Rewind {
  readonly id: string
  /** Monotonic per tenant, for paging and audit order. */
  readonly seq: number
  readonly tenantId: string
  readonly consumer: string
  readonly fromSeq: number
  readonly toSeq: number
  readonly actor: string
  readonly at: Date
}

export interface RewindInput {
  readonly tenantId: string
  readonly consumer: string
  /** The position the caller expects right now. */
  readonly expectedSeq: number
  /** The new, lower position. Events after it are resent on the next round. */
  readonly toSeq: number
  /** Operator identity, kept for the audit trail. */
  readonly actor: string
  readonly at: Date
}

export interface RewindQuery {
  readonly tenantId: string
  readonly consumer?: string
  readonly limit?: number
}

/** The compare failed: the position moved while the caller was deciding. Retry with the new position. */
export class ConsumerPositionConflict extends Error {
  constructor(
    readonly tenantId: string,
    readonly consumer: string,
    readonly expectedSeq: number,
  ) {
    super(`consumer ${consumer} is no longer at position ${expectedSeq}; read its status and retry`)
    this.name = 'ConsumerPositionConflict'
  }
}

/** A rewind that does not move backwards, or targets an invalid sequence. */
export class InvalidRewindError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRewindError'
  }
}

/** The reason a consumer last failed: an HTTP status or a transport error. */
export function failureReason(attempt: DeliveryAttempt | null): string | null {
  if (attempt === null || attempt.outcome !== 'failure') return null
  return attempt.error ?? (attempt.httpStatus === null ? 'unknown error' : `HTTP ${attempt.httpStatus}`)
}

export interface DeliveryAttemptJson {
  readonly id: string
  readonly seq: number
  readonly eventId: string
  readonly eventSeq: number
  readonly at: string
  readonly httpStatus: number | null
  readonly error: string | null
  readonly durationMs: number
  readonly outcome: DeliveryOutcome
  readonly reason: string | null
}

export function deliveryAttemptJson(a: DeliveryAttempt): DeliveryAttemptJson {
  return {
    id: a.id,
    seq: a.seq,
    eventId: a.eventId,
    eventSeq: a.eventSeq,
    at: a.at.toISOString(),
    httpStatus: a.httpStatus,
    error: a.error,
    durationMs: a.durationMs,
    outcome: a.outcome,
    reason: failureReason(a),
  }
}

export interface ConsumerStatusJson {
  readonly tenantId: string
  readonly consumer: string
  readonly position: number
  readonly latestSeq: number
  readonly lag: number
  readonly lastAttempt: DeliveryAttemptJson | null
  readonly lastSuccess: DeliveryAttemptJson | null
  readonly lastFailure: DeliveryAttemptJson | null
}

export function consumerStatusJson(s: ConsumerStatus): ConsumerStatusJson {
  return {
    tenantId: s.tenantId,
    consumer: s.consumer,
    position: s.position,
    latestSeq: s.latestSeq,
    lag: s.lag,
    lastAttempt: s.lastAttempt === null ? null : deliveryAttemptJson(s.lastAttempt),
    lastSuccess: s.lastSuccess === null ? null : deliveryAttemptJson(s.lastSuccess),
    lastFailure: s.lastFailure === null ? null : deliveryAttemptJson(s.lastFailure),
  }
}

export interface RewindJson {
  readonly id: string
  readonly tenantId: string
  readonly consumer: string
  readonly fromSeq: number
  readonly toSeq: number
  readonly actor: string
  readonly at: string
}

export function rewindJson(r: Rewind): RewindJson {
  return {
    id: r.id,
    tenantId: r.tenantId,
    consumer: r.consumer,
    fromSeq: r.fromSeq,
    toSeq: r.toSeq,
    actor: r.actor,
    at: r.at.toISOString(),
  }
}

/** Compute a consumer's status from its cursor, the event tail and its attempt log. */
export async function getConsumerStatus(store: Store, tenantId: string, consumer: string): Promise<ConsumerStatus> {
  const key = eventCursorKey(tenantId, consumer)
  const [saved, latestSeq, attempts, successes, failures] = await Promise.all([
    store.getCursor(key),
    store.getLatestEventSeq(tenantId),
    store.listDeliveryAttempts({ tenantId, consumer, limit: 1 }),
    store.listDeliveryAttempts({ tenantId, consumer, outcome: 'success', limit: 1 }),
    store.listDeliveryAttempts({ tenantId, consumer, outcome: 'failure', limit: 1 }),
  ])
  const position = saved === null ? await store.getEventsPrunedThrough(tenantId) : Number(saved)
  const lastAttempt = attempts[0] ?? null
  const lastSuccess = successes[0] ?? null
  const lastFailure = failures[0] ?? null
  return {
    tenantId,
    consumer,
    position,
    latestSeq,
    lag: Math.max(0, latestSeq - position),
    lastAttempt,
    lastSuccess,
    lastFailure,
  }
}

/**
 * Validate and apply a rewind. `expectedSeq` must be the position the caller
 * saw in the status response; anything else is a conflict, never a silent
 * overwrite of a deliverer that ran in between.
 */
export async function rewindConsumer(store: Store, input: RewindInput): Promise<Rewind> {
  if (!Number.isSafeInteger(input.toSeq) || input.toSeq < 0) {
    throw new InvalidRewindError('toSeq must be a non-negative integer.')
  }
  if (!Number.isSafeInteger(input.expectedSeq) || input.expectedSeq < 0) {
    throw new InvalidRewindError('expectedSeq must be a non-negative integer.')
  }
  if (input.toSeq >= input.expectedSeq) {
    throw new InvalidRewindError('toSeq must be lower than expectedSeq: replay only moves a consumer backwards.')
  }
  if (input.actor.length === 0) throw new InvalidRewindError('actor must not be empty.')
  const prunedThrough = await store.getEventsPrunedThrough(input.tenantId)
  if (input.toSeq < prunedThrough) {
    throw new EventHistoryPrunedError(input.tenantId, input.toSeq, prunedThrough)
  }
  const rewind = await store.transaction((tx) => tx.rewindConsumer(input))
  if (rewind === null) throw new ConsumerPositionConflict(input.tenantId, input.consumer, input.expectedSeq)
  return rewind
}
