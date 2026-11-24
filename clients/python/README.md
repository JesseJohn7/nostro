# nostro-client (Python)

A small, dependency-free Python client for the [nostro](https://github.com/nostro-labs/nostro) HTTP API.

- Standard library only: `urllib.request` for HTTP, `decimal` for money. No `httpx`, no generated code.
- Every method is named after an OpenAPI `operationId` in snake_case; a test checks that none are missing.
- Amounts are exact decimal strings on the wire. Floats are refused; assets always compare on the full `CODE:ISSUER` id.
- List methods are lazy iterators that follow the API's `next` cursor back into `after`.
- Errors raise `ProblemError` with the stable `code` from the RFC 9457 problem document.

Requires Python 3.11 or newer.

```sh
pip install -e clients/python          # from the repo root
pip install -e "clients/python[dev]"   # with pytest, for the test suite
```

## Client basics

```python
from decimal import Decimal
from nostro_client import Client, ProblemError, parse_money, same_asset

client = Client("http://127.0.0.1:8080", api_key="<the key part of NOSTRO_API_KEYS>")

assert client.health() == {"ok": True}

usdc = parse_money("10.25", "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN")
created = client.create_expectation(
    reference="invoice-1001",
    account="GABC...",
    amount=usdc,                 # or "10.25", or Decimal("10.25")
    # asset is taken from the Money when omitted; otherwise pass the FULL id
)
assert same_asset(usdc.asset, created["asset"])

try:
    client.create_expectation(reference="invoice-1001", account="GABC...", amount=Decimal("10.25"))
except ProblemError as err:
    if err.code == "reference_taken":
        print("Already recorded:", err.detail)
```

Query names follow the OpenAPI document exactly. Two names are Python keywords, so `from` and `to`
are spelled `from_` and `to_` (both in query arguments and in `move_account`'s body):

```python
client.list_movements(from_="2026-01-01T00:00:00Z", limit=50)
client.move_account(from_="expenses:old", to_="expenses:new")
```

### Exact money

`as_amount_str(value)` accepts only `str`, `Decimal` and `Money`; it raises `TypeError` for a
`float` (and for ints and anything else). Client methods apply it to every field named `amount`
in request bodies, including nested journal lines and resolution allocations, so amounts are
always JSON strings. `same_asset(a, b)` is exact equality on the complete asset id: `USDC` and
`USDC:GISSUER...` are different assets.

## Paging

`list_*` methods return an `Iterator`; `*_page` methods return one raw `{"data": [...], "next": N}`
page when you want to control the cursor yourself. `next` is `null` on the last page.

```python
from nostro_client import Client

client = Client("http://127.0.0.1:8080", api_key="<key>")

total = Decimal(0)
for movement in client.list_movements(limit=100, disposition="settled"):
    if movement["asset"] == "native":
        total += Decimal(movement["amount"])   # exact; never float()
    print(movement["id"], movement["amount"], movement["asset"])

# Equivalent manual loop:
page = client.list_movements_page(limit=100)
while True:
    for row in page["data"]:
        print(row["seq"])
    if page["next"] is None:
        break
    page = client.list_movements_page(limit=100, after=page["next"])
```

Other paged iterators: `list_expectations`, `list_exceptions`, `list_events`,
`list_journal_entries`, `list_schedules` and `webhook_attempts(consumer)`.

## Webhook receiver (complete example)

Delivery is at least once, so dedupe on `Nostro-Event-Id`. Verify the signature against the **raw**
body before parsing JSON: re-serialising parsed JSON changes the bytes. The signature format is
`t=<unix seconds>,v1=<64 lowercase hex>`; the signed payload is `<t>.<raw body>` (UTF-8), with a
default tolerance of 300 seconds.

```python
"""A signed-webhook receiver. Run with NOSTRO_WEBHOOK_SECRET set (openssl rand -hex 32)."""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from nostro_client import verify_webhook

SECRET = os.environ["NOSTRO_WEBHOOK_SECRET"]
seen_event_ids: set[str] = set()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        # 1. Read the raw bytes exactly as received.
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)

        # 2. Verify before parsing. Any failure is a 401/400; do not process it.
        if not verify_webhook(SECRET, self.headers.get("Nostro-Signature"), raw):
            self.send_response(401)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        event = json.loads(raw)
        event_id = self.headers.get("Nostro-Event-Id", event.get("id", ""))
        if event_id in seen_event_ids:
            # Already handled; acknowledge so delivery moves on.
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        seen_event_ids.add(event_id)

        # 3. Handle the event. Business logic goes here.
        print(self.headers.get("Nostro-Event-Type"), event_id)
        if event["type"] == "movement.decided":
            print("disposition:", event["data"]["movement"]["disposition"])

        # 4. Any 2xx acknowledges receipt. Use a persistent store for the
        #    dedupe set in a real deployment; it must survive restarts.
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 9090), Handler).serve_forever()
```

This verifies the same vectors as core's `verifyWebhook()`: expired, tampered, malformed,
wrong-secret and missing-header requests are all refused.

## Tests

```sh
python3 -m pytest clients/python/tests
```

The signature vectors come from the shared `fixtures/webhooks/signatures.json`. A test also checks
that the client covers every `operationId` in `packages/server/src/openapi.ts`.

To run the optional live tests, start a server (see `examples/docker-compose`) and set:

```sh
export NOSTRO_TEST_API_URL=http://127.0.0.1:8080
export NOSTRO_TEST_API_KEY=<the key part of NOSTRO_API_KEYS>
python3 -m pytest clients/python/tests
```

## For maintainers: publishing

Package metadata for PyPI lives in `pyproject.toml` (name `nostro-client`, Apache-2.0, repository
URL, README). Nothing is published from CI. To release:

1. Bump the version in `pyproject.toml` and `__version__` in `nostro_client/__init__.py`.
2. From `clients/python`, build with `python -m build` and check with `python -m twine check dist/*`.
3. Upload through PyPI Trusted Publishing (configure a GitHub Actions `pypa/gh-action-pypi-publish`
   job with `id-token: write` and a PyPI trusted publisher for this repository). No API token is
   stored in the repository.

See [docs/python-client-design.md](../../docs/python-client-design.md) for the design rationale.
