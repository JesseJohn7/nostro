/**
 * A `Store` on PostgreSQL.
 *
 * Every rule comes from `nostro`'s shared store rules; this file only makes
 * the reads those rules depend on safe under concurrency. Rows a write
 * depends on are locked with `SELECT … FOR UPDATE` inside the transaction, so
 * two workers allocating against one expectation serialise on its row, and
 * a cursor read inside a transaction locks the cursor's row (creating it if
 * absent) until that transaction ends.
 *
 * Isolation is PostgreSQL's default, READ COMMITTED. Statements after a lock
 * wait see what the other transaction committed, which is exactly what the
 * over-allocation and compare-and-set checks need.
 */
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import pg from 'pg'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { EventHistoryPrunedError } from '@nostro-labs/nostro'
import type {
  AccountEntity,
  AccountEntityQuery,
  AccountOpening,
  AccountOpeningQuery,
  ApiKeyRow,
  NewApiKeyRow,
  SyncStateRow,
  WatchedAccountRow,
  Allocation,
  AllocationQuery,
  CursorKey,
  DecisionQuery,
  NewSchedule,
  Schedule,
  ScheduleQuery,
  DecisionRecord,
  DeliveryAttempt,
  DeliveryAttemptQuery,
  Disposition,
  Direction,
  Entity,
  EntityQuery,
  EventQuery,
  ExceptionQuery,
  ExceptionRecord,
  Expectation,
  ExpectationChanges,
  ExpectationQuery,
  InsertMovementsResult,
  InternalTransferLink,
  InternalTransferQuery,
  JournalEntry,
  JournalPeriod,
  JournalQuery,
  Memo,
  MigratableStore,
  Movement,
  MovementConflict,
  MovementQuery,
  NewAccountEntity,
  NewAccountOpening,
  NewAllocation,
  NewDecisionSnapshot,
  NewEntity,
  NewInternalTransferLink,
  NewException,
  NewExpectation,
  NewJournalEntry,
  NewMovement,
  NewDeliveryAttempt,
  NewOutboxEvent,
  OutboxEvent,
  Rewind,
  RewindInput,
  RewindQuery,
  PruneEventsResult,
  RefundLink,
  RefundQuery,
  Resolution,
  SchemaVersion,
  StoreReader,
  StoreTx,
  MovementValuation,
  NewMovementValuation,
  ValuationQuery,
} from '@nostro-labs/nostro'
import {
  refundParts,
  refundCoverage,
  refundLinkFromRow,
  postAccrual,
  Money,
  ConstraintError,
  NotFoundError,
  TransactionClosedError,
  assertValidNewAccountEntity,
  assertValidNewAccountOpening,
  assertValidNewAllocation,
  assertValidNewEntity,
  assertValidNewInternalTransferLink,
  assertValidNewException,
  assertValidNewExpectation,
  assertValidNewJournalEntry,
  assertValidNewMovement,
  DELIVERY_ATTEMPT_LIMIT,
  DELIVERY_ATTEMPT_TTL_MS,
  eventCursorKey,
  amendExpectationRecord,
  checkAllocation,
  checkCancel,
  checkCursorValue,
  checkDisposition,
  checkJournalEntry,
  checkJournalPeriodClose,
  checkJournalPeriodReopen,
  checkResolution,
  exceptionChanged,
  issueMuxedId,
  expectationAmended,
  expectationChanged,
  expectationReferenceKeys,
  movementDecided,
  sameFacts,
} from '@nostro-labs/nostro'
import type {
  AccountEntityRow,
  AccountOpeningRow,
  AllocationRow,
  DecisionRow,
  EntityRow,
  InternalTransferLinkRow,
  DeliveryAttemptRow,
  EventRow,
  ExceptionRow,
  ExpectationRow,
  JournalEntryRow,
  JournalLineRow,
  MovementRow,
  MovementValuationRow,
  ScheduleRow,
  RewindRow,
} from './rows.js'
import { memoColumns, storedOpeningBalance, toAccountEntity, toAccountOpening, toAllocation, toDecisionRecord, toDeliveryAttempt, toEntity, toEvent, toException, toExpectation, toInternalTransferLink, toJournalEntry, toMovement, toRewind, toSchedule, toValuation } from './rows.js'
import { MIGRATIONS, quoteSchema, rlsPolicySql, RLS_BYPASS_SETTING, RLS_TENANT_SETTING } from './schema.js'

export interface PostgresRlsOptions {
  /** Enable per-tenant isolation. Off by default. */
  readonly enabled: boolean
  /** GUC read by the RLS policies. Default `nostro.tenant`. */
  readonly tenantSetting?: string
  /** Role adopted by store transactions; use a NOBYPASSRLS role. */
  readonly appRole?: string
}

export interface PostgresStoreOptions {
  /** A pool you own. The store never ends it. */
  readonly pool?: Pool
  /** Or a connection string; the store creates a pool and ends it on `close()`. */
  readonly connectionString?: string
  /** PostgreSQL schema holding nostro's tables. Default `nostro`. */
  readonly schema?: string
  /** Id generator. Defaults to `crypto.randomUUID()`. */
  readonly ids?: () => string
  /** Clock for `createdAt` and friends. Defaults to `new Date()`. */
  readonly now?: () => Date
  /** Optional per-tenant row-level security. */
  readonly rls?: PostgresRlsOptions
}

export interface TenantScopedStore {
  readonly tenantId: string
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>
  getMovement(id: string): Promise<Movement | null>
  listMovements(query: Omit<MovementQuery, 'tenantId'>): Promise<Movement[]>
  listEvents(query: Omit<EventQuery, 'tenantId'>): Promise<OutboxEvent[]>
  getCursor(key: Omit<CursorKey, 'tenantId'>): Promise<string | null>
  findApiKeyByDigest(digest: string): Promise<ApiKeyRow | null>
  listApiKeys(): Promise<ApiKeyRow[]>
}

type Run = <R extends QueryResultRow>(sql: string, params?: readonly unknown[]) => Promise<R[]>

const tenantlessMethods = new Set(['findApiKeyByDigest', 'revokeApiKey', 'recordApiKeyUse', 'migrate', 'schemaVersion', 'close', 'transaction', 'forTenant'])

function tenantOf(method: string, args: readonly unknown[]): string | undefined {
  if (tenantlessMethods.has(method)) return undefined
  if (method === 'postAccrualExpectation') return typeof args[1] === 'string' ? args[1] : undefined
  const first: unknown = args[0]
  if (typeof first === 'string') return first
  if (Array.isArray(first)) {
    let found: string | undefined
    for (const row of first as readonly { readonly tenantId?: unknown }[]) {
      const tenantId = row?.tenantId
      if (typeof tenantId !== 'string' || (found !== undefined && found !== tenantId)) {
        throw new Error(`a batch in ${method} must belong to exactly one tenant`)
      }
      found = tenantId
    }
    return found
  }
  if (first !== null && typeof first === 'object' && 'tenantId' in first) {
    const tenantId = (first as { readonly tenantId?: unknown }).tenantId
    return typeof tenantId === 'string' ? tenantId : undefined
  }
  return undefined
}

class TenantPin {
  private pinned: string | undefined

  constructor(private readonly set: (tenantId: string) => Promise<void>) {}

  get tenant(): string | undefined {
    return this.pinned
  }

  async apply(tenantId: string | undefined): Promise<void> {
    if (tenantId === undefined) return
    if (this.pinned !== undefined && this.pinned !== tenantId) {
      throw new Error(`a transaction is pinned to tenant ${JSON.stringify(this.pinned)}, not ${JSON.stringify(tenantId)}`)
    }
    if (this.pinned === undefined) {
      await this.set(tenantId)
      this.pinned = tenantId
    }
  }
}

function tenantReadProxy<T extends object>(target: T, context: AsyncLocalStorage<string>): T {
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object)
      if (typeof property !== 'string' || typeof value !== 'function' || tenantlessMethods.has(property)) return value
      return (...args: unknown[]) => {
        const tenantId = tenantOf(property, args)
        return context.run(tenantId ?? '', () => (value as (...a: unknown[]) => unknown).apply(object, args))
      }
    },
  })
}

function tenantTxProxy(tx: PgTx, pin: TenantPin): StoreTx {
  return new Proxy(tx, {
    get(object, property) {
      const value = Reflect.get(object, property, object)
      if (typeof property !== 'string' || typeof value !== 'function' || property === 'close' || property === 'run') return value
      return async (...args: unknown[]) => {
        await pin.apply(tenantOf(property, args))
        return (value as (...a: unknown[]) => unknown).apply(object, args)
      }
    },
  }) as StoreTx
}

function quoteRole(role: string): string {
  if (role.trim() === '') throw new Error('appRole must be a non-empty PostgreSQL role name')
  return `"${role.replaceAll('"', '""')}"`
}

/** Builds `WHERE` clauses with numbered parameters. */
class Where {
  readonly params: unknown[] = []
  private readonly clauses: string[] = []

  add(sql: (p: string) => string, value: unknown): this {
    if (value !== undefined) {
      this.params.push(value)
      this.clauses.push(sql(`$${this.params.length}`))
    }
    return this
  }

  limit(n: number | undefined): string {
    if (n === undefined) return ''
    this.params.push(n)
    return ` LIMIT $${this.params.length}`
  }

  raw(sql:string): this { this.clauses.push(sql); return this }

  toString(): string {
    return this.clauses.length === 0 ? '' : ` WHERE ${this.clauses.join(' AND ')}`
  }
}

class PgReader implements StoreReader {
  constructor(
    protected readonly s: string,
    protected readonly run: Run,
  ) {}

  async getMovement(tenantId: string, id: string): Promise<Movement | null> {
    const [row] = await this.run<MovementRow>(
      `SELECT * FROM ${this.s}.movements WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    )
    return row === undefined ? null : toMovement(row)
  }

  async listMovements(q: MovementQuery): Promise<Movement[]> {
    if (q.ids?.length === 0) return []
    const w = new Where()
      .add((p) => `tenant_id = ${p}`, q.tenantId)
      .add((p) => `id = ANY(${p}::text[])`, q.ids === undefined ? undefined : [...q.ids])
      .add((p) => `disposition = ${p}`, q.disposition)
      .add((p) => `account = ${p}`, q.account)
      .add((p) => `entity_id = ${p}`, q.entityId)
      .add((p) => `tx_hash = ${p}`, q.txHash)
      .add((p) => `counterparty = ${p}`, q.counterparty)
      .add((p) => `kind = ${p}`, q.kind)
      .add((p) => `ledger >= ${p}`, q.fromLedger)
      .add((p) => `ledger < ${p}`, q.toLedger)
      .add((p) => `occurred_at >= ${p}`, q.occurredFrom)
      .add((p) => `occurred_at < ${p}`, q.occurredBefore)
      .add((p) => `seq > ${p}`, q.afterSeq)
    const sql = `SELECT * FROM ${this.s}.movements${w} ORDER BY seq${w.limit(q.limit)}`
    return (await this.run<MovementRow>(sql, w.params)).map(toMovement)
  }

  async getExpectation(tenantId: string, id: string): Promise<Expectation | null> {
    const [row] = await this.run<ExpectationRow>(
      `SELECT * FROM ${this.s}.expectations WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    )
    return row === undefined ? null : toExpectation(row)
  }

  async getExpectationByReference(tenantId: string, reference: string): Promise<Expectation | null> {
    const [row] = await this.run<ExpectationRow>(
      `SELECT * FROM ${this.s}.expectations WHERE tenant_id = $1 AND reference = $2`,
      [tenantId, reference],
    )
    return row === undefined ? null : toExpectation(row)
  }

  async getExpectationsByNormalizedReference(tenantId: string, normalized: string): Promise<Expectation[]> {
    if (normalized === '') return []
    const rows = await this.run<ExpectationRow>(
      `SELECT e.* FROM ${this.s}.expectation_reference_index k
         JOIN ${this.s}.expectations e ON e.id = k.expectation_id
        WHERE k.tenant_id = $1 AND k.normalized = $2
        ORDER BY e.seq`,
      [tenantId, normalized],
    )
    return rows.map(toExpectation)
  }

  async listExpectations(q: ExpectationQuery): Promise<Expectation[]> {
    if (q.ids?.length === 0) return []
    const w = new Where()
      .add((p) => `tenant_id = ${p}`, q.tenantId)
      .add((p) => `id = ANY(${p}::text[])`, q.ids === undefined ? undefined : [...q.ids])
      .add((p) => `account = ${p}`, q.account)
      .add((p) => `asset = ${p}`, q.asset)
      .add((p) => `direction = ${p}`, q.direction)
      .add((p) => `status = ANY(${p})`, q.status === undefined ? undefined : [...q.status])
      .add((p) => `muxed_id = ${p}`, q.muxedId === undefined ? undefined : q.muxedId.toString())
      .add((p) => `seq > ${p}`, q.afterSeq)
    const sql = `SELECT * FROM ${this.s}.expectations${w} ORDER BY seq${w.limit(q.limit)}`
    return (await this.run<ExpectationRow>(sql, w.params)).map(toExpectation)
  }

  async getSchedule(tenantId: string, id: string): Promise<Schedule | null> {
    const [row] = await this.run<ScheduleRow>(`SELECT * FROM ${this.s}.schedules WHERE tenant_id = $1 AND id = $2`, [tenantId, id])
    return row === undefined ? null : toSchedule(row)
  }

  async listSchedules(q: ScheduleQuery): Promise<Schedule[]> {
    const w = new Where().add((p) => `tenant_id = ${p}`, q.tenantId)
    if (q.activeOnly) w.raw('ended_at IS NULL')
    const rows = await this.run<ScheduleRow>(`SELECT * FROM ${this.s}.schedules${w} ORDER BY start_at, id${w.limit(q.limit ?? 100)}`, w.params)
    return rows.map(toSchedule)
  }

  async listAllocations(q: AllocationQuery): Promise<Allocation[]> {
    if (q.movementIds?.length === 0 || q.expectationIds?.length === 0) return []
    const w = new Where()
      .add((p) => `tenant_id = ${p}`, q.tenantId)
      .add((p) => `movement_id = ${p}`, q.movementId)
      .add((p) => `movement_id = ANY(${p}::text[])`, q.movementIds === undefined ? undefined : [...q.movementIds])
      .add((p) => `expectation_id = ${p}`, q.expectationId)
      .add((p) => `expectation_id = ANY(${p}::text[])`, q.expectationIds === undefined ? undefined : [...q.expectationIds])
    return (await this.run<AllocationRow>(`SELECT * FROM ${this.s}.allocations${w} ORDER BY seq`, w.params)).map(
      toAllocation,
    )
  }

  async getDecision(tenantId: string, movementId: string): Promise<DecisionRecord | null> {
    const [row] = await this.run<DecisionRow>(
      `SELECT * FROM ${this.s}.decisions WHERE tenant_id = $1 AND movement_id = $2`,
      [tenantId, movementId],
    )
    return row === undefined ? null : toDecisionRecord(row)
  }

  async listDecisions(q: DecisionQuery): Promise<DecisionRecord[]> {
    const w = new Where()
      .add((p) => `tenant_id = ${p}`, q.tenantId)
      .add((p) => `movement_id = ${p}`, q.movementId)
      .add((p) => `decided_at >= ${p}`, q.from)
      .add((p) => `decided_at < ${p}`, q.to)
    const sql = `SELECT * FROM ${this.s}.decisions${w} ORDER BY seq${w.limit(q.limit)}`
    return (await this.run<DecisionRow>(sql, w.params)).map(toDecisionRecord)
  }

  async getException(tenantId: string, id: string): Promise<ExceptionRecord | null> {
    const [row] = await this.run<ExceptionRow>(
      `SELECT * FROM ${this.s}.exceptions WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    )
    return row === undefined ? null : toException(row)
  }

  async listExceptions(q: ExceptionQuery): Promise<ExceptionRecord[]> {
    if (q.ids?.length === 0 || q.movementIds?.length === 0 || q.expectationIds?.length === 0) return []
    const w = new Where()
      .add((p) => `tenant_id = ${p}`, q.tenantId)
      .add((p) => `id = ANY(${p}::text[])`, q.ids === undefined ? undefined : [...q.ids])
      .add((p) => `status = ${p}`, q.status)
      .add((p) => `code = ${p}`, q.code)
      .add((p) => `movement_id = ${p}`, q.movementId)
      .add((p) => `movement_id = ANY(${p}::text[])`, q.movementIds === undefined ? undefined : [...q.movementIds])
      .add((p) => `expectation_id = ${p}`, q.expectationId)
      .add((p) => `expectation_id = ANY(${p}::text[])`, q.expectationIds === undefined ? undefined : [...q.expectationIds])
      .add((p) => `seq > ${p}`, q.afterSeq)
    const sql = `SELECT * FROM ${this.s}.exceptions${w} ORDER BY seq${w.limit(q.limit)}`
    return (await this.run<ExceptionRow>(sql, w.params)).map(toException)
  }

  async getEntity(tenantId: string, id: string): Promise<Entity | null> {
    const [row] = await this.run<EntityRow>(
      `SELECT * FROM ${this.s}.entities WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    )
    return row === undefined ? null : toEntity(row)
  }

  async listEntities(q: EntityQuery): Promise<Entity[]> {
    const w = new Where().add((p) => `tenant_id = ${p}`, q.tenantId)
    const rows = await this.run<EntityRow>(
      `SELECT * FROM ${this.s}.entities${w} ORDER BY id${w.limit(q.limit)}`,
      w.params,
    )
    return rows.map(toEntity)
  }

  async getAccountEntity(tenantId: string, network: string, account: string): Promise<AccountEntity | null> {
    const [row] = await this.run<AccountEntityRow>(
      `SELECT * FROM ${this.s}.account_entities WHERE tenant_id = $1 AND network = $2 AND account = $3`,
      [tenantId, network, account],
    )
    return row === undefined ? null : toAccountEntity(row)
  }

  async listAccountEntities(q: AccountEntityQuery): Promise<AccountEntity[]> {
    const w = new Where()
      .add((p) => `tenant_id = ${p}`, q.tenantId)
      .add((p) => `network = ${p}`, q.network)
      .add((p) => `account = ${p}`, q.account)
      .add((p) => `entity_id = ${p}`, q.entityId)
    const rows = await this.run<AccountEntityRow>(
      `SELECT * FROM ${this.s}.account_entities${w} ORDER BY account, network${w.limit(q.limit)}`,
      w.params,
    )
    return rows.map(toAccountEntity)
  }

  async getInternalTransferLink(tenantId: string, id: string): Promise<InternalTransferLink | null> {
    const [row] = await this.run<InternalTransferLinkRow>(
      `SELECT * FROM ${this.s}.internal_transfer_links WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    )
    return row === undefined ? null : toInternalTransferLink(row)
  }

  async listInternalTransferLinks(q: InternalTransferQuery): Promise<InternalTransferLink[]> {
    if (q.movementIds?.length === 0) return []
    const w = new Where()
      .add((p) => `tenant_id = ${p}`, q.tenantId)
      .add((p) => `network = ${p}`, q.network)
      .add((p) => `tx_hash = ${p}`, q.txHash)
      .add(
        (p) => `(movement_a = ANY(${p}::text[]) OR movement_b = ANY(${p}::text[]))`,
        q.movementIds === undefined ? undefined : [...q.movementIds],
      )
    const rows = await this.run<InternalTransferLinkRow>(
      `SELECT * FROM ${this.s}.internal_transfer_links${w} ORDER BY created_at, id${w.limit(q.limit)}`,
      w.params,
    )
    return rows.map(toInternalTransferLink)
  }

  async getAccountOpening(tenantId: string, network: string, account: string): Promise<AccountOpening | null> {
    const [row] = await this.run<AccountOpeningRow>(
      `SELECT * FROM ${this.s}.account_openings WHERE tenant_id = $1 AND network = $2 AND account = $3`,
      [tenantId, network, account],
    )
    return row === undefined ? null : toAccountOpening(row)
  }

  async listAccountOpenings(q: AccountOpeningQuery): Promise<AccountOpening[]> {
    const w = new Where()
      .add((p) => `tenant_id = ${p}`, q.tenantId)
      .add((p) => `network = ${p}`, q.network)
      .add((p) => `account = ${p}`, q.account)
    const rows = await this.run<AccountOpeningRow>(
      `SELECT * FROM ${this.s}.account_openings${w} ORDER BY ledger, id${w.limit(q.limit)}`,
      w.params,
    )
    return rows.map(toAccountOpening)
  }

  async listJournalEntries(q: JournalQuery): Promise<JournalEntry[]> {
    if (q.movementIds?.length === 0) return []
    const w = new Where()
      .add((p) => `tenant_id = ${p}`, q.tenantId)
      .add((p) => `movement_id = ${p}`, q.movementId)
      .add((p) => `movement_id = ANY(${p}::text[])`, q.movementIds === undefined ? undefined : [...q.movementIds])
      .add((p) => `seq > ${p}`, q.afterSeq)
      .add((p) => `effective_at >= ${p}`, q.effectiveFrom)
      .add((p) => `effective_at < ${p}`, q.effectiveBefore)
      .add(
        (p) => `EXISTS (SELECT 1 FROM ${this.s}.journal_lines l WHERE l.entry_id = ${this.s}.journal_entries.id AND l.account = ${p})`,
        q.account,
      )
      .add(
        (p) => `EXISTS (SELECT 1 FROM ${this.s}.journal_lines l WHERE l.entry_id = ${this.s}.journal_entries.id AND l.entity_id = ${p})`,
        q.entityId,
      )
    const entries = await this.run<JournalEntryRow>(
      `SELECT * FROM ${this.s}.journal_entries${w} ORDER BY seq${w.limit(q.limit)}`,
      w.params,
    )
    if (entries.length === 0) return []
    const lines = await this.run<JournalLineRow>(
      `SELECT * FROM ${this.s}.journal_lines WHERE entry_id = ANY($1) ORDER BY entry_id, line_no`,
      [entries.map((e) => e.id)],
    )
    const byEntry = new Map<string, JournalLineRow[]>()
    for (const l of lines) byEntry.set(l.entry_id, [...(byEntry.get(l.entry_id) ?? []), l])
    return entries.map((e) => toJournalEntry(e, byEntry.get(e.id) ?? []))
  }

  async listEvents(q: EventQuery): Promise<OutboxEvent[]> {
    const prunedThrough = await this.getEventsPrunedThrough(q.tenantId)
    if (q.afterSeq !== undefined && q.afterSeq < prunedThrough) {
      throw new EventHistoryPrunedError(q.tenantId, q.afterSeq, prunedThrough)
    }
    const w = new Where().add((p) => `tenant_id = ${p}`, q.tenantId).add((p) => `seq > ${p}`, q.afterSeq)
    return (await this.run<EventRow>(`SELECT * FROM ${this.s}.events${w} ORDER BY seq${w.limit(q.limit)}`, w.params)).map(toEvent)
  }

  async getEventsPrunedThrough(tenantId: string): Promise<number> {
    const [row] = await this.run<{ seq: string | number }>(
      `SELECT coalesce(pruned_through, 0) AS seq FROM ${this.s}.event_prune_state WHERE tenant_id = $1`,
      [tenantId],
    )
    return Number(row?.seq ?? 0)
  }

  async getLatestEventSeq(tenantId: string): Promise<number> {
    const [row] = await this.run<{ seq: string | number | null }>(
      `SELECT max(seq) AS seq FROM ${this.s}.events WHERE tenant_id = $1`,
      [tenantId],
    )
    return Number(row?.seq ?? 0)
  }

  async listDeliveryAttempts(q: DeliveryAttemptQuery): Promise<DeliveryAttempt[]> {
    const w = new Where()
      .add((p) => `tenant_id = ${p}`, q.tenantId)
      .add((p) => `consumer = ${p}`, q.consumer)
      .add((p) => `outcome = ${p}`, q.outcome)
      .add((p) => `seq < ${p}`, q.beforeSeq)
    const rows = await this.run<DeliveryAttemptRow>(
      `SELECT * FROM ${this.s}.webhook_delivery_attempts${w} ORDER BY seq DESC${w.limit(q.limit)}`,
      w.params,
    )
    return rows.map(toDeliveryAttempt)
  }

  async listDeliveryConsumers(tenantId: string): Promise<string[]> {
    const rows = await this.run<{ account: string }>(
      `SELECT account FROM ${this.s}.cursors
         WHERE tenant_id = $1 AND network = 'nostro' AND source = 'outbox' AND value IS NOT NULL
       UNION
       SELECT DISTINCT consumer AS account FROM ${this.s}.webhook_delivery_attempts WHERE tenant_id = $2
       UNION
       SELECT DISTINCT consumer AS account FROM ${this.s}.webhook_rewinds WHERE tenant_id = $3
       ORDER BY account`,
      [tenantId, tenantId, tenantId],
    )
    return rows.map((r) => r.account)
  }

  async listRewinds(q: RewindQuery): Promise<Rewind[]> {
    const w = new Where().add((p) => `tenant_id = ${p}`, q.tenantId).add((p) => `consumer = ${p}`, q.consumer)
    const rows = await this.run<RewindRow>(
      `SELECT * FROM ${this.s}.webhook_rewinds${w} ORDER BY seq DESC${w.limit(q.limit ?? DELIVERY_ATTEMPT_LIMIT)}`,
      w.params,
    )
    return rows.map(toRewind)
  }

  async getCursor(k: CursorKey): Promise<string | null> {
    const [row] = await this.run<{ value: string | null }>(
      `SELECT value FROM ${this.s}.cursors WHERE tenant_id = $1 AND network = $2 AND source = $3 AND account = $4`,
      [k.tenantId, k.network, k.source, k.account],
    )
    return row?.value ?? null
  }

  async findApiKeyByDigest(digest: string): Promise<ApiKeyRow | null> {
    const [row] = await this.run<ApiKeyDbRow>(`SELECT * FROM ${this.s}.api_keys WHERE digest = $1`, [digest])
    return row === undefined ? null : toApiKey(row)
  }

  async listApiKeys(tenantId?: string): Promise<ApiKeyRow[]> {
    const rows =
      tenantId === undefined
        ? await this.run<ApiKeyDbRow>(`SELECT * FROM ${this.s}.api_keys ORDER BY created_at, id`)
        : await this.run<ApiKeyDbRow>(`SELECT * FROM ${this.s}.api_keys WHERE tenant_id = $1 ORDER BY created_at, id`, [tenantId])
    return rows.map(toApiKey)
  }

  async listWatchedAccounts(tenantId: string): Promise<WatchedAccountRow[]> {
    const rows = await this.run<WatchedDbRow>(`SELECT * FROM ${this.s}.watched_accounts WHERE tenant_id = $1 ORDER BY added_at, account`, [tenantId])
    return rows.map(toWatched)
  }

  async listSyncState(tenantId: string): Promise<SyncStateRow[]> {
    const rows = await this.run<SyncDbRow>(`SELECT * FROM ${this.s}.sync_state WHERE tenant_id = $1 ORDER BY account, source, network`, [tenantId])
    return rows.map(toSyncState)
  }

  async getJournalPeriod(tenantId: string): Promise<JournalPeriod | null> {
    const [row] = await this.run<{
      action: string
      closed_through: Date | null
      note: string | null
      created_at: Date
    }>(
      `SELECT action, closed_through, note, created_at FROM ${this.s}.journal_period_actions
       WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1`,
      [tenantId],
    )
    if (row === undefined || row.action !== 'close' || row.closed_through === null) return null
    return Object.freeze({
      tenantId,
      through: row.closed_through,
      note: row.note,
      closedAt: row.created_at,
    })
  }

  async listRefundLinks(q: RefundQuery): Promise<RefundLink[]> {
    if (q.movementIds?.length === 0) return []
    const w=new Where().add(p=>`tenant_id = ${p}`,q.tenantId)
      .add(p=>`credit_movement_id = ${p}`,q.creditMovementId)
      .add(p=>`refund_movement_id = ${p}`,q.refundMovementId)
      .add(p=>`(credit_movement_id = ANY(${p}::text[]) OR refund_movement_id = ANY(${p}::text[]))`,q.movementIds===undefined?undefined:[...q.movementIds])
    return (await this.run(`SELECT * FROM ${this.s}.refund_links${w} ORDER BY seq`,w.params)).map(refundLinkFromRow)
  }

  async accrualGetMode(tenantId: string): Promise<boolean> {
    const [row] = await this.run<{ active: boolean }>(
      `SELECT active FROM ${this.s}.accrual_modes WHERE tenant_id = $1`,
      [tenantId],
    )
    return row?.active ?? false
  }

  async getValuation(tenantId: string, movementId: string): Promise<MovementValuation | null> {
    const [row] = await this.run<MovementValuationRow>(
      `SELECT * FROM ${this.s}.movement_valuations WHERE tenant_id = $1 AND movement_id = $2`,
      [tenantId, movementId],
    )
    return row === undefined ? null : toValuation(row)
  }

  async listValuations(q: ValuationQuery): Promise<MovementValuation[]> {
    let sql = `SELECT * FROM ${this.s}.movement_valuations WHERE tenant_id = $1`
    const params: unknown[] = [q.tenantId]
    let idx = 2
    if (q.movementId !== undefined) {
      sql += ` AND movement_id = $${idx++}`
      params.push(q.movementId)
    }
    if (q.reportingAsset !== undefined) {
      sql += ` AND reporting_asset = $${idx++}`
      params.push(q.reportingAsset)
    }
    sql += ' ORDER BY price_timestamp ASC'
    const rows = await this.run<MovementValuationRow>(sql, params)
    return rows.map(toValuation)
  }
}

interface ApiKeyDbRow {
  id: string
  tenant_id: string
  label: string
  digest: string
  scopes: string[]
  created_at: Date
  revoked_at: Date | null
  last_used_at: Date | null
}
interface WatchedDbRow {
  tenant_id: string
  account: string
  source: 'config' | 'api'
  added_at: Date
}
interface SyncDbRow {
  tenant_id: string
  network: string
  source: string
  account: string
  cursor: string | null
  last_attempt_at: Date
  last_success_at: Date | null
  caught_up: boolean
  last_error: string | null
  last_error_at: Date | null
}

const toApiKey = (r: ApiKeyDbRow): ApiKeyRow => ({
  id: r.id,
  tenantId: r.tenant_id,
  label: r.label,
  digest: r.digest,
  scopes: r.scopes,
  createdAt: r.created_at,
  revokedAt: r.revoked_at,
  lastUsedAt: r.last_used_at,
})
const toWatched = (r: WatchedDbRow): WatchedAccountRow => ({ tenantId: r.tenant_id, account: r.account, source: r.source, addedAt: r.added_at })
const toSyncState = (r: SyncDbRow): SyncStateRow => ({
  tenantId: r.tenant_id,
  network: r.network,
  source: r.source,
  account: r.account,
  cursor: r.cursor,
  lastAttemptAt: r.last_attempt_at,
  lastSuccessAt: r.last_success_at,
  caughtUp: r.caught_up,
  lastError: r.last_error,
  lastErrorAt: r.last_error_at,
})

const isUniqueViolation = (err: unknown, constraint: string): boolean =>
  err instanceof Error &&
  (err as { code?: string }).code === '23505' &&
  (err as { constraint?: string }).constraint === constraint

class PgTx extends PgReader implements StoreTx {
  private open = true
  private savepoints = 0
  private readonly periodLocks = new Set<string>()

  constructor(
    s: string,
    client: PoolClient,
    private readonly ids: () => string,
    private readonly now: () => Date,
    private readonly pin?: TenantPin,
  ) {
    super(s, async (sql, params) => {
      if (!this.open) throw new TransactionClosedError()
      return (await client.query(sql, params === undefined ? undefined : [...params])).rows
    })
  }

  close(): void {
    this.open = false
  }

  async lockJournalPeriod(tenantId: string): Promise<JournalPeriod | null> {
    if (!this.periodLocks.has(tenantId)) {
      await this.run('SELECT pg_advisory_xact_lock(hashtext($1))', [`nostro:journal-period:${this.s}:${tenantId}`])
      this.periodLocks.add(tenantId)
    }
    return this.getJournalPeriod(tenantId)
  }

  async closeJournalPeriod(tenantId: string, through: Date, note: string | null): Promise<void> {
    checkJournalPeriodClose(tenantId, through, note)
    await this.lockJournalPeriod(tenantId)
    await this.run(
      `INSERT INTO ${this.s}.journal_period_actions (tenant_id, action, closed_through, note, reason, created_at)
       VALUES ($1, 'close', $2, $3, NULL, $4)`,
      [tenantId, through, note, this.now()],
    )
  }

  async reopenJournalPeriod(tenantId: string, reason: string): Promise<void> {
    const period = await this.lockJournalPeriod(tenantId)
    checkJournalPeriodReopen(tenantId, reason, period !== null)
    await this.run(
      `INSERT INTO ${this.s}.journal_period_actions (tenant_id, action, closed_through, note, reason, created_at)
       VALUES ($1, 'reopen', NULL, NULL, $2, $3)`,
      [tenantId, reason, this.now()],
    )
  }

  /**
   * Append to the event log, in this transaction. The per-tenant lock is
   * held until commit, so a later seq cannot commit before an earlier one.
   */
  private async emit(event: NewOutboxEvent | null): Promise<void> {
    if (event === null) return
    if (this.pin?.tenant !== undefined && this.pin.tenant !== event.tenantId) {
      throw new Error(`event tenant ${JSON.stringify(event.tenantId)} does not match the pinned tenant`)
    }
    await this.run('SELECT pg_advisory_xact_lock(hashtext($1))', [`nostro:events:${this.s}:${event.tenantId}`])
    await this.run(
      `INSERT INTO ${this.s}.events (id, tenant_id, type, subject_id, payload, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [this.ids(), event.tenantId, event.type, event.subjectId, JSON.stringify(event.payload), this.now()],
    )
  }

  private async lockMovement(tenantId: string, id: string): Promise<Movement> {
    const movement = await this.getMovement(tenantId, id)
    if (movement === null) throw new NotFoundError('movement', id)
    return movement
  }

  private async lockExpectation(tenantId: string, id: string): Promise<Expectation> {
    const [row] = await this.run<ExpectationRow>(
      `SELECT * FROM ${this.s}.expectations WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, id],
    )
    if (row === undefined) throw new NotFoundError('expectation', id)
    return toExpectation(row)
  }

  /** A locking read: the movement is held until the transaction ends. */
  override async getMovement(tenantId: string, id: string): Promise<Movement | null> {
    await this.lockJournalPeriod(tenantId)
    const [row] = await this.run<MovementRow>(
      `SELECT * FROM ${this.s}.movements WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, id],
    )
    return row === undefined ? null : toMovement(row)
  }

  /** A locking read: the cursor row is created if absent, then held until the transaction ends. */
  override async getCursor(k: CursorKey): Promise<string | null> {
    const params = [k.tenantId, k.network, k.source, k.account]
    await this.run(
      `INSERT INTO ${this.s}.cursors (tenant_id, network, source, account, value)
       VALUES ($1, $2, $3, $4, NULL) ON CONFLICT DO NOTHING`,
      params,
    )
    const [row] = await this.run<{ value: string | null }>(
      `SELECT value FROM ${this.s}.cursors
       WHERE tenant_id = $1 AND network = $2 AND source = $3 AND account = $4 FOR UPDATE`,
      params,
    )
    return row?.value ?? null
  }

  async setCursor(k: CursorKey, value: string): Promise<void> {
    checkCursorValue(value)
    await this.run(
      `INSERT INTO ${this.s}.cursors (tenant_id, network, source, account, value) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, network, source, account) DO UPDATE SET value = EXCLUDED.value`,
      [k.tenantId, k.network, k.source, k.account, value],
    )
  }

  async insertApiKey(input: NewApiKeyRow): Promise<ApiKeyRow> {
    const savepoint = `nostro_${++this.savepoints}`
    await this.run(`SAVEPOINT ${savepoint}`)
    try {
      await this.run(
        `INSERT INTO ${this.s}.api_keys (id, tenant_id, label, digest, scopes, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.id, input.tenantId, input.label, input.digest, JSON.stringify([...input.scopes]), input.createdAt],
      )
      await this.run(`RELEASE SAVEPOINT ${savepoint}`)
    } catch (err) {
      await this.run(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      if (isUniqueViolation(err, 'api_keys_digest_unique')) {
        throw new ConstraintError('api_key_digest_unique', 'that key is already stored')
      }
      throw err
    }
    const [row] = await this.run<ApiKeyDbRow>(`SELECT * FROM ${this.s}.api_keys WHERE id = $1`, [input.id])
    return toApiKey(row!)
  }

  async revokeApiKey(id: string, at: Date): Promise<ApiKeyRow> {
    const [row] = await this.run<ApiKeyDbRow>(`SELECT * FROM ${this.s}.api_keys WHERE id = $1 FOR UPDATE`, [id])
    if (row === undefined) throw new NotFoundError('api_key', id)
    if (row.revoked_at === null) {
      await this.run(`UPDATE ${this.s}.api_keys SET revoked_at = $2 WHERE id = $1`, [id, at])
    }
    const [updated] = await this.run<ApiKeyDbRow>(`SELECT * FROM ${this.s}.api_keys WHERE id = $1`, [id])
    return toApiKey(updated!)
  }

  async recordApiKeyUse(uses: readonly { readonly id: string; readonly at: Date }[]): Promise<void> {
    for (const { id, at } of uses) {
      await this.run(`UPDATE ${this.s}.api_keys SET last_used_at = GREATEST(COALESCE(last_used_at, 'epoch'), $2) WHERE id = $1`, [id, at])
    }
  }

  async addWatchedAccount(row: WatchedAccountRow): Promise<WatchedAccountRow> {
    const [stored] = await this.run<WatchedDbRow>(
      `INSERT INTO ${this.s}.watched_accounts (tenant_id, account, source, added_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, account) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
       RETURNING *`,
      [row.tenantId, row.account, row.source, row.addedAt],
    )
    return toWatched(stored!)
  }

  async removeWatchedAccount(tenantId: string, account: string): Promise<boolean> {
    const removed = await this.run<{ account: string }>(
      `DELETE FROM ${this.s}.watched_accounts WHERE tenant_id = $1 AND account = $2 RETURNING account`,
      [tenantId, account],
    )
    return removed.length > 0
  }

  async recordSyncState(state: SyncStateRow): Promise<void> {
    await this.run(
      `INSERT INTO ${this.s}.sync_state (tenant_id, network, source, account, cursor, last_attempt_at, last_success_at, caught_up, last_error, last_error_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (tenant_id, network, source, account) DO UPDATE SET
         cursor = EXCLUDED.cursor, last_attempt_at = EXCLUDED.last_attempt_at, last_success_at = EXCLUDED.last_success_at,
         caught_up = EXCLUDED.caught_up, last_error = EXCLUDED.last_error, last_error_at = EXCLUDED.last_error_at`,
      [
        state.tenantId,
        state.network,
        state.source,
        state.account,
        state.cursor,
        state.lastAttemptAt,
        state.lastSuccessAt,
        state.caughtUp,
        state.lastError,
        state.lastErrorAt,
      ],
    )
  }

  async recordDeliveryAttempt(attempt: NewDeliveryAttempt): Promise<DeliveryAttempt> {
    const [row] = await this.run<DeliveryAttemptRow>(
      `INSERT INTO ${this.s}.webhook_delivery_attempts
         (id, tenant_id, consumer, event_id, event_seq, attempt_at, http_status, error, duration_ms, outcome)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [this.ids(), attempt.tenantId, attempt.consumer, attempt.eventId, attempt.eventSeq, attempt.at, attempt.httpStatus, attempt.error, attempt.durationMs, attempt.outcome],
    )
    await this.run(
      `DELETE FROM ${this.s}.webhook_delivery_attempts
         WHERE tenant_id = $1 AND consumer = $2 AND (
           seq < (SELECT seq FROM ${this.s}.webhook_delivery_attempts
                  WHERE tenant_id = $3 AND consumer = $4
                  ORDER BY seq DESC LIMIT 1 OFFSET $5)
           OR attempt_at < $6
         )`,
      [attempt.tenantId, attempt.consumer, attempt.tenantId, attempt.consumer, DELIVERY_ATTEMPT_LIMIT - 1, new Date(attempt.at.getTime() - DELIVERY_ATTEMPT_TTL_MS)],
    )
    return toDeliveryAttempt(row!)
  }

  async rewindConsumer(input: RewindInput): Promise<Rewind | null> {
    const key = eventCursorKey(input.tenantId, input.consumer)
    const current = await this.getCursor(key)
    if ((current === null ? 0 : Number(current)) !== input.expectedSeq) return null
    await this.setCursor(key, String(input.toSeq))
    const [row] = await this.run<RewindRow>(
      `INSERT INTO ${this.s}.webhook_rewinds (id, tenant_id, consumer, from_seq, to_seq, actor, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [this.ids(), input.tenantId, input.consumer, input.expectedSeq, input.toSeq, input.actor, input.at],
    )
    return toRewind(row!)
  }

  async pruneEventsBefore(tenantId: string, olderThan: Date): Promise<PruneEventsResult> {
    if (!Number.isFinite(olderThan.getTime())) throw new Error('olderThan must be a valid date')
    await this.run('SELECT pg_advisory_xact_lock(hashtext($1))', [`nostro:events:${this.s}:${tenantId}`])
    const [bounds] = await this.run<{ prefix_through: string | number | null; consumer_through: string | number | null }>(
      `SELECT
         coalesce(
           (SELECT min(seq) - 1 FROM ${this.s}.events WHERE tenant_id = $1 AND created_at > $2),
           (SELECT max(seq) FROM ${this.s}.events WHERE tenant_id = $1),
           0
         ) AS prefix_through,
         (SELECT min(value::bigint) FROM ${this.s}.cursors
           WHERE tenant_id = $1 AND network = 'nostro' AND source = 'outbox') AS consumer_through`,
      [tenantId, olderThan],
    )
    const prefixThrough = Number(bounds?.prefix_through ?? 0)
    const safeThrough = Math.min(prefixThrough, bounds?.consumer_through == null ? prefixThrough : Number(bounds.consumer_through))
    await this.run("SELECT set_config('nostro.event_prune', 'on', true)")
    const removed = await this.run<{ seq: string | number }>(
      `DELETE FROM ${this.s}.events
        WHERE tenant_id = $1 AND seq <= $2 AND created_at <= $3
        RETURNING seq`,
      [tenantId, safeThrough, olderThan],
    )
    const lastRemoved = removed.reduce((max, row) => Math.max(max, Number(row.seq)), 0)
    if (lastRemoved > 0) {
      await this.run(
        `INSERT INTO ${this.s}.event_prune_state (tenant_id, pruned_through)
         VALUES ($1, $2)
         ON CONFLICT (tenant_id) DO UPDATE
           SET pruned_through = greatest(${this.s}.event_prune_state.pruned_through, EXCLUDED.pruned_through)`,
        [tenantId, lastRemoved],
      )
    }
    return { deleted: removed.length, prunedThrough: Math.max(await this.getEventsPrunedThrough(tenantId), lastRemoved) }
  }

  async insertEntity(n: NewEntity): Promise<Entity> {
    assertValidNewEntity(n)
    if (await this.getEntity(n.tenantId, n.id) !== null) {
      throw new ConstraintError('entity_duplicate', `entity ${n.id} already exists in this tenant`)
    }
    const record: Entity = Object.freeze({ ...n, createdAt: this.now() })
    try {
      await this.run(
        `INSERT INTO ${this.s}.entities (id, tenant_id, name, created_at) VALUES ($1, $2, $3, $4)`,
        [record.id, record.tenantId, record.name, record.createdAt],
      )
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === '23505') {
        throw new ConstraintError('entity_duplicate', `entity ${n.id} already exists in this tenant`)
      }
      throw err
    }
    return record
  }

  async assignAccountEntity(n: NewAccountEntity): Promise<AccountEntity> {
    assertValidNewAccountEntity(n)
    if (await this.getEntity(n.tenantId, n.entityId) === null) {
      throw new ConstraintError('entity_unknown', `entity ${n.entityId} does not exist in this tenant`)
    }
    const record: AccountEntity = Object.freeze({ ...n, createdAt: this.now() })
    await this.run(
      `INSERT INTO ${this.s}.account_entities (tenant_id, network, account, entity_id, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, network, account)
       DO UPDATE SET entity_id = excluded.entity_id, created_at = excluded.created_at`,
      [record.tenantId, record.network, record.account, record.entityId, record.createdAt],
    )
    return record
  }

  async linkInternalTransfer(n: NewInternalTransferLink): Promise<InternalTransferLink> {
    assertValidNewInternalTransferLink(n)
    const [a, b] = await Promise.all(n.movementIds.map((id) => this.lockMovement(n.tenantId, id))) as [Movement, Movement]
    if (a.network !== n.network || b.network !== n.network) {
      throw new ConstraintError('internal_transfer_invalid', 'both movements must be on the transfer network')
    }
    const sameEntity = a.entityId === b.entityId
    if (sameEntity !== n.sameEntity) {
      throw new ConstraintError('internal_transfer_invalid', 'sameEntity disagrees with the linked movements')
    }
    if ((await this.listInternalTransferLinks({ tenantId: n.tenantId, movementIds: n.movementIds })).length > 0) {
      throw new ConstraintError('internal_transfer_duplicate', 'a movement is already part of another internal transfer')
    }
    const [movementA, movementB] = [...n.movementIds].sort() as [string, string]
    const record: InternalTransferLink = Object.freeze({
      ...n,
      id: this.ids(),
      movementIds: Object.freeze([movementA, movementB]) as readonly [string, string],
      sameEntity,
      createdAt: this.now(),
    })
    try {
      await this.run(
        `INSERT INTO ${this.s}.internal_transfer_links
           (id, tenant_id, network, tx_hash, movement_a, movement_b, same_entity, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          record.id,
          record.tenantId,
          record.network,
          record.txHash,
          movementA,
          movementB,
          sameEntity,
          record.createdAt,
        ],
      )
    } catch (err) {
      if (err instanceof Error && ('code' in err && err.code === '23505' || err.message.includes('internal transfer'))) {
        throw new ConstraintError('internal_transfer_duplicate', 'a movement is already part of another internal transfer')
      }
      throw err
    }
    return record
  }

  async insertAccountOpening(opening: NewAccountOpening): Promise<AccountOpening> {
    assertValidNewAccountOpening(opening)
    if (await this.getAccountOpening(opening.tenantId, opening.network, opening.account) !== null) {
      throw new ConstraintError('account_opening_duplicate', `${opening.network}:${opening.account} already has an opening`)
    }
    const [movement] = await this.run(
      `SELECT 1 FROM ${this.s}.movements WHERE tenant_id = $1 AND network = $2 AND account = $3 LIMIT 1`,
      [opening.tenantId, opening.network, opening.account],
    )
    if (movement !== undefined) {
      throw new ConstraintError('account_opening_has_movements', `${opening.network}:${opening.account} already has movements`)
    }
    const record: AccountOpening = Object.freeze({
      ...opening,
      id: this.ids(),
      occurredAt: opening.occurredAt ?? this.now(),
      balances: opening.balances,
      note: opening.note ?? null,
      createdAt: this.now(),
    })
    await this.run(
      `INSERT INTO ${this.s}.account_openings
         (id, tenant_id, network, account, ledger, occurred_at, balances_json, note, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        record.id,
        record.tenantId,
        record.network,
        record.account,
        record.ledger,
        record.occurredAt,
        JSON.stringify(record.balances.map(storedOpeningBalance)),
        record.note,
        record.createdAt,
      ],
    )
    return record
  }

  async insertMovements(batch: readonly NewMovement[]): Promise<InsertMovementsResult> {
    batch.forEach(assertValidNewMovement)
    if (batch.length === 0) return { inserted: [], duplicates: [], conflicts: [] }

    // Keep only the first input for each dedupe key in the SQL input. Repeated
    // keys in the same batch are classified against the final stored row below,
    // just as the original sequential implementation classified them.
    const unique: { ordinal: number; movement: NewMovement; id: string }[] = []
    const seen = new Set<string>()
    const entityIds = await Promise.all(batch.map(async (movement) => {
      const assignment = await this.getAccountEntity(movement.tenantId, movement.network, movement.account)
      const entityId = movement.entityId ?? assignment?.entityId ?? null
      if (entityId !== null && await this.getEntity(movement.tenantId, entityId) === null) {
        throw new ConstraintError('entity_unknown', `entity ${entityId} does not exist in this tenant`)
      }
      return entityId
    }))
    const inputRows = batch.map((movement, ordinal) => {
      const key = JSON.stringify([movement.tenantId, movement.network, movement.source, movement.externalId])
      const [memoType, memoValue, memoText] = memoColumns(movement.memo)
      const row = {
        ordinal,
        id: this.ids(),
        tenant_id: movement.tenantId,
        network: movement.network,
        source: movement.source,
        external_id: movement.externalId,
        revision: movement.revision ?? 1,
        account: movement.account,
        entity_id: entityIds[ordinal] ?? null,
        direction: movement.direction,
        kind: movement.kind,
        asset: movement.amount.asset,
        decimals: movement.amount.decimals,
        amount: movement.amount.raw.toString(),
        counterparty: movement.counterparty ?? null,
        muxed_id: movement.muxedId == null ? null : movement.muxedId.toString(),
        memo_type: memoType,
        memo_value: memoValue,
        memo_text: memoText === null ? null : memoText.toString('base64'),
        ledger: movement.ledger,
        tx_hash: movement.txHash ?? null,
        operation_id: movement.operationId ?? null,
        occurred_at: movement.occurredAt.toISOString(),
        enrichment: movement.enrichment ?? 'complete',
        disposition: 'pending',
        ignored_reason: null,
        created_at: this.now().toISOString(),
      }
      if (!seen.has(key)) {
        seen.add(key)
        unique.push({ ordinal, movement, id: row.id })
      }
      return { key, row }
    })

    const uniqueOrdinals = new Set(unique.map(({ ordinal }) => ordinal))
    const uniqueRows = inputRows.filter(({ row }) => uniqueOrdinals.has(row.ordinal)).map(({ row }) => row)
    const insertedRows = await this.run<MovementRow>(
      `INSERT INTO ${this.s}.movements (
         id, tenant_id, network, source, external_id, revision, account, entity_id, direction, kind,
         asset, decimals, amount, counterparty, muxed_id, memo_type, memo_value, memo_text,
         ledger, tx_hash, operation_id, occurred_at, enrichment, disposition, ignored_reason, created_at
       )
       SELECT id, tenant_id, network, source, external_id, revision, account, entity_id, direction, kind,
              asset, decimals, amount, counterparty, muxed_id, memo_type, memo_value,
              CASE WHEN memo_text IS NULL THEN NULL ELSE decode(memo_text, 'base64') END,
              ledger, tx_hash, operation_id, occurred_at, enrichment, disposition, ignored_reason, created_at
         FROM jsonb_to_recordset($1::jsonb) AS x(
           ordinal integer, id text, tenant_id text, network text, source text, external_id text,
           revision integer, account text, entity_id text, direction text, kind text, asset text, decimals integer,
           amount numeric, counterparty text, muxed_id numeric, memo_type text, memo_value text,
           memo_text text, ledger bigint, tx_hash text, operation_id text, occurred_at timestamptz,
           enrichment text, disposition text, ignored_reason text, created_at timestamptz
         )
        ORDER BY ordinal
       ON CONFLICT ON CONSTRAINT movements_dedupe DO NOTHING
       RETURNING *`,
      [JSON.stringify(uniqueRows)],
    )

    const existingRows = await this.run<MovementRow>(
      `SELECT m.* FROM ${this.s}.movements m
       JOIN jsonb_to_recordset($1::jsonb) AS x(
         tenant_id text, network text, source text, external_id text
       ) ON m.tenant_id = x.tenant_id AND m.network = x.network
         AND m.source = x.source AND m.external_id = x.external_id`,
      [JSON.stringify(unique.map(({ movement }) => ({
        tenant_id: movement.tenantId,
        network: movement.network,
        source: movement.source,
        external_id: movement.externalId,
      })))],
    )
    const keyOf = (value: Pick<NewMovement, 'tenantId' | 'network' | 'source' | 'externalId'>) =>
      JSON.stringify([value.tenantId, value.network, value.source, value.externalId])
    const storedByKey = new Map(existingRows.map((row) => [keyOf({
      tenantId: row.tenant_id,
      network: row.network,
      source: row.source,
      externalId: row.external_id,
    }), toMovement(row)]))
    const insertedKeys = new Set(insertedRows.map((row) => keyOf({
      tenantId: row.tenant_id,
      network: row.network,
      source: row.source,
      externalId: row.external_id,
    })))
    const inserted: Movement[] = []
    const duplicates: Movement[] = []
    const conflicts: MovementConflict[] = []
    const firstOrdinalByKey = new Map(unique.map(({ movement, ordinal }) => [keyOf(movement), ordinal]))
    for (const [ordinal, movement] of batch.entries()) {
      const key = keyOf(movement)
      const existing = storedByKey.get(key)!
      if (firstOrdinalByKey.get(key) === ordinal && insertedKeys.has(key)) {
        inserted.push(existing)
      } else if (sameFacts(existing, movement)) {
        duplicates.push(existing)
      } else {
        conflicts.push({ existing, incoming: movement })
      }
    }
    return { inserted, duplicates, conflicts }
  }

  async setDisposition(
    tenantId: string,
    movementId: string,
    disposition: Disposition,
    reason?: string,
  ): Promise<Movement> {
    const m = await this.lockMovement(tenantId, movementId)
    const allocations = await this.listAllocations({ tenantId, movementId })
    const exceptions = await this.listExceptions({ tenantId, movementId })
    checkDisposition(m, allocations, exceptions, disposition, reason,refundCoverage(m,await this.listRefundLinks({tenantId,movementIds:[m.id]})))
    const [row] = await this.run<MovementRow>(
      `UPDATE ${this.s}.movements SET disposition = $3, ignored_reason = $4
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tenantId, movementId, disposition, disposition === 'ignored' ? reason! : null],
    )
    const next = toMovement(row!)
    if (m.disposition !== disposition) await this.emit(movementDecided(next, m.disposition, allocations))
    return next
  }

  async insertSchedule(n: NewSchedule): Promise<Schedule> {
    const [memoType, memoValue, memoText] = memoColumns(n.memo ?? null)
    const now = this.now()
    const [row] = await this.run<ScheduleRow>(
      `INSERT INTO ${this.s}.schedules (
         id, tenant_id, reference_pattern, account, direction, asset, decimals, amount,
         memo_type, memo_value, memo_text, payers, cadence, start_at, end_at, ended_at, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18)
       RETURNING *`,
      [this.ids(), n.tenantId, n.referencePattern, n.account, n.direction ?? 'credit', n.amount.asset, n.amount.decimals, n.amount.raw.toString(), memoType, memoValue, memoText, JSON.stringify(n.payers ?? []), JSON.stringify(n.cadence), n.startAt, n.endAt ?? null, null, now, now],
    )
    return toSchedule(row!)
  }

  async endSchedule(tenantId: string, id: string, endedAt: Date): Promise<Schedule> {
    const [row] = await this.run<ScheduleRow>(
      `UPDATE ${this.s}.schedules SET ended_at = $3, updated_at = $4 WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tenantId, id, endedAt, this.now()],
    )
    if (row === undefined) throw new NotFoundError('expectation', id)
    return toSchedule(row)
  }

  async insertExpectation(n: NewExpectation): Promise<Expectation> {
    assertValidNewExpectation(n)
    const taken = () =>
      new ConstraintError(
        'expectation_reference_unique',
        `reference ${JSON.stringify(n.reference)} already exists in this tenant`,
      )
    if ((await this.getExpectationByReference(n.tenantId, n.reference)) !== null) throw taken()

    await this.run('SELECT pg_advisory_xact_lock(hashtext($1))', [`nostro:muxed:${this.s}:${n.tenantId}:${n.account}`])
    let muxedId: bigint | null
    if (n.muxedId === 'issue') {
      const rows = await this.run<{ max: string | null }>(`SELECT max(muxed_id)::text AS max FROM ${this.s}.expectations WHERE tenant_id = $1 AND account = $2 AND muxed_id IS NOT NULL`, [n.tenantId, n.account])
      const max = rows[0]?.max == null ? 0n : BigInt(rows[0].max)
      muxedId = issueMuxedId(max)
    } else {
      muxedId = n.muxedId ?? null
    }
    if (muxedId !== null) {
      const rows = await this.run<{ id: string }>(`SELECT id FROM ${this.s}.expectations WHERE tenant_id = $1 AND account = $2 AND muxed_id = $3`, [n.tenantId, n.account, muxedId.toString()])
      if (rows.length > 0) throw new ConstraintError('expectation_muxed_id_unique', `muxed id ${muxedId.toString()} is already used on account ${n.account}`)
    }

    const [memoType, memoValue, memoText] = memoColumns(n.memo)
    const now = this.now()

    // Resolve fingerprintSuffix: 'allocate' picks the lowest free value.
    let fingerprintSuffix: bigint | null = null
    if (n.fingerprintSuffix === 'allocate') {
      await this.run('SELECT pg_advisory_xact_lock(hashtext($1))', [`nostro:fingerprint:${this.s}:${n.tenantId}:${n.account}:${n.amount.asset}`])
      const rows = await this.run<{ fingerprint_suffix: string }>(
        `SELECT fingerprint_suffix FROM ${this.s}.expectations
          WHERE tenant_id = $1 AND account = $2 AND asset = $3
            AND status = 'open' AND fingerprint_suffix IS NOT NULL
          ORDER BY fingerprint_suffix::numeric`,
        [n.tenantId, n.account, n.amount.asset],
      )
      const taken = new Set(rows.map((r) => BigInt(r.fingerprint_suffix)))
      let candidate = 1n
      while (taken.has(candidate)) candidate++
      fingerprintSuffix = candidate
    } else if (n.fingerprintSuffix != null) {
      fingerprintSuffix = n.fingerprintSuffix
    }

    const savepoint = `nostro_${++this.savepoints}`
    await this.run(`SAVEPOINT ${savepoint}`)
    try {
      const [row] = await this.run<ExpectationRow>(
        `INSERT INTO ${this.s}.expectations (
           id, tenant_id, reference, account, direction, asset, decimals, amount, muxed_id,
           memo_type, memo_value, memo_text, payers, due_at, expires_at, status, metadata,
           fingerprint_suffix, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'open', $16, $17, $18, $18)
         RETURNING *`,
        [
          this.ids(),
          n.tenantId,
          n.reference,
          n.account,
          n.direction ?? 'credit',
          n.amount.asset,
          n.amount.decimals,
          n.amount.raw.toString(),
          muxedId == null ? null : muxedId.toString(),
          memoType,
          memoValue,
          memoText,
          [...(n.payers ?? [])],
          n.dueAt ?? null,
          n.expiresAt ?? null,
          JSON.stringify(n.metadata ?? {}),
          fingerprintSuffix == null ? null : fingerprintSuffix.toString(),
          now,
        ],
      )
      await this.run(`RELEASE SAVEPOINT ${savepoint}`)
      for (const normalized of expectationReferenceKeys(n.reference, n.memo)) {
        await this.run(
          `INSERT INTO ${this.s}.expectation_reference_index (tenant_id, normalized, expectation_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [n.tenantId, normalized, row!.id],
        )
      }
      return toExpectation(row!)
    } catch (err) {
      await this.run(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      if (isUniqueViolation(err, 'expectations_reference_unique')) throw taken()
      if (isUniqueViolation(err, 'expectation_muxed_id_unique')) {
        throw new ConstraintError(
          'expectation_muxed_id_unique',
          `muxed id ${muxedId!.toString()} is already used on account ${n.account}`,
        )
      }
      throw err
    }
  }

  async cancelExpectation(tenantId: string, id: string, reason: string): Promise<Expectation> {
    const e = await this.lockExpectation(tenantId, id)
    checkCancel(e, reason)
    const [row] = await this.run<ExpectationRow>(
      `UPDATE ${this.s}.expectations SET status = 'cancelled', cancel_reason = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tenantId, id, reason, this.now()],
    )
    const next = toExpectation(row!)
    await this.emit(expectationChanged(next, null))
    return next
  }

  async amendExpectation(tenantId: string, id: string, changes: ExpectationChanges, reason: string): Promise<Expectation> {
    const e = await this.lockExpectation(tenantId, id)
    const allocations = await this.listAllocations({ tenantId, expectationId: id })
    let muxedIdTaken = false
    if (changes.muxedId !== undefined && changes.muxedId !== e.muxedId && changes.muxedId !== null) {
      await this.run('SELECT pg_advisory_xact_lock(hashtext($1))', [`nostro:muxed:${this.s}:${tenantId}:${e.account}`])
      const rows = await this.run<{ id: string }>(`SELECT id FROM ${this.s}.expectations WHERE tenant_id = $1 AND account = $2 AND muxed_id = $3 AND id <> $4`, [tenantId, e.account, changes.muxedId.toString(), id])
      muxedIdTaken = rows.length > 0
    }
    const next = amendExpectationRecord(e, allocations, changes, reason, this.now(), muxedIdTaken)
    const [memoType, memoValue, memoText] = memoColumns(next.memo)
    const [row] = await this.run<ExpectationRow>(
      `UPDATE ${this.s}.expectations
         SET amount = $3, decimals = $4, asset = $5, muxed_id = $6, memo_type = $7, memo_value = $8, memo_text = $9,
             payers = $10, due_at = $11, expires_at = $12, status = $13, metadata = $14, updated_at = $15
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [
        tenantId,
        id,
        next.amount.raw.toString(),
        next.amount.decimals,
        next.amount.asset,
        next.muxedId == null ? null : next.muxedId.toString(),
        memoType,
        memoValue,
        memoText,
        [...next.payers],
        next.dueAt,
        next.expiresAt,
        next.status,
        JSON.stringify({ ...next.metadata }),
        next.updatedAt,
      ],
    )
    const saved = toExpectation(row!)
    await this.run(`DELETE FROM ${this.s}.expectation_reference_index WHERE expectation_id = $1`, [e.id])
    for (const normalized of expectationReferenceKeys(saved.reference, saved.memo)) {
      await this.run(
        `INSERT INTO ${this.s}.expectation_reference_index (tenant_id, normalized, expectation_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [saved.tenantId, normalized, saved.id],
      )
    }
    await this.emit(expectationAmended(saved, e, reason))
    return saved
  }

  async allocate(n: NewAllocation): Promise<Allocation> {
    assertValidNewAllocation(n)
    // Lock order is always movement, then expectation.
    const m = await this.lockMovement(n.tenantId, n.movementId)
    const e = await this.lockExpectation(n.tenantId, n.expectationId)
    const status = checkAllocation(
      n,
      m,
      e,
      await this.listAllocations({ tenantId: n.tenantId, movementId: m.id }),
      await this.listAllocations({ tenantId: n.tenantId, expectationId: e.id }),
      refundCoverage(m,await this.listRefundLinks({tenantId:n.tenantId,movementIds:[m.id]})),
    )
    const now = this.now()
    const [row] = await this.run<AllocationRow>(
       `INSERT INTO ${this.s}.allocations (
          id, tenant_id, movement_id, expectation_id, asset, decimals, amount, strategy, score, decision, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::json, $11) RETURNING *`,
      [
        this.ids(),
        n.tenantId,
        m.id,
        e.id,
        n.amount.asset,
        n.amount.decimals,
        n.amount.raw.toString(),
        n.strategy,
        n.score ?? null,
        n.decision == null ? null : JSON.stringify(n.decision),
        now,
      ],
    )

    const [updated] = await this.run<ExpectationRow>(
      `UPDATE ${this.s}.expectations SET status = $2, updated_at = $3 WHERE id = $1 RETURNING *`,
      [e.id, status, now],
    )
    const allocation = toAllocation(row!)
    if (status !== e.status) await this.emit(expectationChanged(toExpectation(updated!), allocation))
    return allocation
  }

  async recordDecision(n: NewDecisionSnapshot): Promise<DecisionRecord> {
    const [row] = await this.run<DecisionRow>(
      `INSERT INTO ${this.s}.decisions (tenant_id, movement_id, decided_at, snapshot)
       VALUES ($1, $2, $3, $4::json)
       ON CONFLICT ON CONSTRAINT decisions_unique
       DO UPDATE SET decided_at = excluded.decided_at, snapshot = excluded.snapshot
       RETURNING *`,
      [n.tenantId, n.movementId, n.decidedAt, JSON.stringify(n.snapshot)],
    )
    return toDecisionRecord(row!)
  }

  async postJournalEntry(n: NewJournalEntry): Promise<JournalEntry> {
    assertValidNewJournalEntry(n)
    const period = await this.lockJournalPeriod(n.tenantId)
    // Locking the movement serialises posters, so the posting-number check
    // below sees every entry committed before it.
    const movement = n.movementId == null ? null : await this.lockMovement(n.tenantId, n.movementId)
    const existing = movement === null ? [] : await this.listJournalEntries({ tenantId: n.tenantId, movementId: movement.id })
    const now = this.now()
    const entryToPost = { ...n, effectiveAt: n.effectiveAt ?? now }
    checkJournalEntry(entryToPost, movement, existing, period?.through ?? null)
    const expectationIds = [...new Set(n.lines.flatMap((line) => line.expectationId == null ? [] : [line.expectationId]))]
    if (expectationIds.length > 0) {
      const rows = await this.run<{ id: string }>(
        `SELECT id FROM ${this.s}.expectations WHERE tenant_id = $1 AND id = ANY($2::text[])`,
        [n.tenantId, expectationIds],
      )
      const found = new Set(rows.map((row) => row.id))
      const missing = expectationIds.find((id) => !found.has(id))
      if (missing !== undefined) throw new NotFoundError('expectation', missing)
    }
    const exceptionIds = [...new Set(n.lines.flatMap((line) => line.exceptionId == null ? [] : [line.exceptionId]))]
    if (exceptionIds.length > 0) {
      const rows = await this.run<{ id: string }>(
        `SELECT id FROM ${this.s}.exceptions WHERE tenant_id = $1 AND id = ANY($2::text[])`,
        [n.tenantId, exceptionIds],
      )
      const found = new Set(rows.map((row) => row.id))
      const missing = exceptionIds.find((id) => !found.has(id))
      if (missing !== undefined) throw new NotFoundError('exception', missing)
    }
    const [entry] = await this.run<JournalEntryRow>(
      `INSERT INTO ${this.s}.journal_entries (
         id, tenant_id, movement_id, posting_no, kind, effective_at, posted_at, description
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [this.ids(), n.tenantId, movement?.id ?? null, n.postingNo ?? null, n.kind, entryToPost.effectiveAt, now, n.description],
    )
    const lineRows = n.lines.map((line, index) => ({
      line_no: index + 1,
      account: line.account,
      entity_id: line.entityId ?? movement?.entityId ?? null,
      role: line.role,
      side: line.side,
      asset: line.amount.asset,
      decimals: line.amount.decimals,
      amount: line.amount.raw.toString(),
      expectation_id: line.expectationId ?? null,
      exception_id: line.exceptionId ?? null,
    }))
    const lines = await this.run<JournalLineRow>(
      `INSERT INTO ${this.s}.journal_lines (
         entry_id, line_no, tenant_id, account, entity_id, role, side, asset, decimals, amount, expectation_id, exception_id
       )
       SELECT $1, x.line_no, $2, x.account, x.entity_id, x.role, x.side, x.asset, x.decimals,
              x.amount, x.expectation_id, x.exception_id
         FROM jsonb_to_recordset($3::jsonb) AS x(
           line_no integer, account text, entity_id text, role text, side text, asset text, decimals integer,
           amount numeric, expectation_id text, exception_id text
         )
        ORDER BY x.line_no
       RETURNING *`,
      [entry!.id, n.tenantId, JSON.stringify(lineRows)],
    )
    lines.sort((a, b) => a.line_no - b.line_no)
    return toJournalEntry(entry!, lines)
  }

  async openException(n: NewException): Promise<ExceptionRecord> {
    assertValidNewException(n)
    if (n.movementId != null && (await this.getMovement(n.tenantId, n.movementId)) === null) {
      throw new NotFoundError('movement', n.movementId)
    }
    if (n.expectationId != null && (await this.getExpectation(n.tenantId, n.expectationId)) === null) {
      throw new NotFoundError('expectation', n.expectationId)
    }
    const [row] = await this.run<ExceptionRow>(
      `INSERT INTO ${this.s}.exceptions (
         id, tenant_id, code, status, movement_id, expectation_id, account, asset, decimals, amount,
         detail, evidence, opened_at
       ) VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        this.ids(),
        n.tenantId,
        n.code,
        n.movementId ?? null,
        n.expectationId ?? null,
        n.account ?? null,
        n.amount?.asset ?? null,
        n.amount?.decimals ?? null,
        n.amount == null ? null : n.amount.raw.toString(),
        n.detail,
        JSON.stringify(n.evidence ?? null),
        this.now(),
      ],
    )
    const record = toException(row!)
    await this.emit(exceptionChanged(record))
    return record
  }

  async resolveException(tenantId: string, id: string, resolution: Resolution): Promise<ExceptionRecord> {
    const [current] = await this.run<ExceptionRow>(
      `SELECT * FROM ${this.s}.exceptions WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, id],
    )
    if (current === undefined) throw new NotFoundError('exception', id)
    checkResolution(toException(current), resolution)
    const [row] = await this.run<ExceptionRow>(
      `UPDATE ${this.s}.exceptions SET status = $3, resolved_at = $4, resolution_note = $5
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tenantId, id, resolution.status, this.now(), resolution.note],
    )
    const next = toException(row!)
    await this.emit(exceptionChanged(next))
    return next
  }

  async postAccrualExpectation(expectationId: string, tenantId: string, direction: Direction, amount: Money, reference: string): Promise<void> {
    await postAccrual(this, expectationId, tenantId, direction, amount, reference)
  }

  async linkRefund(tenantId: string, creditMovementId: string, refundMovementId: string): Promise<RefundLink> {
    await this.getMovement(tenantId,creditMovementId)
    const [existing]=await this.listRefundLinks({tenantId,refundMovementId})
    if (existing) {
      if (existing.creditMovementId !== creditMovementId) throw new ConstraintError('refund_invalid','refund already linked to another credit')
      return existing
    }
    const parts=await refundParts(this,tenantId,creditMovementId,refundMovementId)
    const [row]=await this.run(`INSERT INTO ${this.s}.refund_links(id,tenant_id,credit_movement_id,refund_movement_id,asset,decimals,amount,residual_amount,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[this.ids(),tenantId,creditMovementId,refundMovementId,parts.amount.asset,parts.amount.decimals,parts.amount.raw.toString(),parts.residualAmount.raw.toString(),this.now()])
    return refundLinkFromRow(row!)
  }

  async insertValuations(batch: readonly NewMovementValuation[]): Promise<void> {
    const now = this.now()
    for (const n of batch) {
      const m = await this.getMovement(n.tenantId, n.movementId)
      if (m === null) throw new NotFoundError('movement', n.movementId)
      await this.run(
        `INSERT INTO ${this.s}.movement_valuations (
           tenant_id, movement_id, reporting_asset, price_n, price_d, price_source, price_timestamp, decimals, value, valued_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id, movement_id) DO NOTHING`,
        [
          n.tenantId,
          n.movementId,
          n.reportingAsset,
          n.priceNumerator.toString(),
          n.priceDenominator.toString(),
          n.priceSource,
          n.priceTimestamp,
          n.value.decimals,
          n.value.raw.toString(),
          n.valuedAt ?? now,
        ],
      )
    }
  }
}

export class PostgresStore extends PgReader implements MigratableStore {
  async exportGetMark(tenantId: string, destination: string): Promise<string | null> {
    const [row] = await this.run<{ last_seq: string | null }>(
      `SELECT last_seq FROM ${this.s}.exports WHERE tenant_id = $1 AND destination = $2`,
      [tenantId, destination],
    )
    return row?.last_seq ?? null
  }

  async exportSetMark(tenantId: string, destination: string, lastSeq: number): Promise<void> {
    await this.run(
      `INSERT INTO ${this.s}.exports (tenant_id, destination, last_seq, last_exported_at, control_totals, checksum)
       VALUES ($1, $2, $3, now(), '{}', '')
       ON CONFLICT (tenant_id, destination) DO UPDATE SET last_seq = $3, last_exported_at = now()`,
      [tenantId, destination, lastSeq],
    )
  }


  async postAccrualExpectation(expectationId: string, tenantId: string, direction: Direction, amount: Money, reference: string): Promise<void> {
    await this.transaction(tx => tx.postAccrualExpectation(expectationId, tenantId, direction, amount, reference))
  }

  async exportListBatches(tenantId: string): Promise<readonly { readonly destination: string; readonly last_seq: number; readonly last_exported_at: number; readonly control_totals: string; readonly checksum: string }[]> {
    const rows = await this.run<{ destination: string; last_seq: number; last_exported_at: string; control_totals: string; checksum: string }>(
      `SELECT destination, last_seq, last_exported_at, control_totals, checksum FROM ${this.s}.exports WHERE tenant_id = $1`,
      [tenantId],
    )
    return rows.map(r => ({
      destination: r.destination,
      last_seq: r.last_seq,
      last_exported_at: Number(r.last_exported_at),
      control_totals: r.control_totals,
      checksum: r.checksum,
    }))
  }
  private readonly pool: Pool
  private readonly ownsPool: boolean
  private readonly schema: string
  private readonly ids: () => string
  private readonly now: () => Date
  private readonly rls: PostgresRlsOptions | undefined
  private readonly rlsContext: AsyncLocalStorage<string> | undefined
  private readonly rlsSetting: string

  constructor(options: PostgresStoreOptions) {
    if (options.pool === undefined && options.connectionString === undefined) {
      throw new Error('PostgresStore needs a pool or a connectionString.')
    }
    const pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString })
    const schema = options.schema ?? 'nostro'
    const rls = options.rls?.enabled === true ? options.rls : undefined
    const rlsSetting = rls?.tenantSetting ?? RLS_TENANT_SETTING
    if (!/^[a-z_][a-z0-9_.]*$/.test(rlsSetting)) {
      throw new Error(`Invalid tenant setting ${JSON.stringify(rlsSetting)}: use lowercase letters, digits, _ and .`)
    }
    if (rls?.appRole !== undefined) quoteRole(rls.appRole)
    const context = rls === undefined ? undefined : new AsyncLocalStorage<string>()
    super(quoteSchema(schema), async (sql, params) => {
      const args = params === undefined ? undefined : [...params]
      if (rls === undefined) return (await pool.query(sql, args)).rows
      const client = await pool.connect()
      let broken: Error | undefined
      try {
        await client.query('BEGIN READ ONLY')
        if (rls.appRole !== undefined) await client.query(`SET LOCAL ROLE ${quoteRole(rls.appRole)}`)
        await client.query('SELECT set_config($1, $2, true)', [rlsSetting, context!.getStore() ?? ''])
        const result = await client.query(sql, args)
        await client.query('COMMIT')
        return result.rows
      } catch (err) {
        await client.query('ROLLBACK').catch((rollbackError: unknown) => {
          broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError))
        })
        throw err
      } finally {
        client.release(broken)
      }
    })
    this.pool = pool
    this.ownsPool = options.pool === undefined
    this.schema = schema
    this.ids = options.ids ?? randomUUID
    this.now = options.now ?? (() => new Date())
    this.rls = rls
    this.rlsContext = context
    this.rlsSetting = rlsSetting
    if (rls !== undefined) return tenantReadProxy(this, context!) as PostgresStore
  }

  /**
   * Fill the text-memo index for expectations written before migration 5.
   * Idempotent, so a database rolled back and re-migrated does not double up.
   */
  private async backfillReferenceIndex(client: PoolClient): Promise<void> {
    const { rows } = await client.query<{
      id: string
      tenant_id: string
      reference: string
      memo_type: Memo['type'] | null
      memo_text: Buffer | null
    }>(`SELECT id, tenant_id, reference, memo_type, memo_text FROM ${this.s}.expectations`)
    const insert = `INSERT INTO ${this.s}.expectation_reference_index (tenant_id, normalized, expectation_id)
                    VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`
    for (const row of rows) {
      const memo: Memo | null = row.memo_type === 'text'
        ? { type: 'text', value: (row.memo_text ?? Buffer.alloc(0)).toString('utf8') }
        : null
      for (const normalized of expectationReferenceKeys(row.reference, memo)) {
        await client.query(insert, [row.tenant_id, normalized, row.id])
      }
    }
  }

  /**
   * Create the schema and apply any pending migrations. Safe to call from
   * several processes at once: they serialise on an advisory lock.
   */
  async migrate(): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT set_config($1, $2, true)', [RLS_BYPASS_SETTING, 'on'])
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nostro:migrate:${this.schema}`])
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.s}`)
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${this.s}.migrations (
           version    integer PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      )
      const { rows } = await client.query<{ version: number }>(
        `SELECT coalesce(max(version), 0) AS version FROM ${this.s}.migrations`,
      )
      const version = rows[0]!.version
      for (let v = version + 1; v <= MIGRATIONS.length; v++) {
        await client.query(MIGRATIONS[v - 1]!(this.s))
        await client.query(`INSERT INTO ${this.s}.migrations (version) VALUES ($1)`, [v])
      }
      if (version < 5) await this.backfillReferenceIndex(client)
      if (this.rls !== undefined && this.rlsSetting !== RLS_TENANT_SETTING) {
        await client.query(rlsPolicySql(this.s, this.rlsSetting))
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw err
    } finally {
      client.release()
    }
  }

  /** The highest migration applied to this schema, and the version `migrate()` brings it to. */
  async schemaVersion(): Promise<SchemaVersion> {
    const latest = MIGRATIONS.length
    const [table] = await this.run<{ name: string | null }>('SELECT to_regclass($1)::text AS name', [`${this.s}.migrations`])
    if (table?.name == null) return { current: 0, latest }
    const [row] = await this.run<{ version: number }>(
      `SELECT coalesce(max(version), 0) AS version FROM ${this.s}.migrations`,
    )
    return { current: row!.version, latest }
  }

  async transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>
  async transaction<T>(tenantId: string, fn: (tx: StoreTx) => Promise<T>): Promise<T>
  async transaction<T>(
    tenantIdOrFn: string | ((tx: StoreTx) => Promise<T>),
    maybeFn?: (tx: StoreTx) => Promise<T>,
  ): Promise<T> {
    const tenantId = typeof tenantIdOrFn === 'string' ? tenantIdOrFn : undefined
    const fn = (typeof tenantIdOrFn === 'string' ? maybeFn : tenantIdOrFn)!
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.transactionOnce(fn, tenantId)
      } catch (error) {
        if ((error as { code?: unknown })?.code !== '40P01' || attempt >= 3) throw error
        // The complete transaction is replayed on a fresh connection. A short
        // stagger prevents two writers from repeatedly colliding in lockstep.
        await new Promise<void>((resolve) => setTimeout(resolve, 10 * (2 ** attempt) + Math.floor(Math.random() * 10)))
      }
    }
  }

  private async transactionOnce<T>(fn: (tx: StoreTx) => Promise<T>, tenantId?: string): Promise<T> {
    const client = await this.pool.connect()
    const pin = this.rls === undefined
      ? undefined
      : new TenantPin(async (id) => {
          await client.query('SELECT set_config($1, $2, true)', [this.rlsSetting, id])
        })
    const raw = new PgTx(this.s, client, this.ids, this.now, pin)
    const tx = pin === undefined ? raw : tenantTxProxy(raw, pin)
    let broken: Error | undefined
    try {
      await client.query('BEGIN')
      if (this.rls?.appRole !== undefined) await client.query(`SET LOCAL ROLE ${quoteRole(this.rls.appRole)}`)
      await pin?.apply(tenantId)
      const result = await fn(tx)
      raw.close()
      await client.query('COMMIT')
      return result
    } catch (err) {
      raw.close()
      await client.query('ROLLBACK').catch((rollbackError: unknown) => {
        // The connection is unusable; make the pool discard it.
        broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError))
      })
      throw err
    } finally {
      raw.close()
      client.release(broken)
    }
  }

  /** A convenience handle for one tenant: writes pin the tenant, reads need no tenant argument. */
  forTenant(tenantId: string): TenantScopedStore {
    const store: PostgresStore = this
    const read = <T>(fn: () => Promise<T>): Promise<T> =>
      this.rlsContext === undefined ? fn() : this.rlsContext.run(tenantId, fn)
    return Object.freeze({
      tenantId,
      transaction: <T>(fn: (tx: StoreTx) => Promise<T>) => store.transaction(tenantId, fn),
      getMovement: (id: string) => store.getMovement(tenantId, id),
      listMovements: (query: Omit<MovementQuery, 'tenantId'>) => store.listMovements({ ...query, tenantId }),
      listEvents: (query: Omit<EventQuery, 'tenantId'>) => store.listEvents({ ...query, tenantId }),
      getCursor: (key: Omit<CursorKey, 'tenantId'>) => store.getCursor({ ...key, tenantId }),
      findApiKeyByDigest: (digest: string) => read(() => store.findApiKeyByDigest(digest)),
      listApiKeys: () => read(() => store.listApiKeys(tenantId)),
    })
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end()
  }
}
