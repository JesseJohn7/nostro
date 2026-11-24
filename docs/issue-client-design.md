# Issue C — browser-safe `@nostro-labs/client`

## Hand-written methods, proven by the OpenAPI document

The client has one method per `operationId` in `buildOpenApi()`. Rather than
add a generator dependency, the methods are written out in `src/client.ts`,
and a test reads the live OpenAPI document and asserts a same-named method
exists for every operation (excluding `health`, `openapi` and the webhook
callback keys). A renamed or added route therefore fails the client's test
suite instead of silently drifting.

Query parameter names are the OpenAPI names (`after`, `limit`, `status`,
`account`, `entityId`, `from`, `to`, `code`, `reference`, `consumer`, …), and
path parameters come first in the method signature. The API key is only ever
put in an `Authorization: Bearer` header; `ApiError` is built from the problem
document alone, so messages and stacks cannot leak the key or URL userinfo.

## Money via core subpath exports

Amounts are never re-implemented in the client. `packages/core/package.json`
gains browser-safe subpaths `./money`, `./json` and `./webhooks/verify`; the
client re-exports `Money`, `NATIVE`, `parseAsset`, `moneyFromJson`, the
`*FromJson` parsers and Web Crypto `verifyWebhook` from them. `moneyFromJson`
infers decimals from the decimal string and delegates to `Money.parse`, so a
value beyond 2^64 keeps every digit. The HTTP layer only ever sees strings.

`*FromJson` helpers were added to core because the wire format deliberately
omits tenant ids and stores uuid-sized ids as strings; callers that know their
tenant can pass it as an optional second argument.

## One parsing rule for both verifiers

Header parsing and the 300-second replay window moved to the pure
`webhooks/parse.ts` module, which has no Node imports. The Node verifier keeps
`createHmac` + `timingSafeEqual`; the browser verifier uses
`crypto.subtle.importKey`/`verify`. Both call `parseSignature`, and the shared
signature fixture vectors are run through both in the client's test suite.
