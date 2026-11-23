# @nostro-labs/server

An HTTP API over a [nostro](https://github.com/nostro-labs/nostro) store: list movements,
expectations, exceptions and journal entries, record expectations, and download the journal as CSV.
It holds no reconciliation logic of its own; run `sync()` and `reconcile()` (or `nostro sync` and
`nostro reconcile`) beside it.

```sh
npm install @nostro-labs/nostro @nostro-labs/server
```

```ts
import { SqliteStore } from '@nostro-labs/store-sqlite'
import { apiKeys, createServer } from '@nostro-labs/server'

const store = new SqliteStore({ filename: './nostro.db' })
const app = createServer({ store, authenticate: apiKeys({ [process.env.ACME_API_KEY!]: 'acme' }) })
await app.listen({ port: 8080 })
```

| Route | |
|---|---|
| `GET /v1/health` | `{ "ok": true }`; needs no key |
| `GET /v1/openapi.json` | the OpenAPI 3.1 document for all of this; needs no key |
| `GET /v1/movements` | `?disposition=`, `?account=`, `?txHash=`, `?from=`, `?to=`, `?fromLedger=`, `?toLedger=`, `?counterparty=`, `?kind=` |
| `GET /v1/movements/{id}` | the movement, its allocations, exceptions and journal entries |
| `GET /v1/expectations` | `?status=open,partially_paid`, `?account=` |
| `GET /v1/expectations/by-reference` | `?reference=`, lookup by unique reference |
| `GET /v1/expectations/{id}` | the expectation and its allocations |
| `POST /v1/expectations` | record one; `201` with `Location`, `409` if the reference is taken |
| `GET /v1/exceptions` | `?status=`, `?code=`, `?movementId=`, `?expectationId=` |
| `GET /v1/exceptions/{id}` | the exception, its movement and its expectation |
| `POST /v1/exceptions/{id}/resolve` | decide it: `{ "action": "apply", "allocations": [{ "reference": "INV-1" }], "note": "..." }`, `{ "action": "ignore", "note": "..." }` or `{ "action": "close", "note": "..." }`; see [When a person decides](../../docs/matching.md#when-a-person-decides) |
| `GET /v1/journal` | `?from=`, `?to=` (ISO 8601, effective dates) |
| `GET /v1/journal.csv` | the journal as CSV, streamed |
| `GET /v1/events` | the event log ([docs/webhooks.md](../../docs/webhooks.md)), for clients that would rather poll than receive webhooks |
| `GET /v1/accounts` | the watched accounts, each with its sync state per network and source: saved cursor, last attempt and success, whether caught up, and the last error |
| `POST /v1/accounts` | `{ "account": "G..." }` starts syncing it on the next round; `201`, or `200` if already watched |
| `DELETE /v1/accounts/{account}` | stops syncing it; its movements, expectations and cursor are kept. `409` `config_managed` for an account from the service configuration; `409` `has_open_expectations` unless `?force=true` |
| `POST /v1/rounds` | ask serve to run a round now: `{ "account": "G..." }` (optional); `202` with `Location`, `429` if rate limited, `501` if hook not configured |
| `GET /v1/rounds/{id}` | reports round status (`queued`, `running`, `done`, `failed`) and summary report |
| `GET /v1/webhooks` | every webhook consumer, with position, lag and last outcomes |
| `GET /v1/webhooks/{consumer}/status` | one consumer's position, lag, last attempt, success and failure |
| `GET /v1/webhooks/{consumer}/attempts` | `?outcome=success\|failure`, `?limit=`, `?after=`; attempts, newest first |
| `POST /v1/webhooks/{consumer}/replay` | `{ "expectedSeq": 42, "toSeq": 39, "actor": "ops@example.com" }`; `409` if the position moved, `410` if it was pruned, `422` if the rewind is invalid |

- **Authentication.** `Authorization: Bearer <key>`. The key decides the tenant, so a caller can never
  ask for another tenant's records. Keys come from two places. `storedKeys(store)` looks each key up
  by its SHA-256 digest in the store, so a revoked key is refused on the next request, with no cache;
  `nostro keys` manages them. `apiKeys()` takes keys from configuration, keeps only their digests,
  compares in constant time, and refuses keys shorter than 32 characters (`openssl rand -hex 32`).
  A wrong key and a revoked key get the same `401`. `firstOf()` tries several of these in turn.
- **Scopes.** Each key carries scopes, and each route needs one: `read` (every GET except the ones
  below), `events` (`GET /v1/events`), `webhooks` (consumer status, attempts and replay),
  `expectations` (create, cancel, amend), `exceptions` (resolve), `journal` (post, move, chart) and
  `accounts` (start and stop watching an account; reading the watch list needs `read`).
  A key without the route's scope gets `403 forbidden`. The OpenAPI document names each operation's
  scope under the bearer scheme. `apiKeys({ key: { tenant, scopes: ['read'] } })` narrows a key; a
  bare tenant string keeps every scope, as keys did before scopes existed.
- **Paging.** Lists return `{ "data": [...], "next": <seq> | null }`; pass `next` back as `?after=`.
  `?limit=` is 1 to 500 (default 100).
- **Amounts** are exact decimal strings beside their asset (`"amount": "25.0000000", "asset":
  "native"`), never JSON numbers, in both directions: a request body containing any number is
  refused, because by the time it is parsed it may already have been rounded.
- **Errors** are RFC 9457 problem details (`application/problem+json`) with a stable `code`:
  `unauthorized` (401), `forbidden` (403), `invalid_request` (400), `not_found`, `reference_taken` (409),
  `invalid_expectation` (422, e.g. an amount with more decimals than the asset has),
  `invalid_resolution` (422), `resolution_refused` (409, the rules refuse it),
  `consumer_position_conflict` (409), `invalid_replay` (422), `event_history_pruned` (410),
  `too_many_requests` (429), `not_supported` (501),
  `internal`. A
  query parameter or body field the API does not know is a 400, not silently ignored. A 500 says
  nothing about the server's insides.

The OpenAPI document is built from the same schemas the server validates requests with, and tests
check that it is valid, lists exactly the routes the server has, and matches real responses,
errors included.

Not here yet: a container image. Webhooks are delivered by `nostro serve --webhook-url`, or by calling `deliverWebhooks()` from `nostro`.

**Status:** 0.1.0, early: tested, and run against real testnet accounts, but the API may change before 1.0.
