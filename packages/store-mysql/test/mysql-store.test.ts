import { randomUUID } from 'node:crypto'
import mysql from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2'
import { afterAll, describe, expect, it } from 'vitest'
import type { StoreTx } from '@nostro-labs/nostro'
import { Money, NATIVE } from '@nostro-labs/nostro'
import { describeStoreConformance, describeStoreProperties } from '@nostro-labs/store-conformance'
import { MysqlStore, STORE_CONTRACT_VERSION } from '../src/index.js'
import { MIGRATIONS } from '../src/schema.js'

const url = process.env.NOSTRO_TEST_MYSQL_DATABASE_URL
if (url === undefined && process.env.CI !== undefined) {
  throw new Error('NOSTRO_TEST_MYSQL_DATABASE_URL must be set in CI; the MySQL store would go untested.')
}

const admin = url === undefined ? undefined : mysql.createPool(url)
const databases: string[] = []
const stores: MysqlStore[] = []

const quote = (name: string) => `\`${name}\``

async function freshStore(options: { now?: () => Date } = {}): Promise<MysqlStore> {
  const database = `nostro_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  databases.push(database)
  await admin!.query(`CREATE DATABASE ${quote(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`)
  const store = new MysqlStore({
    connectionString: url!,
    database,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  stores.push(store)
  await store.migrate()
  // MySQL slows down as databases pile up, and each open pool holds connections.
  const close = store.close.bind(store)
  store.close = async () => {
    await close()
    await admin!.query(`DROP DATABASE IF EXISTS ${quote(database)}`)
  }
  return store
}

afterAll(async () => {
  for (const store of stores) await store.close().catch(() => undefined)
  if (admin === undefined) return
  for (const database of new Set(databases)) {
    await admin.query(`DROP DATABASE IF EXISTS ${quote(database)}`).catch(() => undefined)
  }
  await admin.end()
}, 300_000)

if (admin === undefined) {
  describe.skip('MysqlStore (set NOSTRO_TEST_MYSQL_DATABASE_URL to run)', () => {
    it('conformance', () => {})
  })
} else {
  describeStoreConformance('MysqlStore', () => freshStore(), { contractVersion: STORE_CONTRACT_VERSION })
  describeStoreProperties('MysqlStore', (now: () => Date) => freshStore({ now }), {
    runs: 15,
    differential: true,
    contractVersion: STORE_CONTRACT_VERSION,
  })

  describe('MysqlStore', () => {
    it('migrates idempotently, even when several processes migrate at once', async () => {
      const database = `nostro_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      databases.push(database)
      await admin.query(`CREATE DATABASE ${quote(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`)
      const open = () => {
        const store = new MysqlStore({ connectionString: url!, database })
        stores.push(store)
        return store
      }
      await Promise.all([open(), open(), open()].map((store) => store.migrate()))
      await open().migrate()
      const [rows] = await admin.query<RowDataPacket[]>(
        `SELECT version FROM ${quote(database)}.migrations ORDER BY version`,
      )
      expect(rows.map((r) => Number(r.version))).toEqual(Array.from({ length: MIGRATIONS.length }, (_, i) => i + 1))
    })

    it('reports the schema version without changing it', async () => {
      const database = `nostro_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      databases.push(database)
      await admin.query(`CREATE DATABASE ${quote(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`)
      const store = new MysqlStore({ connectionString: url!, database })
      stores.push(store)
      expect(await store.schemaVersion()).toEqual({ current: 0, latest: MIGRATIONS.length })
      await store.migrate()
      expect(await store.schemaVersion()).toEqual({ current: MIGRATIONS.length, latest: MIGRATIONS.length })
      await admin.query(`DELETE FROM ${quote(database)}.migrations WHERE version >= 3`)
      expect(await store.schemaVersion()).toEqual({ current: 2, latest: MIGRATIONS.length })
    })

    it('commits events in seq order, so a reader after a seq can never miss one', async () => {
      const store = await freshStore()
      const open = (tenantId: string, detail: string) => (tx: StoreTx) =>
        tx.openException({ tenantId, code: 'MEMO_MISSING', account: `G${'A'.repeat(55)}`, detail })
      let release!: () => void
      const held = new Promise<void>((r) => (release = r))
      let written!: () => void
      const emitted = new Promise<void>((r) => (written = r))
      const slow = store.transaction(async (tx) => {
        await open('t', 'first')(tx)
        written()
        await held
      })
      await emitted
      let fastDone = false
      const fast = store.transaction(open('t', 'second')).then(() => (fastDone = true))
      await store.transaction(open('u', 'elsewhere'))
      await new Promise((r) => setTimeout(r, 200))
      expect(fastDone).toBe(false)
      expect(await store.listEvents({ tenantId: 't' })).toEqual([])
      release()
      await Promise.all([slow, fast])
      const events = await store.listEvents({ tenantId: 't' })
      expect(events.map((e) => (e.payload as { exception: { detail: string } }).exception.detail)).toEqual(['first', 'second'])
      expect(events[0]!.seq).toBeLessThan(events[1]!.seq)
    })

    it('refuses to edit or delete posted events', async () => {
      const store = await freshStore()
      const database = (store as unknown as { database: string }).database
      await store.transaction((tx) =>
        tx.openException({ tenantId: 't', code: 'MEMO_MISSING', account: `G${'A'.repeat(55)}`, detail: 'no memo' }),
      )
      await expect(admin!.query(`UPDATE ${quote(database)}.events SET payload = '{}'`)).rejects.toThrow(/append-only/)
      await expect(admin!.query(`DELETE FROM ${quote(database)}.events`)).rejects.toThrow(/append-only/)
      expect(await store.listEvents({ tenantId: 't' })).toHaveLength(1)
    })

    it('preserves NUL bytes in a text memo', async () => {
      const store = await freshStore()
      const memo = { type: 'text' as const, value: `a\u0000b\u0001c` }
      const { inserted } = await store.transaction((tx) =>
        tx.insertMovements([{
          tenantId: 't',
          network: 'testnet',
          source: 'horizon',
          externalId: 'nul-1',
          account: `G${'A'.repeat(55)}`,
          direction: 'credit',
          kind: 'transfer',
          amount: Money.parse('10', NATIVE),
          ledger: 1,
          occurredAt: new Date('2026-10-05T00:00:00Z'),
          memo,
        }]),
      )
      expect(inserted).toHaveLength(1)
      expect((await store.getMovement('t', inserted[0]!.id))!.memo).toEqual(memo)
    })

    it('keeps amounts exact beyond 64 bits', async () => {
      const store = await freshStore()
      const huge = Money.fromRaw(2n ** 100n + 7n, NATIVE)
      const e = await store.transaction((tx) =>
        tx.insertExpectation({ tenantId: 't', reference: 'R', account: `G${'A'.repeat(55)}`, amount: huge }),
      )
      expect((await store.getExpectation('t', e.id))!.amount.raw).toBe(2n ** 100n + 7n)
    })

    it('rejects a database name that is not a plain identifier', () => {
      expect(() => new MysqlStore({ connectionString: url!, database: 'x`; DROP DATABASE y; --' })).toThrow(/Invalid database name/)
      expect(() => new MysqlStore({})).toThrow(/needs a pool or a connectionString/)
    })
  })
}
