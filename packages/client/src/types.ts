/**
 * Request and response shapes for the client. Amounts and uint64 ids are
 * strings on the wire; the client never turns them into a `number`.
 *
 * Query parameter names are exactly the OpenAPI query parameter names, so a
 * `listMovements({ entityId: '...' })` sends `?entityId=...`.
 */
import type {
  AllocationJson,
  ExceptionJson,
  ExpectationJson,
  JournalEntryJson,
  MovementJson,
  ScheduleJson,
} from '@nostro-labs/nostro/json'

export type { AllocationJson, ExceptionJson, ExpectationJson, JournalEntryJson, MovementJson, ScheduleJson }

/** Anything a querystring can carry. Arrays are sent as repeated parameters. */
export type QueryValue = string | number | boolean | readonly (string | number)[] | undefined
export type Query = Record<string, QueryValue>

/** A JSON object returned by an endpoint that has no dedicated type yet. */
export interface JsonObject {
  readonly [key: string]: JsonValue
}
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject

export type Direction = 'credit' | 'debit'
export type Disposition = 'pending' | 'allocated' | 'partial' | 'exception' | 'ignored'
export type MovementKind = 'transfer' | 'mint' | 'burn' | 'clawback' | 'fee'
export type ExpectationStatus = 'open' | 'partially_paid' | 'settled' | 'cancelled'
export type ExceptionStatus = 'open' | 'resolved' | 'dismissed'

export interface MemoBody {
  readonly type: 'text' | 'id' | 'hash'
  readonly value: string
}

// ---- Bodies ---------------------------------------------------------------

export interface WatchAccountBody {
  readonly account: string
}

export interface UnwatchAccountParams {
  readonly force?: boolean
}

export interface CreateExpectationBody {
  readonly reference: string
  readonly account: string
  readonly amount: string
  readonly asset?: string
  readonly direction?: Direction
  readonly muxedId?: string
  readonly memo?: MemoBody
  readonly payers?: readonly string[]
  readonly dueAt?: string
  readonly expiresAt?: string
  readonly metadata?: Readonly<Record<string, string>>
}

export interface CancelExpectationBody {
  readonly reason: string
}

export interface AmendExpectationBody {
  readonly reason: string
  readonly amount?: string
  readonly muxedId?: string | null
  readonly memo?: MemoBody | null
  readonly payers?: readonly string[]
  readonly dueAt?: string | null
  readonly expiresAt?: string | null
  readonly metadata?: Readonly<Record<string, string>>
}

export type ExceptionDecision =
  | {
      readonly action: 'apply'
      readonly allocations: readonly { readonly reference: string; readonly amount?: string }[]
      readonly note: string
    }
  | { readonly action: 'ignore'; readonly note: string }
  | { readonly action: 'close'; readonly status?: 'resolved' | 'dismissed'; readonly note: string }

export interface ResolveExceptionsBody {
  readonly mode: 'atomic' | 'row'
  readonly decisions: readonly { readonly exceptionId: string; readonly decision: ExceptionDecision }[]
}

export interface CreateScheduleBody {
  readonly referencePattern: string
  readonly account: string
  readonly amount: string
  readonly asset?: string
  readonly direction?: Direction
  readonly memo?: { readonly type: 'text' | 'id' | 'hash' | 'return'; readonly value: string }
  readonly payers?: readonly string[]
  readonly cadence: { readonly kind: 'daily' } | { readonly kind: 'weekly'; readonly day: number } | { readonly kind: 'monthly'; readonly day: number }
  readonly startAt: string
  readonly endAt?: string
}

export interface PostJournalEntryBody {
  readonly description: string
  readonly reason: string
  readonly note?: string
  readonly postedBy?: string
  readonly movementId?: string
  readonly effectiveAt?: string
  readonly lines: readonly {
    readonly account: string
    readonly role: string
    readonly side: 'debit' | 'credit'
    readonly amount: string
    readonly asset?: string
  }[]
}

export interface TriggerRoundBody {
  readonly account?: string
}

export interface ReplayWebhookBody {
  readonly expectedSeq: number
  readonly toSeq: number
  readonly actor: string
}

export interface MoveAccountBody {
  readonly from: string
  readonly to: string
  readonly note?: string
  readonly effectiveAt?: string
}

// ---- Query parameters -----------------------------------------------------

/** Every list query accepts the cursor from the previous page's `next`. */
export interface PagingParams {
  readonly after?: string | number
  readonly limit?: number
}

export interface ListMovementsParams extends PagingParams {
  readonly disposition?: Disposition
  readonly account?: string
  readonly entityId?: string
  readonly txHash?: string
  readonly from?: string
  readonly to?: string
  readonly fromLedger?: number
  readonly toLedger?: number
  readonly counterparty?: string
  readonly kind?: MovementKind
}

export interface ReplayDecisionsParams {
  readonly from?: string
  readonly to?: string
  readonly threshold?: number
  readonly margin?: number
  readonly strategy?: string | readonly string[]
  readonly limit?: number
}

export interface ListSchedulesParams extends PagingParams {
  readonly activeOnly?: 'true' | 'false'
}

export interface ListExpectationsParams extends PagingParams {
  readonly status?: string
  readonly account?: string
}

export interface GetExpectationByReferenceParams {
  readonly reference: string
}

export interface ListExceptionsParams extends PagingParams {
  readonly status?: ExceptionStatus
  readonly code?: string
  readonly movementId?: string
  readonly expectationId?: string
}

export interface WebhookAttemptsParams extends PagingParams {
  readonly outcome?: 'success' | 'failure'
}

export interface ListJournalEntriesParams extends PagingParams {
  readonly from?: string
  readonly to?: string
  readonly entityId?: string
}

export interface JournalCsvParams {
  readonly from?: string
  readonly to?: string
  readonly entityId?: string
}

export interface TrialBalanceParams {
  readonly asOf?: string
  readonly entityId?: string
}

export interface AccountLedgerParams {
  readonly account: string
  readonly asset: string
  readonly from?: string
  readonly to?: string
  readonly entityId?: string
}

export interface BalanceSheetParams {
  readonly asOf?: string
  readonly entityId?: string
}

export interface IncomeStatementParams {
  readonly from?: string
  readonly to?: string
  readonly entityId?: string
}

// ---- Compound responses ---------------------------------------------------
// These are the server's wire shapes. Their records are JSON, so the CLI (or
// any caller) can turn them into domain values with the `*FromJson` helpers
// re-exported from this package.

export interface ExpectationDetail {
  readonly expectation: ExpectationJson
  readonly allocations: AllocationJson[]
}

export interface MovementDetail {
  readonly movement: MovementJson
  readonly allocations: AllocationJson[]
  readonly exceptions: ExceptionJson[]
  readonly journal: JournalEntryJson[]
  readonly refunds: JsonObject[]
  readonly decision: JsonValue | null
}

export interface ExceptionDetail {
  readonly exception: ExceptionJson
  readonly movement: MovementJson | null
  readonly expectation: ExpectationJson | null
}

export interface Resolution {
  readonly movement: MovementJson | null
  readonly allocations: AllocationJson[]
  readonly closed: ExceptionJson[]
  readonly opened: ExceptionJson | null
  readonly journalEntry: JournalEntryJson | null
  readonly alreadyApplied: boolean
}

export interface BatchResolutionResult {
  readonly index: number
  readonly exceptionId: string
  readonly result: Resolution | null
  readonly error: { readonly code: string; readonly detail: string } | null
}

export interface BatchResolution {
  readonly mode: 'atomic' | 'row'
  readonly applied: number
  readonly errors: number
  readonly results: BatchResolutionResult[]
}

/** Minimal shapes for the remaining endpoints, so callers get typed fields. */
export interface OpenApiDocument {
  readonly info: { readonly title: string; readonly version: string }
}
export interface BatchCreateResult {
  readonly data: readonly { readonly index: number; readonly reference: string | null; readonly status: string }[]
}
export interface ConsumerStatus {
  readonly tenantId: string
  readonly consumer: string
  /** The saved position: read it, then pass it as `expectedSeq` to a replay. */
  readonly position: number
  readonly latestSeq: number
  readonly lag: number
}
export interface Rewind {
  readonly fromSeq: number
  readonly toSeq: number
  readonly actor: string
}
export interface Round {
  readonly id: string
  readonly state: string
}
export interface TrialBalanceReport {
  readonly balanced: boolean
}
export interface BalanceSheetReport {
  readonly balanced: boolean
}
export interface AccountLedgerReport {
  readonly lines: readonly JsonObject[]
}
export interface IncomeStatementReport {
  readonly lines: readonly JsonObject[]
}
export interface MoveAccountResult {
  readonly moved: number
}
