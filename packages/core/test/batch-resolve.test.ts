import { describe, expect, it } from 'vitest'
import { MemoryStore, Money, NATIVE, decideExceptions, doctor, reconcile } from '../src/index.js'

const T = 'acme'
const A = `G${'A'.repeat(55)}`
const xlm = (v: string) => Money.parse(v, NATIVE)
let n = 0
const paid = async (store: MemoryStore, amount = '10') => {
  n++
  const [m] = (await store.transaction((tx) => tx.insertMovements([{ tenantId: T, network: 'testnet', source: 'x', externalId: `e-${n}`, account: A, direction: 'credit', kind: 'transfer', amount: xlm(amount), ledger: n, occurredAt: new Date('2026-10-01T00:00:00Z') }]))).inserted
  await reconcile({ store, tenantId: T })
  return m!
}

describe('decideExceptions batch', () => {
  it('atomic batch with bad row changes nothing', async () => {
    const store = new MemoryStore()
    await store.transaction((tx) => tx.insertExpectation({ tenantId: T, reference: 'INV-1', account: A, amount: xlm('10') }))
    const m = await paid(store)
    const ex = (await store.listExceptions({ tenantId: T, movementId: m.id }))[0]!
    const report = await decideExceptions({ store, tenantId: T, mode: 'atomic', decisions: [
      { exceptionId: ex.id, decision: { action: 'apply', allocations: [{ reference: 'INV-1' }], note: 'ok' } },
      { exceptionId: 'nope', decision: { action: 'close', note: 'bad' } },
    ] })
    expect(report.errors).toBe(1)
    expect(report.applied).toBe(0)
    expect((await store.getMovement(T, m.id))!.disposition).toBe('exception')
    expect((await store.getException(T, ex.id))!.status).toBe('open')
    expect((await store.listAllocations({ tenantId: T, movementId: m.id }))).toHaveLength(0)
  })

  it('retrying committed batch reports success and changes nothing', async () => {
    const store = new MemoryStore()
    await store.transaction((tx) => tx.insertExpectation({ tenantId: T, reference: 'INV-R', account: A, amount: xlm('10') }))
    const m = await paid(store)
    const ex = (await store.listExceptions({ tenantId: T, movementId: m.id }))[0]!
    const decisions = [{ exceptionId: ex.id, decision: { action: 'apply', allocations: [{ reference: 'INV-R' }], note: 'ok' } as const }]
    const first = await decideExceptions({ store, tenantId: T, mode: 'atomic', decisions })
    expect(first.errors).toBe(0)
    const second = await decideExceptions({ store, tenantId: T, mode: 'atomic', decisions })
    expect(second.errors).toBe(0)
    expect(second.results[0]!.result?.alreadyApplied).toBe(true)
    expect(await store.listAllocations({ tenantId: T, movementId: m.id })).toHaveLength(1)
  })

  it('mixed batch leaves doctor clean', async () => {
    const store = new MemoryStore()
    await store.transaction((tx) => tx.insertExpectation({ tenantId: T, reference: 'INV-M', account: A, amount: xlm('10') }))
    const m1 = await paid(store)
    const m2 = await paid(store)
    const ex1 = (await store.listExceptions({ tenantId: T, movementId: m1.id }))[0]!
    const ex2 = (await store.listExceptions({ tenantId: T, movementId: m2.id }))[0]!
    const report = await decideExceptions({ store, tenantId: T, mode: 'row', decisions: [
      { exceptionId: ex1.id, decision: { action: 'apply', allocations: [{ reference: 'INV-M' }], note: 'apply' } },
      { exceptionId: ex2.id, decision: { action: 'ignore', note: 'ignore' } },
    ] })
    expect(report.errors).toBe(0)
    expect((await doctor({ store, tenantId: T })).findings).toEqual([])
  })
})
