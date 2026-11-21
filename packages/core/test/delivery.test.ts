import { describe, expect, it } from 'vitest'
import {
  DELIVERY_ATTEMPT_LIMIT,
  MemoryStore,
  consumerStatusJson,
  deliveryAttemptJson,
  eventCursorKey,
  failureReason,
  getConsumerStatus,
  rewindConsumer,
  rewindJson,
} from '../src/index.js'

const T = 'acme'

describe('delivery records', () => {
  it('formats attempts, status and rewinds for the API', () => {
    const at = new Date('2026-11-01T12:00:00Z')
    const a = {
      id: 'a1', seq: 1, tenantId: T, consumer: 'webhook', eventId: 'e1', eventSeq: 7,
      at, httpStatus: 503, error: null, durationMs: 34, outcome: 'failure' as const,
    }
    expect(deliveryAttemptJson(a)).toMatchObject({
      id: 'a1', eventId: 'e1', eventSeq: 7, at: at.toISOString(),
      httpStatus: 503, error: null, durationMs: 34, outcome: 'failure', reason: 'HTTP 503',
    })
    expect(failureReason(a)).toBe('HTTP 503')
    expect(failureReason({ ...a, outcome: 'success' as const })).toBeNull()
    expect(failureReason(null)).toBeNull()
    expect(failureReason({ ...a, httpStatus: null })).toBe('unknown error')
    expect(consumerStatusJson({
      tenantId: T, consumer: 'webhook', position: 5, latestSeq: 8, lag: 3,
      lastAttempt: a, lastSuccess: null, lastFailure: a,
    })).toMatchObject({ position: 5, latestSeq: 8, lag: 3, lastSuccess: null })
    expect(rewindJson({
      id: 'r1', seq: 1, tenantId: T, consumer: 'webhook', fromSeq: 8, toSeq: 5, actor: 'ops', at,
    })).toEqual({ id: 'r1', tenantId: T, consumer: 'webhook', fromSeq: 8, toSeq: 5, actor: 'ops', at: at.toISOString() })
  })

  it('keeps only the newest attempts and drops attempts past the TTL', async () => {
    const store = new MemoryStore()
    const old = new Date('2025-01-01T00:00:00Z')
    const fresh = new Date('2026-11-01T00:00:00Z')
    await store.transaction((tx) => tx.recordDeliveryAttempt({
      tenantId: T, consumer: 'webhook', eventId: 'old', eventSeq: 1,
      at: old, httpStatus: 200, error: null, durationMs: 1, outcome: 'success',
    }))
    for (let i = 0; i < DELIVERY_ATTEMPT_LIMIT + 2; i++) {
      await store.transaction((tx) => tx.recordDeliveryAttempt({
        tenantId: T, consumer: 'webhook', eventId: `e${i}`, eventSeq: i,
        at: fresh, httpStatus: 200, error: null, durationMs: 1, outcome: 'success',
      }))
    }
    const kept = await store.listDeliveryAttempts({ tenantId: T, consumer: 'webhook' })
    expect(kept).toHaveLength(DELIVERY_ATTEMPT_LIMIT)
    expect(kept.every((a) => a.at.getTime() === fresh.getTime())).toBe(true)
    expect(kept[0]!.eventId).toBe(`e${DELIVERY_ATTEMPT_LIMIT + 1}`)
  })

  it('validates rewinds before touching the cursor', async () => {
    const store = new MemoryStore()
    const at = new Date('2026-11-01T00:00:00Z')
    await store.transaction((tx) => tx.setCursor(eventCursorKey(T, 'webhook'), '10'))
    await expect(rewindConsumer(store, { tenantId: T, consumer: 'webhook', expectedSeq: 10, toSeq: -1, actor: 'ops', at })).rejects.toThrow('toSeq')
    await expect(rewindConsumer(store, { tenantId: T, consumer: 'webhook', expectedSeq: -1, toSeq: 5, actor: 'ops', at })).rejects.toThrow('expectedSeq')
    await expect(rewindConsumer(store, { tenantId: T, consumer: 'webhook', expectedSeq: 10, toSeq: 5, actor: '', at })).rejects.toThrow('actor')
    expect(await store.getCursor(eventCursorKey(T, 'webhook'))).toBe('10')

    const status = await getConsumerStatus(store, T, 'never-ran')
    expect(status.position).toBe(0)
    expect(status.lastAttempt).toBeNull()
  })
})
