# Design: config profiles, CLI remote mode, TypeScript client, Python client

Posted for maintainer review before code was written; the decisions below were agreed and this
branch implements them. One branch, one commit per issue, in dependency order.

## Config profiles

- **JSON**, no new parser dependency. Top level: `version`, `defaultProfile`, `profiles`, and the
  existing serve `tenants` list. A profile has `db`, `tenant`, `network`, `horizon`, `accounts`,
  `schema`, `port`, `host`, `interval` and an opaque `settings` extension object for future issues.
- **Lookup**: explicit `--config` / `NOSTRO_CONFIG` only; otherwise `./nostro.json`, then
  `$XDG_CONFIG_HOME/nostro/nostro.json` (`~/.config/nostro/nostro.json` fallback). First file wins;
  files are never merged.
- **Precedence**: flag > selected profile > environment > default. Selection: `--profile` >
  `NOSTRO_PROFILE` > `defaultProfile`. With no file, behaviour is unchanged.
- **Passwords**: refused in the file (value and key names checked recursively); credentials stay in
  the environment. API keys and webhook secrets have no key in the schema and are refused.
- `nostro config` prints every resolved value with its source, redacts URLs and hides keys.

## Remote mode

- A `Backend` interface returns domain values, so commands and formatters are shared between modes.
  Remote-capable: `expectations`, `expect`, `exceptions`, `resolve`, `export` (CSV); every other
  command refuses in remote mode.
- `--api` / `NOSTRO_API_URL`; key only from `NOSTRO_API_KEY`. `http://` only for loopback; URL
  credentials are refused; the key never appears in output, with or without `NOSTRO_DEBUG`.
- RFC 9457 codes: `invalid_request`, `invalid_expectation`, `invalid_resolution`, `invalid_replay`
  map to exit 2 (matching local `UsageError`); all others to 1. The code is printed in the message.
  Lists follow `next` into `after`. The CLI uses `@nostro-labs/client`.
- `expect` side effects stay in step: the server's create-expectation handler posts accrual, as the
  local command does.

## TypeScript client

- Hand-written methods, one per `operationId`, proven by a test that reads `buildOpenApi()`. Pages
  are lazy async iterators; `ApiError` carries status and code; amounts are `Money` via browser-safe
  `./money`, `./json` and `./webhooks/verify` subpath exports of core (no `node:` imports).
- Web Crypto `verifyWebhook` shares the Node verifier's pure header parser and accepts the same
  `t=…,v1=…` grammar and 300 s tolerance. Shared vectors from `fixtures/webhooks/signatures.json`,
  generated with core's `signWebhook()`.

## Python client

- `clients/python/`, `nostro-client`, Python ≥ 3.11, stdlib `urllib`, pytest, hand-written methods
  proven against the OpenAPI document. Amounts are `Decimal` beside the full asset id; `float` is
  refused; `verify_webhook` uses `hmac.compare_digest` and the same shared vectors.
- CI builds nostro, starts `serve` over SQLite and runs the tests against it. Publishing to PyPI is
  for maintainers (Trusted Publishing); nothing is published here.
