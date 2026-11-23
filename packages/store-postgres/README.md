# @nostro-labs/store-postgres

PostgreSQL store for [nostro](https://github.com/nostro-labs/nostro). Passes the same Store
conformance suite as nostro's in-memory store.

```sh
npm install @nostro-labs/nostro @nostro-labs/store-postgres
```

```ts
import { PostgresStore } from '@nostro-labs/store-postgres'

const store = new PostgresStore({ connectionString: process.env.DATABASE_URL, schema: 'nostro' })
await store.migrate() // creates the schema and applies pending migrations; safe to run concurrently
```

- Amounts are `NUMERIC(40,0)` raw units plus decimals, never floats.
- Uniqueness, positive amounts and closed value sets are enforced by the database as well as in code.
- Concurrent workers are safe: rows a write depends on are locked with `SELECT … FOR UPDATE`, and a
  cursor read inside a transaction holds that cursor until the transaction ends.
- Event writers serialize per tenant using a transaction-scoped advisory lock. If PostgreSQL
  detects a deadlock (`40P01`), the store rolls back and retries the whole transaction up to
  three times. The transaction callback may run more than once; keep external side effects
  outside it. Transactions touching more than one tenant follow the same retry rule.
- Text memos are stored as bytes, because a Stellar text memo can contain NUL and a PostgreSQL
  `text` column cannot.
- The journal's cash and issued lines are checked again at COMMIT by a deferred trigger. Using exact
  `NUMERIC` arithmetic, a movement's cumulative balance-role lines must net to zero or to the
  movement's signed amount; a raw insert that breaks this fails when the transaction commits.

Pass `pool` instead of `connectionString` to share a pool you manage; the store will not end it.

## Row-level security (opt-in)

The last migration enables and **forces** RLS on every tenant-scoped table. The `migrations` table is
global and unforced. Two policies govern each tenant table: one requires
`tenant_id = current_setting('nostro.tenant', true)` for both `USING` and `WITH CHECK`, and a narrow
migration policy permits access only while `nostro.migrate_bypass = 'on'`. A third policy keeps
owner access working, since `FORCE` also applies to the owner; never grant the app role membership
in the owner role. `migrate()` sets the bypass GUC inside its own transaction; nothing else does.

```ts
import { PostgresStore } from '@nostro-labs/store-postgres'

const store = new PostgresStore({
  connectionString: process.env.APP_DATABASE_URL,
  rls: { enabled: true, appRole: 'nostro_app', tenantSetting: 'nostro.tenant' },
})
await store.migrate() // run this once as the schema owner, not as the app role

const receipt = await store.forTenant('acme').getMovement(movementId)
await store.transaction('acme', (tx) => tx.insertMovements([movement]))
```

Create a dedicated role with `NOBYPASSRLS`, grant it only DML on the schema, and let the migration
role connect to the pool:

```sql
CREATE ROLE nostro_app NOLOGIN NOBYPASSRLS;
GRANT USAGE ON SCHEMA nostro TO nostro_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA nostro TO nostro_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA nostro TO nostro_app;
```

The pool user must be a superuser or a member of `appRole` so the store can `SET LOCAL ROLE` to it.
Owners and superusers bypass RLS (a superuser bypasses even `FORCE ROW LEVEL SECURITY`), so never
give the app role `BYPASSRLS` or ownership of the tables. Without `rls.enabled`, the store does not
set the tenant GUC or adopt a role and behaves as before; a non-superuser owner of a forced table
needs `BYPASSRLS` for that legacy mode.

With RLS enabled each call's tenant is written to a transaction-local GUC. A `transaction(tenantId,
fn)` pins its tenant: a second tenant in the same transaction throws instead of silently writing
another tenant's rows. Reads outside a transaction get a short `BEGIN READ ONLY` / `set_config` /
query / `COMMIT` cycle on a pooled client, so a single read has slightly more round trips than in
the default mode. `forTenant(id)` binds the tenant for reads and for `transaction`. Keep
`tenantSetting` at its default unless the policies were retargeted by `migrate()` with the same
value; only lowercase letters, digits, `_` and `.` are accepted.

**Status:** 0.1.0, early: tested, and run against real testnet accounts, but the API may change before 1.0.
