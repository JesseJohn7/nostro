/**
 * What a key may do. Each route needs exactly one scope, declared here and
 * nowhere else: the server checks it, and the OpenAPI document lists it.
 *
 * - `read`: every GET except events and webhooks.
 * - `events`: `GET /v1/events`, the full event stream.
 * - `webhooks`: webhook consumer status, attempts and replay.
 * - `expectations`: create, cancel and amend expectations.
 * - `exceptions`: resolve exceptions.
 * - `journal`: post manual journal entries, close and reopen periods, and move account balances.
 * - `accounts`: start and stop watching an account. Reading the watch list needs `read`.
 */
export const SCOPES = ['read', 'events', 'webhooks', 'expectations', 'exceptions', 'journal', 'accounts'] as const
export type Scope = (typeof SCOPES)[number]

/** `METHOD /v1/path` (Fastify's route path, `:param` form) to the scope it needs. Unlisted routes are refused. */
export const ROUTE_SCOPES: Readonly<Record<string, Scope>> = {
  'GET /v1/movements': 'read',
  'GET /v1/movements/:id': 'read',
  'GET /v1/expectations': 'read',
  'GET /v1/expectations/:id': 'read',
  'POST /v1/expectations': 'expectations',
  'POST /v1/expectations/:id/cancel': 'expectations',
  'POST /v1/expectations/:id/amend': 'expectations',
  'GET /v1/exceptions': 'read',
  'POST /v1/exceptions/:id/resolve': 'exceptions',
  'GET /v1/events': 'events',
  'GET /v1/webhooks': 'webhooks',
  'GET /v1/webhooks/:consumer/status': 'webhooks',
  'GET /v1/webhooks/:consumer/attempts': 'webhooks',
  'POST /v1/webhooks/:consumer/replay': 'webhooks',
  'GET /v1/journal': 'read',
  'POST /v1/journal': 'journal',
  'GET /v1/journal.csv': 'read',
  'GET /v1/reports/trial-balance': 'read',
  'GET /v1/reports/ledger': 'read',
  'GET /v1/reports/balance-sheet': 'read',
  'GET /v1/reports/income': 'read',
  'POST /v1/chart/move': 'journal',
  'GET /v1/accounts': 'read',
  'POST /v1/accounts': 'accounts',
  'DELETE /v1/accounts/:account': 'accounts',
}
