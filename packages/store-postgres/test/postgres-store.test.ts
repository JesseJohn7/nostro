/**
 * Runs the shared Store conformance suite against a real PostgreSQL.
 *
 * Set NOSTRO_TEST_DATABASE_URL to a database the tests may create schemas
 * in; each test gets a fresh schema, dropped afterwards. Without it the suite
 * is skipped locally and fails in CI.
 */
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StoreTx } from '@nostro-labs/nostro'
import { Money, NATIVE, doctor } from '@nostro-labs/nostro'
import { describeStoreConformance, describeStoreProperties } from '@nostro-labs/store-conformance'
import { PostgresStore, STORE_CONTRACT_VERSION } from '../src/index.js'
import type { PostgresRlsOptions } from '../src/index.js'
import { MIGRATIONS, quoteSchema } from '../src/schema.js'

const url = process.env.NOSTRO_TEST_DATABASE_URL
if (url === undefined && process.env.CI !== undefined) {
  throw new Error('NOSTRO_TEST_DATABASE_URL must be set in CI; the Postgres store would go untested.')
}

const pool = url === undefined ? undefined : new pg.Pool({ connectionString: url, max: 20 })
const schemas: string[] = []
const appRole = `nostro_rls_${randomUUID().replaceAll('-', '')}`
const quotedRole = `"${appRole}"`

async function freshStore(options: { schema?: string; now?: () => Date; rls?: PostgresRlsOptions } = {}): Promise<PostgresStore> {
  const schema = options.schema ?? `nostro_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  schemas.push(schema)
  const store = new PostgresStore({
    pool: pool!,
    schema,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.rls === undefined ? {} : { rls: options.rls }),
  })
  await store.migrate()
  if (options.rls?.enabled === true) {
    await pool!.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${quotedRole}`)
    await pool!.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${quotedRole}`)
    await pool!.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO ${quotedRole}`)
  }
  return store
}

if (pool !== undefined) {
  beforeAll(async () => {
    await pool!.query(`CREATE ROLE ${quotedRole} NOLOGIN NOBYPASSRLS`)
  })
}

afterAll(async () => {
  if (pool === undefined) return
  await pool.query(`DROP OWNED BY ${quotedRole} CASCADE`).catch(() => undefined)
  await pool.query(`DROP ROLE IF EXISTS ${quotedRole}`).catch(() => undefined)
  for (const schema of new Set(schemas)) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await pool.end()
}, 300_000) // the property tests make a schema per history

if (pool === undefined) {
  describe.skip('PostgresStore (set NOSTRO_TEST_DATABASE_URL to run)', () => {
    it('conformance', () => {})
  })
} else {
  describeStoreConformance('PostgresStore', () => freshStore(), { contractVersion: STORE_CONTRACT_VERSION })
  describeStoreProperties('PostgresStore', (now) => freshStore({ now }), {
    runs: 15,
    differential: true,
    contractVersion: STORE_CONTRACT_VERSION,
  })
  describeStoreConformance('PostgresStore (RLS)', () => freshStore({ rls: { enabled: true, appRole } }), {
    contractVersion: STORE_CONTRACT_VERSION,
  })

  describe('PostgresStore', () => {
    it('migrates idempotently, even when several processes migrate at once', async () => {
      const schema = `nostro_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      await Promise.all([1, 2, 3].map(() => freshStore({ schema })))
      await freshStore({ schema })
      const { rows } = await pool.query(`SELECT version FROM "${schema}".migrations ORDER BY version`)
      expect(rows.map((r) => r.version)).toEqual(Array.from({ length: MIGRATIONS.length }, (_, i) => i + 1))
    })

    it('reports the schema version without changing it', async () => {
      const schema = `nostro_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      schemas.push(schema)
      const store = new PostgresStore({ pool: pool!, schema })
      expect(await store.schemaVersion()).toEqual({ current: 0, latest: MIGRATIONS.length })
      expect(await store.schemaVersion()).toEqual({ current: 0, latest: MIGRATIONS.length })
      await store.migrate()
      expect(await store.schemaVersion()).toEqual({ current: MIGRATIONS.length, latest: MIGRATIONS.length })
      await pool.query(`DELETE FROM "${schema}".migrations WHERE version >= 3`)
      expect(await store.schemaVersion()).toEqual({ current: 2, latest: MIGRATIONS.length })
    })

    it('migrates a version 5 database with duplicate muxed ids and refuses later duplicates', async () => {
      const schema = `nostro_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      schemas.push(schema)
      const s = quoteSchema(schema)
      const account = `G${'A'.repeat(55)}`
      const rawExpectation = (id: string, reference: string) =>
        `INSERT INTO ${s}.expectations (id, tenant_id, reference, account, direction, asset, decimals, amount,
           muxed_id, payers, status, metadata, created_at, updated_at)
         VALUES ('${id}', 't', '${reference}', '${account}', 'credit', 'native', 7, '1', '7', '{}', 'open', '{}', now(), now())`

      const client = await pool!.connect()
      try {
        await client.query(`CREATE SCHEMA ${s}`)
        await client.query(
          `CREATE TABLE ${s}.migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
        )
        await client.query('BEGIN')
        for (const migration of MIGRATIONS.slice(0, 5)) await client.query(migration(s))
        for (let version = 1; version <= 5; version++) {
          await client.query(`INSERT INTO ${s}.migrations (version) VALUES ($1)`, [version])
        }
        await client.query(rawExpectation('e1', 'r1'))
        await client.query(rawExpectation('e2', 'r2'))
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw err
      } finally {
        client.release()
      }

      const store = new PostgresStore({ pool: pool!, schema })
      await store.migrate()
      expect(await store.schemaVersion()).toEqual({ current: MIGRATIONS.length, latest: MIGRATIONS.length })
      expect((await doctor({ store, tenantId: 't' })).findings).toEqual([
        expect.objectContaining({ code: 'muxed_id_duplicate' }),
      ])
      await store.transaction((tx) =>
        tx.amendExpectation('t', 'e1', { memo: { type: 'text', value: 'still here' } }, 'legacy duplicate'),
      )
      await expect(pool!.query(rawExpectation('e3', 'r3'))).rejects.toThrow(/muxed id.*already used on account/)
    })

    it('gives two concurrent writers issuing muxed ids distinct ids', async () => {
      const store = await freshStore()
      const account = `G${'A'.repeat(55)}`
      const issue = (reference: string) =>
        store.transaction((tx) =>
          tx.insertExpectation({ tenantId: 't', reference, account, amount: Money.parse('1', NATIVE), muxedId: 'issue' }),
        )
      const [a, b] = await Promise.all([issue('r1'), issue('r2')])
      expect(a.muxedId).not.toBeNull()
      expect(b.muxedId).not.toBeNull()
      expect(a.muxedId).not.toEqual(b.muxedId)
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
      // Another tenant's events do not wait.
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

    it('keeps amounts exact beyond 64 bits', async () => {
      const store = await freshStore()
      const huge = Money.fromRaw(2n ** 100n + 7n, NATIVE)
      const e = await store.transaction((tx) =>
        tx.insertExpectation({ tenantId: 't', reference: 'R', account: `G${'A'.repeat(55)}`, amount: huge }),
      )
      expect((await store.getExpectation('t', e.id))!.amount.raw).toBe(2n ** 100n + 7n)
    })

    it('applies the RLS migration to a database that already holds a valid journal', async () => {
      const schema = `nostro_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      schemas.push(schema)
      const s = quoteSchema(schema)
      const client = await pool!.connect()
      try {
        await client.query(`CREATE SCHEMA ${s}`)
        await client.query(`CREATE TABLE ${s}.migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`)
        await client.query('BEGIN')
        for (const [index, migration] of MIGRATIONS.slice(0, -1).entries()) {
          await client.query(migration(s))
          await client.query(`INSERT INTO ${s}.migrations (version) VALUES ($1)`, [index + 1])
        }
        await client.query(
          `INSERT INTO ${s}.movements
             (id, tenant_id, network, source, external_id, revision, account, direction, kind, asset,
              decimals, amount, ledger, occurred_at, enrichment, disposition, created_at)
           VALUES ('m', 't', 'testnet', 'horizon', 'e', 1, 'G${'A'.repeat(55)}', 'credit', 'transfer', 'native',
             7, '10.0000000', 1, now(), 'complete', 'pending', now())`,
        )
        await client.query(
          `INSERT INTO ${s}.journal_entries (id, tenant_id, movement_id, posting_no, kind, effective_at, posted_at, description)
           VALUES ('e', 't', 'm', 1, 'initial', now(), now(), 'valid')`,
        )
        await client.query(
          `INSERT INTO ${s}.journal_lines (entry_id, line_no, tenant_id, account, role, side, asset, decimals, amount)
           VALUES ('e', 1, 't', 'cash', 'cash', 'debit', 'native', 7, '10.0000000'),
                  ('e', 2, 't', 'unapplied', 'unapplied', 'credit', 'native', 7, '10.0000000')`,
        )
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw err
      } finally {
        client.release()
      }

      const store = new PostgresStore({ pool: pool!, schema })
      expect((await store.schemaVersion()).current).toBe(MIGRATIONS.length - 1)
      await store.migrate()
      expect(await store.schemaVersion()).toEqual({ current: MIGRATIONS.length, latest: MIGRATIONS.length })
      const check = await pool!.connect()
      try {
        await check.query(`SELECT set_config('nostro.tenant', 't', false)`)
        const { rows } = await check.query<{ id: string }>(`SELECT id FROM ${s}.journal_entries`)
        expect(rows.map((row) => row.id)).toEqual(['e'])
        const { rows: rls } = await check.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '${s}.journal_entries'::regclass`,
        )
        expect(rls[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true })
      } finally {
        check.release()
      }
    })

    it('isolates tenants when RLS is enabled', async () => {
      const store = await freshStore({ rls: { enabled: true, appRole } })
      const s = quoteSchema(schemas[schemas.length - 1]!)
      const seedMovement = (id: string, tenantId: string) =>
        `INSERT INTO ${s}.movements
           (id, tenant_id, network, source, external_id, revision, account, direction, kind, asset,
            decimals, amount, ledger, occurred_at, enrichment, disposition, created_at)
         VALUES ('${id}', '${tenantId}', 'testnet', 'horizon', '${id}', 1, 'G${'A'.repeat(55)}',
           'credit', 'transfer', 'native', 7, '1.0000000', 1, now(), 'complete', 'pending', now())`
      const seed = await pool!.connect()
      try {
        await seed.query(`SELECT set_config('nostro.migrate_bypass', 'on', false)`)
        await seed.query(seedMovement('m-t', 't'))
        await seed.query(seedMovement('m-u', 'u'))
      } finally {
        seed.release()
      }

      const app = await pool!.connect()
      try {
        await app.query(`SET LOCAL ROLE ${quotedRole}`)
        await app.query(`SELECT set_config('nostro.tenant', 't', true)`)
        const { rows } = await app.query<{ id: string }>(`SELECT id FROM ${s}.movements ORDER BY id`)
        expect(rows.map((row) => row.id)).toEqual(['m-t'])
        await expect(app.query(seedMovement('bad', 'u'))).rejects.toThrow(/row-level security/)
      } finally {
        app.release()
      }

      expect(await store.forTenant('t').getMovement('m-t')).not.toBeNull()
      expect(await store.forTenant('t').getMovement('m-u')).toBeNull()
      await expect(store.transaction('t', async (tx) => {
        await tx.getMovement('t', 'm-t')
        await tx.getMovement('u', 'm-u')
      })).rejects.toThrow(/pinned to tenant/)
    })

    it('enforces the hard constraints in the database too, not only in code', async () => {
      const store = await freshStore()
      const s = schemas[schemas.length - 1]!
      await expect(
        pool.query(
          `INSERT INTO "${s}".expectations (id, tenant_id, reference, account, direction, asset, decimals,
             amount, payers, status, metadata, created_at, updated_at)
           VALUES ('x', 't', 'r', 'a', 'credit', 'native', 7, 0, '{}', 'open', '{}', now(), now())`,
        ),
      ).rejects.toThrow(/check constraint/)
      expect(await store.listExpectations({ tenantId: 't' })).toEqual([])
    })

    it('reports a reference taken by a concurrent transaction, and leaves this one usable', async () => {
      const store = await freshStore()
      const insert = (tx: Parameters<Parameters<PostgresStore['transaction']>[0]>[0]) =>
        tx.insertExpectation({ tenantId: 't', reference: 'INV-RACE', account: `G${'A'.repeat(55)}`, amount: Money.parse('1', NATIVE) })
      let release!: () => void
      const held = new Promise<void>((r) => (release = r))
      const first = store.transaction(async (tx) => {
        await insert(tx)
        await held // keep the row uncommitted while the second transaction tries
      })
      await new Promise((r) => setTimeout(r, 50))
      const second = store.transaction(async (tx) => {
        // The pre-check cannot see the uncommitted row; the unique index must catch it.
        const attempt = insert(tx).catch((e: unknown) => e)
        setTimeout(release, 50)
        const err = await attempt
        await tx.setCursor({ tenantId: 't', network: 'n', source: 's', account: 'a' }, 'still-usable')
        return err
      })
      await first
      expect(await second).toMatchObject({ name: 'ConstraintError', constraint: 'expectation_reference_unique' })
      expect(await store.getCursor({ tenantId: 't', network: 'n', source: 's', account: 'a' })).toBe('still-usable')
    })

    describe('journal, enforced by the database itself', () => {
      /** A store with one movement, and the schema it lives in. */
      async function withMovement() {
        const store = await freshStore()
        const s = `"${schemas[schemas.length - 1]!}"`
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
        return { store, s, movement: inserted[0]! }
      }
      const rawEntry = async (client: pg.PoolClient, s: string, lines: [string, string][]) => {
        await client.query(
          `INSERT INTO ${s}.journal_entries (id, tenant_id, kind, effective_at, posted_at, description)
           VALUES ('raw', 't', 'reclass', now(), now(), 'raw')`,
        )
        for (const [i, [side, amount]] of lines.entries()) {
          await client.query(
            `INSERT INTO ${s}.journal_lines (entry_id, line_no, tenant_id, account, role, side, asset, decimals, amount)
             VALUES ('raw', $1, 't', 'x', 'unapplied', $2, 'native', 7, $3)`,
            [i + 1, side, amount],
          )
        }
      }

      it('refuses an unbalanced entry at COMMIT, even written with raw SQL', async () => {
        const { s } = await withMovement()
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          await rawEntry(client, s, [
            ['debit', '10'],
            ['credit', '9'],
          ])
          await expect(client.query('COMMIT')).rejects.toThrow(/does not balance/)
        } finally {
          client.release()
        }
        const one = await pool.connect()
        try {
          await one.query('BEGIN')
          await rawEntry(one, s, [['debit', '10']])
          await expect(one.query('COMMIT')).rejects.toThrow(/fewer than two lines/)
        } finally {
          one.release()
        }
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${s}.journal_entries`)
        expect(rows[0].n).toBe(0)
      })

      it('refuses a cash leg that disagrees with the movement, even written with raw SQL', async () => {
        const { s, movement } = await withMovement()
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          await client.query(
            `INSERT INTO ${s}.journal_entries (id, tenant_id, movement_id, posting_no, kind, effective_at, posted_at, description)
             VALUES ('cash-raw', 't', $1, 1, 'initial', now(), now(), 'raw cash')`,
            [movement.id],
          )
          await client.query(
            `INSERT INTO ${s}.journal_lines (entry_id, line_no, tenant_id, account, role, side, asset, decimals, amount)
             VALUES ('cash-raw', 1, 't', 'cash', 'cash', 'debit', 'native', 7, '9.0000000')`,
          )
          await client.query(
            `INSERT INTO ${s}.journal_lines (entry_id, line_no, tenant_id, account, role, side, asset, decimals, amount)
             VALUES ('cash-raw', 2, 't', 'unapplied', 'unapplied', 'credit', 'native', 7, '9.0000000')`,
          )
          await expect(client.query('COMMIT')).rejects.toThrow(/cash leg nets to/)
        } finally {
          client.release()
        }
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${s}.journal_entries`)
        expect(rows[0].n).toBe(0)
      })

      it('checks the cash leg exactly beyond 64 bits', async () => {
        const store = await freshStore()
        const s = `"${schemas[schemas.length - 1]!}"`
        const raw = 2n ** 100n + 7n
        const amount = Money.fromRaw(raw, NATIVE)
        const { inserted } = await store.transaction((tx) =>
          tx.insertMovements([
            {
              tenantId: 't',
              network: 'testnet',
              source: 'horizon',
              externalId: 'huge',
              account: `G${'A'.repeat(55)}`,
              direction: 'credit',
              kind: 'transfer',
              amount,
              ledger: 1,
              occurredAt: new Date('2026-10-05T00:00:00Z'),
            },
          ]),
        )
        const movement = inserted[0]!
        await store.transaction((tx) =>
          tx.postJournalEntry({
            tenantId: 't',
            movementId: movement.id,
            postingNo: 1,
            kind: 'initial',
            description: 'Huge receipt',
            lines: [
              { account: 'cash', role: 'cash', side: 'debit', amount },
              { account: 'unapplied', role: 'unapplied', side: 'credit', amount },
            ],
          }),
        )
        expect(await store.listJournalEntries({ tenantId: 't' })).toHaveLength(1)

        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          await client.query(
            `INSERT INTO ${s}.journal_entries (id, tenant_id, movement_id, posting_no, kind, effective_at, posted_at, description)
             VALUES ('huge-raw', 't', $1, 2, 'correction', now(), now(), 'off by one')`,
            [movement.id],
          )
          await client.query(
            `INSERT INTO ${s}.journal_lines (entry_id, line_no, tenant_id, account, role, side, asset, decimals, amount)
             VALUES ('huge-raw', 1, 't', 'cash', 'cash', 'debit', 'native', 7, $1)`,
            [(raw - 1n).toString()],
          )
          await client.query(
            `INSERT INTO ${s}.journal_lines (entry_id, line_no, tenant_id, account, role, side, asset, decimals, amount)
             VALUES ('huge-raw', 2, 't', 'unapplied', 'unapplied', 'credit', 'native', 7, $1)`,
            [(raw - 1n).toString()],
          )
          await expect(client.query('COMMIT')).rejects.toThrow(/cash leg nets to/)
        } finally {
          client.release()
        }
        expect(await store.listJournalEntries({ tenantId: 't' })).toHaveLength(1)
      })

      it('refuses to edit, delete or truncate posted entries', async () => {
        const { store, s, movement } = await withMovement()
        await store.transaction((tx) =>
          tx.postJournalEntry({
            tenantId: 't',
            movementId: movement.id,
            postingNo: 1,
            kind: 'initial',
            description: 'Received 10 XLM',
            lines: [
              { account: 'cash', role: 'cash', side: 'debit', amount: movement.amount },
              { account: 'unapplied', role: 'unapplied', side: 'credit', amount: movement.amount },
            ],
          }),
        )
        for (const sql of [
          `UPDATE ${s}.journal_entries SET description = 'edited'`,
          `DELETE FROM ${s}.journal_entries`,
          `UPDATE ${s}.journal_lines SET amount = 1`,
          `DELETE FROM ${s}.journal_lines`,
          `TRUNCATE ${s}.journal_lines, ${s}.journal_entries`,
        ]) {
          await expect(pool.query(sql)).rejects.toThrow(/append-only/)
        }
        expect(await store.listJournalEntries({ tenantId: 't' })).toHaveLength(1)
      })

      it('upgrades a version 1 database with data to the latest version', async () => {
        const { store, s, movement } = await withMovement()
        // Put the schema back to version 1, keeping its data.
        await pool.query(
          `DROP TABLE ${s}.refund_links, ${s}.movement_valuations, ${s}.event_prune_state, ${s}.exports, ${s}.accrual_modes, ${s}.expectation_reference_index, ${s}.journal_period_actions, ${s}.journal_lines, ${s}.journal_entries, ${s}.events`,
        )
        await pool.query(
          `DROP FUNCTION ${s}.journal_entry_balanced, ${s}.journal_line_balanced, ${s}.journal_check_entry, ${s}.journal_append_only, ${s}.events_append_only, ${s}.journal_period_actions_append_only`,
        )
        await pool.query(`DELETE FROM ${s}.migrations WHERE version > 1`)
        await store.migrate()
        expect((await store.getMovement('t', movement.id))!.amount.toString()).toBe('10.0000000')
        expect(await store.listJournalEntries({ tenantId: 't' })).toEqual([])
        expect(await store.listEvents({ tenantId: 't' })).toEqual([])
      })

      it('backfills the text-memo index when upgrading a database with existing rows', async () => {
        const store = await freshStore()
        const s = `"${schemas[schemas.length - 1]!}"`
        const e = await store.transaction((tx) =>
          tx.insertExpectation({
            tenantId: 't',
            reference: 'INV-9',
            account: `G${'A'.repeat(55)}`,
            amount: Money.parse('10', NATIVE),
            memo: { type: 'text', value: 'REF-8' },
          }),
        )
        await pool.query(`DROP TABLE ${s}.refund_links, ${s}.movement_valuations, ${s}.event_prune_state, ${s}.exports, ${s}.accrual_modes, ${s}.expectation_reference_index`)
        await pool.query(`DELETE FROM ${s}.migrations WHERE version >= 5`)
        await store.migrate()
        const ids = async (key: string) =>
          (await store.getExpectationsByNormalizedReference('t', key)).map((x) => x.id)
        expect(await ids('9')).toEqual([e.id])
        expect(await ids('8')).toEqual([e.id])
        expect(await ids('')).toEqual([])
      })
    })

    it('rejects a schema name that is not a plain identifier', () => {
      expect(() => new PostgresStore({ pool: pool!, schema: 'x"; DROP TABLE y; --' })).toThrow(/Invalid schema name/)
      expect(() => new PostgresStore({})).toThrow(/needs a pool or a connectionString/)
    })

    it('owns and ends a pool it created from a connection string', async () => {
      const store = new PostgresStore({ connectionString: url!, schema: 'unused' })
      await store.close()
      await expect(store.getCursor({ tenantId: 't', network: 'n', source: 's', account: 'a' })).rejects.toThrow()
    })
  })
}
