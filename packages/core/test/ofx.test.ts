import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Movement, NewMovement } from '../src/index.js'
import { MemoryStore, Money, NATIVE, ValidationError, asset } from '../src/index.js'
import { isIso4217, renderOfx, walletStatement } from '../src/journal/ofx.js'

const T = 'acme'
const CASH = `assets:stellar:testnet:${'G'.repeat(56)}`
const ACCOUNT = `G${'A'.repeat(55)}`
const COUNTERPARTY = `G${'B'.repeat(55)}`
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const USDC = asset('USDC', ISSUER)
const HASH = 'cd'.repeat(32)
const PAYER_MEMO = 'Payer wrote THIS-SHOULD-NOT-APPEAR'
const FROM = new Date('2026-10-01T00:00:00Z')
const TO = new Date('2026-11-01T00:00:00Z')
const FIXED_NOW = new Date('2026-10-01T01:00:00Z')
const usdc = (value: string) => Money.parse(value, USDC)

function makeStore(): MemoryStore {
  let next = 0
  return new MemoryStore({ ids: () => `id-${++next}`, now: () => FIXED_NOW })
}

function movement(externalId: string, over: Partial<NewMovement> = {}): NewMovement {
  return {
    tenantId: T,
    network: 'testnet',
    source: 'horizon',
    externalId,
    account: ACCOUNT,
    direction: 'credit',
    kind: 'transfer',
    amount: usdc('1'),
    counterparty: COUNTERPARTY,
    memo: { type: 'text', value: PAYER_MEMO },
    ledger: 1,
    txHash: HASH,
    occurredAt: new Date('2026-10-05T12:00:00Z'),
    ...over,
  }
}

function postCash(
  store: MemoryStore,
  m: Movement,
  effectiveAt: Date,
  value: string,
  side: 'debit' | 'credit',
  description: string,
  expectationId: string | null = null,
  postingNo = 1,
) {
  const amount = usdc(value)
  return store.transaction((tx) =>
    tx.postJournalEntry({
      tenantId: T,
      movementId: m.id,
      postingNo,
      kind: 'initial',
      effectiveAt,
      description,
      lines: [
        { account: CASH, role: 'cash', side, amount, expectationId },
        {
          account: 'liabilities:unapplied-receipts',
          role: 'unapplied',
          side: side === 'debit' ? 'credit' : 'debit',
          amount,
        },
      ],
    }),
  )
}

function expectedFitId(entryId: string, lineNo: number): string {
  return createHash('sha256').update([T, CASH, USDC, entryId, String(lineNo)].join('\u0000')).digest('hex')
}

async function buildJournal(): Promise<{ store: MemoryStore; incomingEntryId: string; outgoingEntryId: string }> {
  const store = makeStore()
  const expectation = await store.transaction((tx) =>
    tx.insertExpectation({
      tenantId: T,
      reference: 'INV-63',
      account: ACCOUNT,
      direction: 'credit',
      amount: usdc('3.25'),
    }),
  )
  const [opening, incoming, outgoing, boundary] = (await store.transaction((tx) =>
    tx.insertMovements([
      movement('opening', { amount: usdc('5'), occurredAt: new Date('2026-09-30T23:59:59Z'), txHash: null, counterparty: null }),
      movement('incoming', { amount: usdc('12.5') }),
      movement('outgoing', {
        amount: usdc('3.25'),
        direction: 'debit',
        occurredAt: new Date('2026-10-10T08:30:00Z'),
        txHash: null,
        counterparty: null,
      }),
      movement('boundary', { amount: usdc('100'), occurredAt: TO }),
    ]),
  )).inserted

  const incomingEntry = await postCash(
    store,
    incoming!,
    new Date('2026-10-05T12:00:00Z'),
    '12.5',
    'debit',
    'Settlement ]]> INV-63',
  )
  const outgoingEntry = await postCash(
    store,
    outgoing!,
    new Date('2026-10-10T08:30:00Z'),
    '3.25',
    'credit',
    'Payout for INV-63',
    expectation.id,
  )
  await postCash(store, opening!, new Date('2026-09-30T23:59:59Z'), '5', 'debit', 'Opening receipt')
  await postCash(store, boundary!, TO, '100', 'debit', 'At exclusive end')

  await store.transaction((tx) =>
    tx.postJournalEntry({
      tenantId: T,
      movementId: incoming!.id,
      postingNo: 2,
      kind: 'reclass',
      effectiveAt: new Date('2026-10-06T12:00:00Z'),
      description: 'Reclass that must be ignored',
      lines: [
        { account: CASH, role: 'other', side: 'debit', amount: usdc('7') },
        { account: 'liabilities:unapplied-receipts', role: 'unapplied', side: 'credit', amount: usdc('7') },
      ],
    }),
  )

  return { store, incomingEntryId: incomingEntry.id, outgoingEntryId: outgoingEntry.id }
}

describe('walletStatement and renderOfx', () => {
  it('recognises ISO 4217 currency codes', () => {
    expect(isIso4217('USD')).toBe(true)
    expect(isIso4217('XLM')).toBe(false)
    expect(isIso4217('USDC')).toBe(false)
    expect(isIso4217('ZZZ')).toBe(false)
    expect(isIso4217('usd')).toBe(false)
    expect(isIso4217('')).toBe(false)
  })

  it('requires an explicit currency for native and non-ISO assets', async () => {
    const store = makeStore()
    const base = { store, tenantId: T, account: CASH, from: FROM, to: TO } as const
    await expect(walletStatement({ ...base, asset: NATIVE })).rejects.toThrow(ValidationError)
    await expect(walletStatement({ ...base, asset: USDC })).rejects.toThrow(/currencyCode/)
    await expect(walletStatement({ ...base, asset: USDC, currencyCode: 'XLM' })).rejects.toThrow(ValidationError)
    await expect(walletStatement({ ...base, asset: NATIVE, currencyCode: 'USD' })).resolves.toMatchObject({ currencyCode: 'USD' })
  })

  it('builds an exact signed, paged statement and renders stable OFX', async () => {
    const { store, incomingEntryId, outgoingEntryId } = await buildJournal()
    const options = { store, tenantId: T, account: CASH, asset: USDC, from: FROM, to: TO, currencyCode: 'USD', pageSize: 1 } as const
    const statement = await walletStatement(options)
    const again = await walletStatement(options)

    expect(statement.openingBalance.toString()).toBe('5.0000000')
    expect(statement.closingBalance.toString()).toBe('14.2500000')
    expect(statement.lines.map((line) => [
      line.amount.toString(),
      line.direction,
      line.counterparty,
      line.txHash,
      line.expectationReference,
      line.description,
    ])).toEqual([
      ['12.5000000', 'credit', COUNTERPARTY, HASH, null, 'Settlement ]]> INV-63'],
      ['-3.2500000', 'debit', null, null, 'INV-63', 'Payout for INV-63'],
    ])
    expect(statement.lines[0]!.id).toBe(expectedFitId(incomingEntryId, 1))
    expect(statement.lines[1]!.id).toBe(expectedFitId(outgoingEntryId, 1))
    expect(again.lines.map((line) => line.id)).toEqual(statement.lines.map((line) => line.id))

    const ofx = renderOfx(statement)
    expect(ofx).toBe(renderOfx(again))
    expect(ofx.startsWith('OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:202\r\n')).toBe(true)
    expect(ofx.endsWith('\r\n')).toBe(true)
    expect(ofx.replaceAll('\r\n', '')).not.toContain('\n')
    expect(ofx).toContain('<CURDEF>USD\r\n')
    expect(ofx).toContain('<BANKID>NOSTRO\r\n')
    expect(ofx).toContain(`<ACCTID>${CASH}\r\n`)
    expect(ofx).toContain('<TRNTYPE>CREDIT\r\n')
    expect(ofx).toContain('<TRNTYPE>DEBIT\r\n')
    expect(ofx).toContain('<DTPOSTED>20261005120000.000\r\n')
    expect(ofx).toContain('<DTPOSTED>20261010083000.000\r\n')
    expect(ofx).toContain('<TRNAMT>12.5000000\r\n')
    expect(ofx).toContain('<TRNAMT>-3.2500000\r\n')
    expect(ofx).toContain(`<FITID>${statement.lines[0]!.id}\r\n`)
    expect(ofx).toContain(`<CHECKNUM>${HASH}\r\n`)
    expect(ofx).toContain('<CHECKNUM>INV-63\r\n')
    expect(ofx).toContain(`<NAME><![CDATA[${COUNTERPARTY}]]>\r\n`)
    expect(ofx).toContain('<NAME><![CDATA[NOSTRO]]>\r\n')
    expect(ofx).toContain('<MEMO><![CDATA[Settlement ]]]]><![CDATA[> INV-63]]>\r\n')
    expect(ofx).toContain('<BALAMT>14.2500000\r\n')
    expect(ofx).toContain('<BALDT>20261101000000.000\r\n')
    expect(ofx).not.toContain(PAYER_MEMO)
    expect(ofx).not.toContain('Reclass')
    expect(ofx).not.toContain('At exclusive end')
  })

  it('uses the asset decimals for a zero balance when the journal is empty', async () => {
    const statement = await walletStatement({
      store: makeStore(),
      tenantId: T,
      account: CASH,
      asset: USDC,
      from: FROM,
      to: TO,
      currencyCode: 'USD',
    })
    expect(statement.openingBalance.toString()).toBe('0.0000000')
    expect(statement.closingBalance.toString()).toBe('0.0000000')
    expect(statement.lines).toEqual([])
  })
})
