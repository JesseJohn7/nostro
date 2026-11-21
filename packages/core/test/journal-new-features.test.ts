/**
 * Tests for issues #58, #59, #60, #61:
 *   aging.ts       — aging report (#58)
 *   valuation.ts   — movement valuation (#59)
 *   cost-basis.ts  — cost basis and realised gains (#60)
 *   post-manual.ts — post manual journal entries (#61)
 */
import { describe, expect, it } from 'vitest'
import type { NewMovement, NewExpectation, Price } from '../src/index.js'
import {
  MemoryStore,
  Money,
  NATIVE,
  asset,
  agingReport,
  bucketNameForDays,
  DEFAULT_AGING_BUCKETS,
  costBasis,
  convertAmount,
  MapPriceSource,
  HorizonPriceSource,
  valueMovements,
  postManualEntry,
  reverseManualEntry,
  doctor,
} from '../src/index.js'

const T = 'tenant-test'
const ACCOUNT = `G${'A'.repeat(55)}`
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const USDC = asset('USDC', ISSUER)
const usdc = (v: string) => Money.parse(v, USDC)
const xlm = (v: string) => Money.parse(v, NATIVE)
const HASH = 'ab'.repeat(32)

function newMovement(over: Partial<NewMovement> = {}): NewMovement {
  return {
    tenantId: T,
    network: 'testnet',
    source: 'horizon',
    externalId: `eff-${Math.random()}`,
    account: ACCOUNT,
    direction: 'credit',
    kind: 'transfer',
    amount: xlm('10'),
    ledger: 1000,
    txHash: HASH,
    occurredAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  }
}

// ---------------------------------------------------------------------------
// bucketNameForDays helper
// ---------------------------------------------------------------------------
describe('bucketNameForDays', () => {
  const buckets = [30, 60, 90]

  it('returns current for 0 or negative days', () => {
    expect(bucketNameForDays(0, buckets)).toBe('current')
    expect(bucketNameForDays(-5, buckets)).toBe('current')
  })

  it('places 1-30 days in 1-30 bucket', () => {
    expect(bucketNameForDays(1, buckets)).toBe('1-30')
    expect(bucketNameForDays(30, buckets)).toBe('1-30')
  })

  it('places 31-60 days in 31-60 bucket', () => {
    expect(bucketNameForDays(31, buckets)).toBe('31-60')
    expect(bucketNameForDays(60, buckets)).toBe('31-60')
  })

  it('places >90 days in >90 bucket', () => {
    expect(bucketNameForDays(91, buckets)).toBe('>90')
    expect(bucketNameForDays(999, buckets)).toBe('>90')
  })
})

// ---------------------------------------------------------------------------
// agingReport — issue #58
// ---------------------------------------------------------------------------
describe('agingReport', () => {
  async function storeWithExpectation() {
    const store = new MemoryStore({now:()=>new Date('2026-09-01T00:00:00Z')})
    const exp: NewExpectation = {
      tenantId: T,
      reference: 'INV-001',
      account: ACCOUNT,
      direction: 'credit',
      amount: usdc('100'),
      dueAt: new Date('2026-09-01T00:00:00Z'),
    }
    await store.transaction((tx) => tx.insertExpectation(exp))
    return store
  }

  it('reports a fully open expectation as a receivable', async () => {
    const store = await storeWithExpectation()
    const report = await agingReport({ store, tenantId: T, asOf: new Date('2026-10-01T00:00:00Z') })
    expect(report.receivables.items).toHaveLength(1)
    const item = report.receivables.items[0]!
    expect(item.reference).toBe('INV-001')
    expect(item.remainingAmount.toString()).toBe('100.0000000')
    expect(item.remainingAmount.asset).toBe(USDC)
    expect(item.daysPastDue).toBe(30)
    expect(item.bucket).toBe('1-30')
  })

  it('reports no receivables before the expectation was created', async () => {
    const store = await storeWithExpectation()
    const report = await agingReport({ store, tenantId: T, asOf: new Date('2026-08-01T00:00:00Z') })
    // The expectation was created on 2026-09-01; asOf is before that so no items
    expect(report.receivables.items).toHaveLength(0)
  })

  it('handles expectations with no due date in no_due_date bucket', async () => {
    const store = new MemoryStore({now:()=>new Date('2026-09-01T00:00:00Z')})
    await store.transaction((tx) =>
      tx.insertExpectation({
        tenantId: T,
        reference: 'INV-002',
        account: ACCOUNT,
        direction: 'credit',
        amount: usdc('50'),
        dueAt: null,
      }),
    )
    const report = await agingReport({ store, tenantId: T, asOf: new Date('2026-10-01T00:00:00Z') })
    expect(report.receivables.items[0]!.bucket).toBe('no_due_date')
    expect(report.receivables.items[0]!.daysPastDue).toBeNull()
  })

  it('reports a partial payment correctly', async () => {
    let clock=new Date('2026-09-01T00:00:00Z')
    const store = new MemoryStore({now:()=>clock})
    await store.transaction((tx) =>
      tx.insertExpectation({
        tenantId: T,
        reference: 'INV-003',
        account: ACCOUNT,
        direction: 'credit',
        amount: usdc('100'),
        dueAt: new Date('2026-09-01T00:00:00Z'),
      }),
    )
    const exps = await store.listExpectations({ tenantId: T })
    const exp = exps[0]!
    const mov = await store.transaction((tx) =>
      tx.insertMovements([newMovement({ amount: usdc('40') })]).then((r) => r.inserted[0]!),
    )
    clock=new Date('2026-10-15T00:00:00Z')
    await store.transaction((tx) =>
      tx.allocate({ tenantId: T, movementId: mov.id, expectationId: exp.id, amount: usdc('40'), strategy: 'manual' }),
    )
    // As of a past date before payment, it was 100
    const pastReport = await agingReport({ store, tenantId: T, asOf: new Date('2026-10-01T00:00:00Z') })
    expect(pastReport.receivables.items[0]!.remainingAmount.toString()).toBe('100.0000000')

    // Today (after payment), it is 60
    const report = await agingReport({ store, tenantId: T })
    const item = report.receivables.items[0]!
    expect(item.remainingAmount.toString()).toBe('60.0000000')
  })

  it('byAsset totals match the sum of remaining amounts', async () => {
    const store = new MemoryStore({now:()=>new Date('2026-09-01T00:00:00Z')})
    await store.transaction((tx) =>
      tx.insertExpectation({ tenantId: T, reference: 'A', account: ACCOUNT, direction: 'credit', amount: usdc('100'), dueAt: new Date('2026-09-01T00:00:00Z') }),
    )
    await store.transaction((tx) =>
      tx.insertExpectation({ tenantId: T, reference: 'B', account: ACCOUNT, direction: 'credit', amount: usdc('200'), dueAt: new Date('2026-09-15T00:00:00Z') }),
    )
    const report = await agingReport({ store, tenantId: T, asOf: new Date('2026-10-20T00:00:00Z') })
    const byAsset = report.receivables.byAsset[0]!
    expect(byAsset.totalRemaining.toString()).toBe('300.0000000')
  })

  it('reports payables separately from receivables', async () => {
    const store = new MemoryStore({now:()=>new Date('2026-09-01T00:00:00Z')})
    await store.transaction((tx) =>
      tx.insertExpectation({ tenantId: T, reference: 'PAY-001', account: ACCOUNT, direction: 'debit', amount: usdc('50'), dueAt: null }),
    )
    const report = await agingReport({ store, tenantId: T })
    expect(report.payables.items).toHaveLength(1)
    expect(report.receivables.items).toHaveLength(0)
  })

  it('uses custom bucket boundaries', async () => {
    const store = new MemoryStore({now:()=>new Date('2026-09-01T00:00:00Z')})
    await store.transaction((tx) =>
      tx.insertExpectation({ tenantId: T, reference: 'C', account: ACCOUNT, direction: 'credit', amount: usdc('10'), dueAt: new Date('2026-09-15T00:00:00Z') }),
    )
    const report = await agingReport({ store, tenantId: T, asOf: new Date('2026-10-01T00:00:00Z'), buckets: [15, 45] })
    // 2026-10-01 - 2026-09-15 = 16 days → bucket 16-45
    expect(report.receivables.items[0]!.bucket).toBe('16-45')
  })

  it('defaults to DEFAULT_AGING_BUCKETS', () => {
    expect(DEFAULT_AGING_BUCKETS).toEqual([30, 60, 90])
  })
})

// ---------------------------------------------------------------------------
// convertAmount and MapPriceSource — issue #59
// ---------------------------------------------------------------------------
describe('valuation', () => {
  describe('convertAmount', () => {
    it('converts using integer round-half-up', () => {
      // 1 XLM at price 0.3 USD = 0.3000000 USD  (3/10 * 1_000_000 / 10_000_000 * 10_000_000)
      const price = { n: 3n, d: 10n }
      const amount = xlm('1')
      const result = convertAmount(amount, price, USDC, 7)
      // 10_000_000 * 10^7 * 3 / (10^7 * 10) = 3_000_000 raw USDC = 0.3000000
      expect(result.raw).toBe(3_000_000n)
      expect(result.asset).toBe(USDC)
    })

    it('returns same amount when base equals quote', () => {
      const amount = usdc('5')
      const result = convertAmount(amount, { n: 1n, d: 1n }, USDC, 7)
      expect(result.raw).toBe(amount.raw)
    })

    it('rounds half-up correctly', () => {
      // 1 raw unit at price 2/3 → 1 * 1 * 2 / (1 * 3) = 0.666... → rounds to 1
      const amount = Money.fromRaw(1n, NATIVE, 7)
      const result = convertAmount(amount, { n: 2n, d: 3n }, USDC, 7)
      // num = 1 * 10^7 * 2 = 20_000_000; den = 10^7 * 3 = 30_000_000
      // rounded = (20_000_000 + 15_000_000) / 30_000_000 = 1
      expect(result.raw).toBe(1n)
    })

    it('throws when price denominator is zero', () => {
      const amount = xlm('1')
      expect(() => convertAmount(amount, { n: 1n, d: 0n }, USDC, 7)).toThrow('denominator cannot be zero')
    })
  })

  describe('MapPriceSource', () => {
    it('returns null when no matching price', async () => {
      const source = new MapPriceSource([])
      const price = await source.price(NATIVE, USDC, new Date())
      expect(price).toBeNull()
    })

    it('returns closest price by time', async () => {
      const t1 = new Date('2026-10-01T00:00:00Z')
      const t2 = new Date('2026-10-01T01:00:00Z')
      const prices: Price[] = [
        { base: NATIVE, quote: USDC, price: { n: 3n, d: 10n }, source: 'test', timestamp: t1 },
        { base: NATIVE, quote: USDC, price: { n: 4n, d: 10n }, source: 'test', timestamp: t2 },
      ]
      const source = new MapPriceSource(prices)
      const result = await source.price(NATIVE, USDC, new Date('2026-10-01T00:10:00Z'))
      expect(result?.price).toEqual({ n: 3n, d: 10n })
    })
  })

  describe('HorizonPriceSource', () => {
    it('returns null when Horizon returns empty records', async () => {
      const fakeFetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ _embedded: { records: [] } }),
      })) as unknown as typeof globalThis.fetch
      const source = new HorizonPriceSource({ url: 'https://horizon-testnet.stellar.org', fetch: fakeFetch })
      const result = await source.price(NATIVE, USDC, new Date('2026-10-01T00:00:00Z'))
      expect(result).toBeNull()
    })

    it('returns null when segment count is 0', async () => {
      const fakeFetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          _embedded: {
            records: [{ timestamp: Date.now(), count: '0', close_r: { n: '3', d: '10' } }],
          },
        }),
      })) as unknown as typeof globalThis.fetch
      const source = new HorizonPriceSource({ url: 'https://horizon-testnet.stellar.org', fetch: fakeFetch })
      const result = await source.price(NATIVE, USDC, new Date('2026-10-01T00:00:00Z'))
      expect(result).toBeNull()
    })

    it('picks closest segment with trades', async () => {
      const now = new Date('2026-10-01T01:00:00Z')
      const fakeFetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          _embedded: {
            records: [
              { timestamp: now.getTime() - 3600000, count: '5', close_r: { n: '3', d: '10' } },
              { timestamp: now.getTime(), count: '10', close_r: { n: '4', d: '10' } },
            ],
          },
        }),
      })) as unknown as typeof globalThis.fetch
      const source = new HorizonPriceSource({ url: 'https://horizon-testnet.stellar.org', fetch: fakeFetch })
      const result = await source.price(NATIVE, USDC, now)
      expect(result?.price).toEqual({ n: 4n, d: 10n })
    })

    it('throws on non-404 HTTP error', async () => {
      const fakeFetch = (async () => ({ ok: false, status: 500 })) as unknown as typeof globalThis.fetch
      const source = new HorizonPriceSource({ url: 'https://horizon-testnet.stellar.org', fetch: fakeFetch })
      await expect(source.price(NATIVE, USDC, new Date())).rejects.toThrow('HTTP 500')
    })

    it('returns null on 404', async () => {
      const fakeFetch = (async () => ({ ok: false, status: 404 })) as unknown as typeof globalThis.fetch
      const source = new HorizonPriceSource({ url: 'https://horizon-testnet.stellar.org', fetch: fakeFetch })
      const result = await source.price(NATIVE, USDC, new Date())
      expect(result).toBeNull()
    })
  })

  describe('valueMovements', () => {
    it('values movements and is idempotent', async () => {
      const store = new MemoryStore()
      const mov = await store.transaction((tx) =>
        tx.insertMovements([newMovement({ amount: xlm('10') })]).then((r) => r.inserted[0]!),
      )
      const price: Price = {
        base: NATIVE,
        quote: USDC,
        price: { n: 3n, d: 10n },
        source: 'test',
        timestamp: mov.occurredAt,
      }
      const priceSource = new MapPriceSource([price])
      const result1 = await valueMovements({ store, tenantId: T, priceSource, reportingAsset: USDC })
      expect(result1.examined).toBe(1)
      expect(result1.valued).toBe(1)
      expect(result1.skipped).toBe(0)

      // Running again changes nothing
      const result2 = await valueMovements({ store, tenantId: T, priceSource, reportingAsset: USDC })
      expect(result2.examined).toBe(1)
      expect(result2.valued).toBe(0)
      expect(result2.skipped).toBe(1)
    })

    it('skips movements with no price', async () => {
      const store = new MemoryStore()
      await store.transaction((tx) =>
        tx.insertMovements([newMovement({ amount: xlm('10') })]).then((r) => r.inserted[0]!),
      )
      const priceSource = new MapPriceSource([])
      const result = await valueMovements({ store, tenantId: T, priceSource, reportingAsset: USDC })
      expect(result.examined).toBe(1)
      expect(result.valued).toBe(0)
      expect(result.skipped).toBe(0)
    })

    it('uses identity price when movement asset equals reporting asset', async () => {
      const store = new MemoryStore()
      await store.transaction((tx) =>
        tx.insertMovements([newMovement({ amount: usdc('10') })]).then((r) => r.inserted[0]!),
      )
      const priceSource = new MapPriceSource([])
      const result = await valueMovements({ store, tenantId: T, priceSource, reportingAsset: USDC })
      expect(result.valued).toBe(1)
      const vals = await store.listValuations({ tenantId: T })
      expect(vals[0]!.value.toString()).toBe('10.0000000')
      expect(vals[0]!.value.asset).toBe(USDC)
    })
  })
})

// ---------------------------------------------------------------------------
// costBasis — issue #60
// ---------------------------------------------------------------------------
describe('costBasis', () => {
  async function storeWithCreditAndDebit() {
    const store = new MemoryStore()
    // Credit: 10 XLM at 0.3 USD each = 3 USD
    const credit = await store.transaction((tx) =>
      tx.insertMovements([newMovement({ amount: xlm('10'), direction: 'credit', occurredAt: new Date('2026-10-01T00:00:00Z') })]).then((r) => r.inserted[0]!),
    )
    const price: Price = {
      base: NATIVE,
      quote: USDC,
      price: { n: 3n, d: 10n },
      source: 'test',
      timestamp: new Date('2026-10-01T00:00:00Z'),
    }
    await valueMovements({ store, tenantId: T, priceSource: new MapPriceSource([price]), reportingAsset: USDC })

    // Debit: 5 XLM at 0.4 USD each = 2 USD proceeds
    const debit = await store.transaction((tx) =>
      tx.insertMovements([newMovement({ amount: xlm('5'), direction: 'debit', occurredAt: new Date('2026-10-15T00:00:00Z') })]).then((r) => r.inserted[0]!),
    )
    const price2: Price = {
      base: NATIVE,
      quote: USDC,
      price: { n: 4n, d: 10n },
      source: 'test',
      timestamp: new Date('2026-10-15T00:00:00Z'),
    }
    await valueMovements({ store, tenantId: T, priceSource: new MapPriceSource([price2]), reportingAsset: USDC })

    return { store, credit, debit }
  }

  it('opens a lot from a credit and closes part on a debit (FIFO)', async () => {
    const { store } = await storeWithCreditAndDebit()
    const report = await costBasis({ store, tenantId: T, asset: NATIVE, method: 'fifo' })
    expect(report.openLots).toHaveLength(1)
    expect(report.disposals).toHaveLength(1)
    const disposal = report.disposals[0]!
    // proceeds = 5 XLM * 0.4 USD/XLM = 2 USD
    expect(disposal.proceeds?.toString()).toBe('2.0000000')
    // cost = 5/10 * 3 USD = 1.5 USD
    expect(disposal.cost.toString()).toBe('1.5000000')
    // gain = 0.5 USD
    expect(disposal.gain?.toString()).toBe('0.5000000')
  })

  it('open lots plus disposals always equal total movements (amount)', async () => {
    const { store } = await storeWithCreditAndDebit()
    const report = await costBasis({ store, tenantId: T, asset: NATIVE, method: 'fifo' })
    const lotTotal = report.openLots.reduce((s, l) => s + l.remainingAmount.raw, 0n)
    const disposalTotal = report.disposals.reduce((s, d) => s + d.amount.raw, 0n)
    // Total credit was 10 XLM; 5 disposed; 5 remain
    expect(lotTotal + disposalTotal).toBe(xlm('10').raw)
  })

  it('open lots plus disposals always equal total cost', async () => {
    const { store } = await storeWithCreditAndDebit()
    const report = await costBasis({ store, tenantId: T, asset: NATIVE, method: 'fifo' })
    const lotCost = report.openLots.reduce((s, l) => s + l.remainingCost.raw, 0n)
    const disposalCost = report.disposals.reduce((s, d) => s + d.cost.raw, 0n)
    // Total original cost = 3 USD raw = 30_000_000
    const originalCost = xlm('10').raw * 3n / 10n  // = 3_000_000 raw USDC
    expect(lotCost + disposalCost).toBe(originalCost)
  })

  it('reports a credit with no valuation in unvaluedCredits', async () => {
    const store = new MemoryStore()
    await store.transaction((tx) =>
      tx.insertMovements([newMovement({ amount: xlm('10'), direction: 'credit' })]).then((r) => r.inserted[0]!),
    )
    const report = await costBasis({ store, tenantId: T, asset: NATIVE })
    expect(report.unvaluedCredits).toHaveLength(1)
    expect(report.openLots).toHaveLength(0)
  })

  it('handles LIFO ordering', async () => {
    const store = new MemoryStore()
    // Two credits: 5 XLM at 0.2 USD, then 5 XLM at 0.4 USD
    for (const [i, priceVal] of [[0, 0.2], [1, 0.4]] as const) {
      const occ = new Date(`2026-10-0${i + 1}T00:00:00Z`)
      await store.transaction((tx) =>
        tx.insertMovements([newMovement({ amount: xlm('5'), direction: 'credit', externalId: `c${i}`, occurredAt: occ })]),
      )
      const n = BigInt(Math.round(priceVal * 10))
      await valueMovements({
        store, tenantId: T, priceSource: new MapPriceSource([{ base: NATIVE, quote: USDC, price: { n, d: 10n }, source: 'test', timestamp: occ }]),
        reportingAsset: USDC,
      })
    }
    // Debit 3 XLM at 0.5 USD proceeds
    const debitOcc = new Date('2026-10-05T00:00:00Z')
    await store.transaction((tx) =>
      tx.insertMovements([newMovement({ amount: xlm('3'), direction: 'debit', externalId: 'debit1', occurredAt: debitOcc })]).then((r) => r.inserted[0]!),
    )
    await valueMovements({
      store, tenantId: T,
      priceSource: new MapPriceSource([{ base: NATIVE, quote: USDC, price: { n: 5n, d: 10n }, source: 'test', timestamp: debitOcc }]),
      reportingAsset: USDC,
    })
    const report = await costBasis({ store, tenantId: T, asset: NATIVE, method: 'lifo' })
    // LIFO: use the most recent lot (cost 0.4 USD/XLM)
    // cost = 3 * 0.4 = 1.2 USD
    expect(report.disposals[0]!.cost.toString()).toBe('1.2000000')
  })

  it('handles a lot used up across several debits', async () => {
    const store = new MemoryStore()
    const occ = new Date('2026-10-01T00:00:00Z')
    await store.transaction((tx) =>
      tx.insertMovements([newMovement({ amount: xlm('9'), direction: 'credit', occurredAt: occ })]).then((r) => r.inserted[0]!),
    )
    await valueMovements({
      store, tenantId: T,
      priceSource: new MapPriceSource([{ base: NATIVE, quote: USDC, price: { n: 1n, d: 1n }, source: 'test', timestamp: occ }]),
      reportingAsset: USDC,
    })
    // 3 debits of 3 XLM each
    for (let i = 0; i < 3; i++) {
      const dOcc = new Date(`2026-10-0${i + 2}T00:00:00Z`)
      await store.transaction((tx) =>
        tx.insertMovements([newMovement({ amount: xlm('3'), direction: 'debit', externalId: `d${i}`, occurredAt: dOcc })]).then((r) => r.inserted[0]!),
      )
      await valueMovements({
        store, tenantId: T,
        priceSource: new MapPriceSource([{ base: NATIVE, quote: USDC, price: { n: 1n, d: 1n }, source: 'test', timestamp: dOcc }]),
        reportingAsset: USDC,
      })
    }
    const report = await costBasis({ store, tenantId: T, asset: NATIVE, method: 'fifo' })
    expect(report.openLots).toHaveLength(0)
    expect(report.disposals).toHaveLength(3)
    const lotCost = report.openLots.reduce((s, l) => s + l.remainingCost.raw, 0n)
    const disposalCost = report.disposals.reduce((s, d) => s + d.cost.raw, 0n)
    expect(lotCost + disposalCost).toBe(xlm('9').raw)
  })

  it('gives the same report on the same inputs (determinism)', async () => {
    const { store } = await storeWithCreditAndDebit()
    const r1 = await costBasis({ store, tenantId: T, asset: NATIVE })
    const r2 = await costBasis({ store, tenantId: T, asset: NATIVE })
    expect(r1.disposals.length).toBe(r2.disposals.length)
    expect(r1.realizedGain?.raw).toBe(r2.realizedGain?.raw)
  })
})

// ---------------------------------------------------------------------------
// postManualEntry / reverseManualEntry — issue #61
// ---------------------------------------------------------------------------
describe('postManualEntry', () => {
  it('posts a write-off entry with non-cash roles', async () => {
    const store = new MemoryStore()
    const entry = await postManualEntry({
      store,
      tenantId: T,
      description: 'Write off old suspense',
      lines: [
        { account: 'assets:suspense', role: 'other', side: 'credit', amount: usdc('10') },
        { account: 'expenses:write-off', role: 'uncategorized_expense', side: 'debit', amount: usdc('10') },
      ],
      reason: 'Balance confirmed unrecoverable after 2 years',
      postedBy: 'alice@example.com',
    })
    expect(entry.kind).toBe('manual')
    expect(entry.movementId).toBeNull()
    expect(entry.postingNo).toBeNull()
    expect(entry.description).toContain('Write off old suspense')
    expect(entry.lines).toHaveLength(2)
  })

  it('refuses a manual entry with a cash line', async () => {
    const store = new MemoryStore()
    await expect(
      postManualEntry({
        store,
        tenantId: T,
        description: 'Invalid cash touch',
        lines: [
          { account: 'assets:stellar:wallet', role: 'cash', side: 'debit', amount: usdc('10') },
          { account: 'liabilities:something', role: 'unapplied', side: 'credit', amount: usdc('10') },
        ],
        reason: 'Testing the guard',
      }),
    ).rejects.toMatchObject({ constraint: 'journal_cash_without_movement' })
  })

  it('refuses a manual entry with no reason', async () => {
    const store = new MemoryStore()
    await expect(
      postManualEntry({
        store,
        tenantId: T,
        description: 'Entry without reason',
        lines: [
          { account: 'assets:suspense', role: 'other', side: 'credit', amount: usdc('5') },
          { account: 'expenses:write-off', role: 'uncategorized_expense', side: 'debit', amount: usdc('5') },
        ],
      }),
    ).rejects.toMatchObject({ field: 'reason' })
  })

  it('refuses a manual entry with no description', async () => {
    const store = new MemoryStore()
    await expect(
      postManualEntry({
        store,
        tenantId: T,
        description: '',
        lines: [
          { account: 'assets:suspense', role: 'other', side: 'credit', amount: usdc('5') },
          { account: 'expenses:write-off', role: 'uncategorized_expense', side: 'debit', amount: usdc('5') },
        ],
        reason: 'Some reason',
      }),
    ).rejects.toMatchObject({ field: 'description' })
  })

  it('refuses an unbalanced manual entry', async () => {
    const store = new MemoryStore()
    await expect(
      postManualEntry({
        store,
        tenantId: T,
        description: 'Unbalanced',
        lines: [
          { account: 'assets:suspense', role: 'other', side: 'credit', amount: usdc('10') },
          { account: 'expenses:write-off', role: 'uncategorized_expense', side: 'debit', amount: usdc('5') },
        ],
        reason: 'Testing unbalanced',
      }),
    ).rejects.toMatchObject({ constraint: 'journal_unbalanced' })
  })

  it('reverses a manual entry with equal and opposite lines', async () => {
    const store = new MemoryStore()
    const original = await postManualEntry({
      store,
      tenantId: T,
      description: 'Reclassify rent',
      lines: [
        { account: 'assets:suspense', role: 'other', side: 'debit', amount: usdc('500') },
        { account: 'expenses:rent', role: 'uncategorized_expense', side: 'credit', amount: usdc('500') },
      ],
      reason: 'Identified as rent',
    })
    const reversal = await reverseManualEntry({
      store,
      tenantId: T,
      entryId: original.id,
      reason: 'Was posted to wrong account',
    })
    expect(reversal.kind).toBe('manual')
    expect(reversal.description).toContain(`Reversal of ${original.id}`)
    // Lines are flipped
    for (const [i, origLine] of original.lines.entries()) {
      const revLine = reversal.lines[i]!
      expect(revLine.side).toBe(origLine.side === 'debit' ? 'credit' : 'debit')
      expect(revLine.amount.raw).toBe(origLine.amount.raw)
    }
  })

  it('doctor reports an existing manual entry that touches cash', async () => {
    const store = new MemoryStore()
    const badEntry = {
      tenantId: T,
      id: 'bad_entry_1',
      seq: 1,
      movementId: null,
      postingNo: null,
      kind: 'manual' as const,
      description: 'Bad manual entry',
      lines: [
        { account: 'assets:stellar:wallet', role: 'cash' as const, side: 'debit' as const, amount: usdc('10') },
        { account: 'liabilities:something', role: 'unapplied' as const, side: 'credit' as const, amount: usdc('10') },
      ],
      effectiveAt: new Date(),
      postedAt: new Date(),
    }
    ;(store as any).committed.journal.set(badEntry.id, badEntry)

    const report = await doctor({ store, tenantId: T })
    const finding = report.findings.find((f) => f.code === 'manual_entry_touches_cash')
    expect(finding).toBeDefined()
    expect(finding?.code).toBe('manual_entry_touches_cash')
  })
})
