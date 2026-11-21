import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MapPriceSource, Money, NATIVE, postManualEntry, reconcile, valueMovements } from '@nostro-labs/nostro'
import { SqliteStore } from '@nostro-labs/store-sqlite'
import { A, migrated, nostro } from './helpers.js'

async function reportingBooks() {
  const cwd = await migrated()
  const store = new SqliteStore({ filename: join(cwd, 'nostro.db') })
  await store.transaction(async tx => {
    await tx.insertExpectation({tenantId:'default', account:A, reference:'=SUM(1)', amount:Money.parse('9',NATIVE), dueAt:new Date('2026-10-01')})
    await tx.insertExpectation({tenantId:'default', account:A, reference:'PAY-1', direction:'debit', amount:Money.parse('6',NATIVE)})
    await tx.insertMovements([
      {tenantId:'default', account:A, network:'testnet', source:'fixture', externalId:'in', direction:'credit', kind:'transfer', amount:Money.parse('25',NATIVE), occurredAt:new Date('2026-10-05'), ledger:1},
      {tenantId:'default', account:A, network:'testnet', source:'fixture', externalId:'out', direction:'debit', kind:'transfer', amount:Money.parse('5',NATIVE), occurredAt:new Date('2026-10-06'), ledger:2},
      {tenantId:'default', account:A, network:'testnet', source:'fixture', externalId:'fee', direction:'debit', kind:'fee', amount:Money.fromRaw(100n,NATIVE), occurredAt:new Date('2026-10-06'), ledger:2},
    ])
  })
  await reconcile({store,tenantId:'default'})
  await postManualEntry({store,tenantId:'default',description:'Earned income',reason:'Verified',lines:[
    {account:'assets:adjustments',role:'other',side:'debit',amount:Money.parse('2',NATIVE)},
    {account:'income:other',role:'uncategorized_income',side:'credit',amount:Money.parse('2',NATIVE)},
  ]})
  await valueMovements({store,tenantId:'default',reportingAsset:NATIVE,priceSource:new MapPriceSource([])})
  await store.close()
  return cwd
}

describe('accounting reports through the CLI', () => {
  it('reports the same balances in readable tables and JSON', async () => {
    const cwd = await reportingBooks()
    const commands = [
      ['trial-balance'], ['ledger','--account',`assets:stellar:testnet:${A}`,'--asset','native'],
      ['balance-sheet'], ['income'], ['aging','--as-of','2030-01-01','--buckets','15,30,90'],
      ['gains','--asset','native','--account',A,'--from','2026-10-01','--to','2030-01-01'],
    ]
    for (const command of commands) {
      const table = await nostro(cwd,['report',...command])
      expect(table.code,table.stderr).toBe(0)
      expect(table.stdout.length).toBeGreaterThan(20)
      const output = await nostro(cwd,['report',...command,'--json'])
      expect(output.code,output.stderr).toBe(0)
      const report = JSON.parse(output.stdout)
      if (command[0] === 'trial-balance') expect(report).toMatchObject({balanced:true,assetTotals:[{asset:'native',net:'0'}]})
      if (command[0] === 'ledger') expect(report.closingBalance).toBe('199999900')
      if (command[0] === 'balance-sheet') expect(report.balanced).toBe(true)
      if (command[0] === 'income') expect(report.netResult).toEqual([{asset:'native',amount:'19999900'}])
      if (command[0] === 'aging') {
        expect(report.receivables.items[0].remainingAmount).toBe('9.0000000')
        expect(report.payables.items[0].remainingAmount).toBe('6.0000000')
        expect(report.unexplainedMoney.items).toHaveLength(2)
      }
      if (command[0] === 'gains') expect(report).toMatchObject({realizedGain:'0.0000000',totalCost:'5.0000100',unvaluedCredits:0})
    }
    const csv = await nostro(cwd,['report','aging','--as-of','2030-01-01','--csv'])
    expect(csv.code).toBe(0)
    expect(csv.stdout).toContain("'=SUM(1)")
    expect(csv.stdout).toContain('payable,')
    expect(csv.stdout).toContain('unexplained,')
  })

  it('handles empty reports and validates required report arguments', async () => {
    const cwd = await migrated()
    for (const command of [['aging'],['gains','--asset','native'],['ledger','--account','empty','--asset','native']]) {
      expect((await nostro(cwd,['report',...command])).code).toBe(0)
    }
    for (const command of [['unknown'],['ledger'],['ledger','--account','x'],['gains'],['aging','--buckets','oops']]) {
      expect((await nostro(cwd,['report',...command])).code).toBe(2)
    }
  })

  it('moves an expense account once and retains a balanced ledger', async () => {
    const cwd = await reportingBooks()
    expect(JSON.parse((await nostro(cwd,['chart','move','--from','expenses:network-fees','--to','expenses:fees','--json'])).stdout)).toEqual({moved:1,assets:['native']})
    expect((await nostro(cwd,['chart','move','--from','expenses:network-fees','--to','expenses:fees'])).stdout).toContain('Nothing to move')
    expect((await nostro(cwd,['chart','move','--from','expenses:fees','--to','expenses:final-fees'])).stdout).toContain('Moved 1 balance')
    for (const command of [['bad'],['move'],['move','--from','x']]) expect((await nostro(cwd,['chart',...command])).code).toBe(2)
  })

  it('prunes an old event prefix once and validates the cutoff', async () => {
    const cwd = await reportingBooks()
    for (const extra of [[],['--json']]) {
      const result = await nostro(cwd,['prune-events','--older-than','2030-01-01T00:00:00Z',...extra])
      expect(result.code,result.stderr).toBe(0)
      if (extra.length) expect(JSON.parse(result.stdout).deleted).toBe(0)
      else expect(result.stdout).toMatch(/Pruned [1-9][0-9]* event/ )
    }
    expect((await nostro(cwd,['prune-events'])).code).toBe(2)
    expect((await nostro(cwd,['prune-events','--older-than','invalid'])).code).toBe(2)
  })
})
