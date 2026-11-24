import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryStore, Money, NATIVE, eventCursorKey, reconcile } from '@nostro-labs/nostro'
import type { RoundRecord, RoundRunner } from '@nostro-labs/server'
import { apiKeys, createServer } from '@nostro-labs/server'
import { ApiError, createClient, type NostroClient } from '../src/index.js'

const KEY = 'k'.repeat(32)
const A = 'G' + 'A'.repeat(55)
const B = 'G' + 'B'.repeat(55)
const BIG = '1844674407370.9551739'
const MOVEMENTS = 105

let app: ReturnType<typeof createServer>
let client: NostroClient
let store: MemoryStore

const roundRunner: RoundRunner = {
  async triggerRound(tenantId, account) {
    const round: RoundRecord = {
      id: 'round-1',
      tenantId,
      account: account ?? null,
      state: 'queued',
      queuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      summary: null,
      error: null,
    }
    return { id: round.id, round }
  },
  async getRound(tenantId, id) {
    return id === 'round-1'
      ? { id, tenantId, state: 'done', queuedAt: new Date().toISOString(), startedAt: null, finishedAt: null, summary: null, error: null }
      : null
  },
}

beforeAll(async () => {
  store = new MemoryStore()
  const at = new Date('2026-01-01T00:00:00.000Z')
  await store.transaction(async (tx) => {
    for (let i = 1; i <= 3; i++) {
      await tx.insertExpectation({
        tenantId: 'tenant',
        reference: `INV-${i}`,
        account: A,
        amount: Money.parse('25', NATIVE),
      })
    }
    await tx.addWatchedAccount({ tenantId: 'tenant', account: A, source: 'config', addedAt: at })
    const batch = []
    for (let i = 1; i <= MOVEMENTS; i++) {
      batch.push({
        tenantId: 'tenant',
        network: 'testnet',
        source: 'x',
        externalId: `m-${i}`,
        account: A,
        direction: 'credit' as const,
        kind: 'transfer' as const,
        amount: i === 1 ? Money.fromRaw(2n ** 64n + 123n, NATIVE, 7) : Money.parse('5', NATIVE),
        ledger: 1,
        occurredAt: at,
      })
    }
    await tx.insertMovements(batch)
    // Give the webhook consumer a position so replay has somewhere to rewind.
    await tx.setCursor(eventCursorKey('tenant', 'webhook'), '1')
  })
  await reconcile({ store, tenantId: 'tenant' })
  app = createServer({ store, authenticate: apiKeys({ [KEY]: 'tenant' }), roundRunner })
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
  client = createClient({ baseUrl, apiKey: KEY })
})

afterAll(async () => {
  await app.close()
})

describe('createClient', () => {
  it('exercises every operationId against a real server', async () => {
    expect((await client.health()).ok).toBe(true)
    expect((await client.openapi()).info.title).toBe('nostro')

    expect((await client.listAccounts().page()).data.length).toBe(1)
    expect((await client.watchAccount({ account: B })).account).toBe(B)
    expect(await client.unwatchAccount(B, { force: true })).toBeUndefined()

    const firstPage = await client.listMovements({ limit: 10 }).page()
    expect(firstPage.data.length).toBe(10)
    expect(firstPage.next).not.toBeNull()
    const movementId = firstPage.data[0]!.id
    expect((await client.getMovement(movementId)).movement.id).toBe(movementId)
    expect((await client.explainMovement(movementId)).movementId).toBe(movementId)
    expect((await client.replayDecisions({ limit: 2 })).replayed).toBeGreaterThanOrEqual(0)

    const schedule = await client.createSchedule({
      referencePattern: 'REC-{n}',
      account: A,
      amount: '25',
      asset: 'native',
      cadence: { kind: 'daily' },
      startAt: new Date().toISOString(),
    })
    expect((await client.getSchedule(schedule.id)).id).toBe(schedule.id)
    expect((await client.endSchedule(schedule.id)).endedAt).not.toBeNull()
    expect((await client.listSchedules().page()).data.length).toBeGreaterThanOrEqual(1)

    const expectations = await client.listExpectations().page()
    const expectationId = expectations.data[0]!.id
    expect((await client.getExpectation(expectationId)).expectation.id).toBe(expectationId)
    expect((await client.getExpectationByReference({ reference: 'INV-1' })).expectation.reference).toBe('INV-1')
    expect((await client.batchCreateExpectations([{ reference: 'BATCH-1', account: A, amount: '1' }])).data[0]!.status).toBe('created')
    const amended = await client.amendExpectation(expectationId, { reason: 'test', amount: '30' })
    expect(amended.id).toBe(expectationId)
    const cancelled = await client.cancelExpectation(expectationId, { reason: 'test' })
    expect(cancelled.status).toBe('cancelled')

    const exceptions = await client.listExceptions().page()
    expect(exceptions.data.length).toBeGreaterThan(0)
    const exceptionId = exceptions.data[0]!.id
    expect((await client.getException(exceptionId)).exception.id).toBe(exceptionId)
    const batch = await client.resolveExceptions({
      mode: 'row',
      decisions: [{ exceptionId, decision: { action: 'ignore', note: 'client test batch' } }],
    })
    expect(batch.applied + batch.errors).toBe(1)
    const remaining = (await client.listExceptions().page()).data.map((e) => e.id)
    const secondId = remaining.find((id) => id !== exceptionId)
    if (secondId !== undefined) {
      const resolved = await client.resolveException(secondId, { action: 'ignore', note: 'client test' })
      expect(resolved).toBeTruthy()
    }

    const events = await client.listEvents({ limit: 2 }).page()
    expect(events.data.length).toBe(2)
    expect((await client.triggerRound({ account: A })).id).toBe('round-1')
    expect((await client.getRound('round-1')).state).toBe('done')

    expect((await client.listWebhookConsumers().page()).data.length).toBeGreaterThanOrEqual(1)
    const status = await client.webhookStatus('webhook')
    expect((await client.webhookAttempts('webhook').page()).data).toBeTruthy()
    const rewound = await client.replayWebhook('webhook', { expectedSeq: status.position, toSeq: 0, actor: 'client test' })
    expect(rewound.toSeq).toBe(0)

    const journal = await client.listJournalEntries().page()
    expect(journal.data.length).toBeGreaterThan(0)
    const posted = await client.postManualJournalEntry({
      description: 'client test',
      reason: 'client test',
      lines: [
        { account: 'expenses:test', role: 'uncategorized_expense', side: 'debit', amount: '1' },
        { account: 'income:test', role: 'uncategorized_income', side: 'credit', amount: '1' },
      ],
    })
    expect(posted.lines.length).toBe(2)
    expect(await client.exportJournal()).toContain(',')

    expect((await client.trialBalance()).balanced).toBe(true)
    expect((await client.accountLedger({ account: 'expenses:test', asset: 'native' })).lines.length).toBeGreaterThan(0)
    expect((await client.balanceSheet()).balanced).toBe(true)
    expect((await client.incomeStatement()).lines.length).toBeGreaterThan(0)
    expect((await client.moveAccount({ from: 'income:test', to: 'income:test2' })).moved).toBeGreaterThanOrEqual(0)
  })

  it('follows next into after across pages', async () => {
    const rows: string[] = []
    for await (const movement of client.listMovements({ limit: 10 })) rows.push(movement.id)
    expect(rows.length).toBe(MOVEMENTS)
    expect(new Set(rows).size).toBe(MOVEMENTS)

    const first = await client.listMovements({ limit: 10 }).page()
    expect(typeof first.next).toBe('number')
    const second = await client.listMovements({ limit: 10 }).page({ after: first.next! })
    expect(second.data[0]!.seq).toBeGreaterThan(first.data.at(-1)!.seq)
  })

  it('keeps amounts exact beyond 2^64', async () => {
    const amounts: string[] = []
    for await (const movement of client.listMovements({ limit: 100 })) amounts.push(movement.amount)
    expect(amounts).toContain(BIG)
  })

  it('throws ApiError with the problem code for 409 and 422', async () => {
    for (const [body, status, code] of [
      [{ reference: 'INV-1', account: A, amount: '25' }, 409, 'reference_taken'],
      [{ reference: 'BAD-DECIMALS', account: A, amount: '1.00000000' }, 422, 'invalid_expectation'],
    ] as const) {
      try {
        await client.createExpectation(body)
        throw new Error('expected an ApiError')
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError)
        const api = err as ApiError
        expect(api.name).toBe('ApiError')
        expect(api.status).toBe(status)
        expect(api.code).toBe(code)
        expect(api.detail.length).toBeGreaterThan(0)
        expect(api.message).not.toContain(KEY)
        expect(api.stack).not.toContain(KEY)
      }
    }
  })

  it('does not put the key in a URL', async () => {
    let seen = ''
    const observing = createClient({
      baseUrl: 'http://127.0.0.1:1',
      apiKey: KEY,
      fetch: async (input) => {
        seen = String(input)
        throw new Error('offline')
      },
    })
    await expect(observing.health()).rejects.toMatchObject({ code: 'network_error', status: 0 })
    expect(seen).not.toContain(KEY)
  })
})
