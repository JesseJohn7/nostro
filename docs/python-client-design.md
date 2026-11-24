# Python client design (issue D)

## Shape

`clients/python` installs a single import package, `nostro_client`, with a synchronous `Client`
class. Methods are hand-written, one per HTTP operation, named after the OpenAPI `operationId`
converted to snake_case (`replayDecisions` → `replay_decisions`). Correctness is mechanical rather
than manual: `tests/test_client.py` extracts every `operationId` from
`packages/server/src/openapi.ts` and asserts the corresponding method exists, so adding a route
without a client method fails CI. `from`/`to` are reserved words in Python and appear as
`from_`/`to_`, mapped back to the OpenAPI names on the wire.

## Zero dependencies

HTTP uses only `urllib.request`. No `httpx`, no generated client, no pydantic: an existing
`OpenerDirector` can be injected for proxies, TLS configuration or test doubles. Bugs are easy to
diagnose because the transport is one small `_request()` method. All list methods return lazy
iterators that follow `next` back into `after` until the server returns `null`; `*_page()` methods
expose a raw page when a caller wants to manage the cursor (e.g. to resume after a crash).

## Money and assets

The server's non-negotiable rules apply to the client too. `as_amount_str()` accepts only `str`,
`Decimal` or `Money` and refuses floats and ints with `TypeError`; it is applied by the client to
every request-body field named `amount`, including nested journal lines and resolution allocations.
`Money` pairs a `Decimal` with the full asset id, and `same_asset()` is exact string equality — no
code-only matching, because a lookalike issuer is a different asset. Amounts are JSON strings, so
no precision is lost in transit.

## Errors

A non-2xx response is parsed as `application/problem+json` and raised as `ProblemError` with
`status`, `code`, `detail`, `title` and `type`. Branching on `code` is stable; `detail` is prose.
The API key never appears in an exception message.

## Webhooks

`verify_webhook()` ports core's `verifyWebhook()` grammar exactly: parse the comma-separated
`t=...,v1=...` header (trimming key and value, last duplicate wins), require `t` to be 1–12 ASCII
digits and `v1` 64 lowercase hex characters, reject a timestamp more than `tolerance` seconds
(300 by default) from `now`, then compare the HMAC-SHA256 of `<t>.<raw body>` with
`hmac.compare_digest`. It accepts only verification of incoming webhooks — no secret keys and no
transaction signing exist anywhere in this package. The unit test reads the **shared**
`fixtures/webhooks/signatures.json` vectors, so the two implementations cannot drift.

## Tests and CI

Unit tests need no network. Optional live tests read `NOSTRO_TEST_API_URL` and
`NOSTRO_TEST_API_KEY` and skip when absent. `.github/workflows/python-client.yml` builds the
monorepo, migrates a temporary SQLite database, starts `nostro serve` with a generated test key,
waits for `/v1/health`, installs the package with the `dev` extra and runs pytest, stopping the
server afterwards.

## Publishing (not done here)

`pyproject.toml` carries the distribution metadata (name `nostro-client`, version, Apache-2.0
license, README, repository URL). Releases are built with `python -m build` and uploaded by a
maintainer through PyPI Trusted Publishing with `id-token: write`; no credentials are stored and
no publish job is part of this change.
