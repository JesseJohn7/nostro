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
import type { AssetId, Disposition, ExceptionCode, ExceptionDecision, ExceptionStatus, ExpectationChanges, ExpectationStatus, LineRole, Memo, MovementKind, NewExpectation, NewSchedule, Store } from '@nostro-labs/nostro'
import {
  ConsumerPositionConflict,
  ConstraintError,
  EventHistoryPrunedError,
  InvalidAssetError,
  InvalidRewindError,
  Money,
  NATIVE,
  NotFoundError,
  PrecisionError,
  ValidationError,
  accountLedger,
  DEFAULT_STRATEGIES,
  allocationJson,
  balanceSheet,
  consumerStatusJson,
  decideException,
  decideExceptions,
  deliveryAttemptJson,
  exceptionJson,
  expectationJson,
  scheduleJson,
  explainMovement,
  getConsumerStatus,
  incomeStatement,
  journalCsvRows,
  journalEntryJson,
  refundLinkJson,
  moveAccount,
  movementJson,
  outboxEventJson,
  parseAsset,
  postManualEntry,
  replayDecisions,
  resolutionJson,
  rewindConsumer,
  rewindJson,
  trialBalance,
} from '@nostro-labs/nostro'
import type { Authenticate, Principal } from './auth.js'
import { ROUTE_SCOPES } from './scopes.js'
import { buildOpenApi } from './openapi.js'
import { HttpProblem } from './problem.js'
import { UINT64, accountBody, accountParams, amendExpectationBody, batchResolveBody, cancelExpectationBody, consumerParams, createRoundBody, expectationBody, idParams, postJournalBody, query, removeAccountQuery, replayBody, resolveBody, scheduleBody } from './schemas.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** Set from the API key before any `/v1` handler runs. */
    tenantId: string
    /** The key's principal (tenant, scopes, key id); set before any `/v1` handler runs. */
    principal: Principal | undefined
  }
}

export interface RoundSummary {
  readonly movementsInserted: number
  readonly movementsDecided: number
  readonly errors: readonly { readonly account?: string | null; readonly message: string }[]
}

export type RoundState = 'queued' | 'running' | 'done' | 'failed'

export interface RoundRecord {
  readonly id: string
  readonly tenantId: string
  readonly account?: string | null
  readonly state: RoundState
  readonly queuedAt: string
  readonly startedAt?: string | null
  readonly finishedAt?: string | null
  readonly summary?: RoundSummary | null
  readonly error?: string | null
}

export interface RoundRunner {
  triggerRound(tenantId: string, account?: string): Promise<{ id: string; round: RoundRecord }>
  getRound(tenantId: string, id: string): Promise<RoundRecord | null>
}

export interface ServerOptions {
  readonly store: Store
  readonly authenticate: Authenticate
  /** Passed to Fastify; `false` (the default) for no request log. */
  readonly logger?: FastifyServerOptions['logger']
  readonly roundRunner?: RoundRunner
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

/** A watched account, with what its worker last did for it on each network and source. */
function watchedAccountJson(
  row: { account: string; source: string; addedAt: Date },
  states: readonly { network: string; source: string; cursor: string | null; lastAttemptAt: Date; lastSuccessAt: Date | null; caughtUp: boolean; lastError: string | null; lastErrorAt: Date | null }[],
) {
  return {
    account: row.account,
    source: row.source,
    addedAt: row.addedAt.toISOString(),
    sync: states.map((s) => ({
      network: s.network,
      source: s.source,
      cursor: s.cursor,
      lastAttemptAt: s.lastAttemptAt.toISOString(),
      lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null,
      caughtUp: s.caughtUp,
      lastError: s.lastError,
      lastErrorAt: s.lastErrorAt?.toISOString() ?? null,
    })),
  }
}

interface PostJournalBody {
  description: string
  reason: string
  note?: string
  postedBy?: string
  movementId?: string
  effectiveAt?: string
  lines: {
    account: string
    role: LineRole
    side: 'debit' | 'credit'
    amount: string
    asset?: string
  }[]
}

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

interface ScheduleBody { referencePattern:string; account:string; amount:string; asset?:string; direction?:'credit'|'debit'; memo?:{type:'text'|'id'|'hash'|'return'; value:string}; payers?:string[]; cadence:{kind:'daily'}|{kind:'weekly';day:number}|{kind:'monthly';day:number}; startAt:string; endAt?:string }
function toNewSchedule(tenantId: string, b: ScheduleBody): NewSchedule {
  let asset: AssetId
  try { asset = b.asset === undefined || b.asset === 'native' ? NATIVE : parseAsset(b.asset) } catch (err) {
    if (err instanceof InvalidAssetError) throw invalid(`asset must be "native" or CODE:ISSUER: ${err.message}`)
    throw err
  }
  let amount: Money
  try { amount = Money.parse(b.amount, asset) } catch (err) {
    if (err instanceof PrecisionError) throw invalid(`amount: ${err.message}`)
    throw err
  }
  let memo: NewSchedule['memo']
  if (b.memo) {
    if (b.memo.type === 'text') {
      if (Buffer.byteLength(b.memo.value,'utf8') > 28) throw invalid('memo.value must fit in a text memo: 28 bytes.')
      memo = { type:'text', value:b.memo.value }
    } else if (b.memo.type === 'id') memo = { type:'id', value:uint64('memo.value', b.memo.value) }
    else if (b.memo.type === 'hash' || b.memo.type === 'return') {
      if (!/^[0-9a-f]{64}$/i.test(b.memo.value)) throw invalid('memo.value must be 64 hex characters.')
      memo = { type:b.memo.type, value:b.memo.value.toLowerCase() }
    }
  }
  const cadence = b.cadence.kind === 'daily' ? { type: 'daily' as const } : b.cadence.kind === 'weekly' ? { type: 'weekly' as const, dayOfWeek: b.cadence.day } : { type: 'monthly' as const, dayOfMonth: b.cadence.day }
  return { tenantId, referencePattern:b.referencePattern, account:b.account, direction:b.direction ?? 'credit', amount, ...(memo ? { memo } : {}), payers:b.payers ?? [], cadence, startAt:new Date(b.startAt), ...(b.endAt ? { endAt:new Date(b.endAt) } : {}) }
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
  app.decorateRequest('principal', undefined)

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
    } else if (err instanceof ConsumerPositionConflict) {
      problem = new HttpProblem(409, 'consumer_position_conflict', err.message)
    } else if (err instanceof InvalidRewindError) {
      problem = new HttpProblem(422, 'invalid_replay', err.message)
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
        const principal = token === '' ? null : await authenticate(token)
        if (principal === null) throw new HttpProblem(401, 'unauthorized', 'Send Authorization: Bearer <API key>.')
        // Fail closed: a route with no declared scope is refused, not opened.
        const needed = ROUTE_SCOPES[`${request.method} ${request.routeOptions.url}`]
        if (needed === undefined || !principal.scopes.has(needed)) {
          throw new HttpProblem(403, 'forbidden', `This API key lacks the "${needed ?? 'required'}" scope for this route.`)
        }
        request.principal = principal
        request.tenantId = principal.tenantId
      })

      v1.get('/accounts', async ({ tenantId }) => {
        const [watched, states] = await Promise.all([store.listWatchedAccounts(tenantId), store.listSyncState(tenantId)])
        return {
          data: watched.map((w) => watchedAccountJson(w, states.filter((s) => s.account === w.account))),
        }
      })

      v1.post<{ Body: { account: string } }>('/accounts', { schema: { body: accountBody } }, async ({ tenantId, body }, reply) => {
        const already = (await store.listWatchedAccounts(tenantId)).some((w) => w.account === body.account)
        const row = await store.transaction((tx) =>
          tx.addWatchedAccount({ tenantId, account: body.account, source: 'api', addedAt: new Date() }),
        )
        const json = watchedAccountJson(row, [])
        if (already) return reply.code(200).send(json)
        return reply.code(201).header('location', `/v1/accounts/${body.account}`).send(json)
      })

      v1.post<{ Body: { account?: string } }>('/rounds', { schema: { body: createRoundBody } }, async (request, reply) => {
        const { tenantId, body } = request
        if (options.roundRunner === undefined) {
          throw new HttpProblem(501, 'not_supported', 'Manual rounds are not supported in this server configuration (serve hook not configured).')
        }
        const { id, round } = await options.roundRunner.triggerRound(tenantId, body?.account)
        return reply.code(202).header('location', `/v1/rounds/${id}`).send(round)
      })

      v1.get<{ Params: { id: string } }>('/rounds/:id', { schema: { params: idParams } }, async (request, reply) => {
        const { tenantId, params } = request
        if (options.roundRunner === undefined) {
          throw new HttpProblem(501, 'not_supported', 'Manual rounds are not supported in this server configuration.')
        }
        const round = await options.roundRunner.getRound(tenantId, params.id)
        if (round === null || round.tenantId !== tenantId) {
          throw new HttpProblem(404, 'not_found', `Round ${params.id} not found.`)
        }
        return reply.code(200).send(round)
      })

      v1.delete<{ Params: { account: string }; Querystring: { force?: boolean } }>(
        '/accounts/:account',
        { schema: { params: accountParams, querystring: removeAccountQuery } },
        async (request, reply) => {
          const { tenantId, params, query: q } = request
          const watched = (await store.listWatchedAccounts(tenantId)).find((w) => w.account === params.account)
          if (watched === undefined) throw new HttpProblem(404, 'not_found', `Account ${params.account} is not on the watch list.`)
          if (watched.source === 'config') {
            throw new HttpProblem(409, 'config_managed', `${params.account} comes from the service configuration; remove it there.`)
          }
          if (q.force !== true) {
            const open = await store.listExpectations({ tenantId, account: params.account, status: ['open', 'partially_paid'], limit: 1 })
            if (open.length > 0) {
              throw new HttpProblem(
                409,
                'has_open_expectations',
                `${params.account} has open expectations; pass force=true to stop watching it anyway. Its movements and expectations are kept.`,
              )
            }
          }
          await store.transaction((tx) => tx.removeWatchedAccount(tenantId, params.account))
          return reply.code(204).send()
        },
      )

      v1.get<{
        Querystring: Paging & {
          disposition?: Disposition
          account?: string
          entityId?: string
          txHash?: string
          from?: string
          to?: string
          fromLedger?: number
          toLedger?: number
          counterparty?: string
          kind?: MovementKind
        }
      }>(
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
              ...(q.entityId === undefined ? {} : { entityId: q.entityId }),
              ...(q.txHash === undefined ? {} : { txHash: q.txHash }),
              ...(q.from === undefined ? {} : { occurredFrom: new Date(q.from) }),
              ...(q.to === undefined ? {} : { occurredBefore: new Date(q.to) }),
              ...(q.fromLedger === undefined ? {} : { fromLedger: q.fromLedger }),
              ...(q.toLedger === undefined ? {} : { toLedger: q.toLedger }),
              ...(q.counterparty === undefined ? {} : { counterparty: q.counterparty }),
              ...(q.kind === undefined ? {} : { kind: q.kind }),
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
          refunds: (await store.listRefundLinks({ tenantId, movementIds: [movementId] })).map(refundLinkJson),
          allocations: (await store.listAllocations({ tenantId, movementId })).map(allocationJson),
          exceptions: (await store.listExceptions({ tenantId, movementId })).map(exceptionJson),
          journal: (await store.listJournalEntries({ tenantId, movementId })).map(journalEntryJson),
          decision: (await store.getDecision(tenantId, movementId))?.snapshot ?? null,
        }
      })

      v1.get<{ Params: { id: string } }>('/movements/:id/explain', { schema: { params: idParams } }, async ({ tenantId, params }) =>
        explainMovement({ store, tenantId, movementId: params.id }),
      )

      v1.get<{ Querystring: { from?: string; to?: string; threshold?: number; margin?: number; strategy?: string | string[]; limit?: number } }>(
        '/decisions/replay',
        { schema: { querystring: query.decisionReplay } },
        async ({ tenantId, query: q }) => {
          const options: { threshold?: number; margin?: number; strategies?: readonly (typeof DEFAULT_STRATEGIES)[number][] } = {}
          if (q.threshold !== undefined) options.threshold = q.threshold
          if (q.margin !== undefined) options.margin = q.margin
          if (q.strategy !== undefined) {
            options.strategies = (Array.isArray(q.strategy) ? q.strategy : [q.strategy]).map((name) => {
              const strategy = DEFAULT_STRATEGIES.find((s) => s.name === name)
              if (strategy === undefined) throw invalid(`unknown strategy: ${name}`)
              return strategy
            })
          }
          return replayDecisions({
            store,
            tenantId,
            ...(q.from === undefined ? {} : { from: new Date(q.from) }),
            ...(q.to === undefined ? {} : { to: new Date(q.to) }),
            ...(q.limit === undefined ? {} : { limit: q.limit }),
            options,
          })
        },
      )


      v1.get<{ Querystring: Paging & { activeOnly?: string } }>(
        '/schedules',
        { schema: { querystring: query.schedules } },
        async ({ tenantId, query: q }) => {
          const items = await store.listSchedules({ tenantId, limit: q.limit, ...(q.activeOnly === 'true' ? { activeOnly: true } : {}) })
          return { items: items.map(scheduleJson) }
        },
      )

      v1.post<{ Body: ScheduleBody }>(
        '/schedules',
        { schema: { body: scheduleBody }, preValidation: async (request) => onlyStrings(request.body, '') },
        async (request, reply) => {
          const created = await store.transaction((tx) => tx.insertSchedule(toNewSchedule(request.tenantId, request.body)))
          return reply.code(201).header('location', `/v1/schedules/${created.id}`).send(scheduleJson(created))
        },
      )

      v1.get<{ Params: { id: string } }>('/schedules/:id', { schema: { params: idParams } }, async ({ tenantId, params }) => {
        const sc = await store.getSchedule(tenantId, params.id)
        if (sc === null) throw new HttpProblem(404, 'not_found', `No schedule ${params.id}.`)
        return scheduleJson(sc)
      })

      v1.post<{ Params: { id: string } }>('/schedules/:id/end', { schema: { params: idParams } }, async ({ tenantId, params }) => {
        const sc = await store.getSchedule(tenantId, params.id)
        if (sc === null) throw new HttpProblem(404, 'not_found', `No schedule ${params.id}.`)
        if (sc.endedAt) return scheduleJson(sc)
        const ended = await store.transaction((tx) => tx.endSchedule(tenantId, params.id, new Date()))
        return scheduleJson(ended)
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

      v1.get<{ Querystring: { reference: string } }>(
        '/expectations/by-reference',
        { schema: { querystring: query.expectationByReference } },
        async ({ tenantId, query: q }) => {
          const expectation = await store.getExpectationByReference(tenantId, q.reference)
          if (expectation === null) throw new HttpProblem(404, 'not_found', `No expectation with reference ${q.reference}.`)
          const allocations = await store.listAllocations({ tenantId, expectationId: expectation.id })
          return { expectation: expectationJson(expectation), allocations: allocations.map(allocationJson) }
        },
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

      v1.get<{ Querystring: Paging & { status?: ExceptionStatus; code?: ExceptionCode; movementId?: string; expectationId?: string } }>(
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
              ...(q.movementId === undefined ? {} : { movementId: q.movementId }),
              ...(q.expectationId === undefined ? {} : { expectationId: q.expectationId }),
            }),
            q.limit,
            exceptionJson,
          ),
      )

      v1.get<{ Params: { id: string } }>('/exceptions/:id', { schema: { params: idParams } }, async ({ tenantId, params }) => {
        const exception = await store.getException(tenantId, params.id)
        if (exception === null) throw new HttpProblem(404, 'not_found', `No exception ${params.id}.`)
        const movement = exception.movementId ? await store.getMovement(tenantId, exception.movementId) : null
        const expectation = exception.expectationId ? await store.getExpectation(tenantId, exception.expectationId) : null
        return {
          exception: exceptionJson(exception),
          movement: movement ? movementJson(movement) : null,
          expectation: expectation ? expectationJson(expectation) : null,
        }
      })

      v1.get<{ Querystring: Paging }>('/events', { schema: { querystring: query.events } }, async ({ tenantId, query: q }) => {
        try {
          return page(await store.listEvents({ tenantId, limit: q.limit, ...after(q) }), q.limit, outboxEventJson)
        } catch (err) {
          if (err instanceof EventHistoryPrunedError) {
            throw new HttpProblem(
              410,
              'event_history_pruned',
              `Event history through sequence ${err.prunedThrough} was pruned; resume after that sequence.`,
            )
          }
          throw err
        }
      })

      // ---- Webhook delivery status and replay (issue #89) -----------------

      v1.get('/webhooks', async ({ tenantId }) => {
        const consumers = await store.listDeliveryConsumers(tenantId)
        const statuses = await Promise.all(consumers.map((consumer) => getConsumerStatus(store, tenantId, consumer)))
        return { data: statuses.map(consumerStatusJson) }
      })

      v1.get<{ Params: { consumer: string } }>(
        '/webhooks/:consumer/status',
        { schema: { params: consumerParams } },
        async ({ tenantId, params }) => consumerStatusJson(await getConsumerStatus(store, tenantId, params.consumer)),
      )

      v1.get<{ Params: { consumer: string }; Querystring: Paging & { outcome?: 'success' | 'failure' } }>(
        '/webhooks/:consumer/attempts',
        { schema: { params: consumerParams, querystring: query.webhookAttempts } },
        async ({ tenantId, params, query: q }) =>
          page(
            await store.listDeliveryAttempts({
              tenantId,
              consumer: params.consumer,
              limit: q.limit,
              ...(q.after === undefined ? {} : { beforeSeq: q.after }),
              ...(q.outcome === undefined ? {} : { outcome: q.outcome }),
            }),
            q.limit,
            deliveryAttemptJson,
          ),
      )

      v1.post<{ Params: { consumer: string }; Body: { expectedSeq: number; toSeq: number; actor: string } }>(
        '/webhooks/:consumer/replay',
        { schema: { params: consumerParams, body: replayBody } },
        async ({ tenantId, params, body }) => {
          try {
            return rewindJson(
              await rewindConsumer(store, {
                tenantId,
                consumer: params.consumer,
                expectedSeq: body.expectedSeq,
                toSeq: body.toSeq,
                actor: body.actor,
                at: new Date(),
              }),
            )
          } catch (err) {
            if (err instanceof EventHistoryPrunedError) {
              throw new HttpProblem(
                410,
                'event_history_pruned',
                `Event history through sequence ${err.prunedThrough} was pruned; resume after that sequence.`,
              )
            }
            throw err
          }
        },
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

      v1.post<{ Body: { mode: 'atomic' | 'row'; decisions: { exceptionId: string; decision: ExceptionDecision }[] } }>(
        '/exceptions/resolve',
        { schema: { body: batchResolveBody }, preValidation: async (request) => onlyStrings(request.body, '') },
        async ({ tenantId, body }, reply) => {
          try {
            const report = await decideExceptions({ store, tenantId, mode: body.mode, decisions: body.decisions })
            if (report.errors > 0 && report.mode === 'row') reply.code(207)
            return {
              mode: report.mode,
              applied: report.applied,
              errors: report.errors,
              results: report.results.map((r) => ({
                index: r.index,
                exceptionId: r.exceptionId,
                result: r.result ? resolutionJson(r.result) : null,
                error: r.error ?? null,
              })),
            }
          } catch (err) {
            if (err instanceof ValidationError || err instanceof PrecisionError) throw new HttpProblem(422, 'invalid_resolution', err.message)
            throw err
          }
        },
      )

      const dates = (q: { from?: string; to?: string }) => ({
        ...(q.from === undefined ? {} : { effectiveFrom: new Date(q.from) }),
        ...(q.to === undefined ? {} : { effectiveBefore: new Date(q.to) }),
      })
      const entityFilter = (q: { entityId?: string }) =>
        q.entityId === undefined ? {} : { entityId: q.entityId }

      v1.get<{ Querystring: Paging & { from?: string; to?: string; entityId?: string } }>(
        '/journal',
        { schema: { querystring: query.journal } },
        async ({ tenantId, query: q }) =>
          page(await store.listJournalEntries({ tenantId, limit: q.limit, ...after(q), ...dates(q), ...entityFilter(q) }), q.limit, journalEntryJson),
      )

      v1.post<{ Body: PostJournalBody }>(
        '/journal',
        { schema: { body: postJournalBody }, preValidation: async (request) => onlyStrings(request.body, '') },
        async ({ tenantId, body }, reply) => {
          try {
            const lines = body.lines.map((l) => {
              const assetId = l.asset === undefined || l.asset === 'native' ? NATIVE : parseAsset(l.asset)
              const amount = Money.parse(l.amount, assetId)
              return {
                account: l.account,
                role: l.role,
                side: l.side,
                amount,
              }
            })
            const entry = await postManualEntry({
              store,
              tenantId,
              description: body.description,
              reason: body.reason,
              ...(body.note !== undefined ? { note: body.note } : {}),
              ...(body.postedBy !== undefined ? { postedBy: body.postedBy } : {}),
              ...(body.movementId !== undefined ? { movementId: body.movementId } : {}),
              ...(body.effectiveAt !== undefined ? { effectiveAt: new Date(body.effectiveAt) } : {}),
              lines,
            })
            reply.status(201)
            return journalEntryJson(entry)
          } catch (err) {
            if (err instanceof ValidationError || err instanceof PrecisionError || err instanceof InvalidAssetError) {
              throw new HttpProblem(422, 'invalid_request', err.message)
            }
            if (err instanceof ConstraintError) {
              if (err.constraint === 'journal_cash_without_movement' || err.constraint === 'journal_unbalanced' || err.constraint === 'journal_manual_slot') {
                throw new HttpProblem(422, 'invalid_request', err.message)
              }
              if (err.constraint === 'journal_posting_conflict' || err.constraint === 'journal_period_closed') {
                throw new HttpProblem(409, 'resolution_refused', err.message)
              }
              throw new HttpProblem(409, 'resolution_refused', err.message)
            }
            throw err
          }
        },
      )

      v1.get<{ Querystring: { from?: string; to?: string; entityId?: string } }>(
        '/journal.csv',
        { schema: { querystring: query.journalCsv } },
        async ({ tenantId, query: q }, reply) => {
          const { effectiveFrom, effectiveBefore } = dates(q)
          const rows = journalCsvRows({
            store,
            tenantId,
            ...(effectiveFrom === undefined ? {} : { from: effectiveFrom }),
            ...(effectiveBefore === undefined ? {} : { to: effectiveBefore }),
            ...entityFilter(q),
          })
          return reply
            .type('text/csv; charset=utf-8')
            .header('content-disposition', 'attachment; filename="journal.csv"')
            .send(Readable.from(rows))
        },
      )

      // ---- Reports (issue #56, #57) ----------------------------------------

      v1.get<{ Querystring: { asOf?: string; entityId?: string } }>(
        '/reports/trial-balance',
        {
          schema: {
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: {
                asOf: { type: 'string', format: 'date-time' },
                entityId: { type: 'string', minLength: 1, maxLength: 100 },
              },
            },
          },
        },
        async ({ tenantId, query: q }) => {
          const asOf = q.asOf !== undefined ? new Date(q.asOf) : undefined
          const report = await trialBalance({ store, tenantId, ...(asOf !== undefined ? { asOf } : {}), ...entityFilter(q) })
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

      v1.get<{ Querystring: { account: string; asset: string; from?: string; to?: string; entityId?: string } }>(
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
                entityId: { type: 'string', minLength: 1, maxLength: 100 },
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
            ...entityFilter(q),
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

      v1.get<{ Querystring: { asOf?: string; entityId?: string } }>(
        '/reports/balance-sheet',
        {
          schema: {
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: {
                asOf: { type: 'string', format: 'date-time' },
                entityId: { type: 'string', minLength: 1, maxLength: 100 },
              },
            },
          },
        },
        async ({ tenantId, query: q }) => {
          const asOf = q.asOf !== undefined ? new Date(q.asOf) : undefined
          const bs = await balanceSheet({ store, tenantId, ...(asOf !== undefined ? { asOf } : {}), ...entityFilter(q) })
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

      v1.get<{ Querystring: { from?: string; to?: string; entityId?: string } }>(
        '/reports/income',
        {
          schema: {
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: {
                from: { type: 'string', format: 'date-time' },
                to: { type: 'string', format: 'date-time' },
                entityId: { type: 'string', minLength: 1, maxLength: 100 },
              },
            },
          },
        },
        async ({ tenantId, query: q }) => {
          const from = q.from !== undefined ? new Date(q.from) : undefined
          const to = q.to !== undefined ? new Date(q.to) : undefined
          const stmt = await incomeStatement({
            store,
            tenantId,
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
            ...entityFilter(q),
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
