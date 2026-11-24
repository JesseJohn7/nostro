/**
 * Webhooks: the event log, POSTed to a URL, signed.
 *
 * `deliverWebhooks()` reads the tenant's events after the consumer's saved
 * position and POSTs them one at a time, in order. A 2xx moves the position
 * on; anything else stops the round there, so the next call retries the
 * same event and nothing is ever delivered out of order or skipped.
 * Delivery is at least once (a crash after the POST but before the position
 * is saved sends that event again), so receivers dedupe on the event id.
 * Every POST is also recorded in a bounded attempt log per consumer, which
 * backs the status and replay routes; see `store/delivery.ts`.
 *
 * Each request carries `Nostro-Signature: t=<unix seconds>,v1=<hex>`, the
 * HMAC-SHA256 of `<t>.<body>` under the shared secret. `verifyWebhook()`
 * checks it in constant time and refuses a timestamp outside the tolerance,
 * so a captured request cannot be replayed later.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { DeliveryOutcome, Store } from '../store/index.js'
import { eventCursorKey, outboxEventJson } from '../store/index.js'
import { parseSignature, SIGNATURE_HEADER, type VerifyOptions } from './parse.js'

export { parseSignature, SIGNATURE_HEADER } from './parse.js'
export type { ParsedSignature, VerifyOptions } from './parse.js'

/** Shorter secrets can be guessed; generate them with `openssl rand -hex 32`. */
export const MIN_WEBHOOK_SECRET_LENGTH = 32

const hmac = (secret: string, t: number, body: string) =>
  createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex')

/** The `Nostro-Signature` value for a body sent at `t` (unix seconds). */
export function signWebhook(secret: string, body: string, t: number): string {
  return `t=${t},v1=${hmac(secret, t, body)}`
}

/** True only for a body signed with `secret` within the tolerance. */
export function verifyWebhook(options: VerifyOptions): boolean {
  const { secret, header, body } = options
  if (typeof header !== 'string') return false
  const now = Math.floor((options.now ?? (() => new Date()))().getTime() / 1000)
  const signature = parseSignature(header, now, options.toleranceSeconds ?? 300)
  if (signature === null) return false
  return timingSafeEqual(
    Buffer.from(hmac(secret, signature.t, body), 'hex'),
    Buffer.from(signature.v1, 'hex'),
  )
}

export interface DeliverOptions {
  readonly store: Store
  readonly tenantId: string
  readonly url: string
  readonly secret: string
  /** Names this destination's saved position. Default `webhook`. */
  readonly consumer?: string
  /** Events per call. Default 100. */
  readonly limit?: number
  /** Per request. Default 10 seconds. */
  readonly timeoutMs?: number
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => Date
}

export interface DeliverReport {
  readonly delivered: number
  /** The seq of the last event delivered, or the saved position if none was. */
  readonly position: number
  /** Why the round stopped early, if it did; the next call retries that event. */
  readonly failure: { readonly eventId: string; readonly reason: string } | null
  /** Another deliverer moved the position during this round; this one stopped. */
  readonly contended: boolean
}

/** Deliver the tenant's undelivered events, in order, until one fails or none are left. */
export async function deliverWebhooks(options: DeliverOptions): Promise<DeliverReport> {
  const { store, tenantId, url, secret } = options
  if (secret.length < MIN_WEBHOOK_SECRET_LENGTH) {
    throw new Error(`A webhook secret must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters.`)
  }
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? (() => new Date())
  const consumer = options.consumer ?? 'webhook'
  const key = eventCursorKey(tenantId, consumer)
  const saved = await store.getCursor(key)
  let position = saved === null ? await store.getEventsPrunedThrough(tenantId) : Number(saved)
  if (saved === null) {
    await store.transaction((tx) => tx.setCursor(key, String(position)))
  }
  let delivered = 0

  const events = await store.listEvents({ tenantId, afterSeq: position, limit: options.limit ?? 100 })
  for (const event of events) {
    // A replay between rounds moves the cursor back. Notice it before POSTing
    // so this round does not send an event the rewound consumer has not earned.
    const current = await store.getCursor(key)
    if ((current === null ? 0 : Number(current)) !== position) {
      return { delivered, position: current === null ? 0 : Number(current), failure: null, contended: true }
    }
    const body = JSON.stringify(outboxEventJson(event))
    const started = Date.now()
    let httpStatus: number | null = null
    let error: string | null = null
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'nostro-webhooks',
          'nostro-event-id': event.id,
          'nostro-event-type': event.type,
          [SIGNATURE_HEADER]: signWebhook(secret, body, Math.floor(now().getTime() / 1000)),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      })
      await response.body?.cancel()
      httpStatus = response.status
      if (response.status < 200 || response.status >= 300) error = `HTTP ${response.status}`
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    const outcome: DeliveryOutcome = error === null ? 'success' : 'failure'
    const durationMs = Math.max(0, Date.now() - started)
    const from = position

    // The attempt is recorded whether or not the POST worked. A successful
    // POST and the position it earns are written together; on a failed compare
    // the attempt still lands, but this deliverer stops before the cursor.
    const result = await store.transaction(async (tx) => {
      await tx.recordDeliveryAttempt({
        tenantId,
        consumer,
        eventId: event.id,
        eventSeq: event.seq,
        at: now(),
        httpStatus,
        error,
        durationMs,
        outcome,
      })
      if (error !== null) return { status: 'failed' as const, position }
      const current = await tx.getCursor(key)
      const currentPos = current === null ? 0 : Number(current)
      if (currentPos !== from) return { status: 'contended' as const, position: currentPos }
      await tx.setCursor(key, String(event.seq))
      return { status: 'moved' as const, position: event.seq }
    })
    if (result.status === 'failed') return { delivered, position, failure: { eventId: event.id, reason: error! }, contended: false }
    if (result.status === 'contended') return { delivered, position: result.position, failure: null, contended: true }
    position = result.position
    delivered += 1
  }
  return { delivered, position, failure: null, contended: false }
}
