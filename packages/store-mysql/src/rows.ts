import type { AccountEntity, AccountOpening, Allocation, AssetId, DecisionRecord, DecisionSnapshot, DeliveryAttempt, Entity, ExceptionRecord, Expectation, InternalTransferLink, JournalEntry, JournalLine, Json, Memo, Movement, MovementValuation, OpeningBalance, OutboxEvent, Rewind, Schedule } from '@nostro-labs/nostro'
import { Money, parseAsset } from '@nostro-labs/nostro'

export const flag = (value: unknown): boolean => value === true || value === 1 || value === '1'

export interface MovementRow {
  id: string
  seq: string
  tenant_id: string
  network: string
  source: string
  external_id: string
  revision: number
  account: string
  entity_id: string | null
  direction: Movement['direction']
  kind: Movement['kind']
  asset: string
  decimals: number
  amount: string
  counterparty: string | null
  muxed_id: string | null
  memo_type: Memo['type'] | null
  memo_value: string | null
  memo_text: Buffer | null
  ledger: string
  tx_hash: string | null
  operation_id: string | null
  occurred_at: Date
  enrichment: Movement['enrichment']
  disposition: Movement['disposition']
  ignored_reason: string | null
  created_at: Date
}

export interface EntityRow {
  id: string
  tenant_id: string
  name: string
  created_at: Date
}

export function toEntity(r: EntityRow): Entity {
  return Object.freeze({
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    createdAt: r.created_at,
  })
}

export interface AccountEntityRow {
  tenant_id: string
  network: string
  account: string
  entity_id: string
  created_at: Date
}

export function toAccountEntity(r: AccountEntityRow): AccountEntity {
  return Object.freeze({
    tenantId: r.tenant_id,
    network: r.network,
    account: r.account,
    entityId: r.entity_id,
    createdAt: r.created_at,
  })
}

export interface InternalTransferLinkRow {
  id: string
  tenant_id: string
  network: string
  tx_hash: string
  movement_a: string
  movement_b: string
  same_entity: number
  created_at: Date
}

export function toInternalTransferLink(r: InternalTransferLinkRow): InternalTransferLink {
  return Object.freeze({
    id: r.id,
    tenantId: r.tenant_id,
    network: r.network,
    txHash: r.tx_hash,
    movementIds: Object.freeze([r.movement_a, r.movement_b]) as readonly [string, string],
    sameEntity: flag(r.same_entity),
    createdAt: r.created_at,
  })
}

export interface AccountOpeningRow {
  id: string
  tenant_id: string
  network: string
  account: string
  ledger: string
  occurred_at: Date
  balances_json: string
  note: string | null
  created_at: Date
}

interface StoredOpeningBalance {
  raw: string
  asset: string
  decimals: number
  lastModifiedLedger: number | null
}

export function storedOpeningBalance(b: OpeningBalance): StoredOpeningBalance {
  return { ...b.amount.toJSON(), lastModifiedLedger: b.lastModifiedLedger }
}

export function toAccountOpening(r: AccountOpeningRow): AccountOpening {
  const balances = JSON.parse(r.balances_json) as StoredOpeningBalance[]
  return Object.freeze({
    id: r.id,
    tenantId: r.tenant_id,
    network: r.network,
    account: r.account,
    ledger: Number(r.ledger),
    occurredAt: r.occurred_at,
    balances: Object.freeze(balances.map((b) => Object.freeze({
      amount: Money.fromRaw(BigInt(b.raw), parseAsset(b.asset), b.decimals),
      lastModifiedLedger: b.lastModifiedLedger,
    }))),
    note: r.note,
    createdAt: r.created_at,
  })
}

export interface EventRow {
  seq: string
  id: string
  tenant_id: string
  type: OutboxEvent['type']
  subject_id: string
  payload: string
  created_at: Date
}

export function toEvent(r: EventRow): OutboxEvent {
  return Object.freeze({
    id: r.id,
    tenantId: r.tenant_id,
    seq: Number(r.seq),
    type: r.type,
    subjectId: r.subject_id,
    payload: JSON.parse(r.payload) as Json,
    createdAt: r.created_at,
  })
}

export interface DeliveryAttemptRow {
  seq: string
  id: string
  tenant_id: string
  consumer: string
  event_id: string
  event_seq: string
  attempt_at: Date
  http_status: number | null
  error: string | null
  duration_ms: number
  outcome: DeliveryAttempt['outcome']
}

export function toDeliveryAttempt(r: DeliveryAttemptRow): DeliveryAttempt {
  return Object.freeze({
    id: r.id,
    seq: Number(r.seq),
    tenantId: r.tenant_id,
    consumer: r.consumer,
    eventId: r.event_id,
    eventSeq: Number(r.event_seq),
    at: r.attempt_at,
    httpStatus: r.http_status,
    error: r.error,
    durationMs: r.duration_ms,
    outcome: r.outcome,
  })
}

export interface RewindRow {
  seq: string
  id: string
  tenant_id: string
  consumer: string
  from_seq: string
  to_seq: string
  actor: string
  at: Date
}

export function toRewind(r: RewindRow): Rewind {
  return Object.freeze({
    id: r.id,
    seq: Number(r.seq),
    tenantId: r.tenant_id,
    consumer: r.consumer,
    fromSeq: Number(r.from_seq),
    toSeq: Number(r.to_seq),
    actor: r.actor,
    at: r.at,
  })
}

export interface ExpectationRow {
  id: string
  tenant_id: string
  seq: string
  reference: string
  account: string
  direction: Expectation['direction']
  asset: string
  decimals: number
  amount: string
  muxed_id: string | null
  memo_type: Memo['type'] | null
  memo_value: string | null
  memo_text: Buffer | null
  payers: string
  due_at: Date | null
  expires_at: Date | null
  status: Expectation['status']
  cancel_reason: string | null
  metadata: string
  fingerprint_suffix: string | null
  created_at: Date
  updated_at: Date
}

export interface AllocationRow {
  id: string
  tenant_id: string
  movement_id: string
  expectation_id: string
  asset: string
  decimals: number
  amount: string
  strategy: string
  score: number | null
  decision: string | null
  created_at: Date
}

export interface ExceptionRow {
  id: string
  tenant_id: string
  seq: string
  code: ExceptionRecord['code']
  status: ExceptionRecord['status']
  movement_id: string | null
  expectation_id: string | null
  account: string | null
  asset: string | null
  decimals: number | null
  amount: string | null
  detail: string
  evidence: string
  opened_at: Date
  resolved_at: Date | null
  resolution_note: string | null
}

const money = (amount: string, asset: string, decimals: number): Money =>
  Money.fromRaw(BigInt(amount), parseAsset(asset), decimals)

export function memoColumns(memo: Memo | null | undefined): [string | null, string | null, Buffer | null] {
  if (memo == null) return [null, null, null]
  if (memo.type === 'text') return ['text', null, Buffer.from(memo.value, 'utf8')]
  return [memo.type, String(memo.value), null]
}

function memoOf(row: Pick<MovementRow, 'memo_type' | 'memo_value' | 'memo_text'>): Memo | null {
  switch (row.memo_type) {
    case null:
      return null
    case 'text':
      return Object.freeze({ type: 'text', value: (row.memo_text ?? Buffer.alloc(0)).toString('utf8') })
    case 'id':
      return Object.freeze({ type: 'id', value: BigInt(row.memo_value!) })
    default:
      return Object.freeze({ type: row.memo_type, value: row.memo_value! })
  }
}

export function toMovement(r: MovementRow): Movement {
  return Object.freeze({
    id: r.id,
    tenantId: r.tenant_id,
    seq: Number(r.seq),
    network: r.network,
    source: r.source,
    externalId: r.external_id,
    revision: r.revision,
    account: r.account,
    entityId: r.entity_id,
    direction: r.direction,
    kind: r.kind,
    amount: money(r.amount, r.asset, r.decimals),
    counterparty: r.counterparty,
    muxedId: r.muxed_id === null ? null : BigInt(r.muxed_id),
    memo: memoOf(r),
    ledger: Number(r.ledger),
    txHash: r.tx_hash,
    operationId: r.operation_id,
    occurredAt: r.occurred_at,
    enrichment: r.enrichment,
    disposition: r.disposition,
    ignoredReason: r.ignored_reason,
    createdAt: r.created_at,
  })
}

export function toExpectation(r: ExpectationRow): Expectation {
  return Object.freeze({
    id: r.id,
    tenantId: r.tenant_id,
    seq: Number(r.seq),
    reference: r.reference,
    account: r.account,
    direction: r.direction,
    amount: money(r.amount, r.asset, r.decimals),
    muxedId: r.muxed_id === null ? null : BigInt(r.muxed_id),
    memo: memoOf(r),
    payers: Object.freeze(JSON.parse(r.payers) as string[]),
    dueAt: r.due_at,
    expiresAt: r.expires_at,
    status: r.status,
    cancelReason: r.cancel_reason,
    metadata: Object.freeze(JSON.parse(r.metadata) as Record<string, string>),
    fingerprintSuffix: r.fingerprint_suffix === null ? null : BigInt(r.fingerprint_suffix),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  })
}

export function toAllocation(r: AllocationRow): Allocation {
  return Object.freeze({
    id: r.id,
    tenantId: r.tenant_id,
    movementId: r.movement_id,
    expectationId: r.expectation_id,
    amount: money(r.amount, r.asset, r.decimals),
    strategy: r.strategy,
    score: r.score,
    decision: r.decision == null ? null : JSON.parse(r.decision) as DecisionSnapshot,
    createdAt: r.created_at,
  })
}

export function toException(r: ExceptionRow): ExceptionRecord {
  return Object.freeze({
    id: r.id,
    tenantId: r.tenant_id,
    seq: Number(r.seq),
    code: r.code,
    status: r.status,
    movementId: r.movement_id,
    expectationId: r.expectation_id,
    account: r.account,
    amount: r.amount === null ? null : money(r.amount, r.asset!, r.decimals!),
    detail: r.detail,
    evidence: JSON.parse(r.evidence) as Json,
    openedAt: r.opened_at,
    resolvedAt: r.resolved_at,
    resolutionNote: r.resolution_note,
  })
}

export interface JournalEntryRow {
  id: string
  seq: string
  tenant_id: string
  movement_id: string | null
  posting_no: number | null
  kind: JournalEntry['kind']
  effective_at: Date
  posted_at: Date
  description: string
}

export interface JournalLineRow {
  entry_id: string
  line_no: number
  account: string
  entity_id: string | null
  role: JournalLine['role']
  side: JournalLine['side']
  asset: string
  decimals: number
  amount: string
  expectation_id: string | null
  exception_id: string | null
}

export function toJournalEntry(r: JournalEntryRow, lines: readonly JournalLineRow[]): JournalEntry {
  return Object.freeze({
    id: r.id,
    tenantId: r.tenant_id,
    seq: Number(r.seq),
    movementId: r.movement_id,
    postingNo: r.posting_no,
    kind: r.kind,
    effectiveAt: r.effective_at,
    postedAt: r.posted_at,
    description: r.description,
    lines: Object.freeze(
      lines.map((l) =>
        Object.freeze({
          account: l.account,
          entityId: l.entity_id,
          role: l.role,
          side: l.side,
          amount: money(l.amount, l.asset, l.decimals),
          expectationId: l.expectation_id,
          exceptionId: l.exception_id,
        }),
      ),
    ),
  })
}

export interface MovementValuationRow {
  movement_id: string
  tenant_id: string
  reporting_asset: string
  price_n: string
  price_d: string
  price_source: string
  price_timestamp: Date
  decimals: number
  value: string
  valued_at: Date
}

export function toValuation(r: MovementValuationRow): MovementValuation {
  return Object.freeze({
    movementId: r.movement_id,
    tenantId: r.tenant_id,
    reportingAsset: r.reporting_asset as AssetId,
    priceNumerator: BigInt(r.price_n),
    priceDenominator: BigInt(r.price_d),
    priceSource: r.price_source,
    priceTimestamp: r.price_timestamp,
    value: money(r.value, r.reporting_asset, r.decimals),
    valuedAt: r.valued_at,
  })
}

export interface DecisionRow {
  seq: string
  tenant_id: string
  movement_id: string
  decided_at: Date
  snapshot: string
}

export function toDecisionRecord(r: DecisionRow): DecisionRecord {
  return Object.freeze({
    tenantId: r.tenant_id,
    movementId: r.movement_id,
    seq: Number(r.seq),
    decidedAt: r.decided_at,
    snapshot: JSON.parse(r.snapshot) as DecisionSnapshot,
  })
}

export interface ScheduleRow {
  id: string
  tenant_id: string
  reference_pattern: string
  account: string
  direction: Schedule['direction']
  asset: string
  decimals: number
  amount: string
  memo_type: Memo['type'] | null
  memo_value: string | null
  memo_text: Buffer | null
  payers: string
  cadence: string
  start_at: Date
  end_at: Date | null
  ended_at: Date | null
  created_at: Date
  updated_at: Date
}

export function toSchedule(r: ScheduleRow): Schedule {
  return Object.freeze({
    id: r.id,
    tenantId: r.tenant_id,
    referencePattern: r.reference_pattern,
    account: r.account,
    direction: r.direction,
    amount: money(r.amount, r.asset, r.decimals),
    memo: memoOf(r),
    payers: Object.freeze(JSON.parse(r.payers) as string[]),
    cadence: JSON.parse(r.cadence) as Schedule['cadence'],
    startAt: r.start_at,
    endAt: r.end_at,
    endedAt: r.ended_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  })
}
