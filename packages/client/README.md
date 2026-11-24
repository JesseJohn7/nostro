# `@nostro-labs/client`

A browser-safe TypeScript client for the nostro HTTP API. One method per
OpenAPI `operationId`, with the same camelCase name. It uses `fetch` and Web
Crypto — no Node built-ins — so the same code runs in browsers, workers and
Node 22.

```ts
import { createClient, Money, NATIVE, expectationFromJson } from '@nostro-labs/client'

const client = createClient({
  baseUrl: 'https://api.example.com',
  apiKey: process.env.NOSTRO_API_KEY!, // sent only as Authorization: Bearer
})

const created = await client.createExpectation({
  reference: 'INV-1001', account: 'GAAAA…', amount: '25.0000000', asset: 'native',
})
const expectation = expectationFromJson(created) // domain Expectation, with Money
expectation.amount.equals(Money.parse('25', NATIVE)) // true
```

The API key never appears in a URL or in an error message. Requests carry
`Authorization: Bearer <key>` and `Content-Type: application/json`.

## Paging

Every list method returns a `PageIterable<T>`: call `.page()` for one page or
iterate with `for await` to follow the server's `next` cursor into `after` until
it is `null`. Query parameter names are the OpenAPI names (`limit`, `after`,
`status`, `account`, `entityId`, `from`, `to`, `code`, `reference`, `consumer`, …).

```ts
const first = await client.listMovements({ limit: 50, account: 'GAAAA…' }).page()
// first: { data: MovementJson[], next: number | string | null }

for await (const movement of client.listMovements({ limit: 50 })) {
  console.log(movement.id, movement.amount)
}

// Resume from a `next` the server gave you (it may be a number):
const second = await client.listMovements({ limit: 50 }).page({ after: first.next! })
```

`.page(params?)` merges overrides with the method's original params. List
items are the JSON wire records; parse them with `movementFromJson`,
`expectationFromJson`, `exceptionFromJson`, `journalEntryFromJson` or
`scheduleFromJson` to get `Money`, `Date` and bigint fields.

## Amounts

Amounts are decimal strings in both directions, never JSON numbers. The
helpers re-exported from core's browser-safe `./money` subpath keep them exact:

```ts
import { Money, NATIVE, parseAsset, moneyFromJson } from '@nostro-labs/client'

moneyFromJson('18446744073709551616.0000123', NATIVE) // exact, beyond 2^64
parseAsset('USDC:GA5Z…')                              // canonical AssetId
Money.parse('0.1', NATIVE).add(Money.parse('0.2', NATIVE)).toString() // '0.3000000'
```

`moneyFromJson` infers the decimals from the decimal string and calls
`Money.parse`, which refuses to round.

## Errors

Any non-2xx response throws `ApiError` with the RFC 9457 problem fields:
`status`, `code`, `detail`, `title`, `type` and `name === 'ApiError'`.
Its message and stack contain no request URL, headers or API key.

```ts
import { ApiError } from '@nostro-labs/client'

try {
  await client.createExpectation({ reference: 'INV-1001', account: A, amount: '25' })
} catch (err) {
  if (err instanceof ApiError && err.code === 'reference_taken') {
    // branch on the stable code, not on the prose detail
  }
}
```

## Webhook verification

`verifyWebhook` is core's Web Crypto verifier with the same `VerifyOptions` as
the Node one. It checks the same header grammar and replay window (300 seconds
by default), then verifies the HMAC in constant time inside SubtleCrypto.

```ts
import { verifyWebhook } from '@nostro-labs/client'

const ok = await verifyWebhook({
  secret: process.env.NOSTRO_WEBHOOK_SECRET!,
  header: request.headers.get('Nostro-Signature'),
  body: await request.text(), // the raw body, before JSON.parse
})
if (!ok) return new Response('bad signature', { status: 400 })
```

SubtleCrypto is available only in **secure contexts** (HTTPS or localhost). A
plain-HTTP browser page cannot verify a signature; terminate TLS or verify on
the server instead.

## Compound responses

- `getExpectation(id)` and `getExpectationByReference({ reference })` return
  `{ expectation, allocations }`.
- `getMovement(id)` returns `{ movement, allocations, exceptions, journal,
  refunds, decision }`.
- `getException(id)` returns `{ exception, movement, expectation }`.
- `resolveException(id, decision)` returns a `resolutionJson`-shaped object:
  `{ movement, allocations, closed, opened, journalEntry, alreadyApplied }`.
- `resolveExceptions({ mode, decisions })` returns
  `{ mode, applied, errors, results }`, each result being
  `{ index, exceptionId, result, error }`.
- `exportJournal(params)` returns the raw CSV text as a `string` (the server
  responds with `text/csv`; the client reads `response.text()`).

## Supported runtimes

| Runtime | `fetch` | Web Crypto (SubtleCrypto) |
|---|---|---|
| Browsers (secure contexts only) | [MDN Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch) | [MDN SubtleCrypto](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto) · [secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts) |
| Node 22 | [Node globals: fetch](https://nodejs.org/api/globals.html#fetch) | [Node Web Crypto](https://nodejs.org/api/webcrypto.html) |
| Deno | [Deno fetch](https://docs.deno.com/runtime/fundamentals/networking/#fetch) | [Deno Web Crypto](https://docs.deno.com/runtime/reference/web_crypto/) |
| Bun | [Bun fetch](https://bun.sh/docs/api/fetch) | [Bun Web Crypto](https://bun.sh/docs/api/web-crypto) |
| Cloudflare Workers | [Workers fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/) | [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) |

You can inject any `fetch`-compatible function with `createClient({ fetch })`
(for tests, proxies or runtimes with a custom implementation).
