import { describe, expect, it } from 'vitest'
import {
  MemoryStore,
  Money,
  NATIVE,
  allocationFromJson,
  allocationJson,
  exceptionFromJson,
  exceptionJson,
  expectationFromJson,
  expectationJson,
  journalEntryFromJson,
  journalEntryJson,
  moneyFromJson,
  movementFromJson,
  movementJson,
  reconcile,
  scheduleFromJson,
  scheduleJson,
} from '@nostro-labs/nostro'

const A = 'G' + 'A'.repeat(55)
const B = 'G' + 'B'.repeat(55)
const at = new Date('2026-01-01T00:00:00.000Z')

describe('JSON wire format round trips', () => {
  it('infers decimals and keeps every digit beyond 2^64', () => {
    const exact = '18446744073709551616.0000123'
    const money = moneyFromJson(exact, NATIVE)
    expect(money).toBeInstanceOf(Money)
    expect(money.toString()).toBe(exact)
    expect(moneyFromJson('25', NATIVE).toString()).toBe('25')
  })

  it('round-trips every *Json function through its *FromJson counterpart', async () => {
    const store = new MemoryStore()
    await store.transaction(async (tx) => {
      await tx.insertExpectation({
        tenantId: 't',
        reference: 'INV-1',
        account: A,
        amount: Money.parse('25.5', NATIVE),
        memo: { type: 'id', value: 123n },
        payers: [B],
        dueAt: at,
        metadata: { invoice: '1' },
      })
      await tx.insertMovements([
        {
          tenantId: 't', network: 'testnet', source: 'x', externalId: '1', account: A,
          direction: 'credit', kind: 'transfer', amount: Money.parse('25.5', NATIVE),
          muxedId: 456n, memo: { type: 'text', value: 'INV-1' }, ledger: 1, occurredAt: at,
        },
        {
          tenantId: 't', network: 'testnet', source: 'x', externalId: '2', account: A,
          direction: 'credit', kind: 'transfer', amount: Money.parse('5', NATIVE),
          ledger: 1, occurredAt: at,
        },
      ])
      await tx.insertSchedule({
        tenantId: 't', referencePattern: 'REC-{n}', account: A,
        amount: Money.parse('25.5', NATIVE), cadence: { type: 'daily' },
        memo: { type: 'text', value: 'recurring' }, payers: [B], startAt: at,
      })
    })
    await reconcile({ store, tenantId: 't' })

    const movement = (await store.listMovements({ tenantId: 't' }))[0]!
    const movementWire = movementJson(movement)
    const movementBack = movementFromJson(movementWire, 't')
    expect(movementBack.amount).toBeInstanceOf(Money)
    expect(movementBack.amount.equals(movement.amount)).toBe(true)
    expect(movementBack.occurredAt).toBeInstanceOf(Date)
    expect(movementBack.occurredAt.toISOString()).toBe(movementWire.occurredAt)
    expect(movementBack.muxedId).toBe(456n)
    expect(movementBack.memo).toEqual({ type: 'text', value: 'INV-1' })
    expect(movementJson(movementBack)).toEqual(movementWire)

    const expectation = (await store.listExpectations({ tenantId: 't' }))[0]!
    const expectationWire = expectationJson(expectation)
    const expectationBack = expectationFromJson(expectationWire, 't')
    expect(expectationBack.amount.equals(expectation.amount)).toBe(true)
    expect(expectationBack.memo).toEqual({ type: 'id', value: 123n })
    expect(expectationBack.dueAt).toBeInstanceOf(Date)
    expect(expectationJson(expectationBack)).toEqual(expectationWire)

    const allocation = (await store.listAllocations({ tenantId: 't' }))[0]!
    const allocationWire = allocationJson(allocation)
    const allocationBack = allocationFromJson(allocationWire, 't')
    expect(allocationBack.amount.equals(allocation.amount)).toBe(true)
    expect(allocationJson(allocationBack)).toEqual(allocationWire)

    const exception = (await store.listExceptions({ tenantId: 't' }))[0]!
    const exceptionWire = exceptionJson(exception)
    const exceptionBack = exceptionFromJson(exceptionWire, 't')
    expect(exceptionBack.amount?.equals(exception.amount!)).toBe(true)
    expect(exceptionBack.openedAt.toISOString()).toBe(exceptionWire.openedAt)
    expect(exceptionJson(exceptionBack)).toEqual(exceptionWire)

    const entry = (await store.listJournalEntries({ tenantId: 't' }))[0]!
    const entryWire = journalEntryJson(entry)
    const entryBack = journalEntryFromJson(entryWire, 't')
    expect(entryBack.lines[0]!.amount.equals(entry.lines[0]!.amount)).toBe(true)
    expect(entryBack.effectiveAt.toISOString()).toBe(entryWire.effectiveAt)
    expect(journalEntryJson(entryBack)).toEqual(entryWire)

    const schedule = (await store.listSchedules({ tenantId: 't' }))[0]!
    const scheduleWire = scheduleJson(schedule)
    const scheduleBack = scheduleFromJson(scheduleWire, 't')
    expect(scheduleBack.amount.equals(schedule.amount)).toBe(true)
    expect(scheduleBack.startAt.toISOString()).toBe(scheduleWire.startAt)
    expect(scheduleJson(scheduleBack)).toEqual(scheduleWire)
  })
})
