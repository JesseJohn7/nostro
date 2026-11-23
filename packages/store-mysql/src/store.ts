import { randomUUID } from 'node:crypto'
import mysql from 'mysql2/promise'
import type { Pool, PoolConnection } from 'mysql2/promise'
import type { ResultSetHeader } from 'mysql2'
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
  RewindRow,
} from './rows.js'
import { flag, memoColumns, storedOpeningBalance, toAccountEntity, toAccountOpening, toAllocation, toDeliveryAttempt, toEntity, toEvent, toException, toExpectation, toInternalTransferLink, toJournalEntry, toMovement, toRewind, toValuation } from './rows.js'
import { MIGRATIONS, quoteSchema } from './schema.js'

export interface MysqlStoreOptions {
  readonly pool?: Pool
  readonly connectionString?: string
  readonly database?: string
  readonly ids?: () => string
  readonly now?: () => Date
}

type Run = <R>(sql: string, params?: readonly unknown[]) => Promise<R[]>
type Exec = (sql: string, params?: readonly unknown[]) => Promise<ResultSetHeader>

const TIME = 'DATETIME(6)'
const ENGINE = ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC'

interface ParsedUrl {
  readonly config: Record<string, unknown>
  readonly database: string
}

const CONNECTION_FLAGS = {
  charset: 'utf8mb4',
  timezone: 'Z',
  supportBigNumbers: true,
  bigNumberStrings: true,
  decimalNumbers: false,
  multipleStatements: false,
}

function parseConnectionString(url: string): ParsedUrl {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid MySQL connection string ${JSON.stringify(url)}.`)
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  const config: Record<string, unknown> = {
    ...CONNECTION_FLAGS,
    host: parsed.hostname,
    port: parsed.port === '' ? 3306 : Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  }
  for (const [key, value] of parsed.searchParams) {
    config[key] = key === 'ssl' ? value !== 'false' && value !== '0' : value
  }
  return { config, database }
}

class Where {
  readonly params: unknown[] = []
  private readonly clauses: string[] = []

  add(sql: (p: string) => string, value: unknown): this {
    if (value !== undefined) {
      this.params.push(value)
      this.clauses.push(sql('?'))
    }
    return this
  }

  in(sql: (p: string) => string, values: readonly unknown[] | undefined): this {
    if (values === undefined) return this
    if (values.length === 0) {
      this.clauses.push('1 = 0')
      return this
    }
    this.params.push([...values])
    this.clauses.push(sql('?'))
    return this
  }

  pair(sql: (a: string, b: string) => string, values: readonly unknown[] | undefined): this {
    if (values === undefined) return this
    if (values.length === 0) {
      this.clauses.push('1 = 0')
      return this
    }
    this.params.push([...values], [...values])
    this.clauses.push(sql('?', '?'))
    return this
  }

  limit(n: number | undefined): string {
    if (n === undefined) return ''
    this.params.push(n)
    return ' LIMIT ?'
  }

  toString(): string {
    return this.clauses.length === 0 ? '' : ` WHERE ${this.clauses.join(' AND ')}`
  }
}

function valuesSql(rows: readonly (readonly unknown[])[]): { sql: string; params: unknown[] } {
  const width = rows[0]?.length ?? 0
  const params = rows.flatMap((row) => [...row])
  return { sql: rows.map(() => `(${new Array<string>(width).fill('?').join(', ')})`).join(', '), params }
}

function tupleIn(rows: readonly (readonly unknown[])[]): { sql: string; params: unknown[] } {
  const width = rows[0]?.length ?? 0
  return {
    sql: rows.map(() => `(${new Array<string>(width).fill('?').join(', ')})`).join(', '),
    params: rows.flatMap((row) => [...row]),
  }
}

class MysqlReader implements StoreReader {
  constructor(
    protected readonly s: string,
    protected readonly run: Run,
    protected readonly exec: Exec,
  ) {}

  async getMovement(tenantId: string, id: string): Promise<Movement | null> {
    const [row] = await this.run<MovementRow>(
      `SELECT * FROM ${this.s}.movements WHERE tenant_id = ? AND id = ?`,
      [tenantId, id],
    )
    return row === undefined ? null : toMovement(row)
  }

  async listMovements(q: MovementQuery): Promise<Movement[]> {
    if (q.ids?.length === 0) return []
    const w = new Where()
      .add((p) => `tenant_id = ${p}`, q.tenantId)
      .in((p) => `id IN (${p})`, q.ids)
      .add((p) => `disposition = ${p}`, q.disposition)
      .add((p) => `account = ${p}`, q.account)
      .add((p) => `entity_id = ${p}`, q.entityId)
      .add((p) => `tx_hash = ${p}`, q.txHash)
      .add((p) => `seq > ${p}`, q.afterSeq)
    const sql = `SELECT * FROM ${this.s}.movements${w} ORDER BY seq${w.limit(q.limit)}`
    return (await this.run<MovementRow>(sql, w.params)).map(toMovement)
  }

  async getExpectation(tenantId: string, id: string): Promise<Expectation | null> {
    const [row] = await this.run<ExpectationRow>(
      `SELECT * FROM ${this.s}.expectations WHERE tenant_id = ? AND id = ?`,
      [tenantId, id],
    )
    return row === undefined ? null : toExpectation(row)
  }

  async getExpectationByReference(tenantId: string, reference: string): Promise<Expectation | null> {
    const [row] = await this.run<ExpectationRow>(
      `SELECT * FROM ${this.s}.expectations WHERE tenant_id = ? AND reference = ?`,
      [tenantId, reference],
    )
    return row === undefined ? null : toExpectation(row)
  }

  async getExpectationsByNormalizedReference(tenantId: string, normalized: string): Promise<Expectation[]> {
    if (normalized === '') return []
    const rows = await this.run<ExpectationRow>(
      `SELECT e.* FROM ${this.s}.expectation_reference_index k
         JOIN ${this.s}.expectations e ON e.id = k.expectation_id
        WHERE k.tenant_id = ? AND k.normalized = ?
        ORDER BY e.seq`,
      [tenantId, normalized],
    )
    return rows.map(toExpectation)
  }

  async listExpectations(q: ExpectationQuery): Promise<Expectation[]> {
    if (q.ids?.length === 0) return []
    const w = new Where()
      .add((p) => `tenant_id = ${p}`, q.tenantId)
      .in((p) => `id IN (${p})`, q.ids)
      .add((p) => `account = ${p}`, q.account)
      .add((p) => `asset = ${p}`, q.asset)
      .add((p) => `direction = ${p}`, q.direction)
      .in((p) => `status IN (${p})`, q.status)
      .add((p) => `muxed_id = ${p}`, q.muxedId === undefined ? undefined : q.muxedId.toString())
      .add((p) => `seq > ${p}`, q.afterSeq)
    const sql = `SELECT * FROM ${this.s}.expectations${w} ORDER BY seq${w.limit(q.limit)}`
    return (await this.run<ExpectationRow>(sql, w.params)).map(toExpectation)
  }

  async listAllocations(q: AllocationQuery): Promise<Allocation[]> {
    if (q.movementIds?.length === 0 || q.expectationIds?.length === 0) return []
    const w = new Where()
      .add((p) => `tenant_id = ${p}`, q.tenantId)
      .add((p) => `movement_id = ${p}`, q.movementId)
      .in((p) => `movement_id IN (${p})`, q.movementIds)
      .add((p) => `expectation_id = ${p}`, q.expectationId)
      .in((p) => `expectation_id IN (${p})`, q.expectationIds)
    return (await this.run<AllocationRow>(`SELECT * FROM ${this.s}.allocations${w} ORDER BY seq`, w.params)).map(
      toAllocation,
    )
  }

  async getException(tenantId: string, id: string): Promise<ExceptionRecord | null> {
    const [row] = await this.run<ExceptionRow>(
      `SELECT * FROM ${this.s}.exceptions WHERE tenant_id = ? AND id = ?`,
      [tenantId, id],
    )
    return row === undefined ? null : toException(row)
  }

  async listExceptions(q: ExceptionQuery): Promise<ExceptionRecord[]> {
    if (q.ids?.length === 0 || q.movementIds?.length === 0 || q.expectationIds?.length === 0) return []
    const w = new Where()
      .add((p) => `tenant_id = ${p}`, q.tenantId)
      .in((p) => `id IN (${p})`, q.ids)
      .add((p) => `status = ${p}`, q.status)
      .add((p) => `code = ${p}`, q.code)
      .add((p) => `movement_id = ${p}`, q.movementId)
      .in((p) => `movement_id IN (${p})`, q.movementIds)
      .add((p) => `expectation_id = ${p}`, q.expectationId)
      .in((p) => `expectation_id IN (${p})`, q.expectationIds)
      .add((p) => `seq > ${p}`, q.afterSeq)
    const sql = `SELECT * FROM ${this.s}.exceptions${w} ORDER BY seq${w.limit(q.limit)}`
    return (await this.run<ExceptionRow>(sql, w.params)).map(toException)
  }

  async getEntity(tenantId: string, id: string): Promise<Entity | null> {
    const [row] = await this.run<EntityRow>(
      `SELECT * FROM ${this.s}.entities WHERE tenant_id = ? AND id = ?`,
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
      `SELECT * FROM ${this.s}.account_entities WHERE tenant_id = ? AND network = ? AND account = ?`,
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
      `SELECT * FROM ${this.s}.internal_transfer_links WHERE tenant_id = ? AND id = ?`,
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
      .pair((a, b) => `(movement_a IN (${a}) OR movement_b IN (${b}))`, q.movementIds)
    const rows = await this.run<InternalTransferLinkRow>(
      `SELECT * FROM ${this.s}.internal_transfer_links${w} ORDER BY created_at, id${w.limit(q.limit)}`,
      w.params,
    )
    return rows.map(toInternalTransferLink)
  }

  async getAccountOpening(tenantId: string, network: string, account: string): Promise<AccountOpening | null> {
    const [row] = await this.run<AccountOpeningRow>(
      `SELECT * FROM ${this.s}.account_openings WHERE tenant_id = ? AND network = ? AND account = ?`,
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
      .in((p) => `movement_id IN (${p})`, q.movementIds)
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
      `SELECT * FROM ${this.s}.journal_lines WHERE entry_id IN (?) ORDER BY entry_id, line_no`,
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
      `SELECT COALESCE(pruned_through, 0) AS seq FROM ${this.s}.event_prune_state WHERE tenant_id = ?`,
      [tenantId],
    )
    return Number(row?.seq ?? 0)
  }

  async getLatestEventSeq(tenantId: string): Promise<number> {
    const [row] = await this.run<{ seq: string | number | null }>(
      `SELECT MAX(seq) AS seq FROM ${this.s}.events WHERE tenant_id = ?`,
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
         WHERE tenant_id = ? AND network = 'nostro' AND source = 'outbox' AND value IS NOT NULL
       UNION
       SELECT DISTINCT consumer AS account FROM ${this.s}.webhook_delivery_attempts WHERE tenant_id = ?
       UNION
       SELECT DISTINCT consumer AS account FROM ${this.s}.webhook_rewinds WHERE tenant_id = ?
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
      `SELECT value FROM ${this.s}.cursors WHERE tenant_id = ? AND network = ? AND source = ? AND account = ?`,
      [k.tenantId, k.network, k.source, k.account],
    )
    return row?.value ?? null
  }

  async findApiKeyByDigest(digest: string): Promise<ApiKeyRow | null> {
    const [row] = await this.run<ApiKeyDbRow>(`SELECT * FROM ${this.s}.api_keys WHERE digest = ?`, [digest])
    return row === undefined ? null : toApiKey(row)
  }

  async listApiKeys(tenantId?: string): Promise<ApiKeyRow[]> {
    const rows =
      tenantId === undefined
        ? await this.run<ApiKeyDbRow>(`SELECT * FROM ${this.s}.api_keys ORDER BY created_at, id`)
        : await this.run<ApiKeyDbRow>(`SELECT * FROM ${this.s}.api_keys WHERE tenant_id = ? ORDER BY created_at, id`, [tenantId])
    return rows.map(toApiKey)
  }

  async listWatchedAccounts(tenantId: string): Promise<WatchedAccountRow[]> {
    const rows = await this.run<WatchedDbRow>(`SELECT * FROM ${this.s}.watched_accounts WHERE tenant_id = ? ORDER BY added_at, account`, [tenantId])
    return rows.map(toWatched)
  }

  async listSyncState(tenantId: string): Promise<SyncStateRow[]> {
    const rows = await this.run<SyncDbRow>(`SELECT * FROM ${this.s}.sync_state WHERE tenant_id = ? ORDER BY account, source, network`, [tenantId])
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
        WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1`,
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
    const w = new Where()
      .add((p) => `tenant_id = ${p}`, q.tenantId)
      .add((p) => `credit_movement_id = ${p}`, q.creditMovementId)
      .add((p) => `refund_movement_id = ${p}`, q.refundMovementId)
      .pair((a, b) => `(credit_movement_id IN (${a}) OR refund_movement_id IN (${b}))`, q.movementIds)
    return (await this.run<Record<string, unknown>>(`SELECT * FROM ${this.s}.refund_links${w} ORDER BY seq`, w.params)).map(refundLinkFromRow)
  }

  async accrualGetMode(tenantId: string): Promise<boolean> {
    const [row] = await this.run<{ active: number }>(
      `SELECT active FROM ${this.s}.accrual_modes WHERE tenant_id = ?`,
      [tenantId],
    )
    return flag(row?.active)
  }

  async getValuation(tenantId: string, movementId: string): Promise<MovementValuation | null> {
    const [row] = await this.run<MovementValuationRow>(
      `SELECT * FROM ${this.s}.movement_valuations WHERE tenant_id = ? AND movement_id = ?`,
      [tenantId, movementId],
    )
    return row === undefined ? null : toValuation(row)
  }

  async listValuations(q: ValuationQuery): Promise<MovementValuation[]> {
    let sql = `SELECT * FROM ${this.s}.movement_valuations WHERE tenant_id = ?`
    const params: unknown[] = [q.tenantId]
    if (q.movementId !== undefined) {
      sql += ` AND movement_id = ?`
      params.push(q.movementId)
    }
    if (q.reportingAsset !== undefined) {
      sql += ` AND reporting_asset = ?`
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
  scopes: string
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
  caught_up: number
  last_error: string | null
  last_error_at: Date | null
}

const toApiKey = (r: ApiKeyDbRow): ApiKeyRow => ({
  id: r.id,
  tenantId: r.tenant_id,
  label: r.label,
  digest: r.digest,
  scopes: Object.freeze(JSON.parse(r.scopes) as string[]),
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
  caughtUp: flag(r.caught_up),
  lastError: r.last_error,
  lastErrorAt: r.last_error_at,
})

const errorInfo = (err: unknown): { errno: number | undefined; code: string | undefined; message: string } => {
  const e = err as { errno?: number; code?: string; message?: string }
  return { errno: e.errno, code: e.code, message: e.message ?? String(err) }
}

const isUniqueViolation = (err: unknown, constraint: string): boolean => {
  const info = errorInfo(err)
  return info.errno === 1062 && info.message.includes(constraint)
}

const isDeadlock = (err: unknown): boolean => {
  const info = errorInfo(err)
  return info.errno === 1213 || info.code === 'ER_LOCK_DEADLOCK'
}

class MysqlTx extends MysqlReader implements StoreTx {
  private open = true
  private savepoints = 0
  private readonly periodLocks = new Set<string>()
  private readonly tenantLocks = new Set<string>()

  constructor(
    s: string,
    conn: PoolConnection,
    private readonly ids: () => string,
    private readonly now: () => Date,
  ) {
    super(
      s,
      async (sql, params) => {
        if (!this.open) throw new TransactionClosedError()
        const [result] = await conn.query(sql, params === undefined ? undefined : [...params])
        return Array.isArray(result) ? result as never : []
      },
      async (sql, params) => {
        if (!this.open) throw new TransactionClosedError()
        const [result] = await conn.query(sql, params === undefined ? undefined : [...params])
        return result as ResultSetHeader
      },
    )
  }

  close(): void {
    this.open = false
  }

  private async lockTenant(key: string): Promise<void> {
    if (this.tenantLocks.has(key)) return
    await this.run(`INSERT IGNORE INTO ${this.s}.event_locks (lock_key) VALUES (?)`, [key])
    await this.run(`SELECT lock_key FROM ${this.s}.event_locks WHERE lock_key = ? FOR UPDATE`, [key])
    this.tenantLocks.add(key)
  }

  async lockJournalPeriod(tenantId: string): Promise<JournalPeriod | null> {
    if (!this.periodLocks.has(tenantId)) {
      await this.lockTenant(`nostro:journal-period:${this.s}:${tenantId}`)
      this.periodLocks.add(tenantId)
    }
    return this.getJournalPeriod(tenantId)
  }

  async closeJournalPeriod(tenantId: string, through: Date, note: string | null): Promise<void> {
    checkJournalPeriodClose(tenantId, through, note)
    await this.lockJournalPeriod(tenantId)
    await this.run(
      `INSERT INTO ${this.s}.journal_period_actions (tenant_id, action, closed_through, note, reason, created_at)
       VALUES (?, 'close', ?, ?, NULL, ?)`,
      [tenantId, through, note, this.now()],
    )
  }

  async reopenJournalPeriod(tenantId: string, reason: string): Promise<void> {
    const period = await this.lockJournalPeriod(tenantId)
    checkJournalPeriodReopen(tenantId, reason, period !== null)
    await this.run(
      `INSERT INTO ${this.s}.journal_period_actions (tenant_id, action, closed_through, note, reason, created_at)
       VALUES (?, 'reopen', NULL, NULL, ?, ?)`,
      [tenantId, reason, this.now()],
    )
  }

  private async emit(event: NewOutboxEvent | null): Promise<void> {
    if (event === null) return
    await this.lockTenant(`nostro:events:${this.s}:${event.tenantId}`)
    await this.run(
      `INSERT INTO ${this.s}.events (id, tenant_id, type, subject_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
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
      `SELECT * FROM ${this.s}.expectations WHERE tenant_id = ? AND id = ? FOR UPDATE`,
      [tenantId, id],
    )
    if (row === undefined) throw new NotFoundError('expectation', id)
    return toExpectation(row)
  }

  override async getMovement(tenantId: string, id: string): Promise<Movement | null> {
    await this.lockJournalPeriod(tenantId)
    const [row] = await this.run<MovementRow>(
      `SELECT * FROM ${this.s}.movements WHERE tenant_id = ? AND id = ? FOR UPDATE`,
      [tenantId, id],
    )
    return row === undefined ? null : toMovement(row)
  }

  override async getCursor(k: CursorKey): Promise<string | null> {
    const params = [k.tenantId, k.network, k.source, k.account]
    await this.run(
      `INSERT IGNORE INTO ${this.s}.cursors (tenant_id, network, source, account, value)
       VALUES (?, ?, ?, ?, NULL)`,
      params,
    )
    const [row] = await this.run<{ value: string | null }>(
      `SELECT value FROM ${this.s}.cursors
        WHERE tenant_id = ? AND network = ? AND source = ? AND account = ? FOR UPDATE`,
      params,
    )
    return row?.value ?? null
  }

  async setCursor(k: CursorKey, value: string): Promise<void> {
    checkCursorValue(value)
    await this.run(
      `INSERT INTO ${this.s}.cursors (tenant_id, network, source, account, value) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      [k.tenantId, k.network, k.source, k.account, value],
    )
  }

  async insertApiKey(input: NewApiKeyRow): Promise<ApiKeyRow> {
    const savepoint = `nostro_${++this.savepoints}`
    await this.run(`SAVEPOINT ${savepoint}`)
    try {
      await this.run(
        `INSERT INTO ${this.s}.api_keys (id, tenant_id, label, digest, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [input.id, input.tenantId, input.label, input.digest, JSON.stringify([...input.scopes]), input.createdAt],
      )
      await this.run(`RELEASE SAVEPOINT ${savepoint}`)
    } catch (err) {
      await this.run(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      await this.run(`RELEASE SAVEPOINT ${savepoint}`)
      if (isUniqueViolation(err, 'api_keys_digest_unique')) {
        throw new ConstraintError('api_key_digest_unique', 'that key is already stored')
      }
      throw err
    }
    const [row] = await this.run<ApiKeyDbRow>(`SELECT * FROM ${this.s}.api_keys WHERE id = ?`, [input.id])
    return toApiKey(row!)
  }

  async revokeApiKey(id: string, at: Date): Promise<ApiKeyRow> {
    const [row] = await this.run<ApiKeyDbRow>(`SELECT * FROM ${this.s}.api_keys WHERE id = ? FOR UPDATE`, [id])
    if (row === undefined) throw new NotFoundError('api_key', id)
    if (row.revoked_at === null) {
      await this.run(`UPDATE ${this.s}.api_keys SET revoked_at = ? WHERE id = ?`, [at, id])
    }
    const [updated] = await this.run<ApiKeyDbRow>(`SELECT * FROM ${this.s}.api_keys WHERE id = ?`, [id])
    return toApiKey(updated!)
  }

  async recordApiKeyUse(uses: readonly { readonly id: string; readonly at: Date }[]): Promise<void> {
    for (const { id, at } of uses) {
      await this.run(
        `UPDATE ${this.s}.api_keys SET last_used_at = GREATEST(COALESCE(last_used_at, '1970-01-01 00:00:00.000000'), ?) WHERE id = ?`,
        [at, id],
      )
    }
  }

  async addWatchedAccount(row: WatchedAccountRow): Promise<WatchedAccountRow> {
    await this.run(
      `INSERT INTO ${this.s}.watched_accounts (tenant_id, account, source, added_at) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE tenant_id = tenant_id`,
      [row.tenantId, row.account, row.source, row.addedAt],
    )
    const [stored] = await this.run<WatchedDbRow>(
      `SELECT * FROM ${this.s}.watched_accounts WHERE tenant_id = ? AND account = ?`,
      [row.tenantId, row.account],
    )
    return toWatched(stored!)
  }

  async removeWatchedAccount(tenantId: string, account: string): Promise<boolean> {
    const result = await this.exec(
      `DELETE FROM ${this.s}.watched_accounts WHERE tenant_id = ? AND account = ?`,
      [tenantId, account],
    )
    return result.affectedRows > 0
  }

  async recordSyncState(state: SyncStateRow): Promise<void> {
    await this.run(
       `INSERT INTO ${this.s}.sync_state (tenant_id, network, source, account, \`cursor\`, last_attempt_at, last_success_at, caught_up, last_error, last_error_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          \`cursor\` = VALUES(\`cursor\`), last_attempt_at = VALUES(last_attempt_at), last_success_at = VALUES(last_success_at),
         caught_up = VALUES(caught_up), last_error = VALUES(last_error), last_error_at = VALUES(last_error_at)`,
      [
        state.tenantId,
        state.network,
        state.source,
        state.account,
        state.cursor,
        state.lastAttemptAt,
        state.lastSuccessAt,
        state.caughtUp ? 1 : 0,
        state.lastError,
        state.lastErrorAt,
      ],
    )
  }

  async recordDeliveryAttempt(attempt: NewDeliveryAttempt): Promise<DeliveryAttempt> {
    const id = this.ids()
    await this.run(
      `INSERT INTO ${this.s}.webhook_delivery_attempts
         (id, tenant_id, consumer, event_id, event_seq, attempt_at, http_status, error, duration_ms, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, attempt.tenantId, attempt.consumer, attempt.eventId, attempt.eventSeq, attempt.at, attempt.httpStatus, attempt.error, attempt.durationMs, attempt.outcome],
    )
    const [boundary] = await this.run<{ seq: string }>(
      `SELECT seq FROM ${this.s}.webhook_delivery_attempts
        WHERE tenant_id = ? AND consumer = ? ORDER BY seq DESC LIMIT 1 OFFSET ?`,
      [attempt.tenantId, attempt.consumer, DELIVERY_ATTEMPT_LIMIT - 1],
    )
    const cutoff = new Date(attempt.at.getTime() - DELIVERY_ATTEMPT_TTL_MS)
    if (boundary === undefined) {
      await this.exec(
        `DELETE FROM ${this.s}.webhook_delivery_attempts WHERE tenant_id = ? AND consumer = ? AND attempt_at < ?`,
        [attempt.tenantId, attempt.consumer, cutoff],
      )
    } else {
      await this.exec(
        `DELETE FROM ${this.s}.webhook_delivery_attempts
          WHERE tenant_id = ? AND consumer = ? AND (seq < ? OR attempt_at < ?)`,
        [attempt.tenantId, attempt.consumer, boundary.seq, cutoff],
      )
    }
    const [row] = await this.run<DeliveryAttemptRow>(
      `SELECT * FROM ${this.s}.webhook_delivery_attempts WHERE id = ?`, [id],
    )
    return toDeliveryAttempt(row!)
  }

  async rewindConsumer(input: RewindInput): Promise<Rewind | null> {
    const key = eventCursorKey(input.tenantId, input.consumer)
    const current = await this.getCursor(key)
    if ((current === null ? 0 : Number(current)) !== input.expectedSeq) return null
    await this.setCursor(key, String(input.toSeq))
    const id = this.ids()
    await this.run(
      `INSERT INTO ${this.s}.webhook_rewinds (id, tenant_id, consumer, from_seq, to_seq, actor, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.tenantId, input.consumer, input.expectedSeq, input.toSeq, input.actor, input.at],
    )
    const [row] = await this.run<RewindRow>(`SELECT * FROM ${this.s}.webhook_rewinds WHERE id = ?`, [id])
    return toRewind(row!)
  }

  async pruneEventsBefore(tenantId: string, olderThan: Date): Promise<PruneEventsResult> {
    if (!Number.isFinite(olderThan.getTime())) throw new Error('olderThan must be a valid date')
    await this.lockTenant(`nostro:events:${this.s}:${tenantId}`)
    const [bounds] = await this.run<{ prefix_through: string | number | null; consumer_through: string | number | null }>(
      `SELECT
         COALESCE(
           (SELECT MIN(seq) - 1 FROM ${this.s}.events WHERE tenant_id = ? AND created_at > ?),
           (SELECT MAX(seq) FROM ${this.s}.events WHERE tenant_id = ?),
           0
         ) AS prefix_through,
         (SELECT MIN(CAST(value AS UNSIGNED)) FROM ${this.s}.cursors
           WHERE tenant_id = ? AND network = 'nostro' AND source = 'outbox') AS consumer_through`,
      [tenantId, olderThan, tenantId, tenantId],
    )
    const prefixThrough = Number(bounds?.prefix_through ?? 0)
    const safeThrough = Math.min(prefixThrough, bounds?.consumer_through == null ? prefixThrough : Number(bounds.consumer_through))
    let removed: ResultSetHeader
    let last: { seq: string | number } | undefined
    await this.run("SET @nostro_event_prune = 'on'")
    try {
      const rows = await this.run<{ seq: string | number }>(
        `SELECT COALESCE(MAX(seq), 0) AS seq FROM ${this.s}.events
          WHERE tenant_id = ? AND seq <= ? AND created_at <= ?`,
        [tenantId, safeThrough, olderThan],
      )
      last = rows[0]
      removed = await this.exec(
        `DELETE FROM ${this.s}.events WHERE tenant_id = ? AND seq <= ? AND created_at <= ?`,
        [tenantId, safeThrough, olderThan],
      )
    } finally {
      await this.run("SET @nostro_event_prune = 'off'").catch(() => undefined)
    }
    const lastRemoved = Number(last?.seq ?? 0)
    if (lastRemoved > 0) {
      await this.run(
        `INSERT INTO ${this.s}.event_prune_state (tenant_id, pruned_through) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE pruned_through = GREATEST(pruned_through, VALUES(pruned_through))`,
        [tenantId, lastRemoved],
      )
    }
    return { deleted: removed.affectedRows, prunedThrough: Math.max(await this.getEventsPrunedThrough(tenantId), lastRemoved) }
  }

  async insertEntity(n: NewEntity): Promise<Entity> {
    assertValidNewEntity(n)
    if (await this.getEntity(n.tenantId, n.id) !== null) {
      throw new ConstraintError('entity_duplicate', `entity ${n.id} already exists in this tenant`)
    }
    const record: Entity = Object.freeze({ ...n, createdAt: this.now() })
    try {
      await this.run(
        `INSERT INTO ${this.s}.entities (id, tenant_id, name, created_at) VALUES (?, ?, ?, ?)`,
        [record.id, record.tenantId, record.name, record.createdAt],
      )
    } catch (err) {
      if (errorInfo(err).errno === 1062) {
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
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE entity_id = VALUES(entity_id), created_at = VALUES(created_at)`,
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [record.id, record.tenantId, record.network, record.txHash, movementA, movementB, sameEntity ? 1 : 0, record.createdAt],
      )
    } catch (err) {
      const info = errorInfo(err)
      if (info.errno === 1062 || info.message.includes('already part of another internal transfer')) {
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
      `SELECT 1 FROM ${this.s}.movements WHERE tenant_id = ? AND network = ? AND account = ? LIMIT 1`,
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      const id = this.ids()
      const row = [
        id,
        movement.tenantId,
        movement.network,
        movement.source,
        movement.externalId,
        movement.revision ?? 1,
        movement.account,
        entityIds[ordinal] ?? null,
        movement.direction,
        movement.kind,
        movement.amount.asset,
        movement.amount.decimals,
        movement.amount.raw.toString(),
        movement.counterparty ?? null,
        movement.muxedId == null ? null : movement.muxedId.toString(),
        memoType,
        memoValue,
        memoText,
        movement.ledger,
        movement.txHash ?? null,
        movement.operationId ?? null,
        movement.occurredAt,
        movement.enrichment ?? 'complete',
        'pending',
        null,
        this.now(),
      ]
      if (!seen.has(key)) {
        seen.add(key)
        unique.push({ ordinal, movement, id })
      }
      return { key, row, ordinal }
    })

    const uniqueOrdinals = new Set(unique.map(({ ordinal }) => ordinal))
    const uniqueRows = inputRows.filter(({ ordinal }) => uniqueOrdinals.has(ordinal)).map(({ row }) => row)
    const insert = valuesSql(uniqueRows)
    await this.run(
      `INSERT INTO ${this.s}.movements (
         id, tenant_id, network, source, external_id, revision, account, entity_id, direction, kind,
         asset, decimals, amount, counterparty, muxed_id, memo_type, memo_value, memo_text,
         ledger, tx_hash, operation_id, occurred_at, enrichment, disposition, ignored_reason, created_at
       ) VALUES ${insert.sql}
       ON DUPLICATE KEY UPDATE id = id`,
      insert.params,
    )

    const keys = unique.map(({ movement }) => [movement.tenantId, movement.network, movement.source, movement.externalId])
    const existingRows: MovementRow[] = []
    for (let i = 0; i < keys.length; i += 200) {
      const chunk = keys.slice(i, i + 200)
      if (chunk.length === 0) continue
      const tuples = tupleIn(chunk)
      existingRows.push(...await this.run<MovementRow>(
        `SELECT * FROM ${this.s}.movements
          WHERE (tenant_id, network, source, external_id) IN (${tuples.sql})`,
        tuples.params,
      ))
    }
    const keyOf = (value: Pick<NewMovement, 'tenantId' | 'network' | 'source' | 'externalId'>) =>
      JSON.stringify([value.tenantId, value.network, value.source, value.externalId])
    const storedByKey = new Map(existingRows.map((row) => [keyOf({
      tenantId: row.tenant_id,
      network: row.network,
      source: row.source,
      externalId: row.external_id,
    }), toMovement(row)]))
    const insertedKeys = new Set(unique.filter(({ id }) => existingRows.some((row) => row.id === id)).map(({ movement }) => keyOf(movement)))
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
    checkDisposition(m, allocations, exceptions, disposition, reason, refundCoverage(m, await this.listRefundLinks({ tenantId, movementIds: [m.id] })))
    await this.run(
      `UPDATE ${this.s}.movements SET disposition = ?, ignored_reason = ?
        WHERE tenant_id = ? AND id = ?`,
      [disposition, disposition === 'ignored' ? reason! : null, tenantId, movementId],
    )
    const [row] = await this.run<MovementRow>(`SELECT * FROM ${this.s}.movements WHERE id = ?`, [movementId])
    const next = toMovement(row!)
    if (m.disposition !== disposition) await this.emit(movementDecided(next, m.disposition, allocations))
    return next
  }

  async insertExpectation(n: NewExpectation): Promise<Expectation> {
    assertValidNewExpectation(n)
    const taken = () =>
      new ConstraintError(
        'expectation_reference_unique',
        `reference ${JSON.stringify(n.reference)} already exists in this tenant`,
      )
    if ((await this.getExpectationByReference(n.tenantId, n.reference)) !== null) throw taken()

    await this.lockTenant(`nostro:muxed:${this.s}:${n.tenantId}:${n.account}`)
    let muxedId: bigint | null
    if (n.muxedId === 'issue') {
      const rows = await this.run<{ max: string | null }>(`SELECT CAST(MAX(muxed_id) AS CHAR) AS max FROM ${this.s}.expectations WHERE tenant_id = ? AND account = ? AND muxed_id IS NOT NULL`, [n.tenantId, n.account])
      const max = rows[0]?.max == null ? 0n : BigInt(rows[0].max)
      muxedId = issueMuxedId(max)
    } else {
      muxedId = n.muxedId ?? null
    }
    if (muxedId !== null) {
      const rows = await this.run<{ id: string }>(`SELECT id FROM ${this.s}.expectations WHERE tenant_id = ? AND account = ? AND muxed_id = ?`, [n.tenantId, n.account, muxedId.toString()])
      if (rows.length > 0) throw new ConstraintError('expectation_muxed_id_unique', `muxed id ${muxedId.toString()} is already used on account ${n.account}`)
    }

    const [memoType, memoValue, memoText] = memoColumns(n.memo)
    const now = this.now()

    let fingerprintSuffix: bigint | null = null
    if (n.fingerprintSuffix === 'allocate') {
      await this.lockTenant(`nostro:fingerprint:${this.s}:${n.tenantId}:${n.account}:${n.amount.asset}`)
      const rows = await this.run<{ fingerprint_suffix: string }>(
        `SELECT fingerprint_suffix FROM ${this.s}.expectations
          WHERE tenant_id = ? AND account = ? AND asset = ?
            AND status = 'open' AND fingerprint_suffix IS NOT NULL
          ORDER BY fingerprint_suffix`,
        [n.tenantId, n.account, n.amount.asset],
      )
      const taken = new Set(rows.map((r) => BigInt(r.fingerprint_suffix)))
      let candidate = 1n
      while (taken.has(candidate)) candidate++
      fingerprintSuffix = candidate
    } else if (n.fingerprintSuffix != null) {
      fingerprintSuffix = n.fingerprintSuffix
    }

    const id = this.ids()
    const savepoint = `nostro_${++this.savepoints}`
    await this.run(`SAVEPOINT ${savepoint}`)
    try {
      await this.run(
        `INSERT INTO ${this.s}.expectations (
           id, tenant_id, reference, account, direction, asset, decimals, amount, muxed_id,
           memo_type, memo_value, memo_text, payers, due_at, expires_at, status, metadata,
           fingerprint_suffix, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
        [
          id,
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
          JSON.stringify([...(n.payers ?? [])]),
          n.dueAt ?? null,
          n.expiresAt ?? null,
          JSON.stringify(n.metadata ?? {}),
          fingerprintSuffix == null ? null : fingerprintSuffix.toString(),
          now,
          now,
        ],
      )
      for (const normalized of expectationReferenceKeys(n.reference, n.memo)) {
        await this.run(
          `INSERT IGNORE INTO ${this.s}.expectation_reference_index (tenant_id, normalized, expectation_id)
           VALUES (?, ?, ?)`,
          [n.tenantId, normalized, id],
        )
      }
      await this.run(`RELEASE SAVEPOINT ${savepoint}`)
    } catch (err) {
      await this.run(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      await this.run(`RELEASE SAVEPOINT ${savepoint}`)
      if (isUniqueViolation(err, 'expectations_reference_unique')) throw taken()
      if (isUniqueViolation(err, 'expectation_muxed_id_unique') || errorInfo(err).message.includes('muxed id')) {
        throw new ConstraintError(
          'expectation_muxed_id_unique',
          `muxed id ${muxedId!.toString()} is already used on account ${n.account}`,
        )
      }
      if (isUniqueViolation(err, 'expectations_fingerprint')) {
        throw new ConstraintError('expectation_fingerprint_unique', 'that amount suffix is already used on this account and asset')
      }
      throw err
    }
    const [row] = await this.run<ExpectationRow>(`SELECT * FROM ${this.s}.expectations WHERE id = ?`, [id])
    return toExpectation(row!)
  }

  async cancelExpectation(tenantId: string, id: string, reason: string): Promise<Expectation> {
    const e = await this.lockExpectation(tenantId, id)
    checkCancel(e, reason)
    await this.run(
      `UPDATE ${this.s}.expectations SET status = 'cancelled', cancel_reason = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?`,
      [reason, this.now(), tenantId, id],
    )
    const [row] = await this.run<ExpectationRow>(`SELECT * FROM ${this.s}.expectations WHERE id = ?`, [id])
    const next = toExpectation(row!)
    await this.emit(expectationChanged(next, null))
    return next
  }

  async amendExpectation(tenantId: string, id: string, changes: ExpectationChanges, reason: string): Promise<Expectation> {
    const e = await this.lockExpectation(tenantId, id)
    const allocations = await this.listAllocations({ tenantId, expectationId: id })
    let muxedIdTaken = false
    if (changes.muxedId !== undefined && changes.muxedId !== e.muxedId && changes.muxedId !== null) {
      await this.lockTenant(`nostro:muxed:${this.s}:${tenantId}:${e.account}`)
      const rows = await this.run<{ id: string }>(`SELECT id FROM ${this.s}.expectations WHERE tenant_id = ? AND account = ? AND muxed_id = ? AND id <> ?`, [tenantId, e.account, changes.muxedId.toString(), id])
      muxedIdTaken = rows.length > 0
    }
    const next = amendExpectationRecord(e, allocations, changes, reason, this.now(), muxedIdTaken)
    const [memoType, memoValue, memoText] = memoColumns(next.memo)
    try {
      await this.run(
        `UPDATE ${this.s}.expectations
            SET amount = ?, decimals = ?, asset = ?, muxed_id = ?, memo_type = ?, memo_value = ?, memo_text = ?,
                payers = ?, due_at = ?, expires_at = ?, status = ?, metadata = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`,
        [
          next.amount.raw.toString(),
          next.amount.decimals,
          next.amount.asset,
          next.muxedId == null ? null : next.muxedId.toString(),
          memoType,
          memoValue,
          memoText,
          JSON.stringify([...next.payers]),
          next.dueAt,
          next.expiresAt,
          next.status,
          JSON.stringify({ ...next.metadata }),
          next.updatedAt,
          tenantId,
          id,
        ],
      )
    } catch (err) {
      if (isUniqueViolation(err, 'expectations_fingerprint')) {
        throw new ConstraintError('expectation_fingerprint_unique', 'that amount suffix is already used on this account and asset')
      }
      throw err
    }
    const [row] = await this.run<ExpectationRow>(`SELECT * FROM ${this.s}.expectations WHERE id = ?`, [id])
    const saved = toExpectation(row!)
    await this.run(`DELETE FROM ${this.s}.expectation_reference_index WHERE expectation_id = ?`, [e.id])
    for (const normalized of expectationReferenceKeys(saved.reference, saved.memo)) {
      await this.run(
        `INSERT IGNORE INTO ${this.s}.expectation_reference_index (tenant_id, normalized, expectation_id)
         VALUES (?, ?, ?)`,
        [saved.tenantId, normalized, saved.id],
      )
    }
    await this.emit(expectationAmended(saved, e, reason))
    return saved
  }

  async allocate(n: NewAllocation): Promise<Allocation> {
    assertValidNewAllocation(n)
    const m = await this.lockMovement(n.tenantId, n.movementId)
    const e = await this.lockExpectation(n.tenantId, n.expectationId)
    const status = checkAllocation(
      n,
      m,
      e,
      await this.listAllocations({ tenantId: n.tenantId, movementId: m.id }),
      await this.listAllocations({ tenantId: n.tenantId, expectationId: e.id }),
      refundCoverage(m, await this.listRefundLinks({ tenantId: n.tenantId, movementIds: [m.id] })),
    )
    const now = this.now()
    const id = this.ids()
    await this.run(
      `INSERT INTO ${this.s}.allocations (
         id, tenant_id, movement_id, expectation_id, asset, decimals, amount, strategy, score, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, n.tenantId, m.id, e.id, n.amount.asset, n.amount.decimals, n.amount.raw.toString(), n.strategy, n.score ?? null, now],
    )
    await this.run(
      `UPDATE ${this.s}.expectations SET status = ?, updated_at = ? WHERE id = ?`,
      [status, now, e.id],
    )
    const [row] = await this.run<AllocationRow>(`SELECT * FROM ${this.s}.allocations WHERE id = ?`, [id])
    const allocation = toAllocation(row!)
    if (status !== e.status) {
      const [updated] = await this.run<ExpectationRow>(`SELECT * FROM ${this.s}.expectations WHERE id = ?`, [e.id])
      await this.emit(expectationChanged(toExpectation(updated!), allocation))
    }
    return allocation
  }

  async postJournalEntry(n: NewJournalEntry): Promise<JournalEntry> {
    assertValidNewJournalEntry(n)
    const period = await this.lockJournalPeriod(n.tenantId)
    const movement = n.movementId == null ? null : await this.lockMovement(n.tenantId, n.movementId)
    const existing = movement === null ? [] : await this.listJournalEntries({ tenantId: n.tenantId, movementId: movement.id })
    const now = this.now()
    const entryToPost = { ...n, effectiveAt: n.effectiveAt ?? now }
    checkJournalEntry(entryToPost, movement, existing, period?.through ?? null)
    const expectationIds = [...new Set(n.lines.flatMap((line) => line.expectationId == null ? [] : [line.expectationId]))]
    if (expectationIds.length > 0) {
      const rows = await this.run<{ id: string }>(
        `SELECT id FROM ${this.s}.expectations WHERE tenant_id = ? AND id IN (?)`,
        [n.tenantId, expectationIds],
      )
      const found = new Set(rows.map((row) => row.id))
      const missing = expectationIds.find((id) => !found.has(id))
      if (missing !== undefined) throw new NotFoundError('expectation', missing)
    }
    const exceptionIds = [...new Set(n.lines.flatMap((line) => line.exceptionId == null ? [] : [line.exceptionId]))]
    if (exceptionIds.length > 0) {
      const rows = await this.run<{ id: string }>(
        `SELECT id FROM ${this.s}.exceptions WHERE tenant_id = ? AND id IN (?)`,
        [n.tenantId, exceptionIds],
      )
      const found = new Set(rows.map((row) => row.id))
      const missing = exceptionIds.find((id) => !found.has(id))
      if (missing !== undefined) throw new NotFoundError('exception', missing)
    }
    const entryId = this.ids()
    await this.run(
      `INSERT INTO ${this.s}.journal_entries (
         id, tenant_id, movement_id, posting_no, kind, effective_at, posted_at, description
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [entryId, n.tenantId, movement?.id ?? null, n.postingNo ?? null, n.kind, entryToPost.effectiveAt, now, n.description],
    )
    const lineRows = n.lines.map((line, index) => [
      entryId,
      n.tenantId,
      index + 1,
      line.account,
      line.entityId ?? movement?.entityId ?? null,
      line.role,
      line.side,
      line.amount.asset,
      line.amount.decimals,
      line.amount.raw.toString(),
      line.expectationId ?? null,
      line.exceptionId ?? null,
    ])
    const linesInsert = valuesSql(lineRows)
    await this.run(
      `INSERT INTO ${this.s}.journal_lines (
         entry_id, line_no, tenant_id, account, entity_id, role, side, asset, decimals, amount, expectation_id, exception_id
        ) VALUES ${linesInsert.sql}`,
      linesInsert.params,
    )
    const [entry] = await this.run<JournalEntryRow>(`SELECT * FROM ${this.s}.journal_entries WHERE id = ?`, [entryId])
    const lines = await this.run<JournalLineRow>(
      `SELECT * FROM ${this.s}.journal_lines WHERE entry_id = ? ORDER BY line_no`, [entryId],
    )
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
    const id = this.ids()
    await this.run(
      `INSERT INTO ${this.s}.exceptions (
         id, tenant_id, code, status, movement_id, expectation_id, account, asset, decimals, amount,
         detail, evidence, opened_at
       ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
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
    const [row] = await this.run<ExceptionRow>(`SELECT * FROM ${this.s}.exceptions WHERE id = ?`, [id])
    const record = toException(row!)
    await this.emit(exceptionChanged(record))
    return record
  }

  async resolveException(tenantId: string, id: string, resolution: Resolution): Promise<ExceptionRecord> {
    const [current] = await this.run<ExceptionRow>(
      `SELECT * FROM ${this.s}.exceptions WHERE tenant_id = ? AND id = ? FOR UPDATE`,
      [tenantId, id],
    )
    if (current === undefined) throw new NotFoundError('exception', id)
    checkResolution(toException(current), resolution)
    await this.run(
      `UPDATE ${this.s}.exceptions SET status = ?, resolved_at = ?, resolution_note = ?
        WHERE tenant_id = ? AND id = ?`,
      [resolution.status, this.now(), resolution.note, tenantId, id],
    )
    const [row] = await this.run<ExceptionRow>(`SELECT * FROM ${this.s}.exceptions WHERE id = ?`, [id])
    const next = toException(row!)
    await this.emit(exceptionChanged(next))
    return next
  }

  async postAccrualExpectation(expectationId: string, tenantId: string, direction: Direction, amount: Money, reference: string): Promise<void> {
    await postAccrual(this, expectationId, tenantId, direction, amount, reference)
  }

  async linkRefund(tenantId: string, creditMovementId: string, refundMovementId: string): Promise<RefundLink> {
    await this.getMovement(tenantId, creditMovementId)
    const [existing] = await this.listRefundLinks({ tenantId, refundMovementId })
    if (existing) {
      if (existing.creditMovementId !== creditMovementId) throw new ConstraintError('refund_invalid', 'refund already linked to another credit')
      return existing
    }
    const parts = await refundParts(this, tenantId, creditMovementId, refundMovementId)
    const id = this.ids()
    await this.run(
      `INSERT INTO ${this.s}.refund_links (id, tenant_id, credit_movement_id, refund_movement_id, asset, decimals, amount, residual_amount, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, tenantId, creditMovementId, refundMovementId, parts.amount.asset, parts.amount.decimals, parts.amount.raw.toString(), parts.residualAmount.raw.toString(), this.now()],
    )
    const [row] = await this.run<Record<string, unknown>>(`SELECT * FROM ${this.s}.refund_links WHERE id = ?`, [id])
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
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE movement_id = movement_id`,
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

export class MysqlStore extends MysqlReader implements MigratableStore {
  private readonly pool: Pool
  private readonly ownsPool: boolean
  private readonly database: string
  private readonly ids: () => string
  private readonly now: () => Date

  constructor(options: MysqlStoreOptions) {
    if (options.pool === undefined && options.connectionString === undefined) {
      throw new Error('MysqlStore needs a pool or a connectionString.')
    }
    const parsed = options.connectionString === undefined ? undefined : parseConnectionString(options.connectionString)
    const database = options.database ?? parsed?.database ?? 'nostro'
    const schema = quoteSchema(database)
    const pool = options.pool ?? mysql.createPool(parsed!.config as Parameters<typeof mysql.createPool>[0])
    super(
      schema,
      async (sql, params) => {
        const [result] = await pool.query(sql, params === undefined ? undefined : [...params])
        return Array.isArray(result) ? result as never : []
      },
      async (sql, params) => {
        const [result] = await pool.query(sql, params === undefined ? undefined : [...params])
        return result as ResultSetHeader
      },
    )
    this.pool = pool
    this.ownsPool = options.pool === undefined
    this.database = database
    this.ids = options.ids ?? randomUUID
    this.now = options.now ?? (() => new Date())
  }

  async exportGetMark(tenantId: string, destination: string): Promise<string | null> {
    const [row] = await this.run<{ last_seq: string | null }>(
      `SELECT last_seq FROM ${this.s}.exports WHERE tenant_id = ? AND destination = ?`,
      [tenantId, destination],
    )
    return row?.last_seq ?? null
  }

  async exportSetMark(tenantId: string, destination: string, lastSeq: number): Promise<void> {
    await this.run(
      `INSERT INTO ${this.s}.exports (tenant_id, destination, last_seq, last_exported_at, control_totals, checksum)
       VALUES (?, ?, ?, UTC_TIMESTAMP(6), '{}', '')
       ON DUPLICATE KEY UPDATE last_seq = VALUES(last_seq), last_exported_at = UTC_TIMESTAMP(6)`,
      [tenantId, destination, lastSeq],
    )
  }

  async exportListBatches(tenantId: string): Promise<readonly { readonly destination: string; readonly last_seq: number; readonly last_exported_at: number; readonly control_totals: string; readonly checksum: string }[]> {
    const rows = await this.run<{ destination: string; last_seq: number; last_exported_at: Date | number; control_totals: string | null; checksum: string }>(
      `SELECT destination, last_seq, last_exported_at, control_totals, checksum FROM ${this.s}.exports WHERE tenant_id = ?`,
      [tenantId],
    )
    return rows.map((r) => ({
      destination: r.destination,
      last_seq: Number(r.last_seq),
      last_exported_at: Number(r.last_exported_at),
      control_totals: r.control_totals ?? '{}',
      checksum: r.checksum,
    }))
  }

  async postAccrualExpectation(expectationId: string, tenantId: string, direction: Direction, amount: Money, reference: string): Promise<void> {
    await this.transaction((tx) => tx.postAccrualExpectation(expectationId, tenantId, direction, amount, reference))
  }

  private async backfillReferenceIndex(conn: PoolConnection): Promise<void> {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT id, tenant_id, reference, memo_type, memo_text FROM ${this.s}.expectations`,
    )
    const insert = `INSERT IGNORE INTO ${this.s}.expectation_reference_index (tenant_id, normalized, expectation_id)
                    VALUES (?, ?, ?)`
    for (const row of rows) {
      const memo: Memo | null = row.memo_type === 'text'
        ? { type: 'text', value: (row.memo_text as Buffer | null)?.toString('utf8') ?? '' }
        : null
      for (const normalized of expectationReferenceKeys(row.reference as string, memo)) {
        await conn.query(insert, [row.tenant_id, normalized, row.id])
      }
    }
  }

  private async assertSupported(conn: PoolConnection): Promise<void> {
    const [rows] = await conn.query<RowDataPacket[]>('SELECT VERSION() AS version')
    const version = String(rows[0]?.version ?? '')
    if (/mariadb/i.test(version)) {
      throw new Error(`MySQL 8.0.16+ is required; MariaDB (${version}) is not supported.`)
    }
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
    const parts = match === null ? [0, 0, 0] : [Number(match[1]), Number(match[2]), Number(match[3])]
    const [major, minor, patch] = parts
    if (major === undefined || minor === undefined || patch === undefined ||
        major < 8 || (major === 8 && (minor < 0 || (minor === 0 && patch < 16)))) {
      throw new Error(`MySQL 8.0.16+ is required; found ${version || 'an unknown version'}.`)
    }
  }

  async migrate(): Promise<void> {
    const conn = await this.pool.getConnection()
    const lock = `nostro:migrate:${this.database}`
    let locked = false
    try {
      await this.assertSupported(conn)
      const [lockRows] = await conn.query<RowDataPacket[]>('SELECT GET_LOCK(?, 60) AS acquired', [lock])
      if (Number(lockRows[0]?.acquired) !== 1) throw new Error(`Could not acquire the migration lock for ${this.database}.`)
      locked = true
      await conn.query(`CREATE DATABASE IF NOT EXISTS ${this.s} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`)
      await conn.query(`USE ${this.s}`)
      await conn.query(
        `CREATE TABLE IF NOT EXISTS ${this.s}.migrations (
           version    INT NOT NULL PRIMARY KEY,
           applied_at ${TIME} NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
         )${ENGINE}`,
      )
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT COALESCE(MAX(version), 0) AS version FROM ${this.s}.migrations`,
      )
      const version = Number(rows[0]?.version ?? 0)
      for (let v = version + 1; v <= MIGRATIONS.length; v++) {
        for (const statement of MIGRATIONS[v - 1]!(this.s)) await conn.query(statement)
        await conn.query(`INSERT INTO ${this.s}.migrations (version) VALUES (?)`, [v])
      }
      if (version < 5) await this.backfillReferenceIndex(conn)
    } finally {
      if (locked) await conn.query('SELECT RELEASE_LOCK(?)', [lock]).catch(() => undefined)
      conn.release()
    }
  }

  async schemaVersion(): Promise<SchemaVersion> {
    const latest = MIGRATIONS.length
    const [tables] = await this.run<{ n: number }>(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'migrations'`,
      [this.database],
    )
    if (Number(tables?.n ?? 0) === 0) return { current: 0, latest }
    const [row] = await this.run<{ version: number }>(
      `SELECT COALESCE(MAX(version), 0) AS version FROM ${this.s}.migrations`,
    )
    return { current: Number(row?.version ?? 0), latest }
  }

  async transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.transactionOnce(fn)
      } catch (error) {
        if (!isDeadlock(error) || attempt >= 3) throw error
        await new Promise<void>((resolve) => setTimeout(resolve, 10 * (2 ** attempt) + Math.floor(Math.random() * 10)))
      }
    }
  }

  private async transactionOnce<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection()
    const tx = new MysqlTx(this.s, conn, this.ids, this.now)
    let broken: Error | undefined
    try {
      await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await conn.query('START TRANSACTION')
      const result = await fn(tx)
      tx.close()
      await conn.query('COMMIT')
      return result
    } catch (err) {
      tx.close()
      await conn.query('ROLLBACK').catch((rollbackError: unknown) => {
        broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError))
      })
      throw err
    } finally {
      tx.close()
      if (broken === undefined) conn.release()
      else conn.destroy()
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end()
  }
}
