import { describe, expect, it } from 'vitest'
import type { NewMovement } from '../src/index.js'
import { MemoryStore, Money, asset, doctor, postJournal, sweepExpectations } from '../src/index.js'

const T = 'acme'
const ACCOUNT = `G${'A'.repeat(55)}`
const USDC = asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
const usdc = (v: string) => Money.parse(v, USDC)
const PAST = new Date('2026-10-01T00:00:00Z')
const FUTURE = new Date('2026-11-01T00:00:00Z')
const AS_OF = new Date('2026-10-15T00:00:00Z')
const AT = new Date('2026-09-01T00:00:00Z')

let n = 0
function movement(amount: Money): NewMovement {
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

async function fixture() {
  const store = new MemoryStore({ now: () => AT })
  const [unpaid, partPaid, settled, future, never] = await store.transaction(async (tx) => [
    await tx.insertExpectation({ tenantId: T, reference: 'INV-1001', account: ACCOUNT, amount: usdc('10'), expiresAt: PAST }),
    await tx.insertExpectation({ tenantId: T, reference: 'INV-1002', account: ACCOUNT, amount: usdc('10'), expiresAt: PAST }),
    await tx.insertExpectation({ tenantId: T, reference: 'INV-1003', account: ACCOUNT, amount: usdc('10'), expiresAt: PAST }),
    await tx.insertExpectation({ tenantId: T, reference: 'INV-1004', account: ACCOUNT, amount: usdc('10'), expiresAt: FUTURE }),
    await tx.insertExpectation({ tenantId: T, reference: 'INV-1005', account: ACCOUNT, amount: usdc('10') }),
  ])
  await store.transaction(async (tx) => {
    const [part, full] = (await tx.insertMovements([movement(usdc('4')), movement(usdc('10'))])).inserted
    await tx.allocate({ tenantId: T, movementId: part!.id, expectationId: partPaid.id, amount: usdc('4'), strategy: 'manual' })
    await tx.allocate({ tenantId: T, movementId: full!.id, expectationId: settled.id, amount: usdc('10'), strategy: 'manual' })
    await tx.setDisposition(T, part!.id, 'allocated')
    await tx.setDisposition(T, full!.id, 'allocated')
  })
  return { store, unpaid, partPaid, settled, future, never }
}

describe('sweepExpectations', () => {
  it('raises one expiry for unpaid and part-paid expectations only, and is idempotent', async () => {
    const { store, unpaid, partPaid, settled, future, never } = await fixture()

    const first = await sweepExpectations({ store, tenantId: T, asOf: AS_OF })
    expect(first).toEqual({ scanned: 2, expired: 2, skipped: 0 })
    const raised = await store.listExceptions({ tenantId: T, code: 'EXPECTATION_EXPIRED' })
    expect(raised.map((x) => x.expectationId).sort()).toEqual([unpaid.id, partPaid.id].sort())
    expect(raised.every((x) => x.status === 'open' && x.account === ACCOUNT)).toBe(true)
    expect(raised.every((x) => x.amount!.toString() === '10.0000000')).toBe(true)
    for (const untouched of [settled, future, never]) {
      expect(await store.listExceptions({ tenantId: T, expectationId: untouched.id })).toEqual([])
    }
    expect((await store.getExpectation(T, unpaid.id))!.status).toBe('open')
    expect((await store.getExpectation(T, partPaid.id))!.status).toBe('partially_paid')

    const second = await sweepExpectations({ store, tenantId: T, asOf: AS_OF })
    expect(second).toEqual({ scanned: 2, expired: 0, skipped: 2 })
    expect(await store.listExceptions({ tenantId: T, code: 'EXPECTATION_EXPIRED' })).toHaveLength(2)
  })

  it('uses asOf, including the boundary instant, and pages with a small limit', async () => {
    const { store, unpaid, partPaid, future } = await fixture()

    expect(await sweepExpectations({ store, tenantId: T, asOf: new Date(PAST.getTime() - 1) })).toEqual({
      scanned: 0,
      expired: 0,
      skipped: 0,
    })
    expect(await sweepExpectations({ store, tenantId: T, asOf: PAST, limit: 1 })).toEqual({
      scanned: 2,
      expired: 2,
      skipped: 0,
    })
    expect((await store.listExceptions({ tenantId: T, code: 'EXPECTATION_EXPIRED' })).map((x) => x.expectationId).sort()).toEqual(
      [unpaid.id, partPaid.id].sort(),
    )
    expect(await store.listExceptions({ tenantId: T, expectationId: future.id })).toEqual([])
  })

  it('leaves the doctor with nothing to report after expiries are raised', async () => {
    const { store } = await fixture()
    await sweepExpectations({ store, tenantId: T, asOf: AS_OF })
    await postJournal({ store, tenantId: T })
    const report = await doctor({ store, tenantId: T })
    expect(report.findings).toEqual([])
    expect(report.ok).toBe(true)
  })
})
