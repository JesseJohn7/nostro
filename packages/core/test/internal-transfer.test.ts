import { describe, expect, it } from 'vitest'
import type { NewMovement } from '../src/index.js'
import { doctor, MemoryStore, Money, asset, reconcile } from '../src/index.js'

const T = 'group'
const A = `G${'A'.repeat(55)}`
const B = `G${'C'.repeat(55)}`
const USDC = asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
const usdc = (v: string) => Money.parse(v, USDC)

let counter = 0
const txHash = () => (++counter).toString(16).padStart(64, '0')

function transfer(over: Partial<NewMovement>): NewMovement {
  counter += 1
  return {
    tenantId: T,
    network: 'testnet',
    source: 'horizon',
    externalId: `transfer-${counter}`,
    account: A,
    direction: 'debit',
    kind: 'transfer',
    amount: usdc('10'),
    counterparty: B,
    ledger: 1000 + counter,
    occurredAt: new Date('2026-10-05T12:00:00Z'),
    ...over,
  }
}

async function books(secondEntity = 'beta') {
  const store = new MemoryStore({ now: () => new Date('2026-10-01T00:00:00Z') })
  await store.transaction(async (tx) => {
    await tx.insertEntity({ tenantId: T, id: 'alpha', name: 'Alpha' })
    if (secondEntity !== 'alpha') await tx.insertEntity({ tenantId: T, id: secondEntity, name: 'Beta' })
    await tx.assignAccountEntity({ tenantId: T, network: 'testnet', account: A, entityId: 'alpha' })
    await tx.assignAccountEntity({ tenantId: T, network: 'testnet', account: B, entityId: secondEntity })
  })
  return store
}

async function ingest(store: MemoryStore, ...movements: NewMovement[]) {
  return [...(await store.transaction((tx) => tx.insertMovements(movements))).inserted]
}

async function linesFor(store: MemoryStore, movementId: string) {
  return (await store.listJournalEntries({ tenantId: T, movementId })).flatMap((e) => e.lines)
}

async function rolesFor(store: MemoryStore, movementId: string) {
  return (await linesFor(store, movementId)).map((l) => [l.role, l.side] as const)
}

describe('internal transfers', () => {
  it('posts intercompany legs whichever one is reconciled first', async () => {
    for (const firstAccount of [A, B]) {
      const store = await books()
      const hash = txHash()
      const debit = transfer({ txHash: hash })
      const credit = transfer({ txHash: hash, account: B, direction: 'credit', counterparty: A })
      const ordered = firstAccount === A ? [debit, credit] : [credit, debit]
      const inserted = await ingest(store, ...ordered)
      const debitMovement = inserted.find((m) => m.account === A)!
      const creditMovement = inserted.find((m) => m.account === B)!

      const report = await reconcile({ store, tenantId: T })
      expect(report.errors).toEqual([])
      expect(report.ignored).toBe(1)
      expect((await store.listInternalTransferLinks({ tenantId: T, txHash: hash }))).toHaveLength(1)
      expect(await rolesFor(store, debitMovement.id)).toContainEqual(['due_from', 'debit'])
      expect(await rolesFor(store, creditMovement.id)).toContainEqual(['due_to', 'credit'])
      expect((await doctor({ store, tenantId: T })).findings).toEqual([])
    }
  })

  it('nets a same-entity transfer through in_transit', async () => {
    const store = await books('alpha')
    const hash = txHash()
    const [debit, credit] = await ingest(
      store,
      transfer({ txHash: hash }),
      transfer({ txHash: hash, account: B, direction: 'credit', counterparty: A }),
    )
    expect((await reconcile({ store, tenantId: T })).ignored).toBe(1)
    expect(await rolesFor(store, debit!.id)).toContainEqual(['in_transit', 'debit'])
    expect(await rolesFor(store, credit!.id)).toContainEqual(['in_transit', 'credit'])
    const inTransit = (await linesFor(store, debit!.id))
      .concat(await linesFor(store, credit!.id))
      .filter((l) => l.role === 'in_transit')
      .reduce((sum, l) => sum + (l.side === 'debit' ? l.amount.raw : -l.amount.raw), 0n)
    expect(inTransit).toBe(0n)
    expect((await doctor({ store, tenantId: T })).findings).toEqual([])
  })

  it('reclasses a leg that arrived before its partner', async () => {
    const store = await books()
    const hash = txHash()
    const [first] = await ingest(store, transfer({ txHash: hash }))
    await reconcile({ store, tenantId: T })
    const [second] = await ingest(store, transfer({ txHash: hash, account: B, direction: 'credit', counterparty: A }))

    const report = await reconcile({ store, tenantId: T })
    expect(report.errors).toEqual([])
    expect((await store.getMovement(T, first!.id))!.disposition).toBe('ignored')
    expect((await store.getMovement(T, second!.id))!.disposition).toBe('ignored')
    expect(await linesFor(store, first!.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'due_from' })]),
    )
    expect(await linesFor(store, second!.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'due_to' })]),
    )
    expect(await store.listExceptions({ tenantId: T, movementId: first!.id, status: 'open' })).toEqual([])
    expect((await doctor({ store, tenantId: T })).findings).toEqual([])
  })

  it('leaves a payment aimed at an expectation on the normal matching path', async () => {
    const store = await books()
    const hash = txHash()
    await store.transaction((tx) =>
      tx.insertExpectation({ tenantId: T, reference: 'INV-1', account: B, amount: usdc('10'), direction: 'credit', muxedId: 1n }),
    )
    const [debit, credit] = await ingest(
      store,
      transfer({ txHash: hash }),
      transfer({ txHash: hash, account: B, direction: 'credit', counterparty: A, muxedId: 1n }),
    )
    const report = await reconcile({ store, tenantId: T })
    expect(report.allocated).toBe(1)
    expect((await store.getMovement(T, credit!.id))!.disposition).toBe('allocated')
    expect(await store.listInternalTransferLinks({ tenantId: T, txHash: hash })).toEqual([])
    expect(await rolesFor(store, debit!.id)).not.toContainEqual(['due_from', 'debit'])
    expect(await rolesFor(store, credit!.id)).not.toContainEqual(['due_to', 'credit'])
  })
})
