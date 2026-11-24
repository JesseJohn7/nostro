# examples/invoicing

A small web app that settles invoices from webhooks. It is the end-to-end example the other two
are not: create an invoice, give the payer something to pay to, find out when it is paid, and
handle what nostro would not decide alone.

## What it does

1. **Create an invoice** — records an expectation through the library (explained below).
2. **Show what to pay** — the memo and the M... address, so the payer can quote the invoice.
3. **Receive a webhook** — verifies the signature on the raw body, deduplicates on the event id,
   and updates the invoice's status from `expectation.settled`, `expectation.partially_paid` and
   `expectation.cancelled`.
4. **List open exceptions** — from `listExceptions`, with the matching `nostro resolve` command.
5. **Run against a simulated Horizon** — so it works offline. Nothing signs a transaction or holds a secret key.

## Library or HTTP API

This example uses the library directly (`@nostro-labs/nostro`) rather than the HTTP API
(`nostro serve`). A single-process app that embeds the store has no network hop to the API and no
API key to manage. A multi-process or multi-service deployment should use the HTTP API instead:
`nostro serve` keeps the store in one place, and the app talks to it over HTTP with a scoped key.

## Running it

```sh
node examples/invoicing/server.mjs
```

Then in another terminal:

```sh
# Create an invoice
curl -X POST http://127.0.0.1:3001/invoices \
  -H 'content-type: application/json' \
  -d '{"reference":"INV-1","amount":"25","muxedId":1}'

# Sync, reconcile and deliver webhooks
curl -X POST http://127.0.0.1:3001/sync

# Check the invoice status
curl http://127.0.0.1:3001/invoices/INV-1

# List open exceptions
curl http://127.0.0.1:3001/exceptions
```

## Smoke test

```sh
node examples/invoicing/smoke-test.mjs
```

The smoke test pays three invoices: one correctly (settled), one overpaid (partial with an
overpayment exception), and one with no memo (unmatched, raised as an exception). It then delivers
webhooks to an in-process receiver that verifies signatures and deduplicates on the event id, and
checks that a replayed webhook does not change an invoice twice. Finally it runs `doctor()` to
confirm the books hold.

## What the webhook receiver does right

These are the details every integrator gets wrong:

- **Verify the signature on the raw body** before parsing it. `verifyWebhook()` checks the
  HMAC-SHA256 in constant time and rejects timestamps outside the tolerance.
- **Deduplicate on the event id.** Delivery is at least once: a crash after the POST but before the
  position is saved sends that event again. The receiver stores the event id and skips repeats.
- **Treat `expectation.partially_paid` differently from `expectation.settled`.** A partial payment
  means the invoice is partly settled, with an overpayment exception for the rest.
- **Send people to the exceptions queue** instead of guessing. An unmatched payment is an
  exception, not a settlement.
