import { describe, expect, it } from 'vitest'
import type { ExpectationChanges, ExpectationStatus, NewMovement } from '../src/index.js'
import { MemoryStore, Money, NATIVE, amendExpectationRecord } from '../src/index.js'
import { describeStoreConformance, describeStoreProperties } from 'nostro-testkit'

describeStoreConformance('MemoryStore', () => new MemoryStore())
describeStoreProperties('MemoryStore', (now) => new MemoryStore({ now }), { runs: 200 })

describe('MemoryStore', () => {
  it('uses injected ids and clock so fixture runs are deterministic', async () => {
    let n = 0
    const at = new Date('2026-10-06T09:00:00Z')
    const store = new MemoryStore({ ids: () => `id-${++n}`, now: () => at })
    const e = await store.transaction((tx) =>
      tx.insertExpectation({
        tenantId: 't',
        reference: 'R-1',
        account: `G${'A'.repeat(55)}`,
        amount: Money.parse('1', NATIVE),
      }),
    )
    expect(e.id).toBe('id-1')
    expect(e.createdAt).toEqual(at)
  })

  it('keeps serving transactions after one fails', async () => {
    const store = new MemoryStore()
    await expect(store.transaction(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(store.transaction(async () => 'ok')).resolves.toBe('ok')
  })
})

const T = 't'
const ACCOUNT = `G${'A'.repeat(55)}`
const OTHER = `G${'C'.repeat(55)}`
const PAYER = `G${'B'.repeat(55)}`
const xlm = (v: string) => Money.parse(v, NATIVE)
const AT = new Date('2026-10-06T09:00:00Z')

let n = 0
function payment(amount: Money): NewMovement {
  n += 1
  return {
    tenantId: T,
    network: 'testnet',
    source: 'horizon',
    externalId: `effect-${n}`,
    account: ACCOUNT,
    direction: 'credit',
    kind: 'transfer',
    amount,
    ledger: 1000 + n,
    occurredAt: AT,
  }
}

async function invoice(store: MemoryStore, reference: string, account = ACCOUNT, muxedId?: bigint | 'issue') {
  return store.transaction((tx) =>
    tx.insertExpectation({
      tenantId: T,
      reference,
      account,
      amount: xlm('10'),
      ...(muxedId === undefined ? {} : { muxedId }),
    }),
  )
}

async function pay(store: MemoryStore, expectationId: string, amount: Money) {
  await store.transaction(async (tx) => {
    const [m] = (await tx.insertMovements([payment(amount)])).inserted
    await tx.allocate({ tenantId: T, movementId: m!.id, expectationId, amount, strategy: 'manual' })
  })
}

describe('expectation amendments', () => {
  it('refuses an amount below the allocations and settles at exactly the allocated amount', async () => {
    const store = new MemoryStore({ now: () => AT })
    const e = await invoice(store, 'INV-1')
    await pay(store, e.id, xlm('4'))
    expect((await store.getExpectation(T, e.id))!.status).toBe('partially_paid')

    await expect(store.transaction((tx) => tx.amendExpectation(T, e.id, { amount: xlm('3') }, 'fix'))).rejects.toMatchObject({
      name: 'ConstraintError',
      constraint: 'amendment_below_allocated',
    })
    const amended = await store.transaction((tx) => tx.amendExpectation(T, e.id, { amount: xlm('4') }, 'close out'))
    expect(amended.status).toBe('settled')
    expect(amended.amount.toString()).toBe('4.0000000')
    expect(e.status).toBe('open')
    expect(e.amount.toString()).toBe('10.0000000')
  })

  it('refuses cancelled and unrecognised statuses', async () => {
    const store = new MemoryStore({ now: () => AT })
    const e = await invoice(store, 'INV-C')
    await store.transaction((tx) => tx.cancelExpectation(T, e.id, 'voided'))
    await expect(
      store.transaction((tx) => tx.amendExpectation(T, e.id, { metadata: { tier: 'gold' } }, 'retry')),
    ).rejects.toMatchObject({ constraint: 'expectation_not_amendable' })

    const forged = { ...e, status: 'draft' as ExpectationStatus }
    expect(() => amendExpectationRecord(forged, [], { metadata: { tier: 'gold' } }, 'retry', AT, false)).toThrowError(
      /expectation_not_amendable/,
    )
  })

  it('refuses to amend a settled expectation', async () => {
    const store = new MemoryStore({ now: () => AT })
    const e = await invoice(store, 'INV-S')
    await pay(store, e.id, xlm('10'))
    expect((await store.getExpectation(T, e.id))!.status).toBe('settled')
    await expect(
      store.transaction((tx) => tx.amendExpectation(T, e.id, { metadata: { tier: 'gold' } }, 'late change')),
    ).rejects.toMatchObject({ constraint: 'expectation_not_amendable' })
  })

  it('changes mutable fields and records expectation, previous and reason in the event', async () => {
    const store = new MemoryStore({ now: () => AT })
    const e = await store.transaction((tx) =>
      tx.insertExpectation({
        tenantId: T,
        reference: 'INV-M',
        account: ACCOUNT,
        amount: xlm('10'),
        metadata: { tier: 'old' },
      }),
    )
    const changes: ExpectationChanges = {
      amount: xlm('12'),
      muxedId: 42n,
      memo: { type: 'text', value: 'INV-M ACME' },
      payers: [PAYER],
      dueAt: new Date('2026-10-20T00:00:00Z'),
      expiresAt: new Date('2026-11-20T00:00:00Z'),
      metadata: { tier: 'gold', note: 'corrected' },
    }
    const next = await store.transaction((tx) => tx.amendExpectation(T, e.id, changes, 'customer correction'))
    expect(next).toMatchObject({
      reference: 'INV-M',
      account: ACCOUNT,
      status: 'open',
      muxedId: 42n,
      memo: changes.memo,
      payers: [PAYER],
      metadata: changes.metadata,
    })
    expect(next.amount.toString()).toBe('12.0000000')
    expect(next.dueAt).toEqual(changes.dueAt)
    expect(next.expiresAt).toEqual(changes.expiresAt)
    expect(next.updatedAt).toEqual(AT)
    expect(e.muxedId).toBeNull()
    expect(e.metadata).toEqual({ tier: 'old' })

    const events = await store.listEvents({ tenantId: T })
    expect(events.filter((x) => x.type === 'expectation.amended')).toHaveLength(1)
    const [amended] = events.filter((x) => x.type === 'expectation.amended')
    expect(amended).toMatchObject({ subjectId: e.id, payload: { reason: 'customer correction' } })
    const payload = amended!.payload as {
      expectation: { id: string; status: string; metadata: Record<string, string> }
      previous: { id: string; metadata: Record<string, string> }
      reason: string
    }
    expect(payload.expectation).toMatchObject({ id: e.id, status: 'open', metadata: changes.metadata })
    expect(payload.previous).toMatchObject({ id: e.id, metadata: { tier: 'old' } })
  })
})

describe('muxed ids', () => {
  it('issues the next free id for the tenant and account', async () => {
    const store = new MemoryStore({ now: () => AT })
    const [first, explicit, next, otherAccount, otherTenant] = await store.transaction(async (tx) => [
      await tx.insertExpectation({ tenantId: T, reference: 'R-1', account: ACCOUNT, amount: xlm('1'), muxedId: 'issue' }),
      await tx.insertExpectation({ tenantId: T, reference: 'R-2', account: ACCOUNT, amount: xlm('1'), muxedId: 7n }),
      await tx.insertExpectation({ tenantId: T, reference: 'R-3', account: ACCOUNT, amount: xlm('1'), muxedId: 'issue' }),
      await tx.insertExpectation({ tenantId: T, reference: 'R-4', account: OTHER, amount: xlm('1'), muxedId: 'issue' }),
      await tx.insertExpectation({ tenantId: 'other', reference: 'R-1', account: ACCOUNT, amount: xlm('1'), muxedId: 1n }),
    ])
    expect([first.muxedId, explicit.muxedId, next.muxedId, otherAccount.muxedId, otherTenant.muxedId]).toEqual([
      1n,
      7n,
      8n,
      1n,
      1n,
    ])
  })

  it('refuses a duplicate muxed id on one account but scopes duplicates by tenant and account', async () => {
    const store = new MemoryStore({ now: () => AT })
    await invoice(store, 'R-1', ACCOUNT, 9n)
    await expect(invoice(store, 'R-2', ACCOUNT, 9n)).rejects.toMatchObject({
      name: 'ConstraintError',
      constraint: 'expectation_muxed_id_unique',
    })
    expect((await invoice(store, 'R-3', OTHER, 9n)).muxedId).toBe(9n)
    await expect(
      store.transaction((tx) =>
        tx.insertExpectation({ tenantId: 'other', reference: 'R-1', account: ACCOUNT, amount: xlm('1'), muxedId: 9n }),
      ),
    ).resolves.toMatchObject({ muxedId: 9n })
  })

  it('does not issue the same id twice in concurrent transactions', async () => {
    const store = new MemoryStore({ now: () => AT })
    const issued = await Promise.all(
      ['C-1', 'C-2', 'C-3'].map((reference) => invoice(store, reference, ACCOUNT, 'issue')),
    )
    expect(issued.map((e) => e.muxedId)).toEqual([1n, 2n, 3n])
    expect(new Set(issued.map((e) => e.muxedId)).size).toBe(3)
  })
})
