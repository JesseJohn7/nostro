/**
 * The HTTP API: a thin layer over a `Store`. It holds no reconciliation
 * logic of its own and imports only nostro's public entry point, so the
 * library and the service cannot drift apart (CONTRIBUTING.md).
 *
 * Lists page in the store's own order: pass a response's `next` back as
 * `after` for the page after it. `next` is `null` on the last page.
 */
import { Readable } from 'node:stream'
import Fastify from 'fastify'
import type { FastifyError, FastifyInstance, FastifyServerOptions } from 'fastify'
import type { AssetId, Disposition, ExceptionCode, ExceptionDecision, ExceptionStatus, ExpectationChanges, ExpectationStatus, Memo, NewExpectation, Store } from '@nostro-labs/nostro'
import {
  ConstraintError,
  InvalidAssetError,
  Money,
  NATIVE,
  NotFoundError,
  PrecisionError,
  ValidationError,
  accountLedger,
  allocationJson,
  balanceSheet,
  decideException,
  exceptionJson,
  expectationJson,
  incomeStatement,
  journalCsvRows,
  journalEntryJson,
  moveAccount,
  movementJson,
  outboxEventJson,
  parseAsset,
  resolutionJson,
  trialBalance,
} from '@nostro-labs/nostro'
import type { Authenticate } from './auth.js'
import { buildOpenApi } from './openapi.js'
import { HttpProblem } from './problem.js'
import { UINT64, amendExpectationBody, cancelExpectationBody, expectationBody, idParams, query, resolveBody } from './schemas.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** Set from the API key before any `/v1` handler runs. */
    tenantId: string
  }
}

export interface ServerOptions {
  readonly store: Store
  readonly authenticate: Authenticate
  /** Passed to Fastify; `false` (the default) for no request log. */
  readonly logger?: FastifyServerOptions['logger']
}

const UINT64_MAX = (1n << 64n) - 1n

interface Paging {
  after?: number
  limit: number
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** A page of rows, and where the next one starts if this one was full. */
function page<T extends { seq: number }, J>(rows: readonly T[], limit: number, json: (row: T) => J) {
  return { data: rows.map(json), next: rows.length === limit ? rows[rows.length - 1]!.seq : null }
}

const after = (q: Paging) => (q.after === undefined ? {} : { afterSeq: q.after })

interface ExpectationBody {
  reference: string
  account: string
  amount: string
  asset?: string
  direction?: 'credit' | 'debit'
  muxedId?: string | 'issue'
  memo?: { type: 'text' | 'id' | 'hash'; value: string }
  payers?: string[]
  dueAt?: string
  expiresAt?: string
  metadata?: Record<string, string>
}

/**
 * The validator coerces types, which querystrings need, but in a body it
 * would turn `"amount": 1e21` into a string after JSON.parse had already
 * rounded it. No body field is a number or a boolean, so any is refused.
 */
function onlyStrings(value: unknown, path: string): void {
  if (typeof value === 'number' || typeof value === 'boolean') {
    throw new HttpProblem(400, 'invalid_request', `body${path} must be a string: amounts and ids are sent as strings.`)
  }
  if (Array.isArray(value)) value.forEach((v, i) => onlyStrings(v, `${path}[${i}]`))
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) onlyStrings(v, `${path}.${k}`)
  }
}

const invalid = (detail: string) => new HttpProblem(422, 'invalid_expectation', detail)

function uint64(field: string, value: string): bigint {
  const n = BigInt(value)
  if (n > UINT64_MAX) throw invalid(`${field} must be below 2^64.`)
  return n
}

function toNewExpectation(tenantId: string, b: ExpectationBody): NewExpectation {
  let asset: AssetId
  try {
    asset = b.asset === undefined || b.asset === 'native' ? NATIVE : parseAsset(b.asset)
  } catch (err) {
    if (err instanceof InvalidAssetError) throw invalid(`asset must be "native" or CODE:ISSUER: ${err.message}`)
    throw err
  }
  let amount: Money
  try {
    amount = Money.parse(b.amount, asset)
  } catch (err) {
    if (err instanceof PrecisionError) throw invalid(`amount: ${err.message}`)
    throw err
  }
  let memo: Memo | null = null
  if (b.memo?.type === 'text') {
    if (Buffer.byteLength(b.memo.value, 'utf8') > 28) throw invalid('memo.value must fit in a text memo: 28 bytes.')
    memo = { type: 'text', value: b.memo.value }
  } else if (b.memo?.type === 'id') {
    if (!new RegExp(UINT64).test(b.memo.value)) throw invalid('memo.value must be a whole number for an id memo.')
    memo = { type: 'id', value: uint64('memo.value', b.memo.value) }
  } else if (b.memo?.type === 'hash') {
    if (!/^[0-9a-f]{64}$/.test(b.memo.value)) throw invalid('memo.value must be 64 lowercase hex characters for a hash memo.')
    memo = { type: 'hash', value: b.memo.value }
  }
  return {
    tenantId,
    reference: b.reference,
    account: b.account,
    direction: b.direction ?? 'credit',
    amount,
    muxedId: b.muxedId === undefined ? null : b.muxedId === 'issue' ? 'issue' : uint64('muxedId', b.muxedId),
    memo,
    payers: b.payers ?? [],
    dueAt: b.dueAt === undefined ? null : new Date(b.dueAt),
    expiresAt: b.expiresAt === undefined ? null : new Date(b.expiresAt),
    metadata: b.metadata ?? {},
  }
}

export function createServer(options: ServerOptions): FastifyInstance {
  const { store, authenticate } = options
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 64 * 1024,
    // Reject what the schemas do not name, rather than silently dropping it.
    ajv: { customOptions: { removeAdditional: false } },
  })
  app.decorateRequest('tenantId', '')

  app.setErrorHandler((err: FastifyError, request, reply) => {
    let problem: HttpProblem
    if (err instanceof HttpProblem) problem = err
    else if (err.validation !== undefined) problem = new HttpProblem(400, 'invalid_request', err.message)
    else if (err instanceof ValidationError) problem = invalid(err.message)
    else if (err instanceof ConstraintError && err.constraint === 'expectation_reference_unique') {
      problem = new HttpProblem(409, 'reference_taken', 'An expectation with this reference already exists.')
    } else if (err instanceof ConstraintError && err.constraint === 'expectation_muxed_id_unique') {
      problem = new HttpProblem(409, 'muxed_id_taken', 'That muxed id is already used for an expectation on this account.')
    } else if (err instanceof ConstraintError && (err.constraint === 'expectation_not_amendable' || err.constraint === 'amendment_below_allocated' || err.constraint === 'expectation_has_allocations' || err.constraint === 'expectation_not_open')) {
      problem = new HttpProblem(409, 'expectation_conflict', err.message)
    } else if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
      problem = new HttpProblem(400, 'invalid_request', err.message)
    } else {
      request.log.error({ err }, 'request failed')
      // Say nothing about the inside of the server to a caller.
      problem = new HttpProblem(500, 'internal', 'The request could not be completed.')
    }
    if (problem.status === 401) void reply.header('www-authenticate', 'Bearer')
    return reply.code(problem.status).type('application/problem+json').send(problem.toJSON())
  })
  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .type('application/problem+json')
      .send(new HttpProblem(404, 'not_found', `No route for ${request.method} ${request.url.split('?')[0]}.`).toJSON()),
  )

  app.get('/v1/health', async () => ({ ok: true }))
  const openapi = buildOpenApi()
  app.get('/v1/openapi.json', async () => openapi)

  app.register(
    async (v1) => {
      v1.addHook('onRequest', async (request) => {
        const header = request.headers.authorization
        const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
        const tenantId = token === '' ? null : await authenticate(token)
        if (tenantId === null) throw new HttpProblem(401, 'unauthorized', 'Send Authorization: Bearer <API key>.')
        request.tenantId = tenantId
      })

      v1.get<{ Querystring: Paging & { disposition?: Disposition; account?: string } }>(
        '/movements',
        { schema: { querystring: query.movements } },
        async ({ tenantId, query: q }) =>
          page(
            await store.listMovements({
              tenantId,
              limit: q.limit,
              ...after(q),
              ...(q.disposition === undefined ? {} : { disposition: q.disposition }),
              ...(q.account === undefined ? {} : { account: q.account }),
            }),
            q.limit,
            movementJson,
          ),
      )

      v1.get<{ Params: { id: string } }>('/movements/:id', { schema: { params: idParams } }, async ({ tenantId, params }) => {
        const movement = await store.getMovement(tenantId, params.id)
        if (movement === null) throw new HttpProblem(404, 'not_found', `No movement ${params.id}.`)
        const movementId = movement.id
        return {
          movement: movementJson(movement),
          allocations: (await store.listAllocations({ tenantId, movementId })).map(allocationJson),
          exceptions: (await store.listExceptions({ tenantId, movementId })).map(exceptionJson),
          journal: (await store.listJournalEntries({ tenantId, movementId })).map(journalEntryJson),
        }
      })

      v1.get<{ Querystring: Paging & { status?: string; account?: string } }>(
        '/expectations',
        { schema: { querystring: query.expectations } },
        async ({ tenantId, query: q }) =>
          page(
            await store.listExpectations({
              tenantId,
              limit: q.limit,
              ...after(q),
              ...(q.status === undefined ? {} : { status: q.status.split(',') as ExpectationStatus[] }),
              ...(q.account === undefined ? {} : { account: q.account }),
            }),
            q.limit,
            expectationJson,
          ),
      )

      v1.get<{ Params: { id: string } }>('/expectations/:id', { schema: { params: idParams } }, async ({ tenantId, params }) => {
        const expectation = await store.getExpectation(tenantId, params.id)
        if (expectation === null) throw new HttpProblem(404, 'not_found', `No expectation ${params.id}.`)
        const allocations = await store.listAllocations({ tenantId, expectationId: expectation.id })
        return { expectation: expectationJson(expectation), allocations: allocations.map(allocationJson) }
      })

      v1.post<{ Body: ExpectationBody }>(
        '/expectations',
        { schema: { body: expectationBody }, preValidation: async (request) => onlyStrings(request.body, '') },
        async (request, reply) => {
          const created = await store.transaction((tx) => tx.insertExpectation(toNewExpectation(request.tenantId, request.body)))
          return reply.code(201).header('location', `/v1/expectations/${created.id}`).send(expectationJson(created))
        },
      )

      v1.post<{ Params: { id: string }; Body: { reason: string } }>(
        '/expectations/:id/cancel',
        { schema: { params: idParams, body: cancelExpectationBody }, preValidation: async (request) => onlyStrings(request.body, '') },
        async ({ tenantId, params, body }) => {
          try {
            const cancelled = await store.transaction((tx) => tx.cancelExpectation(tenantId, params.id, body.reason))
            return expectationJson(cancelled)
          } catch (err) {
            if (err instanceof NotFoundError) throw new HttpProblem(404, 'not_found', `No expectation ${params.id}.`)
            if (err instanceof ValidationError) throw invalid(err.message)
            throw err
          }
        },
      )

      v1.post<{ Params: { id: string }; Body: { reason: string; amount?: string; muxedId?: string | null; memo?: { type: 'text' | 'id'; value: string } | null; payers?: string[]; dueAt?: string | null; expiresAt?: string | null; metadata?: Record<string, string> } }>(
        '/expectations/:id/amend',
        { schema: { params: idParams, body: amendExpectationBody }, preValidation: async (request) => onlyStrings(request.body, '') },
        async ({ tenantId, params, body }) => {
          try {
            const { reason, ...rest } = body
            const changes: Mutable<ExpectationChanges> = {}
            if (rest.amount !== undefined) {
              const current = await store.getExpectation(tenantId, params.id)
              if (current === null) throw new HttpProblem(404, 'not_found', `No expectation ${params.id}.`)
              try { changes.amount = Money.parse(rest.amount, current.amount.asset, current.amount.decimals) } catch (err) {
                if (err instanceof PrecisionError) throw invalid(`amount: ${(err as Error).message}`)
                throw err
              }
            }
            if (rest.muxedId !== undefined) changes.muxedId = rest.muxedId === null ? null : uint64('muxedId', rest.muxedId)
            if (rest.memo !== undefined) {
              if (rest.memo === null) changes.memo = null
              else if (rest.memo.type === 'text') {
                if (Buffer.byteLength(rest.memo.value, 'utf8') > 28) throw invalid('memo.value must fit in a text memo: 28 bytes.')
                changes.memo = { type: 'text', value: rest.memo.value }
              } else if (rest.memo.type === 'id') {
                if (!new RegExp(UINT64).test(rest.memo.value)) throw invalid('memo.value must be a whole number for an id memo.')
                changes.memo = { type: 'id', value: uint64('memo.value', rest.memo.value) }
              } else {
                if (!/^[0-9a-f]{64}$/.test(rest.memo.value)) throw invalid('memo.value must be a 64-character lowercase hex hash.')
                changes.memo = { type: 'hash', value: rest.memo.value }
              }
            }
            if (rest.payers !== undefined) changes.payers = rest.payers
            if (rest.dueAt !== undefined) changes.dueAt = rest.dueAt === null ? null : new Date(rest.dueAt)
            if (rest.expiresAt !== undefined) changes.expiresAt = rest.expiresAt === null ? null : new Date(rest.expiresAt)
            if (rest.metadata !== undefined) changes.metadata = rest.metadata
            const amended = await store.transaction((tx) => tx.amendExpectation(tenantId, params.id, changes, reason))
            return expectationJson(amended)
          } catch (err) {
            if (err instanceof NotFoundError) throw new HttpProblem(404, 'not_found', `No expectation ${params.id}.`)
            if (err instanceof ValidationError) throw invalid(err.message)
            throw err
          }
        },
      )

      v1.get<{ Querystring: Paging & { status?: ExceptionStatus; code?: ExceptionCode } }>(
        '/exceptions',
        { schema: { querystring: query.exceptions } },
        async ({ tenantId, query: q }) =>
          page(
            await store.listExceptions({
              tenantId,
              limit: q.limit,
              ...after(q),
              ...(q.status === undefined ? {} : { status: q.status }),
              ...(q.code === undefined ? {} : { code: q.code }),
            }),
            q.limit,
            exceptionJson,
          ),
      )

      v1.get<{ Querystring: Paging }>('/events', { schema: { querystring: query.events } }, async ({ tenantId, query: q }) =>
        page(await store.listEvents({ tenantId, limit: q.limit, ...after(q) }), q.limit, outboxEventJson),
      )

      v1.post<{ Params: { id: string }; Body: ExceptionDecision }>(
        '/exceptions/:id/resolve',
        { schema: { params: idParams, body: resolveBody }, preValidation: async (request) => onlyStrings(request.body, '') },
        async ({ tenantId, params, body }) => {
          try {
            return resolutionJson(await decideException({ store, tenantId, exceptionId: params.id, decision: body }))
          } catch (err) {
            if (err instanceof NotFoundError) {
              if (err.entity === 'exception') throw new HttpProblem(404, 'not_found', `No exception ${params.id}.`)
              throw new HttpProblem(422, 'invalid_resolution', `No ${err.entity} ${err.id}.`)
            }
            if (err instanceof ValidationError || err instanceof PrecisionError) throw new HttpProblem(422, 'invalid_resolution', err.message)
            if (err instanceof ConstraintError) throw new HttpProblem(409, 'resolution_refused', err.message)
            throw err
          }
        },
      )

      const dates = (q: { from?: string; to?: string }) => ({
        ...(q.from === undefined ? {} : { effectiveFrom: new Date(q.from) }),
        ...(q.to === undefined ? {} : { effectiveBefore: new Date(q.to) }),
      })

      v1.get<{ Querystring: Paging & { from?: string; to?: string } }>(
        '/journal',
        { schema: { querystring: query.journal } },
        async ({ tenantId, query: q }) =>
          page(await store.listJournalEntries({ tenantId, limit: q.limit, ...after(q), ...dates(q) }), q.limit, journalEntryJson),
      )

      v1.get<{ Querystring: { from?: string; to?: string } }>(
        '/journal.csv',
        { schema: { querystring: query.journalCsv } },
        async ({ tenantId, query: q }, reply) => {
          const { effectiveFrom, effectiveBefore } = dates(q)
          const rows = journalCsvRows({
            store,
            tenantId,
            ...(effectiveFrom === undefined ? {} : { from: effectiveFrom }),
            ...(effectiveBefore === undefined ? {} : { to: effectiveBefore }),
          })
          return reply
            .type('text/csv; charset=utf-8')
            .header('content-disposition', 'attachment; filename="journal.csv"')
            .send(Readable.from(rows))
        },
      )

      // ---- Reports (issue #56, #57) ----------------------------------------

      v1.get<{ Querystring: { asOf?: string } }>(
        '/reports/trial-balance',
        { schema: { querystring: { type: 'object', additionalProperties: false, properties: { asOf: { type: 'string', format: 'date-time' } } } } },
        async ({ tenantId, query: q }) => {
          const asOf = q.asOf !== undefined ? new Date(q.asOf) : undefined
          const report = await trialBalance({ store, tenantId, ...(asOf !== undefined ? { asOf } : {}) })
          return {
            balanced: report.balanced,
            assetTotals: report.assetTotals.map((t) => ({ asset: t.asset, net: t.net.toString() })),
            lines: report.lines.map((l) => ({
              account: l.account,
              asset: l.asset,
              totalDebits: l.totalDebits.toString(),
              totalCredits: l.totalCredits.toString(),
              netBalance: l.netBalance.toString(),
            })),
          }
        },
      )

      v1.get<{ Querystring: { account: string; asset: string; from?: string; to?: string } }>(
        '/reports/ledger',
        {
          schema: {
            querystring: {
              type: 'object',
              required: ['account', 'asset'],
              additionalProperties: false,
              properties: {
                account: { type: 'string' },
                asset: { type: 'string' },
                from: { type: 'string', format: 'date-time' },
                to: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
        async ({ tenantId, query: q }) => {
          const from = q.from !== undefined ? new Date(q.from) : undefined
          const to = q.to !== undefined ? new Date(q.to) : undefined
          const ledger = await accountLedger({
            store,
            tenantId,
            account: q.account,
            asset: q.asset,
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
          })
          return {
            account: ledger.account,
            asset: ledger.asset,
            openingBalance: ledger.openingBalance.toString(),
            closingBalance: ledger.closingBalance.toString(),
            lines: ledger.lines.map((l) => ({
              entryId: l.entryId,
              seq: l.seq,
              kind: l.kind,
              effectiveAt: l.effectiveAt.toISOString(),
              postedAt: l.postedAt.toISOString(),
              description: l.description,
              side: l.side,
              amount: l.amount.toString(),
              asset: l.amount.asset,
              movementId: l.movementId,
              runningBalance: l.runningBalance.toString(),
            })),
          }
        },
      )

      v1.get<{ Querystring: { asOf?: string } }>(
        '/reports/balance-sheet',
        { schema: { querystring: { type: 'object', additionalProperties: false, properties: { asOf: { type: 'string', format: 'date-time' } } } } },
        async ({ tenantId, query: q }) => {
          const asOf = q.asOf !== undefined ? new Date(q.asOf) : undefined
          const bs = await balanceSheet({ store, tenantId, ...(asOf !== undefined ? { asOf } : {}) })
          return {
            asOf: bs.asOf?.toISOString() ?? null,
            balanced: bs.balanced,
            currentEarnings: bs.currentEarnings.map((e) => ({ asset: e.asset, amount: e.amount.toString() })),
            sections: bs.sections.map((s) => ({
              kind: s.kind,
              accounts: s.accounts.map((a) => ({ account: a.account, asset: a.asset, balance: a.balance.toString() })),
            })),
          }
        },
      )

      v1.get<{ Querystring: { from?: string; to?: string } }>(
        '/reports/income',
        { schema: { querystring: { type: 'object', additionalProperties: false, properties: { from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' } } } } },
        async ({ tenantId, query: q }) => {
          const from = q.from !== undefined ? new Date(q.from) : undefined
          const to = q.to !== undefined ? new Date(q.to) : undefined
          const stmt = await incomeStatement({
            store,
            tenantId,
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
          })
          return {
            from: stmt.from?.toISOString() ?? null,
            to: stmt.to?.toISOString() ?? null,
            netResult: stmt.netResult.map((r) => ({ asset: r.asset, amount: r.amount.toString() })),
            lines: stmt.lines.map((l) => ({
              account: l.account,
              kind: l.kind,
              asset: l.asset,
              amount: l.amount.toString(),
            })),
          }
        },
      )

      // ---- Account migration (issue #55) ------------------------------------

      v1.post<{ Body: { from: string; to: string; note?: string; effectiveAt?: string } }>(
        '/chart/move',
        {
          schema: {
            body: {
              type: 'object',
              additionalProperties: false,
              required: ['from', 'to'],
              properties: {
                from: { type: 'string', minLength: 1, maxLength: 256 },
                to: { type: 'string', minLength: 1, maxLength: 256 },
                note: { type: 'string', minLength: 1, maxLength: 2000 },
                effectiveAt: { type: 'string', format: 'date-time' },
              },
            },
          },
          preValidation: async (request) => {
            if (typeof (request.body as Record<string, unknown>)?.from !== 'string' ||
                typeof (request.body as Record<string, unknown>)?.to !== 'string') {
              throw new HttpProblem(400, 'invalid_request', 'body.from and body.to must be strings.')
            }
          },
        },
        async ({ tenantId, body }) => {
          try {
            const result = await moveAccount({
              store,
              tenantId,
              from: body.from,
              to: body.to,
              ...(body.note !== undefined ? { note: body.note } : {}),
              ...(body.effectiveAt !== undefined ? { effectiveAt: new Date(body.effectiveAt) } : {}),
            })
            return { moved: result.moved, assets: result.assets }
          } catch (err) {
            if (err instanceof Error && err.message.includes('cash account')) {
              throw new HttpProblem(422, 'invalid_request', err.message)
            }
            if (err instanceof ConstraintError && err.constraint === 'journal_period_closed') {
              throw new HttpProblem(409, 'resolution_refused', err.message)
            }
            throw err
          }
        },
      )
    },
    { prefix: '/v1' },
  )

  return app
}
