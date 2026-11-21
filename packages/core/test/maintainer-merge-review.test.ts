import { expect, it } from 'vitest'
import {
  MemoryStore, Money, NATIVE, asset, contractAsset, HorizonPriceSource,
  MapPriceSource, valueMovements, costBasis, reconcile, postManualEntry,
  applyMovement, agingReport,
} from '../src/index.js'

const tenantId = 'merge-review'
const account = `G${'A'.repeat(55)}`
const quote = asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
const instant = new Date('2026-10-01T12:00:00Z')
const segment = (timestamp: number, count = '1') => ({ timestamp: String(timestamp), count, close_r: { n: '2', d: '1' } })
const priceSource = (records: unknown[]) => new HorizonPriceSource({
  url: 'https://example.invalid',
  fetch: (async () => ({ ok: true, json: async () => ({ _embedded: { records } }) })) as unknown as typeof fetch,
})

it('does not price a contract token using XLM trades', async () => {
  const source = priceSource([segment(instant.getTime())])
  const token = contractAsset(`C${'A'.repeat(55)}`)
  expect(await source.price(token, quote, instant)).toBeNull()
})

it('leaves a no-trade segment unvalued instead of borrowing the adjacent segment', async () => {
  const source = priceSource([segment(instant.getTime() - 3600000), segment(instant.getTime(), '0')])
  expect(await source.price(NATIVE, quote, instant)).toBeNull()
})

it('does not report an invented gain when the credit has no cost valuation', async () => {
  const store = new MemoryStore()
  const movement = (externalId: string, direction: 'credit' | 'debit', occurredAt: Date) => ({
    tenantId, account, externalId, direction, occurredAt,
    network: 'testnet', source: 'fixture', kind: 'transfer' as const,
    amount: Money.parse('10', NATIVE), ledger: 1,
  })
  await store.transaction(tx => tx.insertMovements([
    movement('credit', 'credit', new Date('2026-10-01T00:00:00Z')),
    movement('debit', 'debit', instant),
  ]))
  await valueMovements({ store, tenantId, reportingAsset: quote, from: instant,
    priceSource: new MapPriceSource([{ base: NATIVE, quote, price: { n: 2n, d: 1n }, source: 'fixture', timestamp: instant }]),
  })
  const report = await costBasis({ store, tenantId, account, asset: NATIVE })
  expect(report.unvaluedCredits).toHaveLength(1)
  expect(report.realizedGain).toBeNull()
})

it('cannot clear unapplied money twice after a manual write-off then allocation', async () => {
  const store = new MemoryStore()
  const amount = Money.parse('10', NATIVE)
  const { inserted } = await store.transaction(tx => tx.insertMovements([{
    tenantId, account, externalId: 'write-off-credit', direction: 'credit', occurredAt: instant,
    network: 'testnet', source: 'fixture', kind: 'transfer', amount, ledger: 1,
  }]))
  await reconcile({ store, tenantId })
  let refused = false
  try {
    await postManualEntry({ store, tenantId, description: 'Write off part of unapplied receipt', reason: 'write-off', lines: [
      { account: 'liabilities:unapplied-receipts', role: 'unapplied', side: 'debit', amount: Money.parse('5', NATIVE) },
      { account: 'income:uncategorized', role: 'uncategorized_income', side: 'credit', amount: Money.parse('5', NATIVE) },
    ] })
  } catch { refused = true }
  const expectation = await store.transaction(tx => tx.insertExpectation({ tenantId, account, reference: 'INV-review', amount }))
  await applyMovement({ store, tenantId, movementId: inserted[0]!.id, allocations: [{ expectationId: expectation.id }], note: 'Confirmed invoice' })
  const entries = await store.listJournalEntries({ tenantId })
  const balance = entries.flatMap(e => e.lines).filter(l => l.role === 'unapplied')
    .reduce((sum, l) => sum + (l.side === 'credit' ? l.amount.raw : -l.amount.raw), 0n)
  expect({ refused, balance }).toEqual({ refused: true, balance: 0n })
})

it('retains independent export marks and posts a balanced accrual only once', async () => {
  const store = new MemoryStore()
  expect(await store.exportGetMark(tenantId, 'a')).toBeNull()
  await store.exportSetMark(tenantId, 'a', 7)
  await store.exportSetMark(tenantId, 'b', 9)
  expect(await store.exportGetMark(tenantId, 'a')).toBe('7')
  expect(await store.exportListBatches('elsewhere')).toEqual([])
  expect(await store.exportListBatches(tenantId)).toHaveLength(2)
  const amount = Money.parse('10', NATIVE)
  const e = await store.transaction(tx => tx.insertExpectation({tenantId, account, reference: 'accrual', amount}))
  await store.postAccrualExpectation(e.id, tenantId, 'credit', amount, e.reference)
  await store.postAccrualExpectation(e.id, tenantId, 'credit', amount, e.reference)
  const entries = await store.listJournalEntries({tenantId})
  expect(entries).toHaveLength(1)
  expect(entries[0]!.lines.map(l => l.role)).toEqual(['receivable', 'uncategorized_income'])
  await expect(store.postAccrualExpectation(e.id, tenantId, 'debit', amount, e.reference)).rejects.toThrow('accrual must match')
})

it('includes future-due receivables in the current aging bucket', async () => {
  const store=new MemoryStore({now:()=>instant})
  await store.transaction(tx=>tx.insertExpectation({tenantId,account,reference:'FUTURE',amount:Money.parse('10',NATIVE),dueAt:new Date('2026-10-02')}))
  const report=await agingReport({store,tenantId,asOf:instant})
  expect(report.receivables.items[0]).toMatchObject({bucket:'current'})
  expect(report.receivables.items[0]!.remainingAmount.raw).toBe(100000000n)
})
