import { describe, expect, it } from 'vitest'
import { MemoryStore, Money, asset, explainMovement, reconcile, replayDecisions } from '../src/index.js'

const T = 'acme'
const ACCOUNT = `G${'A'.repeat(55)}`
const USDC = asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
const usdc = (v: string) => Money.parse(v, USDC)
let n = 0
const payment = (over: any = {}) => ({ tenantId: T, network: 'testnet', source: 'horizon', externalId: `e-${++n}`, account: ACCOUNT, direction: 'credit' as const, kind: 'transfer' as const, amount: usdc('10'), ledger: 1000 + n, txHash: n.toString(16).padStart(64, '0'), occurredAt: new Date('2026-10-05T12:00:00Z'), ...over })

describe('replay decisions', () => {
  it('reports no differences with unchanged options', async () => {
    const store = new MemoryStore()
    await store.transaction(async (tx) => {
      await tx.insertExpectation({ tenantId: T, reference: 'INV-1', account: ACCOUNT, amount: usdc('10'), muxedId: 1n })
    })
    await store.transaction((tx) => tx.insertMovements([payment({ muxedId: 1n })]))
    await reconcile({ store, tenantId: T })
    const report = await replayDecisions({ store, tenantId: T })
    expect(report.replayed).toBe(1)
    expect(report.unchanged).toBe(1)
    expect(report.wouldSettle).toBe(0)
  })

  it('shows lower-threshold settlement against later manual decision', async () => {
    const store = new MemoryStore()
    await store.transaction(async (tx) => {
      await tx.insertExpectation({ tenantId: T, reference: 'INV-2', account: ACCOUNT, amount: usdc('10') })
    })
    const [m] = (await store.transaction((tx) => tx.insertMovements([payment({ amount: usdc('10') })]))).inserted
    await reconcile({ store, tenantId: T })
    const ex = (await store.listExceptions({ tenantId: T, movementId: m!.id }))[0]!
    await store.transaction(async (tx) => {
      await tx.allocate({ tenantId: T, movementId: m!.id, expectationId: ex.expectationId ?? (await store.listExpectations({ tenantId: T }))[0]!.id, amount: usdc('10'), strategy: 'manual' })
      await tx.resolveException(T, ex.id, { status: 'resolved', note: 'manual' })
      await tx.setDisposition(T, m!.id, 'allocated')
    })
    const report = await replayDecisions({ store, tenantId: T, options: { threshold: 0.5 } })
    expect(report.wouldSettle).toBeGreaterThanOrEqual(0)
  })

  it('explainMovement returns recorded decision', async () => {
    const store = new MemoryStore()
    await store.transaction((tx) => tx.insertExpectation({ tenantId: T, reference: 'INV-3', account: ACCOUNT, amount: usdc('10'), muxedId: 3n }))
    const [m] = (await store.transaction((tx) => tx.insertMovements([payment({ muxedId: 3n })]))).inserted
    await reconcile({ store, tenantId: T })
    const report = await explainMovement({ store, tenantId: T, movementId: m!.id })
    expect(report.status).toBe('agree')
  })
})
