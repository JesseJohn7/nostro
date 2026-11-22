/**
 * The journal half of the Store contract, as executable tests.
 *
 * Every store runs these: entries are append-only and balanced per asset,
 * posting numbers are a compare-and-set per movement, and a movement's cash
 * leg can only ever net to zero or exactly its amount.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JournalQuery, Movement, NewJournalEntry, NewJournalLine, NewMovement, Store } from '@nostro-labs/nostro'
import { agingReport, costBasis, valueMovements, MapPriceSource, NATIVE, cursorAfterLedger, openAccount, reconcile, postManualEntry, Money, NotFoundError, ValidationError, asset, closePeriod, doctor, postMovement, reopenPeriod } from '@nostro-labs/nostro'

const T = 'tenant-a'
const T2 = 'tenant-b'
const ACCOUNT = `G${'A'.repeat(55)}`
const USDC = asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
const usdc = (v: string) => Money.parse(v, USDC)
const CASH = `assets:stellar:testnet:${ACCOUNT}`
const constraint = (name: string) => ({ name: 'ConstraintError', constraint: name })

let counter = 0

export function describeJournalConformance(name: string, makeStore: () => Store | Promise<Store>): void {
  describe(`Journal conformance: ${name}`, () => {
    let store: Store

    beforeEach(async () => {
      store = await makeStore()
    })
    afterEach(async () => {
      await store.close()
    })

    async function movement(
      amount = usdc('10'),
      tenantId = T,
      over: Partial<NewMovement> = {},
    ): Promise<Movement> {
      counter += 1
      const { inserted } = await store.transaction((tx) =>
        tx.insertMovements([
          {
            tenantId,
            network: 'testnet',
            source: 'horizon',
            externalId: `journal-${counter}`,
            account: ACCOUNT,
            direction: 'credit',
            kind: 'transfer',
            amount,
            ledger: 1000 + counter,
            occurredAt: new Date('2026-10-05T12:00:00Z'),
            ...over,
          },
        ]),
      )
      return inserted[0]!
    }

    const lines = (amount: Money, counter = 'liabilities:unapplied-receipts'): NewJournalLine[] => [
      { account: CASH, role: 'cash', side: 'debit', amount },
      { account: counter, role: 'unapplied', side: 'credit', amount },
    ]
    const entry = (m: Movement, over: Partial<NewJournalEntry> = {}): NewJournalEntry => ({
      tenantId: m.tenantId,
      movementId: m.id,
      postingNo: 1,
      kind: 'initial',
      effectiveAt: m.occurredAt,
      description: 'Received 10 USDC',
      lines: lines(m.amount),
      ...over,
    })
    const post = (n: NewJournalEntry) => store.transaction((tx) => tx.postJournalEntry(n))

    it('posts an entry and reads it back exactly, lines in order and frozen', async () => {
      const m = await movement()
      const e = await post(entry(m))
      expect(e).toMatchObject({
        tenantId: T,
        movementId: m.id,
        postingNo: 1,
        kind: 'initial',
        effectiveAt: m.occurredAt,
        description: 'Received 10 USDC',
      })
      expect(e.postedAt).toBeInstanceOf(Date)
      const [read] = await store.listJournalEntries({ tenantId: T })
      expect(read!.lines.map((l) => [l.account, l.role, l.side, l.amount.toString(), l.expectationId, l.exceptionId])).toEqual([
        [CASH, 'cash', 'debit', '10.0000000', null, null],
        ['liabilities:unapplied-receipts', 'unapplied', 'credit', '10.0000000', null, null],
      ])
      expect(Object.isFrozen(read)).toBe(true)
      expect(Object.isFrozen(read!.lines)).toBe(true)
      expect(Object.isFrozen(read!.lines[0])).toBe(true)
    })

    it('posts mints, burns and clawbacks by kind with cash untouched by reclasses', async () => {
      const mint = await movement(usdc('10'), T, { kind: 'mint' })
      const burn = await movement(usdc('5'), T, { kind: 'burn', direction: 'debit' })
      const clawback = await movement(usdc('2'), T, { kind: 'clawback', direction: 'debit' })
      const report = await reconcile({ store, tenantId: T })
      expect(report.ignored).toBe(1)
      const byMovement = new Map(
        (await store.listJournalEntries({ tenantId: T })).map((entry) => [entry.movementId, entry]),
      )
      const roles = (id: string) => byMovement.get(id)!.lines.map((line) => [line.role, line.side])
      expect(roles(mint.id)).toEqual([['cash', 'debit'], ['deposit_clearing', 'credit']])
      expect(roles(burn.id)).toEqual([['cash', 'credit'], ['redemption_payable', 'debit']])
      expect(roles(clawback.id)).toEqual([['cash', 'credit'], ['clawback', 'debit']])
      expect((await doctor({ store, tenantId: T })).findings).toEqual([])
    })

    it('opens an account and seeds both Horizon cursors after the opening ledger', async () => {
      const occurredAt = new Date('2026-10-01T00:00:00Z')
      const opening = await openAccount(store, {
        tenantId: T,
        network: 'testnet',
        account: ACCOUNT,
        ledger: 1000,
        occurredAt,
        balances: [{ amount: Money.parse('10', NATIVE), lastModifiedLedger: 999 }],
        note: 'Opening',
      })
      expect(await store.getAccountOpening(T, 'testnet', ACCOUNT)).toMatchObject({
        id: opening.id,
        ledger: 1000,
        note: 'Opening',
      })
      for (const source of ['horizon', 'horizon-fees']) {
        expect(await store.getCursor({ tenantId: T, network: 'testnet', source, account: ACCOUNT }))
          .toBe(cursorAfterLedger(1000))
      }
      const [entry] = await store.listJournalEntries({ tenantId: T })
      expect(entry).toMatchObject({ kind: 'opening', movementId: null, effectiveAt: occurredAt })
      expect(entry!.lines.map((l) => [l.role, l.side, l.account])).toEqual([
        ['cash', 'debit', CASH],
        ['opening_balance', 'credit', 'equity:opening-balances'],
      ])
    })

    it('refuses an opening once the account has movements', async () => {
      await movement()
      await expect(openAccount(store, {
        tenantId: T,
        network: 'testnet',
        account: ACCOUNT,
        ledger: 900,
        balances: [{ amount: Money.parse('10', NATIVE), lastModifiedLedger: 899 }],
      })).rejects.toMatchObject(constraint('account_opening_has_movements'))
      expect(await store.getAccountOpening(T, 'testnet', ACCOUNT)).toBeNull()
      expect(await store.listJournalEntries({ tenantId: T })).toEqual([])
    })

    it('defaults the effective date to the store clock', async () => {
      const m = await movement()
      const { effectiveAt, ...rest } = entry(m)
      void effectiveAt
      const e = await post(rest)
      expect(e.effectiveAt.getTime()).toBe(e.postedAt.getTime())
    })

    it('keeps amounts beyond 64 bits exact', async () => {
      const huge = Money.fromRaw(2n ** 70n + 3n, USDC)
      const m = await movement(huge)
      await post(entry(m))
      const [read] = await store.listJournalEntries({ tenantId: T, movementId: m.id })
      expect(read!.lines.map((l) => l.amount.raw)).toEqual([2n ** 70n + 3n, 2n ** 70n + 3n])
    })

    it('refuses an unbalanced entry and records nothing', async () => {
      const m = await movement()
      const unbalanced = entry(m, {
        lines: [
          { account: CASH, role: 'cash', side: 'debit', amount: usdc('10') },
          { account: 'x', role: 'unapplied', side: 'credit', amount: usdc('9') },
        ],
      })
      await expect(post(unbalanced)).rejects.toMatchObject(constraint('journal_unbalanced'))
      expect(await store.listJournalEntries({ tenantId: T })).toEqual([])
    })

    it('appends only at the next posting number', async () => {
      const m = await movement()
      await expect(post(entry(m, { postingNo: 2 }))).rejects.toMatchObject(constraint('journal_posting_conflict'))
      await post(entry(m))
      await expect(post(entry(m, { kind: 'reclass', lines: lines(usdc('1'), 'x').map((l) => ({ ...l, role: 'unapplied' })) }))).rejects.toMatchObject(
        constraint('journal_posting_conflict'),
      )
      const reclass: NewJournalEntry = entry(m, {
        postingNo: 2,
        kind: 'reclass',
        lines: [
          { account: 'liabilities:unapplied-receipts', role: 'unapplied', side: 'debit', amount: usdc('10') },
          { account: 'liabilities:customer-credit', role: 'customer_credit', side: 'credit', amount: usdc('10') },
        ],
      })
      await post(reclass)
      expect((await store.listJournalEntries({ tenantId: T, movementId: m.id })).map((e) => e.postingNo)).toEqual([1, 2])
    })

    it("never lets a movement's cash leg drift from its amount", async () => {
      const m = await movement()
      await post(entry(m))
      await expect(post(entry(m, { postingNo: 2, kind: 'correction' }))).rejects.toMatchObject(constraint('journal_cash_mismatch'))
    })

    it('keeps lines in the movement asset', async () => {
      const m = await movement()
      const xlm = Money.parse('10', 'native' as never)
      await expect(post(entry(m, { lines: lines(xlm) }))).rejects.toMatchObject(constraint('journal_asset'))
    })

    it('requires the movement, expectations and exceptions it names to exist in the tenant', async () => {
      const m = await movement()
      await expect(post(entry(m, { movementId: 'missing' }))).rejects.toBeInstanceOf(NotFoundError)
      await expect(post(entry(m, { tenantId: T2 }))).rejects.toBeInstanceOf(NotFoundError)
      const withExpectation = entry(m, { lines: lines(m.amount).map((l, i) => (i === 1 ? { ...l, expectationId: 'missing' } : l)) })
      await expect(post(withExpectation)).rejects.toBeInstanceOf(NotFoundError)
      const withException = entry(m, { lines: lines(m.amount).map((l, i) => (i === 1 ? { ...l, exceptionId: 'missing' } : l)) })
      await expect(post(withException)).rejects.toBeInstanceOf(NotFoundError)
      await expect(post(entry(m, { lines: [] }))).rejects.toBeInstanceOf(ValidationError)
    })

    it('links lines to expectations and exceptions', async () => {
      const m = await movement()
      const [e, x] = await store.transaction(async (tx) => [
        await tx.insertExpectation({ tenantId: T, reference: `J-${counter}`, account: ACCOUNT, amount: usdc('10') }),
        await tx.openException({ tenantId: T, code: 'OVERPAYMENT', movementId: m.id, detail: 'x' }),
      ])
      const linked = entry(m, {
        lines: [
          { account: CASH, role: 'cash', side: 'debit', amount: usdc('10') },
          { account: 'assets:receivable', role: 'receivable', side: 'credit', amount: usdc('6'), expectationId: (e as { id: string }).id },
          { account: 'liabilities:customer-credit', role: 'customer_credit', side: 'credit', amount: usdc('4'), exceptionId: (x as { id: string }).id },
        ],
      })
      const posted = await post(linked)
      expect(posted.lines.map((l) => [l.expectationId, l.exceptionId])).toEqual([
        [null, null],
        [(e as { id: string }).id, null],
        [null, (x as { id: string }).id],
      ])
    })

    it('accepts a manual entry not tied to a movement', async () => {
      const manual = await post({
        tenantId: T,
        kind: 'reclass',
        description: 'Write off suspense',
        lines: [
          { account: 'expenses:write-off', role: 'uncategorized_expense', side: 'debit', amount: usdc('1') },
          { account: 'assets:suspense', role: 'other', side: 'credit', amount: usdc('1') },
        ],
      })
      expect(manual).toMatchObject({ movementId: null, postingNo: null })
    })

    it('refuses closed dates, then permits them after a reasoned reopen', async () => {
      const m = await movement()
      const through = new Date('2026-10-05T12:00:00Z')
      await closePeriod({ store, tenantId: T, through, note: 'Month-end reported' })
      await expect(post(entry(m))).rejects.toMatchObject(constraint('journal_period_closed'))

      const otherTenantEntry = await post({
        tenantId: T2,
        kind: 'reclass',
        effectiveAt: through,
        description: 'Other tenant period remains open',
        lines: [
          { account: 'assets:suspense', role: 'other', side: 'debit', amount: m.amount },
          { account: 'liabilities:unapplied-receipts', role: 'other', side: 'credit', amount: m.amount },
        ],
      })
      expect(otherTenantEntry.tenantId).toBe(T2)

      await reopenPeriod({ store, tenantId: T, reason: 'Correcting a source statement' })
      await expect(post(entry(m))).resolves.toMatchObject({ movementId: m.id })
    })

    it('moves a late automatic posting to the first open instant and retains the source date', async () => {
      const m = await movement()
      const through = new Date('2026-10-05T12:00:00Z')
      await closePeriod({ store, tenantId: T, through })
      await store.transaction((tx) => tx.setDisposition(T, m.id, 'ignored', 'late movement'))
      const posted = await store.transaction((tx) => postMovement(tx, T, m.id))
      expect(posted).toMatchObject({
        effectiveAt: new Date(through.getTime() + 1),
        description: expect.stringContaining(m.occurredAt.toISOString()),
      })
      expect((await store.getMovement(T, m.id))!.occurredAt).toEqual(m.occurredAt)
    })

    it('rejects a correction whose effective date falls in the closed period', async () => {
      const m = await movement()
      await post(entry(m))
      await closePeriod({ store, tenantId: T, through: m.occurredAt })
      const correction = entry(m, {
        postingNo: 2,
        kind: 'correction',
        lines: [
          { account: CASH, role: 'cash', side: 'credit', amount: m.amount },
          { account: 'liabilities:unapplied-receipts', role: 'unapplied', side: 'debit', amount: m.amount },
        ],
      })
      await expect(post(correction)).rejects.toMatchObject(constraint('journal_period_closed'))
    })

    it('orders a concurrent close after a post already holding the tenant close lock', async () => {
      const m = await movement()
      let release!: () => void
      let locked!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      const acquired = new Promise<void>((resolve) => (locked = resolve))
      const posting = store.transaction(async (tx) => {
        await tx.lockJournalPeriod(T)
        locked()
        await gate
        return tx.postJournalEntry(entry(m))
      })
      await acquired

      let closeFinished = false
      const closing = store.transaction(async (tx) => {
        await tx.closeJournalPeriod(T, m.occurredAt, 'Race test')
        closeFinished = true
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(closeFinished).toBe(false)
      release()
      await Promise.all([posting, closing])
      await expect(post({
        tenantId: T,
        kind: 'reclass',
        effectiveAt: m.occurredAt,
        description: 'Must not pass the close',
        lines: lines(m.amount),
      })).rejects.toMatchObject(constraint('journal_period_closed'))
    })

    it('lists entries in posting order, filtered and scoped by tenant', async () => {
      const a = await movement()
      const b = await movement()
      const other = await movement(usdc('10'), T2)
      const ea = await post(entry(a, { effectiveAt: new Date('2026-10-01T00:00:00Z') }))
      const eb = await post(entry(b, { effectiveAt: new Date('2026-10-03T00:00:00Z') }))
      await post(entry(other))
      const ids = async (q: Omit<JournalQuery, 'tenantId'>) =>
        (await store.listJournalEntries({ tenantId: T, ...q })).map((e) => e.id)
      expect(await ids({})).toEqual([ea.id, eb.id])
      expect(await ids({ movementId: b.id })).toEqual([eb.id])
      expect(await ids({ afterSeq: ea.seq })).toEqual([eb.id])
      expect(await ids({ limit: 1 })).toEqual([ea.id])
      expect(await ids({ effectiveFrom: new Date('2026-10-02T00:00:00Z') })).toEqual([eb.id])
      expect(await ids({ effectiveBefore: new Date('2026-10-03T00:00:00Z') })).toEqual([ea.id])
      expect(await ids({ movementId: other.id })).toEqual([])
    })

    it('rolls back an entry when its transaction throws', async () => {
      const m = await movement()
      await expect(
        store.transaction(async (tx) => {
          await tx.postJournalEntry(entry(m))
          throw new Error('abort')
        }),
      ).rejects.toThrow('abort')
      expect(await store.listJournalEntries({ tenantId: T })).toEqual([])
      await post(entry(m)) // posting number 1 is still free

      // Roll back a second entry on a movement that already has one committed.
      const reclass = entry(m, {
        postingNo: 2,
        kind: 'reclass',
        lines: [
          { account: 'liabilities:unapplied-receipts', role: 'unapplied', side: 'debit', amount: usdc('10') },
          { account: 'liabilities:customer-credit', role: 'customer_credit', side: 'credit', amount: usdc('10') },
        ],
      })
      await expect(
        store.transaction(async (tx) => {
          await tx.postJournalEntry(reclass)
          throw new Error('abort')
        }),
      ).rejects.toThrow('abort')
      expect(await store.listJournalEntries({ tenantId: T, movementId: m.id })).toHaveLength(1)
      await post(reclass)
      expect((await store.listJournalEntries({ tenantId: T, movementId: m.id })).map((e) => e.postingNo)).toEqual([1, 2])
    })

    it('lets only one of two concurrent posters append to a movement', async () => {
      const m = await movement()
      // Both read before either starts, as two workers can: each believes
      // posting 1 is free. Reading first is what makes this deterministic;
      // left to chance, a slow reader sees the other's entry and is refused by
      // the check below instead. The store must let exactly one win.
      const [one, two] = await Promise.all([
        store.listJournalEntries({ tenantId: T, movementId: m.id }),
        store.listJournalEntries({ tenantId: T, movementId: m.id }),
      ])
      const poster = (seen: readonly unknown[]) =>
        store.transaction(async (tx) => {
          await new Promise((r) => setTimeout(r, 20))
          return tx.postJournalEntry(entry(m, { postingNo: seen.length + 1 }))
        })
      const results = await Promise.allSettled([poster(one), poster(two)])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
      expect(rejected.reason).toMatchObject(constraint('journal_posting_conflict'))
      expect(await store.listJournalEntries({ tenantId: T, movementId: m.id })).toHaveLength(1)
    })

    it('refuses a manual entry with a cash or issued line', async () => {
      await expect(
        store.transaction((tx) =>
          tx.postJournalEntry({
            tenantId: T,
            kind: 'manual',
            description: 'Manual cash test',
            lines: [
              { account: CASH, role: 'cash', side: 'debit', amount: usdc('10') },
              { account: 'liabilities:unapplied-receipts', role: 'unapplied', side: 'credit', amount: usdc('10') },
            ],
          }),
        ),
      ).rejects.toMatchObject(constraint('journal_cash_without_movement'))

      await expect(
        store.transaction((tx) =>
          tx.postJournalEntry({
            tenantId: T,
            kind: 'manual',
            description: 'Manual issued test',
            lines: [
              { account: CASH, role: 'issued', side: 'debit', amount: usdc('10') },
              { account: 'liabilities:unapplied-receipts', role: 'unapplied', side: 'credit', amount: usdc('10') },
            ],
          }),
        ),
      ).rejects.toMatchObject(constraint('journal_cash_without_movement'))

      await expect(
        store.transaction((tx) =>
          tx.postJournalEntry({
            tenantId: T,
            kind: 'manual',
            description: 'Manual opening balance test',
            lines: [
              { account: 'assets:suspense', role: 'other', side: 'debit', amount: usdc('10') },
              { account: 'equity:opening-balances', role: 'opening_balance', side: 'credit', amount: usdc('10') },
            ],
          }),
        ),
      ).rejects.toMatchObject(constraint('journal_manual_slot'))
    })

    it('posts a manual entry without movement and reads it back', async () => {
      const e = await store.transaction((tx) =>
        tx.postJournalEntry({
          tenantId: T,
          kind: 'manual',
          description: 'Write off suspense',
          lines: [
            { account: 'assets:suspense', role: 'other', side: 'credit', amount: usdc('10') },
            { account: 'expenses:write-off', role: 'uncategorized_expense', side: 'debit', amount: usdc('10') },
          ],
        }),
      )
      expect(e.kind).toBe('manual')
      expect(e.movementId).toBeNull()
      expect(e.postingNo).toBeNull()
      const list = await store.listJournalEntries({ tenantId: T })
      expect(list.some((entry) => entry.id === e.id && entry.kind === 'manual')).toBe(true)
    })

    it('inserts and lists movement valuations', async () => {
      const m = await movement()
      const val = {
        tenantId: T,
        movementId: m.id,
        reportingAsset: USDC,
        value: usdc('50'),
        priceNumerator: 5n,
        priceDenominator: 1n,
        priceSource: 'manual',
        priceTimestamp: new Date('2026-10-06T00:00:00Z'),
        valuedAt: new Date('2026-10-06T00:00:00Z'),
      }
      await store.transaction((tx) => tx.insertValuations([val]))
      const read = await store.getValuation(T, m.id)
      expect(read).not.toBeNull()
      expect(read?.movementId).toBe(m.id)
      expect(read?.value.raw).toBe(usdc('50').raw)

      const listed = await store.listValuations({ tenantId: T })
      expect(listed).toHaveLength(1)
      expect(listed[0]!.movementId).toBe(m.id)
    })

    it('values movements idempotently and reports aging and lots on the same records', async () => {
      const m = await movement()
      await reconcile({store, tenantId:T})
      const options = {store, tenantId:T, reportingAsset:USDC, priceSource:new MapPriceSource([])}
      expect((await valueMovements(options)).valued).toBe(1)
      expect((await valueMovements(options)).valued).toBe(0)
      const lots = await costBasis({store,tenantId:T,asset:USDC,account:ACCOUNT})
      expect(lots.openLots[0]!.remainingCost.raw).toBe(m.amount.raw)
      const aging = await agingReport({store,tenantId:T,asOf:new Date('2030-01-01')})
      expect(aging.unexplainedMoney.items[0]!.amount.raw).toBe(m.amount.raw)
    })

    it('refuses movement balance adjustments even when racing reconciliation', async () => {
      const m = await movement()
      const [manual] = await Promise.allSettled([
        postManualEntry({store,tenantId:T,description:'Invalid write-off',reason:'test',lines:[
          {account:'liabilities:unapplied-receipts',role:'unapplied',side:'debit',amount:m.amount},
          {account:'income:uncategorized',role:'uncategorized_income',side:'credit',amount:m.amount},
        ]}),
        reconcile({store,tenantId:T}),
      ])
      expect(manual.status).toBe('rejected')
      expect(await store.listJournalEntries({tenantId:T,movementId:m.id})).toHaveLength(1)
    })

    it('refuses to post the same cash twice, even with the right posting number', async () => {
      const m = await movement()
      await store.transaction((tx) => tx.postJournalEntry(entry(m, { postingNo: 1 })))
      await expect(store.transaction((tx) => tx.postJournalEntry(entry(m, { postingNo: 2 })))).rejects.toMatchObject(
        constraint('journal_cash_mismatch'),
      )
      expect(await store.listJournalEntries({ tenantId: T, movementId: m.id })).toHaveLength(1)
    })
  })
}
