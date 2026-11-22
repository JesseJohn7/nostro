/**
 * An in-process `Store` with no dependencies.
 *
 * It exists so the quickstart runs with no database and so the matching engine
 * can be tested with no I/O. It is not a toy, though: it enforces every
 * constraint in the `Store` contract and passes the same conformance suite as
 * the SQL stores.
 *
 * Transactions are serialised: each one runs against a private copy of the
 * committed state, which replaces the committed state only if the callback
 * resolves. That gives serializable isolation and all-or-nothing rollback.
 * Reads outside a transaction see committed state only.
 *
 * Each transaction copies the state's indexes, so cost grows with the number
 * of records. That is fine for tests, development and small deployments; use
 * a SQL store for anything long-lived.
 */
import type {
  AccountEntity,
  AccountEntityQuery,
  AccountOpening,
  Allocation,
  CursorKey,
  Entity,
  EntityQuery,
  Disposition,
  Direction,
  ExceptionRecord,
  Expectation,
  ExpectationChanges,
  InternalTransferLink,
  InternalTransferQuery,
  JournalEntry,
  Movement,
  NewAccountEntity,
  NewAccountOpening,
  NewAllocation,
  NewEntity,
  NewInternalTransferLink,
  NewException,
  NewExpectation,
  NewJournalEntry,
  NewMovement,
  MovementValuation,
  NewMovementValuation,
  ValuationQuery,
  OpeningBalance,
} from '../model/index.js'
import {
  assertValidNewJournalEntry,
  assertValidNewAccountEntity,
  assertValidNewAccountOpening,
  assertValidNewEntity,
  assertValidNewInternalTransferLink,
  assertValidNewAllocation,
  assertValidNewException,
  assertValidNewExpectation,
  assertValidNewMovement,
} from '../model/index.js'
import type {
  AccountOpeningQuery,
  RefundLink,
  RefundQuery,
  ExportBatch,
  AllocationQuery,
  ExceptionQuery,
  ExpectationQuery,
  InsertMovementsResult,
  JournalQuery,
  JournalPeriod,
  MovementConflict,
  MovementQuery,
  Resolution,
  Store,
  StoreReader,
  StoreTx,
} from './store.js'
import {
  amendExpectationRecord,
  checkAllocation,
  checkCancel,
  checkCursorValue,
  checkDisposition,
  checkJournalEntry,
  checkJournalPeriodClose,
  checkJournalPeriodReopen,
  checkResolution,
  issueMuxedId,
  storedMemo,
  sameFacts,
} from './rules.js'
import { Money } from '../money/index.js'
import { refundParts, refundCoverage } from './refunds.js'
import { postAccrual } from './accrual.js'
import { ConstraintError, NotFoundError, TransactionClosedError } from './store.js'
import type { ApiKeyRow, NewApiKeyRow, SyncStateRow, WatchedAccountRow } from './store.js'
import { EventHistoryPrunedError, eventCursorKey } from './events.js'
import type { EventQuery, NewOutboxEvent, OutboxEvent, PruneEventsResult } from './events.js'
import type {
  DeliveryAttempt,
  DeliveryAttemptQuery,
  NewDeliveryAttempt,
  Rewind,
  RewindInput,
  RewindQuery,
} from './delivery.js'
import { DELIVERY_ATTEMPT_LIMIT, DELIVERY_ATTEMPT_TTL_MS } from './delivery.js'
import { exceptionChanged, expectationAmended, expectationChanged, movementDecided } from './events.js'
import { expectationReferenceKeys } from '../matching/reference.js'

export interface MemoryStoreOptions {
  /** Id generator. Defaults to `crypto.randomUUID()`; inject one for deterministic tests. */
  readonly ids?: () => string
  /** Clock for `createdAt` and friends. Defaults to `new Date()`. */
  readonly now?: () => Date
}

interface State {
  seq: number
  readonly entities: Map<string, Entity>
  readonly accountEntities: Map<string, AccountEntity>
  readonly internalTransferLinks: Map<string, InternalTransferLink>
  readonly accountOpenings: Map<string, AccountOpening>
  readonly movements: Map<string, Movement>
  /** Dedupe key → movement id. */
  readonly movementKeys: Map<string, string>
  readonly expectations: Map<string, Expectation>
  /** (tenant, reference) → expectation id. */
  readonly expectationRefs: Map<string, string>
  /** (tenant, normalised key) → expectation ids. A key can name several invoices. */
  readonly expectationKeys: Map<string, readonly string[]>
  readonly allocations: Map<string, Allocation>
  readonly exceptions: Map<string, ExceptionRecord>
  readonly cursors: Map<string, string>
  /** Keyed by id. The digest index is checked by scanning, which is fine at a tenant's key count. */
  readonly apiKeys: Map<string, ApiKeyRow>
  /** (tenant, account) → the watched account. */
  readonly watched: Map<string, WatchedAccountRow>
  /** (tenant, network, source, account) → sync state. */
  readonly syncState: Map<string, SyncStateRow>
  journalSeq: number
  readonly journal: Map<string, JournalEntry>
  eventSeq: number
  readonly events: Map<string, OutboxEvent>
  readonly eventPrunedThrough: Map<string, number>
  deliveryAttemptSeq: number
  readonly deliveryAttempts: Map<string, DeliveryAttempt>
  rewindSeq: number
  readonly rewinds: Map<string, Rewind>
  /** Movement id → its entry ids in posting order. Arrays are replaced, never pushed to. */
  readonly journalByMovement: Map<string, readonly string[]>
  readonly refunds: Map<string, RefundLink>
  readonly valuations: Map<string, MovementValuation>
  periodActions: readonly {
    readonly tenantId: string
    readonly action: 'close' | 'reopen'
    readonly through: Date | null
    readonly note: string | null
    readonly reason: string | null
    readonly at: Date
  }[]
}

function emptyState(): State {
  return {
    seq: 0,
    entities: new Map(),
    accountEntities: new Map(),
    internalTransferLinks: new Map(),
    accountOpenings: new Map(),
    movements: new Map(),
    movementKeys: new Map(),
    expectations: new Map(),
    expectationRefs: new Map(),
    expectationKeys: new Map(),
    allocations: new Map(),
    exceptions: new Map(),
    cursors: new Map(),
    apiKeys: new Map(),
    watched: new Map(),
    syncState: new Map(),
    journalSeq: 0,
    journal: new Map(),
    journalByMovement: new Map(),
    eventSeq: 0,
    events: new Map(),
    eventPrunedThrough: new Map(),
    deliveryAttemptSeq: 0,
    deliveryAttempts: new Map(),
    rewindSeq: 0,
    rewinds: new Map(),
    periodActions: [],
    refunds: new Map(),
    valuations: new Map(),
  }
}

/** Records are frozen, so copying the indexes is a complete snapshot. */
function cloneState(s: State): State {
  return {
    seq: s.seq,
    entities: new Map(s.entities),
    accountEntities: new Map(s.accountEntities),
    internalTransferLinks: new Map(s.internalTransferLinks),
    accountOpenings: new Map(s.accountOpenings),
    movements: new Map(s.movements),
    movementKeys: new Map(s.movementKeys),
    expectations: new Map(s.expectations),
    expectationRefs: new Map(s.expectationRefs),
    expectationKeys: new Map(s.expectationKeys),
    allocations: new Map(s.allocations),
    exceptions: new Map(s.exceptions),
    cursors: new Map(s.cursors),
    apiKeys: new Map(s.apiKeys),
    watched: new Map(s.watched),
    syncState: new Map(s.syncState),
    journalSeq: s.journalSeq,
    journal: new Map(s.journal),
    journalByMovement: new Map(s.journalByMovement),
    eventSeq: s.eventSeq,
    events: new Map(s.events),
    eventPrunedThrough: new Map(s.eventPrunedThrough),
    deliveryAttemptSeq: s.deliveryAttemptSeq,
    deliveryAttempts: new Map(s.deliveryAttempts),
    rewindSeq: s.rewindSeq,
    rewinds: new Map(s.rewinds),
    periodActions: [...s.periodActions],
    refunds: new Map(s.refunds),
    valuations: new Map(s.valuations),
  }
}

const key = (...parts: readonly string[]): string => JSON.stringify(parts)
const movementKey = (m: { tenantId: string; network: string; source: string; externalId: string }) =>
  key(m.tenantId, m.network, m.source, m.externalId)
const cursorKey = (k: CursorKey) => key(k.tenantId, k.network, k.source, k.account)
const openingKey = (o: Pick<AccountOpening, 'tenantId' | 'network' | 'account'>) =>
  key(o.tenantId, o.network, o.account)
const entityKey = (e: Pick<Entity, 'tenantId' | 'id'>) => key(e.tenantId, e.id)
const accountEntityKey = (a: Pick<AccountEntity, 'tenantId' | 'network' | 'account'>) =>
  key(a.tenantId, a.network, a.account)
const internalTransferKey = (l: Pick<InternalTransferLink, 'tenantId' | 'network' | 'txHash' | 'movementIds'>) =>
  key(l.tenantId, l.network, l.txHash, [...l.movementIds].sort().join(':'))
const copyDate = (d: Date): Date => new Date(d.getTime())
const copyOpeningBalance = (b: OpeningBalance): OpeningBalance => Object.freeze({ amount: b.amount, lastModifiedLedger: b.lastModifiedLedger })

const addReferenceKeys = (state: State, e: Expectation): void => {
  for (const normalized of expectationReferenceKeys(e.reference, e.memo)) {
    const indexKey = key(e.tenantId, normalized)
    const ids = state.expectationKeys.get(indexKey) ?? []
    if (!ids.includes(e.id)) state.expectationKeys.set(indexKey, [...ids, e.id])
  }
}

const removeReferenceKeys = (state: State, e: Expectation): void => {
  for (const normalized of expectationReferenceKeys(e.reference, e.memo)) {
    const indexKey = key(e.tenantId, normalized)
    const ids = (state.expectationKeys.get(indexKey) ?? []).filter((id) => id !== e.id)
    if (ids.length === 0) state.expectationKeys.delete(indexKey)
    else state.expectationKeys.set(indexKey, ids)
  }
}

abstract class MemoryReader implements StoreReader {
  /** The state reads run against: committed state, or a transaction's draft. */
  protected abstract snapshot(): State

  protected check(): void {}

  async listRefundLinks(q: RefundQuery): Promise<RefundLink[]> {
    this.check()
    return [...this.snapshot().refunds.values()].filter(link => link.tenantId === q.tenantId &&
      (q.creditMovementId === undefined || link.creditMovementId === q.creditMovementId) &&
      (q.refundMovementId === undefined || link.refundMovementId === q.refundMovementId) &&
      (q.movementIds === undefined || q.movementIds.includes(link.creditMovementId) || q.movementIds.includes(link.refundMovementId)))
  }

  async accrualGetMode(_tenantId: string): Promise<boolean> { this.check(); return false }

  async getMovement(tenantId: string, id: string): Promise<Movement | null> {
    this.check()
    const m = this.snapshot().movements.get(id)
    return m !== undefined && m.tenantId === tenantId ? m : null
  }

  async listMovements(q: MovementQuery): Promise<Movement[]> {
    this.check()
    if (q.ids?.length === 0) return []
    const ids = q.ids === undefined ? null : new Set(q.ids)
    const out: Movement[] = []
    for (const m of this.snapshot().movements.values()) {
      if (m.tenantId !== q.tenantId) continue
      if (ids !== null && !ids.has(m.id)) continue
      if (q.disposition !== undefined && m.disposition !== q.disposition) continue
      if (q.account !== undefined && m.account !== q.account) continue
      if (q.entityId !== undefined && m.entityId !== q.entityId) continue
      if (q.txHash !== undefined && m.txHash !== q.txHash) continue
      if (q.afterSeq !== undefined && m.seq <= q.afterSeq) continue
      out.push(m)
    }
    out.sort((a, b) => a.seq - b.seq)
    return q.limit === undefined ? out : out.slice(0, q.limit)
  }

  async getExpectation(tenantId: string, id: string): Promise<Expectation | null> {
    this.check()
    const e = this.snapshot().expectations.get(id)
    return e !== undefined && e.tenantId === tenantId ? e : null
  }

  async getExpectationByReference(tenantId: string, reference: string): Promise<Expectation | null> {
    this.check()
    const id = this.snapshot().expectationRefs.get(key(tenantId, reference))
    return id === undefined ? null : (this.snapshot().expectations.get(id) ?? null)
  }

  async getExpectationsByNormalizedReference(tenantId: string, normalized: string): Promise<Expectation[]> {
    this.check()
    if (normalized === '') return []
    const out: Expectation[] = []
    for (const id of this.snapshot().expectationKeys.get(key(tenantId, normalized)) ?? []) {
      const e = this.snapshot().expectations.get(id)
      if (e !== undefined && e.tenantId === tenantId) out.push(e)
    }
    return out.sort((a, b) => a.seq - b.seq)
  }

  async listExpectations(q: ExpectationQuery): Promise<Expectation[]> {
    this.check()
    if (q.ids?.length === 0) return []
    const ids = q.ids === undefined ? null : new Set(q.ids)
    const out: Expectation[] = []
    for (const e of this.snapshot().expectations.values()) {
      if (e.tenantId !== q.tenantId) continue
      if (ids !== null && !ids.has(e.id)) continue
      if (q.account !== undefined && e.account !== q.account) continue
      if (q.asset !== undefined && e.amount.asset !== q.asset) continue
      if (q.direction !== undefined && e.direction !== q.direction) continue
      if (q.status !== undefined && !q.status.includes(e.status)) continue
      if (q.muxedId !== undefined && e.muxedId !== q.muxedId) continue
      if (q.afterSeq !== undefined && e.seq <= q.afterSeq) continue
      out.push(e)
      if (q.limit !== undefined && out.length >= q.limit) break
    }
    return out
  }

  async listAllocations(q: AllocationQuery): Promise<Allocation[]> {
    this.check()
    if (q.movementIds?.length === 0 || q.expectationIds?.length === 0) return []
    const movementIds = q.movementIds === undefined ? null : new Set(q.movementIds)
    const expectationIds = q.expectationIds === undefined ? null : new Set(q.expectationIds)
    const out: Allocation[] = []
    for (const a of this.snapshot().allocations.values()) {
      if (a.tenantId !== q.tenantId) continue
      if (q.movementId !== undefined && a.movementId !== q.movementId) continue
      if (movementIds !== null && !movementIds.has(a.movementId)) continue
      if (q.expectationId !== undefined && a.expectationId !== q.expectationId) continue
      if (expectationIds !== null && !expectationIds.has(a.expectationId)) continue
      out.push(a)
    }
    return out
  }

  async getException(tenantId: string, id: string): Promise<ExceptionRecord | null> {
    this.check()
    const e = this.snapshot().exceptions.get(id)
    return e !== undefined && e.tenantId === tenantId ? e : null
  }

  async listExceptions(q: ExceptionQuery): Promise<ExceptionRecord[]> {
    this.check()
    if (q.ids?.length === 0 || q.movementIds?.length === 0 || q.expectationIds?.length === 0) return []
    const ids = q.ids === undefined ? null : new Set(q.ids)
    const movementIds = q.movementIds === undefined ? null : new Set(q.movementIds)
    const expectationIds = q.expectationIds === undefined ? null : new Set(q.expectationIds)
    const out: ExceptionRecord[] = []
    for (const e of this.snapshot().exceptions.values()) {
      if (e.tenantId !== q.tenantId) continue
      if (ids !== null && !ids.has(e.id)) continue
      if (q.status !== undefined && e.status !== q.status) continue
      if (q.code !== undefined && e.code !== q.code) continue
      if (q.movementId !== undefined && e.movementId !== q.movementId) continue
      if (movementIds !== null && (e.movementId === null || !movementIds.has(e.movementId))) continue
      if (q.expectationId !== undefined && e.expectationId !== q.expectationId) continue
      if (expectationIds !== null && (e.expectationId === null || !expectationIds.has(e.expectationId))) continue
      if (q.afterSeq !== undefined && e.seq <= q.afterSeq) continue
      out.push(e)
      if (q.limit !== undefined && out.length >= q.limit) break
    }
    return out
  }

  async listEvents(q: EventQuery): Promise<OutboxEvent[]> {
    this.check()
    const prunedThrough = this.snapshot().eventPrunedThrough.get(q.tenantId) ?? 0
    if (q.afterSeq !== undefined && q.afterSeq < prunedThrough) {
      throw new EventHistoryPrunedError(q.tenantId, q.afterSeq, prunedThrough)
    }
    const out: OutboxEvent[] = []
    for (const e of this.snapshot().events.values()) {
      if (e.tenantId !== q.tenantId) continue
      if (q.afterSeq !== undefined && e.seq <= q.afterSeq) continue
      out.push(e)
      if (q.limit !== undefined && out.length >= q.limit) break
    }
    return out
  }

  async getEventsPrunedThrough(tenantId: string): Promise<number> {
    this.check()
    return this.snapshot().eventPrunedThrough.get(tenantId) ?? 0
  }

  async getLatestEventSeq(tenantId: string): Promise<number> {
    this.check()
    let latest = 0
    for (const event of this.snapshot().events.values()) {
      if (event.tenantId === tenantId && event.seq > latest) latest = event.seq
    }
    return latest
  }

  async listDeliveryAttempts(q: DeliveryAttemptQuery): Promise<DeliveryAttempt[]> {
    this.check()
    const out = [...this.snapshot().deliveryAttempts.values()]
      .filter((a) =>
        a.tenantId === q.tenantId &&
        a.consumer === q.consumer &&
        (q.outcome === undefined || a.outcome === q.outcome) &&
        (q.beforeSeq === undefined || a.seq < q.beforeSeq))
      .sort((a, b) => b.seq - a.seq)
    return q.limit === undefined ? out : out.slice(0, q.limit)
  }

  async listDeliveryConsumers(tenantId: string): Promise<string[]> {
    this.check()
    const state = this.snapshot()
    const consumers = new Set<string>()
    for (const [storedKey, value] of state.cursors) {
      const [cursorTenant, network, source, account] = JSON.parse(storedKey) as string[]
      if (cursorTenant === tenantId && network === 'nostro' && source === 'outbox' && value !== null && account !== undefined) {
        consumers.add(account)
      }
    }
    for (const a of state.deliveryAttempts.values()) {
      if (a.tenantId === tenantId) consumers.add(a.consumer)
    }
    for (const r of state.rewinds.values()) {
      if (r.tenantId === tenantId) consumers.add(r.consumer)
    }
    return [...consumers].sort()
  }

  async listRewinds(q: RewindQuery): Promise<Rewind[]> {
    this.check()
    return [...this.snapshot().rewinds.values()]
      .filter((r) => r.tenantId === q.tenantId && (q.consumer === undefined || r.consumer === q.consumer))
      .sort((a, b) => b.seq - a.seq)
      .slice(0, q.limit ?? DELIVERY_ATTEMPT_LIMIT)
  }

  async getEntity(tenantId: string, id: string): Promise<Entity | null> {
    this.check()
    return this.snapshot().entities.get(entityKey({ tenantId, id })) ?? null
  }

  async listEntities(q: EntityQuery): Promise<Entity[]> {
    this.check()
    const out = [...this.snapshot().entities.values()].filter((e) => e.tenantId === q.tenantId)
    out.sort((a, b) => a.id.localeCompare(b.id))
    return q.limit === undefined ? out : out.slice(0, q.limit)
  }

  async getAccountEntity(tenantId: string, network: string, account: string): Promise<AccountEntity | null> {
    this.check()
    return this.snapshot().accountEntities.get(accountEntityKey({ tenantId, network, account })) ?? null
  }

  async listAccountEntities(q: AccountEntityQuery): Promise<AccountEntity[]> {
    this.check()
    const out = [...this.snapshot().accountEntities.values()].filter((a) =>
      a.tenantId === q.tenantId &&
      (q.network === undefined || a.network === q.network) &&
      (q.account === undefined || a.account === q.account) &&
      (q.entityId === undefined || a.entityId === q.entityId)
    )
    out.sort((a, b) => a.account.localeCompare(b.account) || a.network.localeCompare(b.network))
    return q.limit === undefined ? out : out.slice(0, q.limit)
  }

  async getInternalTransferLink(tenantId: string, id: string): Promise<InternalTransferLink | null> {
    this.check()
    const link = this.snapshot().internalTransferLinks.get(id)
    return link !== undefined && link.tenantId === tenantId ? link : null
  }

  async listInternalTransferLinks(q: InternalTransferQuery): Promise<InternalTransferLink[]> {
    this.check()
    if (q.movementIds?.length === 0) return []
    const movementIds = q.movementIds === undefined ? null : new Set(q.movementIds)
    const out = [...this.snapshot().internalTransferLinks.values()].filter((l) =>
      l.tenantId === q.tenantId &&
      (q.network === undefined || l.network === q.network) &&
      (q.txHash === undefined || l.txHash === q.txHash) &&
      (movementIds === null || l.movementIds.some((id) => movementIds.has(id)))
    )
    out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    return q.limit === undefined ? out : out.slice(0, q.limit)
  }

  async getAccountOpening(tenantId: string, network: string, account: string): Promise<AccountOpening | null> {
    this.check()
    return this.snapshot().accountOpenings.get(openingKey({ tenantId, network, account })) ?? null
  }

  async listAccountOpenings(q: AccountOpeningQuery): Promise<AccountOpening[]> {
    this.check()
    const out = [...this.snapshot().accountOpenings.values()].filter((o) =>
      o.tenantId === q.tenantId &&
      (q.network === undefined || o.network === q.network) &&
      (q.account === undefined || o.account === q.account)
    )
    out.sort((a, b) => a.ledger - b.ledger || a.id.localeCompare(b.id))
    return q.limit === undefined ? out : out.slice(0, q.limit)
  }

  async listJournalEntries(q: JournalQuery): Promise<JournalEntry[]> {
    this.check()
    if (q.movementIds?.length === 0) return []
    const state = this.snapshot()
    const ids =
      q.movementId === undefined ? [...state.journal.keys()] : (state.journalByMovement.get(q.movementId) ?? [])
    const movementIds = q.movementIds === undefined ? null : new Set(q.movementIds)
    const out: JournalEntry[] = []
    for (const id of ids) {
      const e = state.journal.get(id)!
      if (e.tenantId !== q.tenantId) continue
      if (movementIds !== null && (e.movementId === null || !movementIds.has(e.movementId))) continue
      if (q.afterSeq !== undefined && e.seq <= q.afterSeq) continue
      if (q.effectiveFrom !== undefined && e.effectiveAt.getTime() < q.effectiveFrom.getTime()) continue
      if (q.effectiveBefore !== undefined && e.effectiveAt.getTime() >= q.effectiveBefore.getTime()) continue
      if (q.account !== undefined && !e.lines.some((l) => l.account === q.account)) continue
      if (q.entityId !== undefined && !e.lines.some((l) => l.entityId === q.entityId)) continue
      out.push(e)
    }
    out.sort((a, b) => a.seq - b.seq)
    return q.limit === undefined ? out : out.slice(0, q.limit)
  }

  async getCursor(k: CursorKey): Promise<string | null> {
    this.check()
    return this.snapshot().cursors.get(cursorKey(k)) ?? null
  }

  async findApiKeyByDigest(digest: string): Promise<ApiKeyRow | null> {
    this.check()
    for (const row of this.snapshot().apiKeys.values()) if (row.digest === digest) return row
    return null
  }

  async listApiKeys(tenantId?: string): Promise<ApiKeyRow[]> {
    this.check()
    return [...this.snapshot().apiKeys.values()]
      .filter((row) => tenantId === undefined || row.tenantId === tenantId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
  }

  async listWatchedAccounts(tenantId: string): Promise<WatchedAccountRow[]> {
    this.check()
    return [...this.snapshot().watched.values()]
      .filter((row) => row.tenantId === tenantId)
      .sort((a, b) => a.addedAt.getTime() - b.addedAt.getTime() || (a.account < b.account ? -1 : 1))
  }

  async listSyncState(tenantId: string): Promise<SyncStateRow[]> {
    this.check()
    return [...this.snapshot().syncState.values()]
      .filter((row) => row.tenantId === tenantId)
      .sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : a.source < b.source ? -1 : a.source > b.source ? 1 : a.network < b.network ? -1 : 1))
  }

  async getJournalPeriod(tenantId: string): Promise<JournalPeriod | null> {
    this.check()
    const actions = this.snapshot().periodActions
    for (let i = actions.length - 1; i >= 0; i--) {
      const action = actions[i]!
      if (action.tenantId !== tenantId) continue
      return action.action === 'close'
        ? Object.freeze({
            tenantId,
            through: copyDate(action.through!),
            note: action.note,
            closedAt: copyDate(action.at),
          })
        : null
    }
    return null
  }

  async getValuation(tenantId: string, movementId: string): Promise<MovementValuation | null> {
    this.check()
    return this.snapshot().valuations.get(`${tenantId}:${movementId}`) ?? null
  }

  async listValuations(q: ValuationQuery): Promise<MovementValuation[]> {
    this.check()
    const out: MovementValuation[] = []
    for (const v of this.snapshot().valuations.values()) {
      if (v.tenantId !== q.tenantId) continue
      if (q.movementId !== undefined && v.movementId !== q.movementId) continue
      if (q.reportingAsset !== undefined && v.reportingAsset !== q.reportingAsset) continue
      out.push(v)
    }
    return out
  }
}

class MemoryTx extends MemoryReader implements StoreTx {
  private open = true

  constructor(
    readonly draft: State,
    private readonly ids: () => string,
    private readonly now: () => Date,
  ) {
    super()
  }

  protected snapshot(): State {
    return this.draft
  }

  close(): void {
    this.open = false
  }

  protected override check(): void {
    if (!this.open) throw new TransactionClosedError()
  }

  async lockJournalPeriod(tenantId: string): Promise<JournalPeriod | null> {
    this.check()
    return this.getJournalPeriod(tenantId)
  }

  async closeJournalPeriod(tenantId: string, through: Date, note: string | null): Promise<void> {
    this.check()
    checkJournalPeriodClose(tenantId, through, note)
    await this.lockJournalPeriod(tenantId)
    this.draft.periodActions = [
      ...this.draft.periodActions,
      Object.freeze({ tenantId, action: 'close', through: copyDate(through), note, reason: null, at: this.now() }),
    ]
  }

  async reopenJournalPeriod(tenantId: string, reason: string): Promise<void> {
    this.check()
    const period = await this.lockJournalPeriod(tenantId)
    checkJournalPeriodReopen(tenantId, reason, period !== null)
    this.draft.periodActions = [
      ...this.draft.periodActions,
      Object.freeze({ tenantId, action: 'reopen', through: null, note: null, reason, at: this.now() }),
    ]
  }

  private movement(tenantId: string, id: string): Movement {
    const m = this.draft.movements.get(id)
    if (m === undefined || m.tenantId !== tenantId) throw new NotFoundError('movement', id)
    return m
  }

  private expectation(tenantId: string, id: string): Expectation {
    const e = this.draft.expectations.get(id)
    if (e === undefined || e.tenantId !== tenantId) throw new NotFoundError('expectation', id)
    return e
  }

  private allocationsOf(field: 'movementId' | 'expectationId', id: string): Allocation[] {
    return [...this.draft.allocations.values()].filter((a) => a[field] === id)
  }

  /** Append to the event log, in this transaction. */
  private emit(event: NewOutboxEvent | null): void {
    if (event === null) return
    const record: OutboxEvent = Object.freeze({
      id: this.ids(),
      seq: ++this.draft.eventSeq,
      ...event,
      createdAt: this.now(),
    })
    this.draft.events.set(record.id, record)
  }

  async insertEntity(n: NewEntity): Promise<Entity> {
    this.check()
    assertValidNewEntity(n)
    const k = entityKey(n)
    if (this.draft.entities.has(k)) {
      throw new ConstraintError('entity_duplicate', `entity ${n.id} already exists in this tenant`)
    }
    const record: Entity = Object.freeze({ ...n, createdAt: this.now() })
    this.draft.entities.set(k, record)
    return record
  }

  async assignAccountEntity(n: NewAccountEntity): Promise<AccountEntity> {
    this.check()
    assertValidNewAccountEntity(n)
    if (!this.draft.entities.has(entityKey({ tenantId: n.tenantId, id: n.entityId }))) {
      throw new ConstraintError('entity_unknown', `entity ${n.entityId} does not exist in this tenant`)
    }
    const k = accountEntityKey(n)
    const record: AccountEntity = Object.freeze({ ...n, createdAt: this.now() })
    this.draft.accountEntities.set(k, record)
    return record
  }

  async linkInternalTransfer(n: NewInternalTransferLink): Promise<InternalTransferLink> {
    this.check()
    assertValidNewInternalTransferLink(n)
    const [a, b] = n.movementIds.map((id) => this.movement(n.tenantId, id)) as [Movement, Movement]
    if (a.network !== n.network || b.network !== n.network) {
      throw new ConstraintError('internal_transfer_invalid', 'both movements must be on the transfer network')
    }
    const sameEntity = a.entityId === b.entityId
    if (sameEntity !== n.sameEntity) {
      throw new ConstraintError('internal_transfer_invalid', 'sameEntity disagrees with the linked movements')
    }
    const k = internalTransferKey(n)
    if (this.draft.internalTransferLinks.has(k)) {
      throw new ConstraintError('internal_transfer_duplicate', 'these movements are already linked')
    }
    const existing = [...this.draft.internalTransferLinks.values()].find((l) =>
      l.movementIds.some((id) => n.movementIds.includes(id)))
    if (existing !== undefined) {
      throw new ConstraintError('internal_transfer_duplicate', 'a movement is already part of another internal transfer')
    }
    const record: InternalTransferLink = Object.freeze({
      ...n,
      id: this.ids(),
      movementIds: Object.freeze([n.movementIds[0]!, n.movementIds[1]!]) as readonly [string, string],
      sameEntity,
      createdAt: this.now(),
    })
    this.draft.internalTransferLinks.set(record.id, record)
    return record
  }

  async insertAccountOpening(opening: NewAccountOpening): Promise<AccountOpening> {
    this.check()
    assertValidNewAccountOpening(opening)
    const k = openingKey(opening)
    if (this.draft.accountOpenings.has(k)) {
      throw new ConstraintError('account_opening_duplicate', `${opening.network}:${opening.account} already has an opening`)
    }
    const hasMovements = [...this.draft.movements.values()].some((m) =>
      m.tenantId === opening.tenantId && m.network === opening.network && m.account === opening.account)
    if (hasMovements) {
      throw new ConstraintError('account_opening_has_movements', `${opening.network}:${opening.account} already has movements`)
    }
    const record: AccountOpening = Object.freeze({
      ...opening,
      id: this.ids(),
      occurredAt: copyDate(opening.occurredAt ?? this.now()),
      balances: Object.freeze(opening.balances.map(copyOpeningBalance)),
      note: opening.note ?? null,
      createdAt: this.now(),
    })
    this.draft.accountOpenings.set(k, record)
    return record
  }

  async insertMovements(batch: readonly NewMovement[]): Promise<InsertMovementsResult> {
    this.check()
    batch.forEach(assertValidNewMovement)
    const inserted: Movement[] = []
    const duplicates: Movement[] = []
    const conflicts: MovementConflict[] = []
    for (const n of batch) {
      const assignment = this.draft.accountEntities.get(accountEntityKey(n))
      const entityId = n.entityId ?? assignment?.entityId ?? null
      if (entityId !== null && !this.draft.entities.has(entityKey({ tenantId: n.tenantId, id: entityId }))) {
        throw new ConstraintError('entity_unknown', `entity ${entityId} does not exist in this tenant`)
      }
      const candidate: Movement = Object.freeze({
        id: '',
        tenantId: n.tenantId,
        seq: 0,
        network: n.network,
        source: n.source,
        externalId: n.externalId,
        revision: n.revision ?? 1,
        account: n.account,
        entityId,
        direction: n.direction,
        kind: n.kind,
        amount: n.amount,
        counterparty: n.counterparty ?? null,
        muxedId: n.muxedId ?? null,
        memo: n.memo == null ? null : Object.freeze(storedMemo(n.memo)),
        ledger: n.ledger,
        txHash: n.txHash ?? null,
        operationId: n.operationId ?? null,
        occurredAt: copyDate(n.occurredAt),
        enrichment: n.enrichment ?? 'complete',
        disposition: 'pending',
        ignoredReason: null,
        createdAt: this.now(),
      })
      const k = movementKey(n)
      const existingId = this.draft.movementKeys.get(k)
      if (existingId !== undefined) {
        const existing = this.draft.movements.get(existingId)!
        if (sameFacts(existing, n)) duplicates.push(existing)
        else conflicts.push({ existing, incoming: n })
        continue
      }
      const movement: Movement = Object.freeze({
        ...candidate,
        id: this.ids(),
        seq: ++this.draft.seq,
      })
      this.draft.movements.set(movement.id, movement)
      this.draft.movementKeys.set(k, movement.id)
      inserted.push(movement)
    }
    return { inserted, duplicates, conflicts }
  }

  async setDisposition(
    tenantId: string,
    movementId: string,
    disposition: Disposition,
    reason?: string,
  ): Promise<Movement> {
    this.check()
    const m = this.movement(tenantId, movementId)
    checkDisposition(
      m,
      this.allocationsOf('movementId', m.id),
      [...this.draft.exceptions.values()].filter((e) => e.movementId === m.id),
      disposition,
      reason,
      refundCoverage(m, await this.listRefundLinks({tenantId,movementIds:[m.id]})),
    )
    const next: Movement = Object.freeze({
      ...m,
      disposition,
      ignoredReason: disposition === 'ignored' ? reason! : null,
    })
    this.draft.movements.set(next.id, next)
    if (m.disposition !== disposition) this.emit(movementDecided(next, m.disposition, this.allocationsOf('movementId', m.id)))
    return next
  }

  async setCursor(k: CursorKey, value: string): Promise<void> {
    this.check()
    checkCursorValue(value)
    this.draft.cursors.set(cursorKey(k), value)
  }

  async insertApiKey(input: NewApiKeyRow): Promise<ApiKeyRow> {
    this.check()
    for (const row of this.draft.apiKeys.values()) {
      if (row.digest === input.digest) throw new ConstraintError('api_key_digest_unique', 'that key is already stored')
    }
    const row: ApiKeyRow = Object.freeze({
      id: input.id,
      tenantId: input.tenantId,
      label: input.label,
      digest: input.digest,
      scopes: Object.freeze([...input.scopes]),
      createdAt: copyDate(input.createdAt),
      revokedAt: null,
      lastUsedAt: null,
    })
    this.draft.apiKeys.set(row.id, row)
    return row
  }

  async revokeApiKey(id: string, at: Date): Promise<ApiKeyRow> {
    this.check()
    const row = this.draft.apiKeys.get(id)
    if (row === undefined) throw new NotFoundError('api_key', id)
    if (row.revokedAt !== null) return row
    const next: ApiKeyRow = Object.freeze({ ...row, revokedAt: copyDate(at) })
    this.draft.apiKeys.set(id, next)
    return next
  }

  async recordApiKeyUse(uses: readonly { readonly id: string; readonly at: Date }[]): Promise<void> {
    this.check()
    for (const { id, at } of uses) {
      const row = this.draft.apiKeys.get(id)
      if (row === undefined) continue
      if (row.lastUsedAt !== null && row.lastUsedAt.getTime() >= at.getTime()) continue
      this.draft.apiKeys.set(id, Object.freeze({ ...row, lastUsedAt: copyDate(at) }))
    }
  }

  async addWatchedAccount(row: WatchedAccountRow): Promise<WatchedAccountRow> {
    this.check()
    const k = key(row.tenantId, row.account)
    const existing = this.draft.watched.get(k)
    if (existing !== undefined) return existing
    const stored: WatchedAccountRow = Object.freeze({ ...row, addedAt: copyDate(row.addedAt) })
    this.draft.watched.set(k, stored)
    return stored
  }

  async removeWatchedAccount(tenantId: string, account: string): Promise<boolean> {
    this.check()
    return this.draft.watched.delete(key(tenantId, account))
  }

  async recordSyncState(state: SyncStateRow): Promise<void> {
    this.check()
    this.draft.syncState.set(
      key(state.tenantId, state.network, state.source, state.account),
      Object.freeze({
        ...state,
        lastAttemptAt: copyDate(state.lastAttemptAt),
        lastSuccessAt: state.lastSuccessAt === null ? null : copyDate(state.lastSuccessAt),
        lastErrorAt: state.lastErrorAt === null ? null : copyDate(state.lastErrorAt),
      }),
    )
  }

  async recordDeliveryAttempt(attempt: NewDeliveryAttempt): Promise<DeliveryAttempt> {
    this.check()
    const record: DeliveryAttempt = Object.freeze({
      ...attempt,
      id: this.ids(),
      seq: ++this.draft.deliveryAttemptSeq,
      at: copyDate(attempt.at),
    })
    this.draft.deliveryAttempts.set(record.id, record)
    const sameConsumer = [...this.draft.deliveryAttempts.values()]
      .filter((a) => a.tenantId === attempt.tenantId && a.consumer === attempt.consumer)
      .sort((a, b) => b.seq - a.seq)
    const cutoff = attempt.at.getTime() - DELIVERY_ATTEMPT_TTL_MS
    const keepFrom = sameConsumer.length > DELIVERY_ATTEMPT_LIMIT ? sameConsumer[DELIVERY_ATTEMPT_LIMIT - 1]!.seq : -Infinity
    for (const old of sameConsumer) {
      if (old.seq < keepFrom || old.at.getTime() < cutoff) this.draft.deliveryAttempts.delete(old.id)
    }
    return record
  }

  async rewindConsumer(input: RewindInput): Promise<Rewind | null> {
    this.check()
    const key = eventCursorKey(input.tenantId, input.consumer)
    const current = this.draft.cursors.get(cursorKey(key))
    if ((current === null || current === undefined ? 0 : Number(current)) !== input.expectedSeq) return null
    checkCursorValue(String(input.toSeq))
    this.draft.cursors.set(cursorKey(key), String(input.toSeq))
    const record: Rewind = Object.freeze({
      id: this.ids(),
      seq: ++this.draft.rewindSeq,
      tenantId: input.tenantId,
      consumer: input.consumer,
      fromSeq: input.expectedSeq,
      toSeq: input.toSeq,
      actor: input.actor,
      at: copyDate(input.at),
    })
    this.draft.rewinds.set(record.id, record)
    return record
  }

  async pruneEventsBefore(tenantId: string, olderThan: Date): Promise<PruneEventsResult> {
    this.check()
    if (!Number.isFinite(olderThan.getTime())) throw new Error('olderThan must be a valid date')
    const events = [...this.draft.events.values()]
      .filter((event) => event.tenantId === tenantId)
      .sort((a, b) => a.seq - b.seq)
    const firstRecent = events.find((event) => event.createdAt > olderThan)
    const prefixThrough = firstRecent?.seq === undefined
      ? events.at(-1)?.seq ?? 0
      : firstRecent.seq - 1
    const consumerPositions = [...this.draft.cursors.entries()].flatMap(([storedKey, value]) => {
      const [cursorTenant, network, source] = JSON.parse(storedKey) as string[]
      return cursorTenant === tenantId && network === 'nostro' && source === 'outbox' ? [Number(value)] : []
    })
    const safeThrough = Math.min(prefixThrough, consumerPositions.length === 0 ? prefixThrough : Math.min(...consumerPositions))
    const removed = events.filter((event) => event.seq <= safeThrough && event.createdAt <= olderThan)
    for (const event of removed) this.draft.events.delete(event.id)
    const prunedThrough = Math.max(this.draft.eventPrunedThrough.get(tenantId) ?? 0, removed.at(-1)?.seq ?? 0)
    if (prunedThrough > 0) this.draft.eventPrunedThrough.set(tenantId, prunedThrough)
    return { deleted: removed.length, prunedThrough }
  }

  async insertExpectation(n: NewExpectation): Promise<Expectation> {
    this.check()
    assertValidNewExpectation(n)
    const refKey = key(n.tenantId, n.reference)
    if (this.draft.expectationRefs.has(refKey)) {
      throw new ConstraintError(
        'expectation_reference_unique',
        `reference ${JSON.stringify(n.reference)} already exists in this tenant`,
      )
    }
    let muxedId: bigint | null
    if (n.muxedId === 'issue') {
      let max = 0n
      for (const e of this.draft.expectations.values()) {
        if (e.tenantId === n.tenantId && e.account === n.account && e.muxedId !== null && e.muxedId > max) max = e.muxedId
      }
      muxedId = issueMuxedId(max)
    } else {
      muxedId = n.muxedId ?? null
    }
    if (muxedId !== null) {
      for (const e of this.draft.expectations.values()) {
        if (e.tenantId === n.tenantId && e.account === n.account && e.muxedId === muxedId) {
          throw new ConstraintError(
            'expectation_muxed_id_unique',
            `muxed id ${muxedId.toString()} is already used on account ${n.account}`,
          )
        }
      }
    }
    // Resolve fingerprintSuffix under the transaction's draft state.
    let fingerprintSuffix: bigint | null = null
    if (n.fingerprintSuffix === 'allocate') {
      const taken = new Set<bigint>()
      for (const e of this.draft.expectations.values()) {
        if (e.tenantId === n.tenantId && e.account === n.account &&
            e.amount.asset === n.amount.asset && e.status === 'open' &&
            e.fingerprintSuffix !== null) {
          taken.add(e.fingerprintSuffix)
        }
      }
      let candidate = 1n
      while (taken.has(candidate)) candidate++
      fingerprintSuffix = candidate
    } else if (n.fingerprintSuffix != null) {
      // Check uniqueness among open expectations on the same (account, asset).
      for (const e of this.draft.expectations.values()) {
        if (e.tenantId === n.tenantId && e.account === n.account &&
            e.amount.asset === n.amount.asset && e.status === 'open' &&
            e.fingerprintSuffix === n.fingerprintSuffix) {
          throw new ConstraintError(
            'expectation_fingerprint_unique',
            `fingerprint suffix ${n.fingerprintSuffix.toString()} is already in use on account ${n.account} / asset ${n.amount.asset}`,
          )
        }
      }
      fingerprintSuffix = n.fingerprintSuffix
    }
    const now = this.now()
    const expectation: Expectation = Object.freeze({
      id: this.ids(),
      tenantId: n.tenantId,
      seq: ++this.draft.seq,
      reference: n.reference,
      account: n.account,
      direction: n.direction ?? 'credit',
      amount: n.amount,
      muxedId,
      memo: n.memo == null ? null : Object.freeze(storedMemo(n.memo)),
      payers: Object.freeze([...(n.payers ?? [])]),
      dueAt: n.dueAt == null ? null : copyDate(n.dueAt),
      expiresAt: n.expiresAt == null ? null : copyDate(n.expiresAt),
      status: 'open',
      cancelReason: null,
      metadata: Object.freeze({ ...(n.metadata ?? {}) }),
      fingerprintSuffix,
      createdAt: now,
      updatedAt: now,
    })
    this.draft.expectations.set(expectation.id, expectation)
    this.draft.expectationRefs.set(refKey, expectation.id)
    addReferenceKeys(this.draft, expectation)
    return expectation
  }

  async cancelExpectation(tenantId: string, id: string, reason: string): Promise<Expectation> {
    this.check()
    const e = this.expectation(tenantId, id)
    checkCancel(e, reason)
    const next: Expectation = Object.freeze({
      ...e,
      status: 'cancelled',
      cancelReason: reason,
      updatedAt: this.now(),
    })
    this.draft.expectations.set(id, next)
    this.emit(expectationChanged(next, null))
    return next
  }

  async amendExpectation(tenantId: string, id: string, changes: ExpectationChanges, reason: string): Promise<Expectation> {
    this.check()
    const e = this.expectation(tenantId, id)
    const allocations = this.allocationsOf('expectationId', e.id)
    let muxedIdTaken = false
    if (changes.muxedId !== undefined && changes.muxedId !== e.muxedId && changes.muxedId !== null) {
      for (const other of this.draft.expectations.values()) {
        if (other.id !== e.id && other.tenantId === tenantId && other.account === e.account && other.muxedId === changes.muxedId) {
          muxedIdTaken = true
          break
        }
      }
    }
    const next = amendExpectationRecord(e, allocations, changes, reason, this.now(), muxedIdTaken)
    this.draft.expectations.set(id, next)
    removeReferenceKeys(this.draft, e)
    addReferenceKeys(this.draft, next)
    this.emit(expectationAmended(next, e, reason))
    return next
  }

  async allocate(n: NewAllocation): Promise<Allocation> {
    this.check()
    assertValidNewAllocation(n)
    const m = this.movement(n.tenantId, n.movementId)
    const e = this.expectation(n.tenantId, n.expectationId)

    const status = checkAllocation(
      n,
      m,
      e,
      this.allocationsOf('movementId', m.id),
      this.allocationsOf('expectationId', e.id),
      refundCoverage(m, await this.listRefundLinks({tenantId:n.tenantId,movementIds:[m.id]})),
    )

    const now = this.now()
    const allocation: Allocation = Object.freeze({
      id: this.ids(),
      tenantId: n.tenantId,
      movementId: m.id,
      expectationId: e.id,
      amount: n.amount,
      strategy: n.strategy,
      score: n.score ?? null,
      createdAt: now,
    })
    this.draft.allocations.set(allocation.id, allocation)
    const updated: Expectation = Object.freeze({ ...e, status, updatedAt: now })
    this.draft.expectations.set(e.id, updated)
    if (status !== e.status) this.emit(expectationChanged(updated, allocation))
    return allocation
  }

  async postJournalEntry(n: NewJournalEntry): Promise<JournalEntry> {
    this.check()
    assertValidNewJournalEntry(n)
    const period = await this.lockJournalPeriod(n.tenantId)
    const movement = n.movementId == null ? null : this.movement(n.tenantId, n.movementId)
    const existing = movement === null ? [] : await this.listJournalEntries({ tenantId: n.tenantId, movementId: movement.id })
    const now = this.now()
    const entryToPost = { ...n, effectiveAt: n.effectiveAt ?? now }
    checkJournalEntry(entryToPost, movement, existing, period?.through ?? null)
    for (const line of n.lines) {
      if (line.expectationId != null) this.expectation(n.tenantId, line.expectationId)
      if (line.exceptionId != null) {
        const x = this.draft.exceptions.get(line.exceptionId)
        if (x === undefined || x.tenantId !== n.tenantId) throw new NotFoundError('exception', line.exceptionId)
      }
    }
    const entry: JournalEntry = Object.freeze({
      id: this.ids(),
      tenantId: n.tenantId,
      seq: ++this.draft.journalSeq,
      movementId: movement?.id ?? null,
      postingNo: n.postingNo ?? null,
      kind: n.kind,
      effectiveAt: copyDate(entryToPost.effectiveAt),
      postedAt: now,
      description: n.description,
      lines: Object.freeze(
        n.lines.map((l) =>
          Object.freeze({
            account: l.account,
            entityId: l.entityId ?? movement?.entityId ?? null,
            role: l.role,
            side: l.side,
            amount: l.amount,
            expectationId: l.expectationId ?? null,
            exceptionId: l.exceptionId ?? null,
          }),
        ),
      ),
    })
    this.draft.journal.set(entry.id, entry)
    if (movement !== null) {
      this.draft.journalByMovement.set(movement.id, [...(this.draft.journalByMovement.get(movement.id) ?? []), entry.id])
    }
    return entry
  }

  async openException(n: NewException): Promise<ExceptionRecord> {
    this.check()
    assertValidNewException(n)
    if (n.movementId != null) this.movement(n.tenantId, n.movementId)
    if (n.expectationId != null) this.expectation(n.tenantId, n.expectationId)
    const record: ExceptionRecord = Object.freeze({
      id: this.ids(),
      tenantId: n.tenantId,
      seq: ++this.draft.seq,
      code: n.code,
      status: 'open',
      movementId: n.movementId ?? null,
      expectationId: n.expectationId ?? null,
      account: n.account ?? null,
      amount: n.amount ?? null,
      detail: n.detail,
      evidence: n.evidence ?? null,
      openedAt: this.now(),
      resolvedAt: null,
      resolutionNote: null,
    })
    this.draft.exceptions.set(record.id, record)
    this.emit(exceptionChanged(record))
    return record
  }

  async resolveException(tenantId: string, id: string, resolution: Resolution): Promise<ExceptionRecord> {
    this.check()
    const e = this.draft.exceptions.get(id)
    if (e === undefined || e.tenantId !== tenantId) throw new NotFoundError('exception', id)
    checkResolution(e, resolution)
    const next: ExceptionRecord = Object.freeze({
      ...e,
      status: resolution.status,
      resolvedAt: this.now(),
      resolutionNote: resolution.note,
    })
    this.draft.exceptions.set(id, next)
    this.emit(exceptionChanged(next))
    return next
  }

  async postAccrualExpectation(expectationId: string, tenantId: string, direction: Direction, amount: Money, reference: string): Promise<void> {
    await postAccrual(this, expectationId, tenantId, direction, amount, reference)
  }

  async linkRefund(tenantId: string, creditMovementId: string, refundMovementId: string): Promise<RefundLink> {
    this.check()
    const [existing] = await this.listRefundLinks({tenantId,refundMovementId})
    if (existing) {
      if (existing.creditMovementId !== creditMovementId) throw new ConstraintError('refund_invalid','refund already linked to another credit')
      return existing
    }
    const parts = await refundParts(this,tenantId,creditMovementId,refundMovementId)
    const link = Object.freeze({id:this.ids(),...parts,createdAt:this.now()})
    this.draft.refunds.set(link.id,link)
    return link
  }

  async insertValuations(batch: readonly NewMovementValuation[]): Promise<void> {
    this.check()
    const now = this.now()
    for (const n of batch) {
      this.movement(n.tenantId, n.movementId)
      const k = `${n.tenantId}:${n.movementId}`
      if (this.draft.valuations.has(k)) continue
      const v: MovementValuation = Object.freeze({
        movementId: n.movementId,
        tenantId: n.tenantId,
        reportingAsset: n.reportingAsset,
        priceNumerator: n.priceNumerator,
        priceDenominator: n.priceDenominator,
        priceSource: n.priceSource,
        priceTimestamp: copyDate(n.priceTimestamp),
        value: n.value,
        valuedAt: n.valuedAt ? copyDate(n.valuedAt) : now,
      })
      this.draft.valuations.set(k, v)
    }
  }
}

export class MemoryStore extends MemoryReader implements Store {
  private committed: State = emptyState()
  private tail: Promise<unknown> = Promise.resolve()
  private readonly ids: () => string
  private readonly now: () => Date

  constructor(options: MemoryStoreOptions = {}) {
    super()
    this.ids = options.ids ?? (() => globalThis.crypto.randomUUID())
    this.now = options.now ?? (() => new Date())
  }

  async postAccrualExpectation(expectationId: string, tenantId: string, direction: Direction, amount: Money, reference: string): Promise<void> {
    await this.transaction(tx => tx.postAccrualExpectation(expectationId, tenantId, direction, amount, reference))
  }

  private readonly exportMarks = new Map<string, ExportBatch>()

  async exportGetMark(tenantId: string, destination: string): Promise<string | null> {
    const mark = this.exportMarks.get(key(tenantId, destination))
    return mark ? String(mark.last_seq) : null
  }

  async exportSetMark(tenantId: string, destination: string, lastSeq: number): Promise<void> {
    this.exportMarks.set(key(tenantId, destination), { destination, last_seq: lastSeq, last_exported_at: this.now().getTime(), control_totals: '{}', checksum: '' })
  }

  async exportListBatches(tenantId: string): Promise<ExportBatch[]> {
    return [...this.exportMarks.entries()].filter(([k]) => JSON.parse(k)[0] === tenantId).map(([, v]) => ({ ...v }))
  }

  protected snapshot(): State {
    return this.committed
  }

  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const tx = new MemoryTx(cloneState(this.committed), this.ids, this.now)
      try {
        const result = await fn(tx)
        this.committed = tx.draft
        return result
      } finally {
        tx.close()
      }
    })
    // The next transaction waits for this one whether it commits or not.
    this.tail = run.catch(() => undefined)
    return run
  }

  async close(): Promise<void> {}
}
