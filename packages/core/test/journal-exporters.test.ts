import { describe, expect, it } from 'vitest'
import {
  MemoryStore,
  Money,
  asset,
  journalBeancountRows,
  journalQuickBooksRows,
  journalXeroRows,
  reconcile,
} from '../src/index.js'
import type { NewMovement } from '../src/index.js'

const T = 'acme'
const ACCOUNT = `G${'A'.repeat(55)}`
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const SECOND_ISSUER = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW'
const USDC = asset('USDC', ISSUER)
const SECOND_USDC = asset('USDC', SECOND_ISSUER)
const usdc = (value: string) => Money.parse(value, USDC)

async function collect(rows: AsyncGenerator<string>): Promise<string> {
  let out = ''
  for await (const row of rows) out += row
  return out
}

async function manualEntry(store: MemoryStore, amount: Money, accounts = [
  'assets:stellar:testnet:wallet',
  'liabilities:unapplied-receipts',
]): Promise<void> {
  await store.transaction((tx) =>
    tx.postJournalEntry({
      tenantId: T,
      kind: 'manual',
      effectiveAt: new Date('2026-10-05T12:00:00Z'),
      description: 'Move "held" funds',
      lines: [
        { account: accounts[0]!, role: 'unapplied', side: 'debit', amount },
        { account: accounts[1]!, role: 'uncategorized_expense', side: 'credit', amount },
      ],
    }),
  )
}

describe('journal import formats', () => {
  it('uses mapped QuickBooks and Xero accounts and exact debit/credit cells', async () => {
    const store = new MemoryStore()
    await manualEntry(store, usdc('12.50'))
    const accountMap = {
      'assets:stellar:testnet:wallet': 'Bank Checking',
      'liabilities:unapplied-receipts': 'Unapplied Receipts',
    }

    const quickbooks = await collect(journalQuickBooksRows({ store, tenantId: T, accountMap }))
    expect(quickbooks).toContain('Journal No.,Journal Date,Account Name,Debits,Credits,Description\r\n')
    expect(quickbooks).toContain(`,2026-10-05,Bank Checking,12.5000000,,\"Move \"\"held\"\" funds\"\r\n`)
    expect(quickbooks).toContain(',2026-10-05,Unapplied Receipts,,12.5000000,')

    const xero = await collect(journalXeroRows({ store, tenantId: T, accountMap }))
    expect(xero).toContain('Narration,Date,AccountCode,Description,TaxRate,Debit,Credit\r\n')
    expect(xero).toContain(',2026-10-05,Bank Checking,')
    expect(xero).toContain(',No Tax,12.5000000,')
  })

  it('refuses missing account mappings and mixed-asset exports without writing partial rows', async () => {
    const store = new MemoryStore()
    await manualEntry(store, usdc('1'))
    await manualEntry(store, Money.parse('1', SECOND_USDC))
    const partial: string[] = []
    const exportRows = async () => {
      for await (const row of journalQuickBooksRows({
        store,
        tenantId: T,
        accountMap: {
          'assets:stellar:testnet:wallet': 'Bank',
          'liabilities:unapplied-receipts': 'Unapplied',
        },
      })) partial.push(row)
    }
    await expect(exportRows()).rejects.toThrow('multiple assets')
    expect(partial).toEqual([])

    await expect(
      collect(journalXeroRows({ store, tenantId: T, accountMap: { 'assets:stellar:testnet:wallet': 'Bank' } })),
    ).rejects.toThrow('No Xero account mapping')
  })

  it('writes Beancount opens, exact amounts, transaction metadata and expectation references', async () => {
    const store = new MemoryStore()
    const movement: NewMovement = {
      tenantId: T,
      network: 'testnet',
      source: 'horizon',
      externalId: 'beancount-movement',
      account: ACCOUNT,
      direction: 'credit',
      kind: 'transfer',
      amount: Money.fromRaw(2n ** 70n + 1n, USDC, 18),
      memo: { type: 'text', value: 'INV-BC' },
      ledger: 123,
      txHash: 'ab'.repeat(32),
      occurredAt: new Date('2026-10-05T12:00:00Z'),
    }
    await store.transaction(async (tx) => {
      await tx.insertExpectation({
        tenantId: T,
        reference: 'INV-BC',
        account: ACCOUNT,
        amount: movement.amount,
      })
      await tx.insertMovements([movement])
    })
    await reconcile({ store, tenantId: T })
    const ledger = await collect(
      journalBeancountRows({
        store,
        tenantId: T,
        commodityMap: { [USDC]: 'USDCISSUERA' },
      }),
    )
    expect(ledger).toContain('2026-10-05 open Assets:Stellar:Testnet:')
    expect(ledger).toContain('  movement_id: "')
    expect(ledger).toContain(`  tx_hash: "${movement.txHash}"`)
    expect(ledger).toContain('  Assets:Stellar:Testnet:')
    expect(ledger).toContain(` ${movement.amount.toString()} USDCISSUERA\n`)
    expect(ledger).toContain('    expectation_reference: "INV-BC"')
  })

  it('does not merge two issuers into one Beancount commodity', async () => {
    const store = new MemoryStore()
    await manualEntry(store, usdc('1'))
    await manualEntry(store, Money.parse('1', SECOND_USDC))
    await expect(
      collect(
        journalBeancountRows({
          store,
          tenantId: T,
          commodityMap: { [USDC]: 'USDC', [SECOND_USDC]: 'USDC' },
        }),
      ),
    ).rejects.toThrow('cannot share commodity USDC')
  })
})
