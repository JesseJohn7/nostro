/**
 * Records as plain JSON: what an API returns and a client can parse.
 *
 * `JSON.stringify` cannot take a record as it is: muxed ids and id memos
 * are bigints, which it refuses, and `Money` would come out as raw units.
 * Here every amount is an exact decimal string beside its asset
 * (`"25.0000000"`, `"native"`), every uint64 is a decimal string, and every
 * date is an ISO 8601 string. Nothing is a float, and nothing is rounded.
 * Tenant ids are left out: whoever is asking already knows which tenant.
 */
import type { RefundLink } from '../store/store.js'
import type { Schedule } from './types.js'
import type { AssetId } from '../money/index.js'
import { moneyFromJson } from '../money/money.js'
import type {
  Allocation,
  DecisionSnapshot,
  Direction,
  Disposition,
  Enrichment,
  ExceptionCode,
  ExceptionRecord,
  ExceptionStatus,
  Expectation,
  ExpectationStatus,
  JournalEntry,
  JournalEntryKind,
  Json,
  LineRole,
  Memo,
  Movement,
  MovementKind,
  Side,
} from './types.js'

export interface MemoJson {
  readonly type: Memo['type']
  /** Text as sent; an id as a decimal string; a hash as hex. */
  readonly value: string
}

export interface MovementJson {
  readonly id: string
  readonly seq: number
  readonly network: string
  readonly source: string
  readonly externalId: string
  readonly revision: number
  readonly account: string
  readonly entityId: string | null
  readonly direction: Direction
  readonly kind: MovementKind
  readonly amount: string
  readonly asset: AssetId
  readonly counterparty: string | null
  readonly muxedId: string | null
  readonly memo: MemoJson | null
  readonly ledger: number
  readonly txHash: string | null
  readonly operationId: string | null
  readonly occurredAt: string
  readonly enrichment: Enrichment
  readonly disposition: Disposition
  readonly ignoredReason: string | null
  readonly createdAt: string
}

export interface ExpectationJson {
  readonly id: string
  readonly seq: number
  readonly reference: string
  readonly account: string
  readonly direction: Direction
  readonly amount: string
  readonly asset: AssetId
  readonly muxedId: string | null
  readonly memo: MemoJson | null
  readonly payers: readonly string[]
  readonly dueAt: string | null
  readonly expiresAt: string | null
  readonly status: ExpectationStatus
  readonly cancelReason: string | null
  readonly metadata: Readonly<Record<string, string>>
  readonly createdAt: string
  readonly updatedAt: string
}

export interface AllocationJson {
  readonly id: string
  readonly movementId: string
  readonly expectationId: string
  readonly amount: string
  readonly asset: AssetId
  readonly strategy: string
  readonly score: number | null
  /** Why the engine made this allocation; null for manual or migrated rows. */
  readonly decision: DecisionSnapshot | null
  readonly createdAt: string
}

export interface ExceptionJson {
  readonly id: string
  readonly seq: number
  readonly code: ExceptionCode
  readonly status: ExceptionStatus
  readonly movementId: string | null
  readonly expectationId: string | null
  readonly account: string | null
  readonly amount: string | null
  readonly asset: AssetId | null
  readonly detail: string
  readonly evidence: Json
  readonly openedAt: string
  readonly resolvedAt: string | null
  readonly resolutionNote: string | null
}

export interface JournalLineJson {
  readonly account: string
  readonly entityId: string | null
  readonly role: LineRole
  readonly side: Side
  readonly amount: string
  readonly asset: AssetId
  readonly expectationId: string | null
  readonly exceptionId: string | null
}

export interface JournalEntryJson {
  readonly id: string
  readonly seq: number
  readonly movementId: string | null
  readonly postingNo: number | null
  readonly kind: JournalEntryKind
  readonly effectiveAt: string
  readonly postedAt: string
  readonly description: string
  readonly lines: readonly JournalLineJson[]
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString())

export function memoJson(memo: Memo | null): MemoJson | null {
  return memo === null ? null : { type: memo.type, value: String(memo.value) }
}

export function movementJson(m: Movement): MovementJson {
  return {
    id: m.id,
    seq: m.seq,
    network: m.network,
    source: m.source,
    externalId: m.externalId,
    revision: m.revision,
    account: m.account,
    entityId: m.entityId ?? null,
    direction: m.direction,
    kind: m.kind,
    amount: m.amount.toString(),
    asset: m.amount.asset,
    counterparty: m.counterparty,
    muxedId: m.muxedId === null ? null : m.muxedId.toString(),
    memo: memoJson(m.memo),
    ledger: m.ledger,
    txHash: m.txHash,
    operationId: m.operationId,
    occurredAt: m.occurredAt.toISOString(),
    enrichment: m.enrichment,
    disposition: m.disposition,
    ignoredReason: m.ignoredReason,
    createdAt: m.createdAt.toISOString(),
  }
}

export function expectationJson(e: Expectation): ExpectationJson {
  return {
    id: e.id,
    seq: e.seq,
    reference: e.reference,
    account: e.account,
    direction: e.direction,
    amount: e.amount.toString(),
    asset: e.amount.asset,
    muxedId: e.muxedId === null ? null : e.muxedId.toString(),
    memo: memoJson(e.memo),
    payers: [...e.payers],
    dueAt: iso(e.dueAt),
    expiresAt: iso(e.expiresAt),
    status: e.status,
    cancelReason: e.cancelReason,
    metadata: { ...e.metadata },
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  }
}

export function allocationJson(a: Allocation): AllocationJson {
  return {
    id: a.id,
    movementId: a.movementId,
    expectationId: a.expectationId,
    amount: a.amount.toString(),
    asset: a.amount.asset,
    strategy: a.strategy,
    score: a.score,
    decision: a.decision ?? null,
    createdAt: a.createdAt.toISOString(),
  }
}

export function exceptionJson(x: ExceptionRecord): ExceptionJson {
  return {
    id: x.id,
    seq: x.seq,
    code: x.code,
    status: x.status,
    movementId: x.movementId,
    expectationId: x.expectationId,
    account: x.account,
    amount: x.amount === null ? null : x.amount.toString(),
    asset: x.amount === null ? null : x.amount.asset,
    detail: x.detail,
    evidence: x.evidence,
    openedAt: x.openedAt.toISOString(),
    resolvedAt: iso(x.resolvedAt),
    resolutionNote: x.resolutionNote,
  }
}

export function journalEntryJson(j: JournalEntry): JournalEntryJson {
  return {
    id: j.id,
    seq: j.seq,
    movementId: j.movementId,
    postingNo: j.postingNo,
    kind: j.kind,
    effectiveAt: j.effectiveAt.toISOString(),
    postedAt: j.postedAt.toISOString(),
    description: j.description,
    lines: j.lines.map((l) => ({
      account: l.account,
      entityId: l.entityId ?? null,
      role: l.role,
      side: l.side,
      amount: l.amount.toString(),
      asset: l.amount.asset,
      expectationId: l.expectationId,
      exceptionId: l.exceptionId,
    })),
  }
}

export interface ScheduleJson {
  id: string
  referencePattern: string
  account: string
  direction: Schedule['direction']
  amount: string
  asset: string
  memo: Schedule['memo']
  payers: readonly string[]
  cadence: Schedule['cadence']
  startAt: string
  endAt: string | null
  endedAt: string | null
  createdAt: string
  updatedAt: string
}

export function scheduleJson(s: Schedule): ScheduleJson {
  return {
    id: s.id,
    referencePattern: s.referencePattern,
    account: s.account,
    direction: s.direction,
    amount: s.amount.toString(),
    asset: s.amount.asset,
    memo: s.memo ?? null,
    payers: s.payers,
    cadence: s.cadence,
    startAt: s.startAt.toISOString(),
    endAt: iso(s.endAt),
    endedAt: iso(s.endedAt),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }
}

// ---- Parse-back: JSON wire format to domain records -----------------------

/** A memo's id value is a decimal string on the wire, a bigint in the domain. */
export function memoFromJson(j: MemoJson | null): Memo | null {
  if (j === null) return null
  switch (j.type) {
    case 'text':
      return { type: 'text', value: j.value }
    case 'id':
      return { type: 'id', value: BigInt(j.value) }
    case 'hash':
      return { type: 'hash', value: j.value }
    case 'return':
      return { type: 'return', value: j.value }
  }
}

const dateOrNull = (value: string | null): Date | null => (value === null ? null : new Date(value))

/**
 * The inverse of the `*Json` functions above. Amounts come back as exact
 * `Money`, dates as `Date`, uint64 strings as bigints. Tenant ids are absent
 * from the wire by design; a caller that knows its tenant may pass it as the
 * optional second argument.
 */
export function movementFromJson(j: MovementJson, tenantId = ''): Movement {
  return {
    id: j.id,
    tenantId,
    seq: j.seq,
    network: j.network,
    source: j.source,
    externalId: j.externalId,
    revision: j.revision,
    account: j.account,
    entityId: j.entityId ?? null,
    direction: j.direction,
    kind: j.kind,
    amount: moneyFromJson(j.amount, j.asset),
    counterparty: j.counterparty,
    muxedId: j.muxedId === null ? null : BigInt(j.muxedId),
    memo: memoFromJson(j.memo),
    ledger: j.ledger,
    txHash: j.txHash,
    operationId: j.operationId,
    occurredAt: new Date(j.occurredAt),
    enrichment: j.enrichment,
    disposition: j.disposition,
    ignoredReason: j.ignoredReason,
    createdAt: new Date(j.createdAt),
  }
}

export function expectationFromJson(j: ExpectationJson, tenantId = ''): Expectation {
  return {
    id: j.id,
    tenantId,
    seq: j.seq,
    reference: j.reference,
    account: j.account,
    direction: j.direction,
    amount: moneyFromJson(j.amount, j.asset),
    muxedId: j.muxedId === null ? null : BigInt(j.muxedId),
    memo: memoFromJson(j.memo),
    payers: [...j.payers],
    dueAt: dateOrNull(j.dueAt),
    expiresAt: dateOrNull(j.expiresAt),
    status: j.status,
    cancelReason: j.cancelReason,
    metadata: { ...j.metadata },
    fingerprintSuffix: null,
    createdAt: new Date(j.createdAt),
    updatedAt: new Date(j.updatedAt),
  }
}

export function allocationFromJson(j: AllocationJson, tenantId = ''): Allocation {
  return {
    id: j.id,
    tenantId,
    movementId: j.movementId,
    expectationId: j.expectationId,
    amount: moneyFromJson(j.amount, j.asset),
    strategy: j.strategy,
    score: j.score,
    decision: j.decision ?? null,
    createdAt: new Date(j.createdAt),
  }
}

export function exceptionFromJson(j: ExceptionJson, tenantId = ''): ExceptionRecord {
  return {
    id: j.id,
    tenantId,
    seq: j.seq,
    code: j.code,
    status: j.status,
    movementId: j.movementId,
    expectationId: j.expectationId,
    account: j.account,
    amount: j.amount === null || j.asset === null ? null : moneyFromJson(j.amount, j.asset),
    detail: j.detail,
    evidence: j.evidence,
    openedAt: new Date(j.openedAt),
    resolvedAt: dateOrNull(j.resolvedAt),
    resolutionNote: j.resolutionNote,
  }
}

export function journalEntryFromJson(j: JournalEntryJson, tenantId = ''): JournalEntry {
  return {
    id: j.id,
    tenantId,
    seq: j.seq,
    movementId: j.movementId,
    postingNo: j.postingNo,
    kind: j.kind,
    effectiveAt: new Date(j.effectiveAt),
    postedAt: new Date(j.postedAt),
    description: j.description,
    lines: j.lines.map((l) => ({
      account: l.account,
      entityId: l.entityId ?? null,
      role: l.role,
      side: l.side,
      amount: moneyFromJson(l.amount, l.asset),
      expectationId: l.expectationId,
      exceptionId: l.exceptionId,
    })),
  }
}

export function scheduleFromJson(j: ScheduleJson, tenantId = ''): Schedule {
  return {
    id: j.id,
    tenantId,
    referencePattern: j.referencePattern,
    account: j.account,
    direction: j.direction,
    amount: moneyFromJson(j.amount, j.asset as AssetId),
    memo: memoFromJson(j.memo === null ? null : { type: j.memo.type, value: String(j.memo.value) }),
    payers: [...j.payers],
    cadence: j.cadence,
    startAt: new Date(j.startAt),
    endAt: dateOrNull(j.endAt),
    endedAt: dateOrNull(j.endedAt),
    createdAt: new Date(j.createdAt),
    updatedAt: new Date(j.updatedAt),
  }
}

export function refundLinkJson(link: RefundLink) {
  return {id:link.id,creditMovementId:link.creditMovementId,refundMovementId:link.refundMovementId,
    asset:link.amount.asset,amount:link.amount.toString(),residualAmount:link.residualAmount.toString(),createdAt:link.createdAt.toISOString()}
}
