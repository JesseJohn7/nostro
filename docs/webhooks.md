# Events and webhooks

Every decision nostro makes is also written to an event log, in the same database transaction as the
decision. `deliverWebhooks()` posts that log to a URL, signed.

## The guarantee

An event exists if and only if its decision committed. So a webhook never announces a payment that
was rolled back, and a crash between deciding and notifying loses nothing: delivery reads the log
from a saved position and picks up where it stopped.

- **Order.** Events are delivered one at a time, in the order they were written. If one fails, the
  round stops there and the next round retries that same event, so nothing is skipped or reordered.
  In PostgreSQL, writers take a per-tenant lock before writing an event, so events commit in the
  order they are numbered.
- **At least once.** A crash after a receiver answered but before the position was saved sends that
  event again. Deduplicate on the event `id`.
- **Redirects are not followed.** A `3xx` counts as a failure: a signed body only goes to the URL you
  configured.

## Event types

| Type | When | `data` |
|---|---|---|
| `movement.decided` | a movement's disposition changed | `movement`, `previous` (the old disposition), `allocations` |
| `expectation.partially_paid` | an allocation part-paid an expectation | `expectation`, `allocation` |
| `expectation.settled` | an allocation paid it in full | `expectation`, `allocation` |
| `expectation.cancelled` | it was cancelled | `expectation`, `allocation: null` |
| `expectation.amended` | its details were changed by a person | `expectation`, `previous`, `reason` |
| `exception.opened` | something needs a person | `exception` |
| `exception.resolved`, `exception.dismissed` | someone closed it | `exception` |

`expectation.amended` carries both the new and the old record, so a consumer can see what changed;
`reason` is the non-empty explanation required for the amendment. An amendment writes only this
event, even when it changes the expectation's status as a side effect; allocations still write
`expectation.partially_paid` or `expectation.settled`.

`EXPECTATION_EXPIRED` is an exception code, not an event type. `sweepExpectations()` opens it against
an unpaid expectation past its expiry, so it arrives as `exception.opened` with
`data.exception.code` set to `EXPECTATION_EXPIRED`. The sweep is idempotent and does not itself change
the expectation's status. It is independent of matching's `LATE_BEYOND_WINDOW`: a truly late, unpaid
expectation can draw both, as two separate `exception.opened` events.

Records use the same JSON as the HTTP API: amounts are exact decimal strings next to their asset,
and ids and dates are strings.

```json
{
  "id": "6f1c…",
  "seq": 42,
  "type": "expectation.settled",
  "subjectId": "0b9e…",
  "createdAt": "2026-10-22T12:00:00.000Z",
  "data": { "expectation": { "reference": "INV-1042", "amount": "25.0000000", "asset": "native", "status": "settled", "…": "…" }, "allocation": { "…": "…" } }
}
```

## Verifying a request

Each request carries `Nostro-Signature: t=<unix seconds>,v1=<hex>`: the HMAC-SHA256 of
`<t>.<raw body>` under your secret, plus `Nostro-Event-Id` and `Nostro-Event-Type` headers. Verify
the signature against the raw body before parsing it:

```ts
import { verifyWebhook } from '@nostro-labs/nostro'

const ok = verifyWebhook({ secret: process.env.NOSTRO_WEBHOOK_SECRET!, header: req.headers['nostro-signature'], body: rawBody })
if (!ok) return res.status(401).end()
```

`verifyWebhook()` compares in constant time and refuses a timestamp more than five minutes from now
(`toleranceSeconds`), so a captured request can't be replayed later. Answer with any `2xx` once the
event is safely stored on your side.

## Sending them

```ts
import { deliverWebhooks } from '@nostro-labs/nostro'

const report = await deliverWebhooks({ store, tenantId: 'acme', url: 'https://example.com/hooks/nostro', secret })
// { delivered, position, failure: { eventId, reason } | null, contended }
```

Like `sync()`, a call is bounded: run it on a timer, or let `nostro serve --webhook-url <url>` do it
after each round (the secret comes only from `NOSTRO_WEBHOOK_SECRET`). The HTTP API serves the same
log at `GET /v1/events` for clients that would rather poll. Secrets must be at least 32 characters
(`openssl rand -hex 32`). Each destination keeps its own position (`consumer`, default `webhook`).
Two deliverers sharing one consumer won't both advance it: the second one notices and stops.

## Watching and replaying delivery

Every POST is recorded whether it worked or not, in a bounded per-consumer attempt log that is
separate from the append-only event log. The newest 1,000 attempts per consumer are kept, and
attempts older than 30 days are dropped in the same transaction that appends a new one. No background
job is needed.

The HTTP API exposes that state:

| Route | What it gives you |
|---|---|
| `GET /v1/webhooks` | every consumer in the tenant — including one configured with `--webhook-url` that has not delivered anything yet — with its position, lag and last outcomes |
| `GET /v1/webhooks/{consumer}/status` | `position`, `latestSeq`, `lag`, and the last attempt, success and failure |
| `GET /v1/webhooks/{consumer}/attempts` | attempts, newest first; `?outcome=success\|failure`, `?limit=`, `?after=` |
| `POST /v1/webhooks/{consumer}/replay` | `{ "expectedSeq": 42, "toSeq": 39, "actor": "ops@example.com" }` — rewinds the consumer so the next round resends events after `toSeq` |

`lag` is `latestSeq - position`: it is zero only after every retained event has been acknowledged.
A consumer with no saved position yet still has a status route; it starts at the retention watermark.

Replay is a compare-and-set, not a rewrite of history. `expectedSeq` must be the `position` you just
read; if a deliverer moved it in the meantime, the server answers `409 consumer_position_conflict`
and you should read the status and retry. `toSeq` must be lower than `expectedSeq` and no lower than
the retention watermark; otherwise the server answers `422 invalid_replay` or `410
event_history_pruned`. Each rewind is recorded with its actor and time, so an operator can see who
moved a consumer back. The deliverer checks the cursor both before a POST and when it saves the
result, so a replay racing a running round cannot advance the rewound position past events that have
not been sent.

There is deliberately no "resend this one event" operation. Receivers already deduplicate on event
`id`, so rewinding to just before a run of events is enough and keeps ordering intact. The same
attempt log is an audit surface a future backoff or parking feature can add its own state beside;
it does not require changing the event store.

## Event retention

Webhook consumers retain their own position in the tenant's event log. The `prune-events` command
removes an old prefix only through the slowest saved consumer position, so an unresponsive consumer
holds the prefix it still needs. Events newer than the requested cutoff remain available.

```sh
nostro prune-events --tenant acme --older-than 2026-01-01T00:00:00Z
```

The command is irreversible. A polling client whose `after` position is older than the recorded
retention watermark receives HTTP `410 event_history_pruned` with the highest pruned sequence in
`detail`; resume from that sequence. A newly registered webhook consumer starts at the current
retention watermark and receives events retained from that point onward. Existing consumers keep
their stored positions.
