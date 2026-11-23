import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NewMovement, Store } from '@nostro-labs/nostro'
import {
  Money,
  NATIVE,
  asset,
  doctor,
  reconcile,
  postJournal,
  postMovement,
  agingReport,
} from '@nostro-labs/nostro'
import type { ConformanceOptions } from './contract.js'
import { assertContractVersion } from './contract.js'

const tenantId = 'refund-tenant'
const account = `G${'A'.repeat(55)}`
const hash = 'ab'.repeat(32)
const amount = (value: string) => Money.parse(value, NATIVE)
let sequence = 0

/** Same lifecycle and invariant checks run on memory, SQLite and PostgreSQL. */
export function describeRefundConformance(
  name: string,
  makeStore: () => Store | Promise<Store>,
  options: ConformanceOptions,
): void {
  assertContractVersion(options.contractVersion)
  describe(`Refunds: ${name}`, () => {
    let store: Store
    beforeEach(async () => {
      store = await makeStore()
    })
    afterEach(async () => {
      await store.close()
    })
    async function credit(value = '10', invoice?: string, over: Partial<NewMovement> = {}) {
      const { inserted } = await store.transaction((tx) =>
        tx.insertMovements([
          {
            tenantId,
            account,
            network: 'testnet',
            source: 'fixture',
            externalId: `credit-${++sequence}`,
            direction: 'credit',
            kind: 'transfer',
            amount: amount(value),
            ledger: 1,
            txHash: hash,
            occurredAt: new Date('2026-10-01'),
            ...(invoice === undefined ? {} : { memo: { type: 'text' as const, value: invoice } }),
            ...over,
          },
        ]),
      )
      return inserted[0]!
    }
    async function refund(value = '10', over: Partial<NewMovement> = {}) {
      const { inserted } = await store.transaction((tx) =>
        tx.insertMovements([
          {
            tenantId,
            account,
            network: 'testnet',
            source: 'fixture',
            externalId: `refund-${++sequence}`,
            direction: 'debit',
            kind: 'transfer',
            amount: amount(value),
            ledger: 2,
            txHash: 'cd'.repeat(32),
            memo: { type: 'return', value: hash },
            occurredAt: new Date('2026-10-02'),
            ...over,
          },
        ]),
      )
      return inserted[0]!
    }
    async function run() {
      const result = await reconcile({ store, tenantId })
      expect(result.errors).toEqual([])
      return result
    }
    async function healthy() {
      expect((await doctor({ store, tenantId })).findings).toEqual([])
      expect((await postJournal({ store, tenantId })).errors).toEqual([])
      expect(Object.values((await postJournal({ store, tenantId })).posted).every((n) => n === 0)).toBe(true)
      const entries = await store.listJournalEntries({ tenantId })
      const clearing = entries
        .flatMap((e) => e.lines)
        .filter((l) => l.role === 'refund_clearing')
        .reduce((sum, l) => sum + (l.side === 'debit' ? l.amount.raw : -l.amount.raw), 0n)
      expect(clearing).toBe(0n)
    }

    it('links a full refund, clears unapplied money and remains idempotent', async () => {
      const c = await credit()
      await run()
      const d = await refund()
      expect((await run()).journalEntries).toBe(2)
      await healthy()
      const [link] = await store.listRefundLinks({ tenantId, creditMovementId: c.id })
      expect(link).toMatchObject({ creditMovementId: c.id, refundMovementId: d.id })
      expect(link!.amount.raw).toBe(amount('10').raw)
      expect(link!.residualAmount.raw).toBe(amount('10').raw)
      expect((await store.getMovement(tenantId, c.id))!.disposition).toBe('allocated')
      expect(await store.listExceptions({ tenantId, status: 'open' })).toEqual([])
      expect(
        (await agingReport({ store, tenantId, asOf: new Date('2030-01-01') })).unexplainedMoney.items,
      ).toEqual([])
      expect(await store.transaction((tx) => tx.linkRefund(tenantId, c.id, d.id))).toEqual(link)
      await run()
      expect(await store.listRefundLinks({ tenantId })).toHaveLength(1)
      expect(await store.listRefundLinks({ tenantId, movementIds: [] })).toEqual([])
      expect(await store.listRefundLinks({ tenantId: 'elsewhere' })).toEqual([])
    })

    it('keeps a partial refund explicitly covered until the rest returns', async () => {
      const c = await credit()
      await run()
      await refund('4')
      await run()
      await healthy()
      expect((await store.getMovement(tenantId, c.id))!.disposition).toBe('partial')
      expect((await store.listExceptions({ tenantId, status: 'open' }))[0]!.amount!.raw).toBe(amount('6').raw)
      await refund('6')
      await run()
      await healthy()
      expect((await store.getMovement(tenantId, c.id))!.disposition).toBe('allocated')
    })

    it('clears customer credit first and expenses the settled portion without reopening the invoice', async () => {
      const invoice = await store.transaction((tx) =>
        tx.insertExpectation({ tenantId, account, reference: 'INV-1', amount: amount('10') }),
      )
      await credit('15', 'INV-1')
      await run()
      await refund('3')
      await run()
      await refund('7')
      await run()
      await healthy()
      expect((await store.getExpectation(tenantId, invoice.id))!.status).toBe('settled')
      const entries = await store.listJournalEntries({ tenantId })
      const net = (role: string) =>
        entries
          .flatMap((e) => e.lines)
          .filter((l) => l.role === role)
          .reduce((s, l) => s + (l.side === 'debit' ? l.amount.raw : -l.amount.raw), 0n)
      expect(net('customer_credit')).toBe(0n)
      expect(net('uncategorized_expense')).toBe(amount('5').raw)
    })

    it('records a full settled-payment refund as a return expense', async () => {
      const invoice = await store.transaction((tx) =>
        tx.insertExpectation({ tenantId, account, reference: 'INV-2', amount: amount('10') }),
      )
      await credit('10', 'INV-2')
      await run()
      await refund()
      await run()
      await healthy()
      expect((await store.getExpectation(tenantId, invoice.id))!.status).toBe('settled')
      expect((await store.listRefundLinks({ tenantId }))[0]!.residualAmount.isZero()).toBe(true)
    })

    it('reports an unknown return memo without guessing or dropping the debit', async () => {
      const d = await refund()
      const result = await run()
      expect(result.exceptions.REFUND_UNLINKED).toBe(1)
      expect((await store.getMovement(tenantId, d.id))!.disposition).toBe('exception')
      expect(await store.listRefundLinks({ tenantId })).toEqual([])
      await healthy()
    })

    it.each(['asset', 'wallet', 'network', 'future', 'ambiguous'] as const)(
      'refuses a return reference with a mismatched %s',
      async (mode) => {
        const over: Partial<NewMovement> =
          mode === 'asset'
            ? { amount: Money.parse('10', asset('USDC', account)) }
            : mode === 'wallet'
              ? { account: `G${'B'.repeat(55)}` }
              : mode === 'network'
                ? { network: 'pubnet' }
                : mode === 'future'
                  ? { occurredAt: new Date('2026-10-03') }
                  : {}
        await credit('10', undefined, over)
        if (mode === 'ambiguous') await credit()
        await refund()
        expect((await run()).exceptions.REFUND_UNLINKED).toBe(1)
        expect(await store.listRefundLinks({ tenantId })).toEqual([])
        await healthy()
      },
    )

    it('serializes competing refunds and never returns more than the credit', async () => {
      await credit()
      await run()
      await refund('6')
      await refund('6')
      const results = await Promise.all([reconcile({ store, tenantId }), reconcile({ store, tenantId })])
      expect(results.flatMap((r) => r.errors)).toEqual([])
      const links = await store.listRefundLinks({ tenantId })
      expect(links).toHaveLength(1)
      expect(links[0]!.amount.raw).toBe(amount('6').raw)
      expect(await store.listExceptions({ tenantId, status: 'open', code: 'REFUND_UNLINKED' })).toHaveLength(
        1,
      )
      await healthy()
    })

    it('rolls back a link and refuses cross-tenant lookup', async () => {
      const c = await credit()
      const d = await refund()
      await expect(
        store.transaction(async (tx) => {
          await tx.linkRefund(tenantId, c.id, d.id)
          throw new Error('rollback')
        }),
      ).rejects.toThrow('rollback')
      expect(await store.listRefundLinks({ tenantId })).toEqual([])
      await expect(store.transaction((tx) => tx.linkRefund('elsewhere', c.id, d.id))).rejects.toThrow()
      await run()
      await healthy()
    })

    it('prevents later allocations from spending money already returned', async () => {
      const c = await credit()
      await run()
      await refund('4')
      await run()
      const invoice = await store.transaction((tx) =>
        tx.insertExpectation({ tenantId, account, reference: 'LATER', amount: amount('7') }),
      )
      await expect(
        store.transaction((tx) =>
          tx.allocate({
            tenantId,
            movementId: c.id,
            expectationId: invoice.id,
            amount: amount('7'),
            strategy: 'manual',
          }),
        ),
      ).rejects.toMatchObject({ constraint: 'allocation_over_movement' })
      await healthy()
    })

    it('handles ingestion order when a refund was stored before its original credit', async () => {
      await refund()
      await credit()
      await run()
      await healthy()
      expect(await store.listRefundLinks({ tenantId })).toHaveLength(1)
    })

    it('keeps refund queries indexed by the exact transaction hash', async () => {
      await credit()
      await credit('1', undefined, { txHash: 'ff'.repeat(32) })
      expect(await store.listMovements({ tenantId, account, txHash: hash })).toHaveLength(1)
      // Ordinary movement posting continues to work with the new store contract.
      await run()
      const [m] = await store.listMovements({ tenantId })
      expect(await store.transaction((tx) => postMovement(tx, tenantId, m!.id))).toBeNull()
    })
  })
}
