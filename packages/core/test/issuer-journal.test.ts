import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FixtureSource } from 'nostro-testkit'
import type { HorizonOperation } from '../src/index.js'
import type { Movement, NewJournalEntry, NewMovement, Store } from '../src/index.js'
import { MemoryStore, Money, asset, doctor, postJournal, reconcile } from '../src/index.js'

const T = 'issuer'
const pubnet = new URL('../../../fixtures/horizon/pubnet/', import.meta.url)
const testnet = new URL('../../../fixtures/horizon/testnet/', import.meta.url)
const load = (dir: URL, name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`${name}.json`, dir)), 'utf8')) as {
    operation: HorizonOperation
  }
const source = (dir: URL, name: string) => new FixtureSource({ fixture: new URL(`${name}.json`, dir) })

async function record(store: Store, movements: readonly NewMovement[]): Promise<Movement> {
  const { inserted } = await store.transaction((tx) => tx.insertMovements(movements))
  return inserted[0]!
}

function roles(entry: { lines: readonly { role: string; side: string }[] }): [string, string][] {
  return entry.lines.map((line) => [line.role, line.side])
}

async function entryFor(store: Store, movementId: string) {
  const [entry] = await store.listJournalEntries({ tenantId: T, movementId })
  if (entry === undefined) throw new Error(`no journal entry for ${movementId}`)
  return entry
}

describe('issuer journal postings from real records', () => {
  it('posts both sides of a mint through deposits received', async () => {
    const fixture = load(pubnet, 'payment-hash-memo')
    const replay = source(pubnet, 'payment-hash-memo')
    const op = replay.movementsFor(T, fixture.operation.from!)
    const holder = replay.movementsFor(T, fixture.operation.to!)
    expect(op[0]?.kind).toBe('mint')
    expect(holder[0]?.kind).toBe('mint')
    const store = new MemoryStore()
    const issuerMovement = await record(store, op)
    const holderMovement = await record(store, holder)
    await reconcile({ store, tenantId: T })
    const issuer = await entryFor(store, issuerMovement.id)
    const customer = await entryFor(store, holderMovement.id)
    expect(roles(issuer)).toEqual([['issued', 'credit'], ['deposit_clearing', 'debit']])
    expect(roles(customer)).toEqual([['cash', 'debit'], ['deposit_clearing', 'credit']])
    expect((await doctor({ store, tenantId: T })).findings).toEqual([])
  })

  it('posts both sides of a burn through redemptions payable', async () => {
    const fixture = load(pubnet, 'burn-to-issuer')
    const replay = source(pubnet, 'burn-to-issuer')
    const holder = replay.movementsFor(T, fixture.operation.from!)
    const issuer = replay.movementsFor(T, fixture.operation.to!)
    expect(holder[0]?.kind).toBe('burn')
    expect(issuer[0]?.kind).toBe('burn')
    const store = new MemoryStore()
    const holderMovement = await record(store, holder)
    const issuerMovement = await record(store, issuer)
    await reconcile({ store, tenantId: T })
    const customer = await entryFor(store, holderMovement.id)
    const own = await entryFor(store, issuerMovement.id)
    expect(roles(customer)).toEqual([['cash', 'credit'], ['redemption_payable', 'debit']])
    expect(roles(own)).toEqual([['issued', 'debit'], ['redemption_payable', 'credit']])
    expect((await doctor({ store, tenantId: T })).findings).toEqual([])
  })

  it('auto-ignores and posts both sides of a real clawback', async () => {
    const fixture = load(testnet, 'clawback-eurox')
    const replay = source(testnet, 'clawback-eurox')
    const holder = replay.movementsFor(T, fixture.operation.from!)
    const issuer = replay.movementsFor(T, fixture.operation.source_account!)
    expect(holder[0]?.kind).toBe('clawback')
    expect(issuer[0]?.kind).toBe('clawback')
    const store = new MemoryStore()
    const holderMovement = await record(store, holder)
    const issuerMovement = await record(store, issuer)
    const report = await reconcile({ store, tenantId: T })
    expect(report.ignored).toBe(2)
    expect(report.exceptions).toEqual({})
    const customer = await entryFor(store, holderMovement.id)
    const own = await entryFor(store, issuerMovement.id)
    expect(roles(customer)).toEqual([['cash', 'credit'], ['clawback', 'debit']])
    expect(roles(own)).toEqual([['issued', 'debit'], ['clawback', 'credit']])
    expect((await doctor({ store, tenantId: T })).findings).toEqual([])
  })

  it('reclasses old suspense and unapplied postings without touching cash', async () => {
    const fixture = load(pubnet, 'burn-to-issuer')
    const replay = source(pubnet, 'burn-to-issuer')
    const movement = replay.movementsFor(T, fixture.operation.from!)[0]!
    const store = new MemoryStore()
    const recorded = await record(store, [movement])
    await store.transaction((tx) => tx.setDisposition(T, recorded.id, 'ignored', 'legacy posting'))
    const old: NewJournalEntry = {
      tenantId: T,
      movementId: recorded.id,
      postingNo: 1,
      kind: 'initial',
      effectiveAt: recorded.occurredAt,
      description: 'Sent 399981.68 USDC',
      lines: [
        { account: `assets:stellar:public:${recorded.account}`, role: 'cash', side: 'credit', amount: recorded.amount },
        { account: 'assets:suspense', role: 'unexplained', side: 'debit', amount: recorded.amount },
      ],
    }
    await store.transaction((tx) => tx.postJournalEntry(old))
    const first = await postJournal({ store, tenantId: T })
    expect(first.posted.reclass).toBe(1)
    const second = await postJournal({ store, tenantId: T })
    expect(second.posted.reclass).toBe(0)
    const entries = await store.listJournalEntries({ tenantId: T, movementId: recorded.id })
    expect(roles(entries[1]!)).toEqual([['redemption_payable', 'debit'], ['unexplained', 'credit']])
    expect(entries[1]!.lines.some((line) => line.role === 'cash')).toBe(false)
    expect((await doctor({ store, tenantId: T })).findings).toEqual([])
  })

  it('refuses movement-only roles in manual entries', async () => {
    const store = new MemoryStore()
    const USDC = asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
    const amount = Money.parse('1', USDC)
    await expect(
      store.transaction((tx) =>
        tx.postJournalEntry({
          tenantId: T,
          kind: 'manual',
          description: 'Not a chain fact',
          lines: [
            { account: 'liabilities:deposits-received', role: 'deposit_clearing', side: 'debit', amount },
            { account: 'equity:adjustments', role: 'other', side: 'credit', amount },
          ],
        }),
      ),
    ).rejects.toMatchObject({ constraint: 'journal_manual_slot' })
  })
})
