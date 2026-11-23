import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { NewMovement } from '../src/index.js'
import {
  ALLOCATION_CSV_COLUMNS,
  EXPECTATION_CSV_COLUMNS,
  EXCEPTION_CSV_COLUMNS,
  MOVEMENT_CSV_COLUMNS,
  MemoryStore,
  Money,
  allocationCsvRows,
  asset,
  exceptionCsvRows,
  expectationCsvRows,
  movementCsvRows,
  reconcile,
} from '../src/index.js'

const T = 'acme'
const ACCOUNT = `G${'A'.repeat(55)}`
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const USDC = asset('USDC', ISSUER)
const usdc = (v: string) => Money.parse(v, USDC)
const FORMULA_REF = '=INVOICE,"Q3"\r\nsecond'
const FORMULA_MEMO = '=CMD,"x"\r\ny'

let n = 0
function payment(over: Partial<NewMovement> = {}): NewMovement {
  n += 1
  return {
    tenantId: T,
    network: 'testnet',
    source: 'horizon',
    externalId: `effect-${n}`,
    account: ACCOUNT,
    direction: 'credit',
    kind: 'transfer',
    amount: usdc('10'),
    ledger: 1000 + n,
    txHash: 'ab'.repeat(32),
    occurredAt: new Date('2026-10-05T12:00:00Z'),
    ...over,
  }
}

async function collect(rows: AsyncGenerator<string>): Promise<string> {
  let out = ''
  for await (const row of rows) out += row
  return out
}

function parse(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]!
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\r' && csv[i + 1] === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      i++
    } else cell += c
  }
  return rows
}

function records(csv: string) {
  const [header, ...rows] = parse(csv)
  return rows.map((r) => Object.fromEntries(header!.map((h, i) => [h, r[i]!])))
}

async function books(): Promise<MemoryStore> {
  const store = new MemoryStore()
  await store.transaction((tx) =>
    tx.insertExpectation({ tenantId: T, reference: 'INV-1', account: ACCOUNT, amount: usdc('25') }),
  )
  await store.transaction((tx) =>
    tx.insertExpectation({ tenantId: T, reference: FORMULA_REF, account: ACCOUNT, amount: usdc('1') }),
  )
  await store.transaction((tx) =>
    tx.insertMovements([
      payment({ amount: usdc('25'), memo: { type: 'text', value: 'INV-1' } }),
      payment({ amount: usdc('10'), memo: { type: 'text', value: FORMULA_MEMO } }),
    ]),
  )
  await reconcile({ store, tenantId: T })
  return store
}

describe('record CSV exports', () => {
  it('keeps the column layout in a golden fixture', () => {
    const golden = readFileSync(new URL('./record-csv-headers.golden', import.meta.url), 'utf8').trimEnd().split('\n')
    expect(golden).toEqual([
      MOVEMENT_CSV_COLUMNS.join(','),
      EXPECTATION_CSV_COLUMNS.join(','),
      EXCEPTION_CSV_COLUMNS.join(','),
      ALLOCATION_CSV_COLUMNS.join(','),
    ])
  })

  it('streams movements across pages, omitting and guarding memos', async () => {
    const store = await books()
    const csv = await collect(movementCsvRows({ store, tenantId: T, pageSize: 1 }))
    const rows = records(csv)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.amount)).toEqual(['25.0000000', '10.0000000'])
    expect(csv).not.toContain(FORMULA_MEMO)

    const withMemo = records(await collect(movementCsvRows({ store, tenantId: T, pageSize: 1, includeMemo: true })))
    expect(withMemo[1]!.memo_value).toBe(`'${FORMULA_MEMO}`)
    expect(withMemo[1]!.memo_type).toBe('text')
  })

  it('writes amount paid and outstanding from allocations', async () => {
    const rows = records(await collect(expectationCsvRows({ store: await books(), tenantId: T, pageSize: 1 })))
    expect(rows).toHaveLength(2)
    const paid = rows.find((r) => r.reference === 'INV-1')!
    expect([paid.amount, paid.amount_paid, paid.amount_outstanding, paid.asset]).toEqual([
      '25.0000000',
      '25.0000000',
      '0.0000000',
      USDC,
    ])
    const guarded = rows.find((r) => r.reference === `'${FORMULA_REF}`)!
    expect(guarded.amount_outstanding).toBe('1.0000000')
    expect(guarded.reference).toContain('\r\n')
  })

  it('writes exceptions with their amount and asset', async () => {
    const rows = records(await collect(exceptionCsvRows({ store: await books(), tenantId: T, pageSize: 1 })))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => r.amount === '10.0000000' && r.asset === USDC)).toBe(true)
    expect(rows.every((r) => r.detail !== '')).toBe(true)
  })

  it('writes allocations without adding a seq column', async () => {
    const rows = records(await collect(allocationCsvRows({ store: await books(), tenantId: T })))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ amount: '25.0000000', asset: USDC, strategy: expect.any(String) })
  })

  it('keeps amounts above 2^64 exact while filtering by occurredAt across pages', async () => {
    const store = new MemoryStore()
    const huge = Money.fromRaw(2n ** 70n + 1n, USDC, 18)
    await store.transaction((tx) =>
      tx.insertMovements([
        payment({ amount: huge, occurredAt: new Date('2026-10-05T12:00:00Z') }),
        payment({ occurredAt: new Date('2026-11-01T00:00:00Z') }),
      ]),
    )
    const rows = records(
      await collect(movementCsvRows({
        store,
        tenantId: T,
        pageSize: 1,
        from: new Date('2026-10-01T00:00:00Z'),
        to: new Date('2026-11-01T00:00:00Z'),
      })),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.amount).toBe(huge.toString())
    expect(rows[0]!.amount).toBe('1180.591620717411303425')
  })
})
