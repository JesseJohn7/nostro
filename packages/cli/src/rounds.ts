import { randomUUID } from 'node:crypto'
import type { RoundRecord, RoundRunner, RoundSummary } from '@nostro-labs/server'
import { HttpProblem } from '@nostro-labs/server'

interface TenantRoundState {
  running: RoundRecord | null
  queued: RoundRecord | null
  readonly history: Map<string, RoundRecord>
  wake?: () => void
  rateTimestamps: number[]
}

/**
 * Manages manual round requests for `nostro serve`.
 *
 * Implements `RoundRunner` for the HTTP API:
 * - Coalesces requests: multiple requests while a round is queued or running produce at most one more round.
 * - Rate limits per tenant: max 5 requests per minute.
 * - Stores recent rounds in an in-memory ring buffer per tenant (up to 100 entries).
 * - Wakes the tenant's sync loop immediately when a round is requested.
 */
export class RoundManager implements RoundRunner {
  private readonly tenants = new Map<string, TenantRoundState>()

  private getTenantState(tenantId: string): TenantRoundState {
    let state = this.tenants.get(tenantId)
    if (!state) {
      state = {
        running: null,
        queued: null,
        history: new Map(),
        rateTimestamps: [],
      }
      this.tenants.set(tenantId, state)
    }
    return state
  }

  registerTenant(tenantId: string, wake: () => void): void {
    const state = this.getTenantState(tenantId)
    state.wake = wake
  }

  async triggerRound(tenantId: string, account?: string): Promise<{ id: string; round: RoundRecord }> {
    const state = this.getTenantState(tenantId)

    // Per-tenant rate limit: max 5 requests per 60 seconds
    const now = Date.now()
    state.rateTimestamps = state.rateTimestamps.filter((t) => now - t < 60_000)
    if (state.rateTimestamps.length >= 5) {
      throw new HttpProblem(429, 'too_many_requests', 'Rate limit exceeded: at most 5 requests per minute per tenant.')
    }
    state.rateTimestamps.push(now)

    // Coalesce: if a round is already queued for this tenant, return it
    if (state.queued !== null) {
      return { id: state.queued.id, round: state.queued }
    }

    const id = randomUUID()
    const round: RoundRecord = {
      id,
      tenantId,
      account: account ?? null,
      state: 'queued',
      queuedAt: new Date(now).toISOString(),
      startedAt: null,
      finishedAt: null,
      summary: null,
      error: null,
    }

    state.queued = round
    state.history.set(id, round)

    // In-memory history ring buffer: keep up to 100 entries per tenant
    if (state.history.size > 100) {
      const oldestKey = state.history.keys().next().value
      if (oldestKey) state.history.delete(oldestKey)
    }

    // Wake loop so it starts within a second, not after the interval sleep
    state.wake?.()

    return { id, round }
  }

  async getRound(tenantId: string, id: string): Promise<RoundRecord | null> {
    const state = this.tenants.get(tenantId)
    if (!state) return null
    const round = state.history.get(id)
    if (!round || round.tenantId !== tenantId) return null
    return round
  }

  onRoundStart(tenantId: string): RoundRecord | null {
    const state = this.getTenantState(tenantId)
    if (state.queued !== null) {
      const round = state.queued
      state.queued = null
      const updated: RoundRecord = {
        ...round,
        state: 'running',
        startedAt: new Date().toISOString(),
      }
      state.running = updated
      state.history.set(updated.id, updated)
      return updated
    }
    return null
  }

  onRoundDone(tenantId: string, summary: RoundSummary): void {
    const state = this.getTenantState(tenantId)
    if (state.running !== null) {
      const updated: RoundRecord = {
        ...state.running,
        state: 'done',
        finishedAt: new Date().toISOString(),
        summary,
      }
      state.history.set(updated.id, updated)
      state.running = null
    }
    if (state.queued !== null) {
      state.wake?.()
    }
  }

  onRoundFailed(tenantId: string, err: unknown): void {
    const state = this.getTenantState(tenantId)
    if (state.running !== null) {
      const updated: RoundRecord = {
        ...state.running,
        state: 'failed',
        finishedAt: new Date().toISOString(),
        error: (err as Error).message,
      }
      state.history.set(updated.id, updated)
      state.running = null
    }
    if (state.queued !== null) {
      state.wake?.()
    }
  }
}
