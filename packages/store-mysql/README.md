# @nostro-labs/store-mysql

MySQL store for [nostro](https://github.com/nostro-labs/nostro). Passes the same Store
conformance suite as nostro's in-memory store. Requires MySQL 8.0.16 or newer; MariaDB is
not supported (CHECK constraints and trigger semantics differ).

```sh
npm install @nostro-labs/nostro @nostro-labs/store-mysql
```

```ts
import { MysqlStore } from '@nostro-labs/store-mysql'

const store = new MysqlStore({
  connectionString: process.env.MYSQL_URL,
  database: 'nostro',
})
await store.migrate() // creates the database and applies pending migrations; safe to run concurrently
```

- Amounts are `DECIMAL(40,0)` raw units plus decimals, never floats.
- Uniqueness, positive amounts and closed value sets are enforced by the database as well as in code.
- Concurrent workers are safe: rows a write depends on are locked with `SELECT ... FOR UPDATE` inside
  a `READ COMMITTED` transaction. Per-tenant locks are rows in `event_locks`, held until commit.
- Event writers serialize per tenant. A deadlock (`errno 1213`) rolls the transaction back and retries
  it up to three times, so the callback may run more than once; keep side effects outside it.
- Text memos are stored as BLOBs, because a Stellar text memo can contain NUL and a MySQL `TEXT`
  column must not be relied on to preserve it through every client and collation.
- JSON payloads are stored as `LONGTEXT` with binary collation and parsed in the application.

Pass `pool` instead of `connectionString` to share a pool you manage; the store will not end it.

**Status:** 0.1.0, early: API may change before 1.0.
