import { csvCell, csvRow } from '../csv.js'
import type { Money } from '../money/index.js'
import type { Memo } from '../model/index.js'
import type { Store } from '../store/index.js'
import { sumAmounts } from '../store/index.js'

export const MOVEMENT_CSV_COLUMNS = [
  'id',
  'seq',
  'external_id',
  'revision',
  'network',
  'source',
  'account',
  'entity_id',
  'direction',
  'kind',
  'amount',
  'asset',
  'counterparty',
  'muxed_id',
  'memo_type',
  'ledger',
  'tx_hash',
  'operation_id',
  'occurred_at',
  'disposition',
  'ignored_reason',
  'created_at',
] as const

export const MOVEMENT_MEMO_COLUMN = 'memo_value'

export const EXPECTATION_CSV_COLUMNS = [
  'id',
  'seq',
  'reference',
  'account',
  'direction',
  'amount',
  'asset',
  'amount_paid',
  'amount_outstanding',
  'muxed_id',
  'payers',
  'due_at',
  'expires_at',
  'status',
  'cancel_reason',
  'fingerprint_suffix',
  'metadata',
  'created_at',
  'updated_at',
] as const

export const EXCEPTION_CSV_COLUMNS = [
  'id',
  'seq',
  'code',
  'status',
  'movement_id',
  'expectation_id',
  'account',
  'amount',
  'asset',
  'detail',
  'resolution_note',
  'opened_at',
  'resolved_at',
] as const

export const ALLOCATION_CSV_COLUMNS = [
  'id',
  'movement_id',
  'expectation_id',
  'amount',
  'asset',
  'strategy',
  'score',
  'created_at',
] as const

export interface RecordCsvOptions {
  readonly store: Store
  readonly tenantId: string
  readonly from?: Date
  readonly to?: Date
  readonly pageSize?: number
}

export interface MovementCsvOptions extends RecordCsvOptions {
  readonly includeMemo?: boolean
}

type PageQuery = { readonly afterSeq?: number; readonly limit: number }

async function* seqPages<T extends { readonly seq: number }>(
  list: (query: PageQuery) => Promise<readonly T[]>,
  pageSize: number,
): AsyncGenerator<readonly T[]> {
  let afterSeq: number | undefined
  for (;;) {
    const page = await list({ limit: pageSize, ...(afterSeq === undefined ? {} : { afterSeq }) })
    if (page.length === 0) return
    yield page
    if (page.length < pageSize) return
    afterSeq = page[page.length - 1]!.seq
  }
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

function textCell(value: string | null): string {
  return csvCell(value === null ? null : value.replaceAll(CONTROL, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`), true)
}

function inRange(at: Date, options: RecordCsvOptions): boolean {
  return (options.from === undefined || at >= options.from) && (options.to === undefined || at < options.to)
}

function iso(at: Date | null): string | null {
  return at === null ? null : at.toISOString()
}

function memoType(memo: Memo | null): string | null {
  return memo === null ? null : memo.type
}

function memoValue(memo: Memo | null): string | bigint | null {
  return memo === null ? null : memo.value
}

export async function* movementCsvRows(options: MovementCsvOptions): AsyncGenerator<string> {
  const { store, tenantId } = options
  const columns: readonly string[] = options.includeMemo
    ? [...MOVEMENT_CSV_COLUMNS, MOVEMENT_MEMO_COLUMN]
    : MOVEMENT_CSV_COLUMNS
  yield csvRow(columns)

  const pageSize = options.pageSize ?? 500
  for await (const page of seqPages(
    (query) => store.listMovements({ tenantId, ...query }),
    pageSize,
  )) {
    for (const movement of page) {
      if (!inRange(movement.occurredAt, options)) continue
      const cells = [
        csvCell(movement.id),
        csvCell(movement.seq),
        csvCell(movement.externalId),
        csvCell(movement.revision),
        csvCell(movement.network),
        csvCell(movement.source),
        textCell(movement.account),
        csvCell(movement.entityId ?? null),
        csvCell(movement.direction),
        csvCell(movement.kind),
        csvCell(movement.amount.toString()),
        csvCell(movement.amount.asset),
        textCell(movement.counterparty),
        csvCell(movement.muxedId),
        csvCell(memoType(movement.memo)),
        csvCell(movement.ledger),
        csvCell(movement.txHash),
        csvCell(movement.operationId),
        csvCell(movement.occurredAt.toISOString()),
        csvCell(movement.disposition),
        textCell(movement.ignoredReason),
        csvCell(movement.createdAt.toISOString()),
      ]
      if (options.includeMemo) {
        const value = memoValue(movement.memo)
        cells.push(typeof value === 'string' ? textCell(value) : csvCell(value))
      }
      yield csvRow(cells)
    }
  }
}

export async function* expectationCsvRows(options: RecordCsvOptions): AsyncGenerator<string> {
  const { store, tenantId } = options
  yield csvRow(EXPECTATION_CSV_COLUMNS)

  const pageSize = options.pageSize ?? 500
  for await (const page of seqPages(
    (query) => store.listExpectations({ tenantId, ...query }),
    pageSize,
  )) {
    const inWindow = page.filter((expectation) => inRange(expectation.createdAt, options))
    const allocations = await store.listAllocations({
      tenantId,
      expectationIds: inWindow.map((expectation) => expectation.id),
    })
    const amounts = new Map<string, Money[]>()
    for (const allocation of allocations) {
      const list = amounts.get(allocation.expectationId) ?? []
      list.push(allocation.amount)
      amounts.set(allocation.expectationId, list)
    }
    for (const expectation of inWindow) {
      const paid = sumAmounts(amounts.get(expectation.id) ?? [], expectation.amount)
      const outstanding = expectation.amount.subtract(paid)
      yield csvRow([
        csvCell(expectation.id),
        csvCell(expectation.seq),
        textCell(expectation.reference),
        textCell(expectation.account),
        csvCell(expectation.direction),
        csvCell(expectation.amount.toString()),
        csvCell(expectation.amount.asset),
        csvCell(paid.toString()),
        csvCell(outstanding.toString()),
        csvCell(expectation.muxedId),
        csvCell(JSON.stringify(expectation.payers), true),
        csvCell(iso(expectation.dueAt)),
        csvCell(iso(expectation.expiresAt)),
        csvCell(expectation.status),
        textCell(expectation.cancelReason),
        csvCell(expectation.fingerprintSuffix),
        csvCell(JSON.stringify(expectation.metadata), true),
        csvCell(expectation.createdAt.toISOString()),
        csvCell(expectation.updatedAt.toISOString()),
      ])
    }
  }
}

export async function* exceptionCsvRows(options: RecordCsvOptions): AsyncGenerator<string> {
  const { store, tenantId } = options
  yield csvRow(EXCEPTION_CSV_COLUMNS)

  const pageSize = options.pageSize ?? 500
  for await (const page of seqPages(
    (query) => store.listExceptions({ tenantId, ...query }),
    pageSize,
  )) {
    for (const exception of page) {
      if (!inRange(exception.openedAt, options)) continue
      yield csvRow([
        csvCell(exception.id),
        csvCell(exception.seq),
        csvCell(exception.code),
        csvCell(exception.status),
        csvCell(exception.movementId),
        csvCell(exception.expectationId),
        textCell(exception.account),
        csvCell(exception.amount === null ? null : exception.amount.toString()),
        csvCell(exception.amount === null ? null : exception.amount.asset),
        textCell(exception.detail),
        textCell(exception.resolutionNote),
        csvCell(exception.openedAt.toISOString()),
        csvCell(iso(exception.resolvedAt)),
      ])
    }
  }
}

export async function* allocationCsvRows(options: RecordCsvOptions): AsyncGenerator<string> {
  const { store, tenantId } = options
  yield csvRow(ALLOCATION_CSV_COLUMNS)

  const allocations = await store.listAllocations({ tenantId })
  for (const allocation of allocations) {
    if (!inRange(allocation.createdAt, options)) continue
    yield csvRow([
      csvCell(allocation.id),
      csvCell(allocation.movementId),
      csvCell(allocation.expectationId),
      csvCell(allocation.amount.toString()),
      csvCell(allocation.amount.asset),
      csvCell(allocation.strategy),
      csvCell(allocation.score),
      csvCell(allocation.createdAt.toISOString()),
    ])
  }
}
