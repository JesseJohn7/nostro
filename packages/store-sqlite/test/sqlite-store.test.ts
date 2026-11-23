import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'
import { Money, NATIVE, STORE_CONTRACT_VERSION, doctor } from '@nostro-labs/nostro'
import { describeStoreConformance, describeStoreProperties } from '@nostro-labs/store-conformance'
import { SqliteStore, registerJournalFunctions } from '../src/index.js'
import { MIGRATIONS } from '../src/schema.js'

const dir = mkdtempSync(join(tmpdir(), 'nostro-sqlite-'))
let files = 0
const freshFile = () => join(dir, `store-${++files}.db`)

async function freshStore(filename = freshFile()): Promise<SqliteStore> {
  const store = new SqliteStore({ filename })
  await store.migrate()
  return store
}

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describeStoreConformance('SqliteStore', () => freshStore(), { contractVersion: STORE_CONTRACT_VERSION })
describeStoreProperties(
  'SqliteStore',
  async (now) => {
    const store = new SqliteStore({ filename: freshFile(), now })
    await store.migrate()
    return store
  },
  { contractVersion: STORE_CONTRACT_VERSION, runs: 25, differential: true },
)

/** A store file holding one movement and its initial journal entry. */
async function journaled(): Promise<string> {
  const filename = freshFile()
  const store = await freshStore(filename)
  const { inserted } = await store.transaction((tx) =>
    tx.insertMovements([
      {
        tenantId: 't',
        network: 'testnet',
        source: 'horizon',
        externalId: 'e1',
        account: `G${'A'.repeat(55)}`,
        direction: 'credit',
        kind: 'transfer',
        amount: Money.parse('10', NATIVE),
        ledger: 1,
        occurredAt: new Date('2026-10-05T00:00:00Z'),
      },
    ]),
  )
  const m = inserted[0]!
  await store.transaction((tx) =>
    tx.postJournalEntry({
      tenantId: 't',
      movementId: m.id,
      postingNo: 1,
      kind: 'initial',
      description: 'Received 10 XLM',
      lines: [
        { account: 'cash', role: 'cash', side: 'debit', amount: m.amount },
        { account: 'unapplied', role: 'unapplied', side: 'credit', amount: m.amount },
      ],
    }),
  )
  await store.close()
  return filename
}

interface RawLine {
  readonly side: 'debit' | 'credit'
  readonly amount: string
  readonly role?: string
  readonly asset?: string
  readonly decimals?: number
}

function rawDatabase(filename: string, register = true): Database.Database {
  const db = new Database(filename)
  if (register) registerJournalFunctions(db)
  return db
}

function rawEntry(db: Database.Database, id: string, lines: readonly RawLine[], movementId: string | null = null): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const [i, line] of lines.entries()) {
      db.prepare(
        `INSERT INTO journal_lines (entry_id, line_no, tenant_id, account, role, side, asset, decimals, amount)
         VALUES (?, ?, 't', 'x', ?, ?, ?, ?, ?)`,
      ).run(
        id,
        i + 1,
        line.role ?? 'other',
        line.side,
        line.asset ?? 'native',
        line.decimals ?? 7,
        line.amount,
      )
    }
    db.prepare(
      `INSERT INTO journal_entries (id, tenant_id, movement_id, posting_no, kind, effective_at, posted_at, description)
       VALUES (?, 't', ?, ?, 'reclass', 0, 0, 'raw')`,
    ).run(id, movementId, movementId === null ? null : 2)
    db.exec('COMMIT')
  } catch (err) {
    if (db.inTransaction) db.exec('ROLLBACK')
    throw err
  }
}

function movementOf(db: Database.Database): { id: string; asset: string; decimals: number } {
  return db.prepare('SELECT id, asset, decimals FROM movements LIMIT 1').get() as {
    id: string
    asset: string
    decimals: number
  }
}

function legacyJournal(filename: string, balanced: boolean): void {
  const db = new Database(filename)
  for (const migration of MIGRATIONS.slice(0, 14)) db.exec(migration)
  db.prepare(
    `INSERT INTO movements (id, tenant_id, network, source, external_id, revision, account, direction, kind,
       asset, decimals, amount, ledger, occurred_at, enrichment, disposition, created_at)
     VALUES ('m1', 't', 'testnet', 'horizon', 'e1', 1, 'G', 'credit', 'transfer', 'native', 7, '10', 1, 0, 'complete', 'pending', 0)`,
  ).run()
  db.prepare(
    `INSERT INTO journal_entries (id, tenant_id, movement_id, posting_no, kind, effective_at, posted_at, description)
     VALUES ('legacy', 't', 'm1', 1, 'initial', 0, 0, 'legacy')`,
  ).run()
  db.prepare(
    `INSERT INTO journal_lines (entry_id, line_no, tenant_id, account, role, side, asset, decimals, amount)
     VALUES ('legacy', 1, 't', 'cash', 'cash', 'debit', 'native', 7, '10')`,
  ).run()
  db.prepare(
    `INSERT INTO journal_lines (entry_id, line_no, tenant_id, account, role, side, asset, decimals, amount)
     VALUES ('legacy', 2, 't', 'unapplied', 'unapplied', 'credit', 'native', 7, ?)`,
  ).run(balanced ? '10' : '9')
  db.pragma('user_version = 14')
  db.close()
}

describe('SqliteStore', () => {
  it('refuses an in-memory database, which a second connection could not share', () => {
    for (const filename of ['', ':memory:', 'file::memory:?cache=shared']) {
      expect(() => new SqliteStore({ filename })).toThrow(/needs a database file/)
    }
  })

  it('migrates idempotently and records the schema version', async () => {
    const filename = freshFile()
    const store = new SqliteStore({ filename })
    expect(await store.schemaVersion()).toEqual({ current: 0, latest: MIGRATIONS.length })
    await store.migrate()
    await store.migrate()
    expect(await store.schemaVersion()).toEqual({ current: MIGRATIONS.length, latest: MIGRATIONS.length })
    await store.close()
    const db = new Database(filename, { readonly: true })
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    db.close()
  })

  it('keeps amounts exact beyond 64 bits', async () => {
    const store = await freshStore()
    const e = await store.transaction((tx) =>
      tx.insertExpectation({
        tenantId: 't',
        reference: 'R',
        account: `G${'A'.repeat(55)}`,
        amount: Money.fromRaw(2n ** 100n + 7n, NATIVE),
      }),
    )
    expect((await store.getExpectation('t', e.id))!.amount.raw).toBe(2n ** 100n + 7n)
    await store.close()
  })

  it('enforces positive integer amounts in the database too, not only in code', async () => {
    const filename = freshFile()
    const store = await freshStore(filename)
    await store.close()
    const db = new Database(filename)
    for (const amount of ['0', '-5', '1.5', '007', '12a']) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO expectations (id, tenant_id, reference, account, direction, asset, decimals, amount,
               payers, status, metadata, created_at, updated_at)
             VALUES (?, 't', ?, 'a', 'credit', 'native', 7, ?, '[]', 'open', '{}', 0, 0)`,
          )
          .run(`x${amount}`, `r${amount}`, amount),
      ).toThrow(/CHECK constraint/)
    }
    db.close()
  })

  it('refuses to edit or delete posted journal entries', async () => {
    const filename = await journaled()
    const db = new Database(filename)
    for (const sql of [
      "UPDATE journal_entries SET description = 'edited'",
      'DELETE FROM journal_entries',
      "UPDATE journal_lines SET amount = '1'",
      'DELETE FROM journal_lines',
    ]) {
      expect(() => db.prepare(sql).run()).toThrow(/append-only/)
    }
    db.close()
  })

  it('doctor() reports unbalanced data written with the checks removed', async () => {
    const filename = await journaled()
    const db = new Database(filename)
    db.exec('DROP TRIGGER journal_lines_checked')
    db.prepare(
      `INSERT INTO journal_lines (entry_id, line_no, tenant_id, account, role, side, asset, decimals, amount)
       VALUES ((SELECT id FROM journal_entries), 3, 't', 'cash', 'cash', 'debit', 'native', 7, '1')`,
    ).run()
    db.close()
    const store = await freshStore(filename)
    const report = await doctor({ store, tenantId: 't' })
    expect(report.ok).toBe(false)
    expect(report.findings).toEqual([expect.objectContaining({ invariant: 'I3', code: 'journal_unbalanced' })])
    await store.close()
  })

  it('upgrades a version 1 database with data to the latest version', async () => {
    const filename = freshFile()
    const db = new Database(filename)
    db.exec(MIGRATIONS[0]!)
    db.prepare('INSERT INTO cursors(tenant_id,network,source,account,value) VALUES (?,?,?,?,?)').run('t','n','s','a','kept')
    db.pragma('user_version = 1')
    db.close()
    const upgraded = await freshStore(filename)
    expect(await upgraded.getCursor({ tenantId: 't', network: 'n', source: 's', account: 'a' })).toBe('kept')
    expect(await upgraded.listJournalEntries({ tenantId: 't' })).toEqual([])
    expect(await upgraded.listEvents({ tenantId: 't' })).toEqual([])
    await upgraded.close()
  })

  it('migrates a v6 database with duplicate muxed ids and refuses later duplicates', async () => {
    const filename = freshFile()
    const insertSql = `INSERT INTO expectations (id, tenant_id, reference, account, direction, asset, decimals, amount, muxed_id, payers, status, metadata, created_at, updated_at)
      VALUES (?, 't', ?, 'G${'A'.repeat(55)}', 'credit', 'native', 7, '1', '7', '[]', 'open', '{}', 0, 0)`

    const v6 = new Database(filename)
    for (const migration of MIGRATIONS.slice(0, 6)) v6.exec(migration)
    v6.pragma('user_version = 6')
    v6.prepare(insertSql).run('e1', 'r1')
    v6.prepare(insertSql).run('e2', 'r2')
    v6.close()

    const store = await freshStore(filename)
    expect(await store.schemaVersion()).toEqual({ current: MIGRATIONS.length, latest: MIGRATIONS.length })
    expect((await doctor({ store, tenantId: 't' })).findings).toEqual([
      expect.objectContaining({ code: 'muxed_id_duplicate' }),
    ])
    await store.transaction((tx) =>
      tx.amendExpectation('t', 'e1', { memo: { type: 'text', value: 'still here' } }, 'legacy duplicate'),
    )
    await store.close()

    const raw = new Database(filename)
    expect(() => raw.prepare(insertSql).run('e3', 'r3')).toThrow(/muxed id already used on account/)
    raw.close()
  })

  it('backfills the text-memo index when upgrading a database with existing rows', async () => {
    const filename = freshFile()
    const db = new Database(filename)
    for (const migration of MIGRATIONS.slice(0,5)) db.exec(migration)
    db.prepare(`INSERT INTO expectations(id,tenant_id,reference,account,direction,asset,decimals,amount,memo_type,memo_text,payers,status,metadata,created_at,updated_at)
      VALUES ('legacy','t','INV-9',?,'credit','native',7,'100000000','text',?,'[]','open','{}',0,0)`)
      .run(`G${'A'.repeat(55)}`, Buffer.from('REF-8'))
    db.pragma('user_version = 5')
    db.close()
    const e = { id: 'legacy' }
    const upgraded = await freshStore(filename)
    const ids = async (key: string) => (await upgraded.getExpectationsByNormalizedReference('t', key)).map((x) => x.id)
    expect(await ids('9')).toEqual([e.id])
    expect(await ids('8')).toEqual([e.id])
    expect(await ids('')).toEqual([])
    await upgraded.close()
  })

  it('sees committed data across separate store instances on one file', async () => {
    const filename = freshFile()
    const a = await freshStore(filename)
    const b = new SqliteStore({ filename })
    await a.transaction((tx) => tx.setCursor({ tenantId: 't', network: 'n', source: 's', account: 'x' }, '42'))
    expect(await b.getCursor({ tenantId: 't', network: 'n', source: 's', account: 'x' })).toBe('42')
    await a.close()
    await b.close()
  })

  it('refuses an unbalanced entry written with raw SQL', async () => {
    const filename = await journaled()
    const db = rawDatabase(filename)
    expect(() =>
      rawEntry(db, 'raw-unbalanced', [
        { side: 'debit', amount: '10' },
        { side: 'credit', amount: '9' },
      ]),
    ).toThrow(/does not balance/)
    expect(() => rawEntry(db, 'raw-single', [{ side: 'debit', amount: '1' }])).toThrow(/fewer than two lines/)
    expect(db.prepare("SELECT 1 FROM journal_entries WHERE id = 'raw-unbalanced'").get()).toBeUndefined()
    db.close()
  })

  it('sums journal amounts exactly beyond 64 bits', async () => {
    const filename = await journaled()
    const db = rawDatabase(filename)
    const big = 2n ** 64n + 100n
    rawEntry(db, 'raw-huge', [
      { side: 'debit', amount: big.toString() },
      { side: 'credit', amount: (2n ** 64n).toString() },
      { side: 'credit', amount: '100' },
    ])
    const net = db
      .prepare("SELECT nostra_signed_sum(side, amount) AS net FROM journal_lines WHERE entry_id = 'raw-huge'")
      .get() as { net: string }
    expect(net.net).toBe('0')
    db.close()
  })

  it('refuses a raw entry whose cash leg disagrees with the movement', async () => {
    const filename = await journaled()
    const db = rawDatabase(filename)
    const m = movementOf(db)
    expect(() =>
      rawEntry(
        db,
        'raw-cash',
        [
          { side: 'credit', amount: '5', role: 'cash', asset: m.asset, decimals: m.decimals },
          { side: 'debit', amount: '5', role: 'unapplied', asset: m.asset, decimals: m.decimals },
        ],
        m.id,
      ),
    ).toThrow(/cash leg/)
    db.close()
  })

  it('fails closed for a raw client without the journal aggregates', async () => {
    const filename = await journaled()
    const db = rawDatabase(filename, false)
    expect(() =>
      rawEntry(db, 'raw-no-functions', [
        { side: 'debit', amount: '1' },
        { side: 'credit', amount: '1' },
      ]),
    ).toThrow(/nostro_signed_sum/)
    db.close()
  })

  it('migrates version 14 data that satisfies the journal rules', async () => {
    const filename = freshFile()
    legacyJournal(filename, true)
    const store = await freshStore(filename)
    expect(await store.schemaVersion()).toEqual({ current: MIGRATIONS.length, latest: MIGRATIONS.length })
    expect((await store.listJournalEntries({ tenantId: 't' })).map((e) => e.id)).toEqual(['legacy'])
    await store.close()
  })

  it('refuses to migrate version 14 data with an unbalanced entry', async () => {
    const filename = freshFile()
    legacyJournal(filename, false)
    const store = new SqliteStore({ filename })
    await expect(store.migrate()).rejects.toThrow(/legacy/)
    await store.close()
    const db = new Database(filename, { readonly: true })
    expect(db.pragma('user_version', { simple: true })).toBe(14)
    db.close()
  })
})
