/**
 * A `Store` on SQLite, for single-node deployments and local development.
 *
 * Every rule comes from `nostro`'s shared store rules. Concurrency is simple
 * by construction: transactions in this process run one at a time, and each
 * begins with `BEGIN IMMEDIATE`, which takes SQLite's write lock up front, so
 * transactions from other processes wait their turn too. That makes every
 * transaction serializable, which satisfies the contract's locking rules
 * (including the cursor read) without row locks.
 *
 * Reads outside a transaction go through a second, read-only connection. In
 * WAL mode it sees only committed data, which is why the store needs a file
 * rather than `:memory:` (use `MemoryStore` for that).
 */
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import type {
  Allocation,
  AllocationQuery,
  CursorKey,
  Disposition,
  EventQuery,
  ExceptionQuery,
  ExceptionRecord,
  Expectation,
  ExpectationChanges,
  ExpectationQuery,
  InsertMovementsResult,
  JournalEntry,
  JournalPeriod,
  JournalQuery,
  Json,
  Memo,
  MigratableStore,
  Movement,
  MovementConflict,
  MovementQuery,
  NewAllocation,
  NewException,
  NewExpectation,
  NewJournalEntry,
  NewMovement,
  NewOutboxEvent,
  OutboxEvent,
  Resolution,
  SchemaVersion,
  StoreReader,
  StoreTx,
} from '@nostro-labs/nostro'
import {
  ConstraintError,
  Money,
  NotFoundError,
  TransactionClosedError,
  assertValidNewAllocation,
  assertValidNewException,
  assertValidNewExpectation,
  assertValidNewJournalEntry,
  assertValidNewMovement,
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
  parseAsset,
  sameFacts,
} from '@nostro-labs/nostro'
import { MIGRATIONS } from './schema.js'

export interface SqliteStoreOptions {
  /** Path to the database file. Created if missing. */
  readonly filename: string
  /** How long to wait for another process's write lock, in ms. Default 5000. */
  readonly busyTimeoutMs?: number
  /** Id generator. Defaults to `crypto.randomUUID()`. */
  readonly ids?: () => string
  /** Clock for `createdAt` and friends. Defaults to `new Date()`. */
  readonly now?: () => Date
}

type Row = Record<string, unknown>

/**
 * Prepared statements, per connection. Compiling the same SQL on every call
 * was a sixth of the time spent reconciling a large backlog.
 */
const statements = new WeakMap<Database.Database, Map<string, Database.Statement>>()

function statement(db: Database.Database, sql: string): Database.Statement {
  let cache = statements.get(db)
  if (cache === undefined) {
    cache = new Map()
    statements.set(db, cache)
  }
  let stmt = cache.get(sql)
  if (stmt === undefined) {
    stmt = db.prepare(sql)
    cache.set(sql, stmt)
  }
  return stmt
}
type Param = string | number | bigint | Buffer | null

const money = (amount: unknown, asset: unknown, decimals: unknown): Money =>
  Money.fromRaw(BigInt(amount as string), parseAsset(asset as string), decimals as number)
const date = (ms: unknown): Date | null => (ms === null ? null : new Date(ms as number))
const ms = (d: Date | null | undefined): number | null => (d == null ? null : d.getTime())

function memoColumns(memo: Memo | null | undefined): [string | null, string | null, Buffer | null] {
  if (memo == null) return [null, null, null]
  if (memo.type === 'text') return ['text', null, Buffer.from(memo.value, 'utf8')]
  return [memo.type, String(memo.value), null]
}

/** One index row per normalised reference/memo key, for the text-memo lookup. */
function referenceIndexRows(id: string, tenantId: string, reference: string, memo: Memo | null): [string, string, string][] {
  return expectationReferenceKeys(reference, memo).map((normalized) => [tenantId, normalized, id])
}

function memoOf(r: Row): Memo | null {
  switch (r.memo_type) {
    case null:
      return null
    case 'text':
      return Object.freeze({ type: 'text', value: ((r.memo_text as Buffer | null) ?? Buffer.alloc(0)).toString('utf8') })
    case 'id':
      return Object.freeze({ type: 'id', value: BigInt(r.memo_value as string) })
    default:
      return Object.freeze({ type: r.memo_type as 'hash' | 'return', value: r.memo_value as string })
  }
}

const toMovement = (r: Row): Movement =>
  Object.freeze({
    id: r.id as string,
    tenantId: r.tenant_id as string,
    seq: r.seq as number,
    network: r.network as string,
    source: r.source as string,
    externalId: r.external_id as string,
    revision: r.revision as number,
    account: r.account as string,
    direction: r.direction as Movement['direction'],
    kind: r.kind as Movement['kind'],
    amount: money(r.amount, r.asset, r.decimals),
    counterparty: r.counterparty as string | null,
    muxedId: r.muxed_id === null ? null : BigInt(r.muxed_id as string),
    memo: memoOf(r),
    ledger: r.ledger as number,
    txHash: r.tx_hash as string | null,
    operationId: r.operation_id as string | null,
    occurredAt: date(r.occurred_at)!,
    enrichment: r.enrichment as Movement['enrichment'],
    disposition: r.disposition as Movement['disposition'],
    ignoredReason: r.ignored_reason as string | null,
    createdAt: date(r.created_at)!,
  })

const toExpectation = (r: Row): Expectation =>
  Object.freeze({
    id: r.id as string,
    tenantId: r.tenant_id as string,
    seq: r.seq as number,
    reference: r.reference as string,
    account: r.account as string,
    direction: r.direction as Expectation['direction'],
    amount: money(r.amount, r.asset, r.decimals),
    muxedId: r.muxed_id === null ? null : BigInt(r.muxed_id as string),
    memo: memoOf(r),
    payers: Object.freeze(JSON.parse(r.payers as string) as string[]),
    dueAt: date(r.due_at),
    expiresAt: date(r.expires_at),
    status: r.status as Expectation['status'],
    cancelReason: r.cancel_reason as string | null,
    metadata: Object.freeze(JSON.parse(r.metadata as string) as Record<string, string>),
    createdAt: date(r.created_at)!,
    updatedAt: date(r.updated_at)!,
  })

const toAllocation = (r: Row): Allocation =>
  Object.freeze({
    id: r.id as string,
    tenantId: r.tenant_id as string,
    movementId: r.movement_id as string,
    expectationId: r.expectation_id as string,
    amount: money(r.amount, r.asset, r.decimals),
    strategy: r.strategy as string,
    score: r.score as number | null,
    createdAt: date(r.created_at)!,
  })

const toException = (r: Row): ExceptionRecord =>
  Object.freeze({
    id: r.id as string,
    tenantId: r.tenant_id as string,
    seq: r.seq as number,
    code: r.code as ExceptionRecord['code'],
    status: r.status as ExceptionRecord['status'],
    movementId: r.movement_id as string | null,
    expectationId: r.expectation_id as string | null,
    account: r.account as string | null,
    amount: r.amount === null ? null : money(r.amount, r.asset, r.decimals),
    detail: r.detail as string,
    evidence: JSON.parse(r.evidence as string) as Json,
    openedAt: date(r.opened_at)!,
    resolvedAt: date(r.resolved_at),
    resolutionNote: r.resolution_note as string | null,
  })

const toEvent = (r: Row): OutboxEvent =>
  Object.freeze({
    id: r.id as string,
    tenantId: r.tenant_id as string,
    seq: r.seq as number,
    type: r.type as OutboxEvent['type'],
    subjectId: r.subject_id as string,
    payload: JSON.parse(r.payload as string) as Json,
    createdAt: date(r.created_at)!,
  })

const toJournalEntry = (r: Row, lines: readonly Row[]): JournalEntry =>
  Object.freeze({
    id: r.id as string,
    tenantId: r.tenant_id as string,
    seq: r.seq as number,
    movementId: r.movement_id as string | null,
    postingNo: r.posting_no as number | null,
    kind: r.kind as JournalEntry['kind'],
    effectiveAt: date(r.effective_at)!,
    postedAt: date(r.posted_at)!,
    description: r.description as string,
    lines: Object.freeze(
      lines.map((l) =>
        Object.freeze({
          account: l.account as string,
          role: l.role as JournalEntry['lines'][number]['role'],
          side: l.side as JournalEntry['lines'][number]['side'],
          amount: money(l.amount, l.asset, l.decimals),
          expectationId: l.expectation_id as string | null,
          exceptionId: l.exception_id as string | null,
        }),
      ),
    ),
  })

/** Builds `WHERE` clauses with positional parameters. */
class Where {
  readonly params: Param[] = []
  private readonly clauses: string[] = []

  add(sql: string, value: Param | undefined): this {
    if (value !== undefined) {
      this.params.push(value)
      this.clauses.push(sql)
    }
    return this
  }

  in(column: string, values: readonly string[] | undefined): this {
    if (values !== undefined) {
      this.params.push(...values)
      this.clauses.push(values.length === 0 ? '0' : `${column} IN (${values.map(() => '?').join(', ')})`)
    }
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

class SqliteReader implements StoreReader {
  constructor(private readonly connection: () => Database.Database) {}

  protected all(sql: string, params: readonly Param[] = []): Row[] {
    return statement(this.connection(), sql).all(...params) as Row[]
  }

  protected one(sql: string, params: readonly Param[] = []): Row | undefined {
    return statement(this.connection(), sql).get(...params) as Row | undefined
  }

  async getMovement(tenantId: string, id: string): Promise<Movement | null> {
    const row = this.one('SELECT * FROM movements WHERE tenant_id = ? AND id = ?', [tenantId, id])
    return row === undefined ? null : toMovement(row)
  }

  async listMovements(q: MovementQuery): Promise<Movement[]> {
    const w = new Where()
      .add('tenant_id = ?', q.tenantId)
      .add('disposition = ?', q.disposition)
      .add('account = ?', q.account)
      .add('seq > ?', q.afterSeq)
    return this.all(`SELECT * FROM movements${w} ORDER BY seq${w.limit(q.limit)}`, w.params).map(toMovement)
  }

  async getExpectation(tenantId: string, id: string): Promise<Expectation | null> {
    const row = this.one('SELECT * FROM expectations WHERE tenant_id = ? AND id = ?', [tenantId, id])
    return row === undefined ? null : toExpectation(row)
  }

  async getExpectationByReference(tenantId: string, reference: string): Promise<Expectation | null> {
    const row = this.one('SELECT * FROM expectations WHERE tenant_id = ? AND reference = ?', [tenantId, reference])
    return row === undefined ? null : toExpectation(row)
  }

  async getExpectationsByNormalizedReference(tenantId: string, normalized: string): Promise<Expectation[]> {
    if (normalized === '') return []
    return this.all(
      `SELECT e.* FROM expectation_reference_index k
         JOIN expectations e ON e.id = k.expectation_id
        WHERE k.tenant_id = ? AND k.normalized = ?
        ORDER BY e.seq`,
      [tenantId, normalized],
    ).map(toExpectation)
  }

  async listExpectations(q: ExpectationQuery): Promise<Expectation[]> {
    const w = new Where()
      .add('tenant_id = ?', q.tenantId)
      .add('account = ?', q.account)
      .add('asset = ?', q.asset)
      .add('direction = ?', q.direction)
      .in('status', q.status)
      .add('muxed_id = ?', q.muxedId === undefined ? undefined : q.muxedId.toString())
      .add('seq > ?', q.afterSeq)
    return this.all(`SELECT * FROM expectations${w} ORDER BY seq${w.limit(q.limit)}`, w.params).map(toExpectation)
  }

  async listAllocations(q: AllocationQuery): Promise<Allocation[]> {
    const w = new Where()
      .add('tenant_id = ?', q.tenantId)
      .add('movement_id = ?', q.movementId)
      .add('expectation_id = ?', q.expectationId)
    return this.all(`SELECT * FROM allocations${w} ORDER BY seq`, w.params).map(toAllocation)
  }

  async getException(tenantId: string, id: string): Promise<ExceptionRecord | null> {
    const row = this.one('SELECT * FROM exceptions WHERE tenant_id = ? AND id = ?', [tenantId, id])
    return row === undefined ? null : toException(row)
  }

  async listExceptions(q: ExceptionQuery): Promise<ExceptionRecord[]> {
    const w = new Where()
      .add('tenant_id = ?', q.tenantId)
      .add('status = ?', q.status)
      .add('code = ?', q.code)
      .add('movement_id = ?', q.movementId)
      .add('expectation_id = ?', q.expectationId)
      .add('seq > ?', q.afterSeq)
    return this.all(`SELECT * FROM exceptions${w} ORDER BY seq${w.limit(q.limit)}`, w.params).map(toException)
  }

  async listEvents(q: EventQuery): Promise<OutboxEvent[]> {
    const w = new Where().add('tenant_id = ?', q.tenantId).add('seq > ?', q.afterSeq)
    return this.all(`SELECT * FROM events${w} ORDER BY seq${w.limit(q.limit)}`, w.params).map(toEvent)
  }

  async listJournalEntries(q: JournalQuery): Promise<JournalEntry[]> {
    const w = new Where()
      .add('tenant_id = ?', q.tenantId)
      .add('movement_id = ?', q.movementId)
      .add('seq > ?', q.afterSeq)
      .add('effective_at >= ?', q.effectiveFrom?.getTime())
      .add('effective_at < ?', q.effectiveBefore?.getTime())
    const selected = `SELECT * FROM journal_entries${w} ORDER BY seq${w.limit(q.limit)}`
    const entries = this.all(selected, w.params)
    if (entries.length === 0) return []
    const lines = this.all(
      `SELECT * FROM journal_lines WHERE entry_id IN (SELECT id FROM (${selected})) ORDER BY entry_id, line_no`,
      w.params,
    )
    const byEntry = new Map<string, Row[]>()
    for (const l of lines) byEntry.set(l.entry_id as string, [...(byEntry.get(l.entry_id as string) ?? []), l])
    return entries.map((e) => toJournalEntry(e, byEntry.get(e.id as string) ?? []))
  }

  async getCursor(k: CursorKey): Promise<string | null> {
    const row = this.one(
      'SELECT value FROM cursors WHERE tenant_id = ? AND network = ? AND source = ? AND account = ?',
      [k.tenantId, k.network, k.source, k.account],
    )
    return row === undefined ? null : (row.value as string)
  }

  async getJournalPeriod(tenantId: string): Promise<JournalPeriod | null> {
    const row = this.one(
      'SELECT action, closed_through, note, created_at FROM journal_period_actions WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1',
      [tenantId],
    )
    if (row === undefined || row.action !== 'close') return null
    return Object.freeze({
      tenantId,
      through: new Date(row.closed_through as number),
      note: row.note as string | null,
      closedAt: new Date(row.created_at as number),
    })
  }
}

class SqliteTx extends SqliteReader implements StoreTx {
  private open = true

  constructor(
    private readonly db: Database.Database,
    private readonly ids: () => string,
    private readonly now: () => Date,
  ) {
    super(() => {
      if (!this.open) throw new TransactionClosedError()
      return db
    })
  }

  close(): void {
    this.open = false
  }

  async lockJournalPeriod(tenantId: string): Promise<JournalPeriod | null> {
    return this.getJournalPeriod(tenantId)
  }

  async closeJournalPeriod(tenantId: string, through: Date, note: string | null): Promise<void> {
    checkJournalPeriodClose(tenantId, through, note)
    await this.lockJournalPeriod(tenantId)
    this.exec(
      `INSERT INTO journal_period_actions (tenant_id, action, closed_through, note, reason, created_at)
       VALUES (?, 'close', ?, ?, NULL, ?)`,
      [tenantId, through.getTime(), note, this.now().getTime()],
    )
  }

  async reopenJournalPeriod(tenantId: string, reason: string): Promise<void> {
    const period = await this.lockJournalPeriod(tenantId)
    checkJournalPeriodReopen(tenantId, reason, period !== null)
    this.exec(
      `INSERT INTO journal_period_actions (tenant_id, action, closed_through, note, reason, created_at)
       VALUES (?, 'reopen', NULL, NULL, ?, ?)`,
      [tenantId, reason, this.now().getTime()],
    )
  }

  private exec(sql: string, params: readonly Param[]): void {
    if (!this.open) throw new TransactionClosedError()
    statement(this.db, sql).run(...params)
  }

  /** Append to the event log, in this transaction. */
  private emit(event: NewOutboxEvent | null): void {
    if (event === null) return
    this.exec('INSERT INTO events (id, tenant_id, type, subject_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      this.ids(),
      event.tenantId,
      event.type,
      event.subjectId,
      JSON.stringify(event.payload),
      this.now().getTime(),
    ])
  }

  private movement(tenantId: string, id: string): Movement {
    const row = this.one('SELECT * FROM movements WHERE tenant_id = ? AND id = ?', [tenantId, id])
    if (row === undefined) throw new NotFoundError('movement', id)
    return toMovement(row)
  }

  private expectation(tenantId: string, id: string): Expectation {
    const row = this.one('SELECT * FROM expectations WHERE tenant_id = ? AND id = ?', [tenantId, id])
    if (row === undefined) throw new NotFoundError('expectation', id)
    return toExpectation(row)
  }

  async setCursor(k: CursorKey, value: string): Promise<void> {
    checkCursorValue(value)
    this.exec(
      `INSERT INTO cursors (tenant_id, network, source, account, value) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, network, source, account) DO UPDATE SET value = excluded.value`,
      [k.tenantId, k.network, k.source, k.account, value],
    )
  }

  async insertMovements(batch: readonly NewMovement[]): Promise<InsertMovementsResult> {
    batch.forEach(assertValidNewMovement)
    const inserted: Movement[] = []
    const duplicates: Movement[] = []
    const conflicts: MovementConflict[] = []
    for (const n of batch) {
      const [memoType, memoValue, memoText] = memoColumns(n.memo)
      const row = this.one(
        `INSERT INTO movements (
           id, tenant_id, network, source, external_id, revision, account, direction, kind,
           asset, decimals, amount, counterparty, muxed_id, memo_type, memo_value, memo_text,
           ledger, tx_hash, operation_id, occurred_at, enrichment, disposition, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT (tenant_id, network, source, external_id) DO NOTHING
         RETURNING *`,
        [
          this.ids(),
          n.tenantId,
          n.network,
          n.source,
          n.externalId,
          n.revision ?? 1,
          n.account,
          n.direction,
          n.kind,
          n.amount.asset,
          n.amount.decimals,
          n.amount.raw.toString(),
          n.counterparty ?? null,
          n.muxedId == null ? null : n.muxedId.toString(),
          memoType,
          memoValue,
          memoText,
          n.ledger,
          n.txHash ?? null,
          n.operationId ?? null,
          n.occurredAt.getTime(),
          n.enrichment ?? 'complete',
          this.now().getTime(),
        ],
      )
      if (row !== undefined) {
        inserted.push(toMovement(row))
        continue
      }
      const existing = toMovement(
        this.one(
          'SELECT * FROM movements WHERE tenant_id = ? AND network = ? AND source = ? AND external_id = ?',
          [n.tenantId, n.network, n.source, n.externalId],
        )!,
      )
      if (sameFacts(existing, n)) duplicates.push(existing)
      else conflicts.push({ existing, incoming: n })
    }
    return { inserted, duplicates, conflicts }
  }

  async setDisposition(
    tenantId: string,
    movementId: string,
    disposition: Disposition,
    reason?: string,
  ): Promise<Movement> {
    const m = this.movement(tenantId, movementId)
    checkDisposition(
      m,
      await this.listAllocations({ tenantId, movementId }),
      await this.listExceptions({ tenantId, movementId }),
      disposition,
      reason,
    )
    const next = toMovement(
      this.one('UPDATE movements SET disposition = ?, ignored_reason = ? WHERE id = ? RETURNING *', [
        disposition,
        disposition === 'ignored' ? reason! : null,
        m.id,
      ])!,
    )
    if (m.disposition !== disposition) {
      this.emit(movementDecided(next, m.disposition, await this.listAllocations({ tenantId, movementId })))
    }
    return next
  }

  async insertExpectation(n: NewExpectation): Promise<Expectation> {
    assertValidNewExpectation(n)
    if ((await this.getExpectationByReference(n.tenantId, n.reference)) !== null) {
      throw new ConstraintError(
        'expectation_reference_unique',
        `reference ${JSON.stringify(n.reference)} already exists in this tenant`,
      )
    }
    let muxedId: bigint | null
    if (n.muxedId === 'issue') {
      const rows = this.all('SELECT muxed_id FROM expectations WHERE tenant_id = ? AND account = ? AND muxed_id IS NOT NULL', [n.tenantId, n.account]) as Row[]
      let max = 0n
      for (const r of rows) {
        const v = BigInt(r.muxed_id as string)
        if (v > max) max = v
      }
      muxedId = issueMuxedId(max)
    } else {
      muxedId = n.muxedId ?? null
    }
    if (muxedId !== null) {
      const taken = this.one('SELECT id FROM expectations WHERE tenant_id = ? AND account = ? AND muxed_id = ?', [n.tenantId, n.account, muxedId.toString()])
      if (taken !== undefined) {
        throw new ConstraintError('expectation_muxed_id_unique', `muxed id ${muxedId.toString()} is already used on account ${n.account}`)
      }
    }
    const [memoType, memoValue, memoText] = memoColumns(n.memo)
    const now = this.now().getTime()
    const id = this.ids()
    const row = this.one(
      `INSERT INTO expectations (
         id, tenant_id, reference, account, direction, asset, decimals, amount, muxed_id,
         memo_type, memo_value, memo_text, payers, due_at, expires_at, status, metadata,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
       RETURNING *`,
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
        JSON.stringify(n.payers ?? []),
        ms(n.dueAt),
        ms(n.expiresAt),
        JSON.stringify(n.metadata ?? {}),
        now,
        now,
      ],
    )!
    const index = this.db.prepare(
      'INSERT OR IGNORE INTO expectation_reference_index (tenant_id, normalized, expectation_id) VALUES (?, ?, ?)',
    )
    for (const values of referenceIndexRows(id, n.tenantId, n.reference, n.memo ?? null)) index.run(...values)
    return toExpectation(row)
  }

  async cancelExpectation(tenantId: string, id: string, reason: string): Promise<Expectation> {
    const e = this.expectation(tenantId, id)
    checkCancel(e, reason)
    const next = toExpectation(
      this.one(
        "UPDATE expectations SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ? RETURNING *",
        [reason, this.now().getTime(), e.id],
      )!,
    )
    this.emit(expectationChanged(next, null))
    return next
  }

  async amendExpectation(tenantId: string, id: string, changes: ExpectationChanges, reason: string): Promise<Expectation> {
    const e = this.expectation(tenantId, id)
    const allocations = await this.listAllocations({ tenantId, expectationId: id })
    let muxedIdTaken = false
    if (changes.muxedId !== undefined && changes.muxedId !== e.muxedId && changes.muxedId !== null) {
      const taken = this.one('SELECT id FROM expectations WHERE tenant_id = ? AND account = ? AND muxed_id = ? AND id != ?', [tenantId, e.account, changes.muxedId.toString(), id])
      muxedIdTaken = taken !== undefined
    }
    const next = amendExpectationRecord(e, allocations, changes, reason, this.now(), muxedIdTaken)
    const [memoType, memoValue, memoText] = memoColumns(next.memo)
    const saved = toExpectation(
      this.one(
        `UPDATE expectations SET amount = ?, decimals = ?, asset = ?, muxed_id = ?, memo_type = ?, memo_value = ?, memo_text = ?,
           payers = ?, due_at = ?, expires_at = ?, status = ?, metadata = ?, updated_at = ?
         WHERE id = ? RETURNING *`,
        [
          next.amount.raw.toString(),
          next.amount.decimals,
          next.amount.asset,
          next.muxedId == null ? null : next.muxedId.toString(),
          memoType,
          memoValue,
          memoText,
          JSON.stringify([...next.payers]),
          ms(next.dueAt),
          ms(next.expiresAt),
          next.status,
          JSON.stringify({ ...next.metadata }),
          next.updatedAt.getTime(),
          e.id,
        ],
      )!,
    )
    this.db.prepare('DELETE FROM expectation_reference_index WHERE expectation_id = ?').run(e.id)
    const index = this.db.prepare(
      'INSERT OR IGNORE INTO expectation_reference_index (tenant_id, normalized, expectation_id) VALUES (?, ?, ?)',
    )
    for (const values of referenceIndexRows(saved.id, saved.tenantId, saved.reference, saved.memo)) index.run(...values)
    this.emit(expectationAmended(saved, e, reason))
    return saved
  }

  async allocate(n: NewAllocation): Promise<Allocation> {
    assertValidNewAllocation(n)
    const m = this.movement(n.tenantId, n.movementId)
    const e = this.expectation(n.tenantId, n.expectationId)
    const status = checkAllocation(
      n,
      m,
      e,
      await this.listAllocations({ tenantId: n.tenantId, movementId: m.id }),
      await this.listAllocations({ tenantId: n.tenantId, expectationId: e.id }),
    )
    const now = this.now().getTime()
    const row = this.one(
      `INSERT INTO allocations (
         id, tenant_id, movement_id, expectation_id, asset, decimals, amount, strategy, score, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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
        now,
      ],
    )!
    const updated = this.one('UPDATE expectations SET status = ?, updated_at = ? WHERE id = ? RETURNING *', [status, now, e.id])!
    const allocation = toAllocation(row)
    if (status !== e.status) this.emit(expectationChanged(toExpectation(updated), allocation))
    return allocation
  }

  async postJournalEntry(n: NewJournalEntry): Promise<JournalEntry> {
    assertValidNewJournalEntry(n)
    const period = await this.lockJournalPeriod(n.tenantId)
    // Transactions are serialised, so no other poster can append between this read and the insert.
    const movement = n.movementId == null ? null : this.movement(n.tenantId, n.movementId)
    const existing = movement === null ? [] : await this.listJournalEntries({ tenantId: n.tenantId, movementId: movement.id })
    const now = this.now()
    const entryToPost = { ...n, effectiveAt: n.effectiveAt ?? now }
    checkJournalEntry(entryToPost, movement, existing, period?.through ?? null)
    for (const line of n.lines) {
      if (line.expectationId != null) this.expectation(n.tenantId, line.expectationId)
      if (line.exceptionId != null && (await this.getException(n.tenantId, line.exceptionId)) === null) {
        throw new NotFoundError('exception', line.exceptionId)
      }
    }
    const nowMs = now.getTime()
    const entry = this.one(
      `INSERT INTO journal_entries (id, tenant_id, movement_id, posting_no, kind, effective_at, posted_at, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      [this.ids(), n.tenantId, movement?.id ?? null, n.postingNo ?? null, n.kind, entryToPost.effectiveAt.getTime(), nowMs, n.description],
    )!
    const lines = n.lines.map(
      (l, i) =>
        this.one(
          `INSERT INTO journal_lines (
             entry_id, line_no, tenant_id, account, role, side, asset, decimals, amount, expectation_id, exception_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          [
            entry.id as string,
            i + 1,
            n.tenantId,
            l.account,
            l.role,
            l.side,
            l.amount.asset,
            l.amount.decimals,
            l.amount.raw.toString(),
            l.expectationId ?? null,
            l.exceptionId ?? null,
          ],
        )!,
    )
    return toJournalEntry(entry, lines)
  }

  async openException(n: NewException): Promise<ExceptionRecord> {
    assertValidNewException(n)
    if (n.movementId != null) this.movement(n.tenantId, n.movementId)
    if (n.expectationId != null) this.expectation(n.tenantId, n.expectationId)
    const record = toException(
      this.one(
        `INSERT INTO exceptions (
           id, tenant_id, code, status, movement_id, expectation_id, account, asset, decimals, amount,
           detail, evidence, opened_at
         ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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
          this.now().getTime(),
        ],
      )!,
    )
    this.emit(exceptionChanged(record))
    return record
  }

  async resolveException(tenantId: string, id: string, resolution: Resolution): Promise<ExceptionRecord> {
    const current = this.one('SELECT * FROM exceptions WHERE tenant_id = ? AND id = ?', [tenantId, id])
    if (current === undefined) throw new NotFoundError('exception', id)
    checkResolution(toException(current), resolution)
    const next = toException(
      this.one('UPDATE exceptions SET status = ?, resolved_at = ?, resolution_note = ? WHERE id = ? RETURNING *', [
        resolution.status,
        this.now().getTime(),
        resolution.note,
        id,
      ])!,
    )
    this.emit(exceptionChanged(next))
    return next
  }
}

export class SqliteStore extends SqliteReader implements MigratableStore {
  private readonly writer: Database.Database
  private readonly reader: Database.Database
  private tail: Promise<unknown> = Promise.resolve()
  private readonly ids: () => string
  private readonly now: () => Date

  constructor(options: SqliteStoreOptions) {
    const { filename } = options
    if (filename === '' || filename === ':memory:' || filename.startsWith('file::memory:')) {
      throw new Error('SqliteStore needs a database file; use MemoryStore for an in-memory store.')
    }
    const busy = options.busyTimeoutMs ?? 5_000
    const writer = new Database(filename, { timeout: busy })
    writer.pragma('journal_mode = WAL')
    // Durability over speed: this is a ledger.
    writer.pragma('synchronous = FULL')
    writer.pragma('foreign_keys = ON')
    const reader = new Database(filename, { readonly: true, timeout: busy })
    super(() => reader)
    this.writer = writer
    this.reader = reader
    this.ids = options.ids ?? randomUUID
    this.now = options.now ?? (() => new Date())
  }

  /** Run `fn` inside `BEGIN IMMEDIATE`, one at a time in this process. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      this.writer.exec('BEGIN IMMEDIATE')
      try {
        const result = await fn()
        this.writer.exec('COMMIT')
        return result
      } catch (err) {
        if (this.writer.inTransaction) this.writer.exec('ROLLBACK')
        throw err
      }
    })
    // The next transaction waits for this one whether it commits or not.
    this.tail = run.catch(() => undefined)
    return run
  }

  /**
   * Fill the text-memo index for expectations written before migration 6.
   * Runs inside `migrate()`'s transaction, and is idempotent so a database
   * rolled back to version 1 and re-migrated does not double-index anything.
   */
  private backfillReferenceIndex(): void {
    const rows = this.writer
      .prepare('SELECT id, tenant_id, reference, memo_type, memo_text FROM expectations')
      .all() as { id: string; tenant_id: string; reference: string; memo_type: string | null; memo_text: Buffer | null }[]
    const insert = this.writer.prepare(
      'INSERT OR IGNORE INTO expectation_reference_index (tenant_id, normalized, expectation_id) VALUES (?, ?, ?)',
    )
    for (const row of rows) {
      const memo: Memo | null =
        row.memo_type === 'text' ? { type: 'text', value: (row.memo_text ?? Buffer.alloc(0)).toString('utf8') } : null
      for (const normalized of expectationReferenceKeys(row.reference, memo)) {
        insert.run(row.tenant_id, normalized, row.id)
      }
    }
  }

  /** Apply any pending migrations. Safe to call from several processes at once. */
  migrate(): Promise<void> {
    return this.serial(async () => {
      const version = this.writer.pragma('user_version', { simple: true }) as number
      for (let v = version + 1; v <= MIGRATIONS.length; v++) {
        this.writer.exec(MIGRATIONS[v - 1]!)
        this.writer.pragma(`user_version = ${v}`)
      }
      if (version < 6) this.backfillReferenceIndex()
    })
  }

  /** The database's `user_version`, and the version `migrate()` brings it to. */
  schemaVersion(): Promise<SchemaVersion> {
    const current = this.reader.pragma('user_version', { simple: true }) as number
    return Promise.resolve({ current, latest: MIGRATIONS.length })
  }

  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      const tx = new SqliteTx(this.writer, this.ids, this.now)
      try {
        return await fn(tx)
      } finally {
        tx.close()
      }
    })
  }

  async close(): Promise<void> {
    // Let queued transactions finish before the connections go away.
    await this.tail
    this.reader.close()
    this.writer.close()
  }
}
