/**
 * A hand-written client for the nostro HTTP API. One method per OpenAPI
 * `operationId`, with the same camelCase name. Fetch is injected (or the
 * runtime's global `fetch` is used), so this module has no Node imports and
 * runs in browsers, workers and Node alike.
 *
 * The API key is sent only in an `Authorization: Bearer` header: never in a
 * URL, and never in an error message or stack.
 */
import { ApiError } from './error.js'
import { pageIterable, type Page, type PageIterable } from './page.js'
import type {
  AccountLedgerParams,
  AccountLedgerReport,
  AmendExpectationBody,
  BalanceSheetParams,
  BalanceSheetReport,
  BatchCreateResult,
  BatchResolution,
  CancelExpectationBody,
  ConsumerStatus,
  CreateExpectationBody,
  CreateScheduleBody,
  ExceptionDecision,
  ExceptionDetail,
  ExpectationDetail,
  GetExpectationByReferenceParams,
  IncomeStatementParams,
  IncomeStatementReport,
  JournalCsvParams,
  JsonObject,
  ListExceptionsParams,
  ListExpectationsParams,
  ListJournalEntriesParams,
  ListMovementsParams,
  ListSchedulesParams,
  MovementJson,
  MoveAccountBody,
  MoveAccountResult,
  MovementDetail,
  OpenApiDocument,
  PagingParams,
  PostJournalEntryBody,
  Query,
  ReplayDecisionsParams,
  ReplayWebhookBody,
  ResolveExceptionsBody,
  Resolution,
  Rewind,
  Round,
  ScheduleJson,
  ExceptionJson,
  ExpectationJson,
  JournalEntryJson,
  TrialBalanceParams,
  TrialBalanceReport,
  TriggerRoundBody,
  UnwatchAccountParams,
  WatchAccountBody,
  WebhookAttemptsParams,
} from './types.js'

type Fetch = typeof globalThis.fetch
type FetchInit = NonNullable<Parameters<Fetch>[1]>
type FetchResponse = Awaited<ReturnType<Fetch>>

export interface ClientOptions {
  /** The API's origin, optionally with a path prefix. */
  readonly baseUrl: string
  /** Sent as `Authorization: Bearer <apiKey>`; never placed in a URL. */
  readonly apiKey: string
  /** Defaults to `globalThis.fetch`. */
  readonly fetch?: Fetch
}

/**
 * The whole API surface; method names are the OpenAPI operationIds.
 *
 * Amounts and ids stay strings in responses: call `expectationFromJson`,
 * `movementFromJson`, `exceptionFromJson`, `allocationFromJson` or
 * `journalEntryFromJson` on a returned record to get the domain types.
 */
export interface NostroClient {
  health(): Promise<JsonObject>
  openapi(): Promise<OpenApiDocument>
  listAccounts(): PageIterable<JsonObject>
  watchAccount(body: WatchAccountBody): Promise<JsonObject>
  unwatchAccount(account: string, params?: UnwatchAccountParams): Promise<void>
  listMovements(params?: ListMovementsParams): PageIterable<MovementJson>
  /** `{ movement, allocations, exceptions, journal, refunds, decision }`. */
  getMovement(id: string): Promise<MovementDetail>
  explainMovement(id: string): Promise<JsonObject>
  replayDecisions(params?: ReplayDecisionsParams): Promise<JsonObject>
  listSchedules(params?: ListSchedulesParams): PageIterable<ScheduleJson>
  createSchedule(body: CreateScheduleBody): Promise<ScheduleJson>
  getSchedule(id: string): Promise<ScheduleJson>
  endSchedule(id: string): Promise<ScheduleJson>
  listExpectations(params?: ListExpectationsParams): PageIterable<ExpectationJson>
  createExpectation(body: CreateExpectationBody): Promise<ExpectationJson>
  batchCreateExpectations(body: readonly CreateExpectationBody[]): Promise<BatchCreateResult>
  /** `{ expectation, allocations }`; parse either record with `*FromJson`. */
  getExpectationByReference(params: GetExpectationByReferenceParams): Promise<ExpectationDetail>
  getExpectation(id: string): Promise<ExpectationDetail>
  cancelExpectation(id: string, body: CancelExpectationBody): Promise<ExpectationJson>
  amendExpectation(id: string, body: AmendExpectationBody): Promise<ExpectationJson>
  listExceptions(params?: ListExceptionsParams): PageIterable<ExceptionJson>
  getException(id: string): Promise<ExceptionDetail>
  /** A `resolutionJson`-shaped object: movement, allocations, closed, opened, journalEntry, alreadyApplied. */
  resolveException(id: string, body: ExceptionDecision): Promise<Resolution>
  /** `{ mode, applied, errors, results }` with one result per submitted decision. */
  resolveExceptions(body: ResolveExceptionsBody): Promise<BatchResolution>
  listEvents(params?: PagingParams): PageIterable<JsonObject>
  triggerRound(body?: TriggerRoundBody): Promise<Round>
  getRound(id: string): Promise<Round>
  listWebhookConsumers(): PageIterable<JsonObject>
  webhookStatus(consumer: string): Promise<ConsumerStatus>
  webhookAttempts(consumer: string, params?: WebhookAttemptsParams): PageIterable<JsonObject>
  replayWebhook(consumer: string, body: ReplayWebhookBody): Promise<Rewind>
  listJournalEntries(params?: ListJournalEntriesParams): PageIterable<JournalEntryJson>
  postManualJournalEntry(body: PostJournalEntryBody): Promise<JournalEntryJson>
  exportJournal(params?: JournalCsvParams): Promise<string>
  trialBalance(params?: TrialBalanceParams): Promise<TrialBalanceReport>
  accountLedger(params: AccountLedgerParams): Promise<AccountLedgerReport>
  balanceSheet(params?: BalanceSheetParams): Promise<BalanceSheetReport>
  incomeStatement(params?: IncomeStatementParams): Promise<IncomeStatementReport>
  moveAccount(body: MoveAccountBody): Promise<MoveAccountResult>
}

interface RequestOptions {
  readonly method: string
  readonly path: string
  readonly query?: Query
  readonly body?: unknown
  /** CSV endpoints return text, not JSON. */
  readonly text?: boolean
}

/** Normalise both `{ data, next }` pages and the schedule list's `{ items }`. */
function asPage<T>(value: unknown): Page<T> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { data: [], next: null }
  const obj = value as Record<string, unknown>
  const rows = Array.isArray(obj.data) ? obj.data : Array.isArray(obj.items) ? obj.items : []
  const next = obj.next === null || obj.next === undefined ? null : (obj.next as string | number)
  return { data: rows as T[], next }
}

/** Build an ApiError from a problem+json body without ever reading the URL. */
async function toApiError(response: FetchResponse): Promise<ApiError> {
  let problem: Record<string, unknown> = {}
  try {
    const text = await response.text()
    const parsed: unknown = text === '' ? null : JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      problem = parsed as Record<string, unknown>
    }
  } catch {
    // A missing or malformed problem document is still an API error.
  }
  return new ApiError({
    status: response.status,
    code: typeof problem.code === 'string' ? problem.code : 'http_error',
    detail: typeof problem.detail === 'string' ? problem.detail : 'The API refused the request.',
    title: typeof problem.title === 'string' ? problem.title : 'Error',
    type: typeof problem.type === 'string' ? problem.type : 'about:blank',
  })
}

class Client implements NostroClient {
  private readonly doFetch: Fetch

  constructor(private readonly options: ClientOptions) {
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  private buildUrl(path: string, query?: Query): string {
    const url = new URL(this.options.baseUrl)
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue
        if (Array.isArray(value)) {
          for (const item of value) url.searchParams.append(key, String(item))
        } else {
          url.searchParams.append(key, String(value))
        }
      }
    }
    return url.toString()
  }

  private async request<T>(options: RequestOptions): Promise<T> {
    const init: FetchInit = {
      method: options.method,
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        Accept: options.text === true ? 'text/csv' : 'application/json',
      },
    }
    if (options.body !== undefined) init.body = JSON.stringify(options.body)
    let response: FetchResponse
    try {
      response = await this.doFetch(this.buildUrl(options.path, options.query), init)
    } catch {
      // The original error can quote the URL (including userinfo) or headers.
      throw new ApiError({ status: 0, code: 'network_error', detail: 'The request could not be completed.' })
    }
    if (!response.ok) throw await toApiError(response)
    if (options.text === true) return (await response.text()) as T
    if (response.status === 204) return undefined as T
    const text = await response.text()
    if (text === '') return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new ApiError({ status: response.status, code: 'invalid_response', detail: 'The API returned a malformed response.' })
    }
  }

  private paged<T>(path: string, params: Query = {}): PageIterable<T> {
    return pageIterable<T>((query) => this.request<unknown>({ method: 'GET', path, query }).then((v) => asPage<T>(v)), params)
  }

  health(): Promise<JsonObject> {
    return this.request({ method: 'GET', path: '/v1/health' })
  }

  openapi(): Promise<OpenApiDocument> {
    return this.request({ method: 'GET', path: '/v1/openapi.json' })
  }

  listAccounts(): PageIterable<JsonObject> {
    return this.paged('/v1/accounts')
  }

  watchAccount(body: WatchAccountBody): Promise<JsonObject> {
    return this.request({ method: 'POST', path: '/v1/accounts', body })
  }

  unwatchAccount(account: string, params: UnwatchAccountParams = {}): Promise<void> {
    return this.request({ method: 'DELETE', path: `/v1/accounts/${encodeURIComponent(account)}`, query: { ...params } })
  }

  listMovements(params: ListMovementsParams = {}): PageIterable<MovementJson> {
    return this.paged('/v1/movements', { ...params })
  }

  getMovement(id: string): Promise<MovementDetail> {
    return this.request({ method: 'GET', path: `/v1/movements/${encodeURIComponent(id)}` })
  }

  explainMovement(id: string): Promise<JsonObject> {
    return this.request({ method: 'GET', path: `/v1/movements/${encodeURIComponent(id)}/explain` })
  }

  replayDecisions(params: ReplayDecisionsParams = {}): Promise<JsonObject> {
    return this.request({ method: 'GET', path: '/v1/decisions/replay', query: { ...params } })
  }

  listSchedules(params: ListSchedulesParams = {}): PageIterable<ScheduleJson> {
    return this.paged('/v1/schedules', { ...params })
  }

  createSchedule(body: CreateScheduleBody): Promise<ScheduleJson> {
    return this.request({ method: 'POST', path: '/v1/schedules', body })
  }

  getSchedule(id: string): Promise<ScheduleJson> {
    return this.request({ method: 'GET', path: `/v1/schedules/${encodeURIComponent(id)}` })
  }

  endSchedule(id: string): Promise<ScheduleJson> {
    return this.request({ method: 'POST', path: `/v1/schedules/${encodeURIComponent(id)}/end` })
  }

  listExpectations(params: ListExpectationsParams = {}): PageIterable<ExpectationJson> {
    return this.paged('/v1/expectations', { ...params })
  }

  createExpectation(body: CreateExpectationBody): Promise<ExpectationJson> {
    return this.request({ method: 'POST', path: '/v1/expectations', body })
  }

  batchCreateExpectations(body: readonly CreateExpectationBody[]): Promise<BatchCreateResult> {
    return this.request({ method: 'POST', path: '/v1/expectations/batch', body })
  }

  getExpectationByReference(params: GetExpectationByReferenceParams): Promise<ExpectationDetail> {
    return this.request({ method: 'GET', path: '/v1/expectations/by-reference', query: { ...params } })
  }

  getExpectation(id: string): Promise<ExpectationDetail> {
    return this.request({ method: 'GET', path: `/v1/expectations/${encodeURIComponent(id)}` })
  }

  cancelExpectation(id: string, body: CancelExpectationBody): Promise<ExpectationJson> {
    return this.request({ method: 'POST', path: `/v1/expectations/${encodeURIComponent(id)}/cancel`, body })
  }

  amendExpectation(id: string, body: AmendExpectationBody): Promise<ExpectationJson> {
    return this.request({ method: 'POST', path: `/v1/expectations/${encodeURIComponent(id)}/amend`, body })
  }

  listExceptions(params: ListExceptionsParams = {}): PageIterable<ExceptionJson> {
    return this.paged('/v1/exceptions', { ...params })
  }

  getException(id: string): Promise<ExceptionDetail> {
    return this.request({ method: 'GET', path: `/v1/exceptions/${encodeURIComponent(id)}` })
  }

  resolveException(id: string, body: ExceptionDecision): Promise<Resolution> {
    return this.request({ method: 'POST', path: `/v1/exceptions/${encodeURIComponent(id)}/resolve`, body })
  }

  resolveExceptions(body: ResolveExceptionsBody): Promise<BatchResolution> {
    return this.request({ method: 'POST', path: '/v1/exceptions/resolve', body })
  }

  listEvents(params: PagingParams = {}): PageIterable<JsonObject> {
    return this.paged('/v1/events', { ...params })
  }

  triggerRound(body: TriggerRoundBody = {}): Promise<Round> {
    return this.request({ method: 'POST', path: '/v1/rounds', body })
  }

  getRound(id: string): Promise<Round> {
    return this.request({ method: 'GET', path: `/v1/rounds/${encodeURIComponent(id)}` })
  }

  listWebhookConsumers(): PageIterable<JsonObject> {
    return this.paged('/v1/webhooks')
  }

  webhookStatus(consumer: string): Promise<ConsumerStatus> {
    return this.request({ method: 'GET', path: `/v1/webhooks/${encodeURIComponent(consumer)}/status` })
  }

  webhookAttempts(consumer: string, params: WebhookAttemptsParams = {}): PageIterable<JsonObject> {
    return this.paged(`/v1/webhooks/${encodeURIComponent(consumer)}/attempts`, { ...params })
  }

  replayWebhook(consumer: string, body: ReplayWebhookBody): Promise<Rewind> {
    return this.request({ method: 'POST', path: `/v1/webhooks/${encodeURIComponent(consumer)}/replay`, body })
  }

  listJournalEntries(params: ListJournalEntriesParams = {}): PageIterable<JournalEntryJson> {
    return this.paged('/v1/journal', { ...params })
  }

  postManualJournalEntry(body: PostJournalEntryBody): Promise<JournalEntryJson> {
    return this.request({ method: 'POST', path: '/v1/journal', body })
  }

  exportJournal(params: JournalCsvParams = {}): Promise<string> {
    return this.request({ method: 'GET', path: '/v1/journal.csv', query: { ...params }, text: true })
  }

  trialBalance(params: TrialBalanceParams = {}): Promise<TrialBalanceReport> {
    return this.request({ method: 'GET', path: '/v1/reports/trial-balance', query: { ...params } })
  }

  accountLedger(params: AccountLedgerParams): Promise<AccountLedgerReport> {
    return this.request({ method: 'GET', path: '/v1/reports/ledger', query: { ...params } })
  }

  balanceSheet(params: BalanceSheetParams = {}): Promise<BalanceSheetReport> {
    return this.request({ method: 'GET', path: '/v1/reports/balance-sheet', query: { ...params } })
  }

  incomeStatement(params: IncomeStatementParams = {}): Promise<IncomeStatementReport> {
    return this.request({ method: 'GET', path: '/v1/reports/income', query: { ...params } })
  }

  moveAccount(body: MoveAccountBody): Promise<MoveAccountResult> {
    return this.request({ method: 'POST', path: '/v1/chart/move', body })
  }
}

/** Create a client. The key is kept in memory and sent only as a bearer token. */
export function createClient(options: ClientOptions): NostroClient {
  if (typeof options.baseUrl !== 'string' || options.baseUrl === '') {
    throw new Error('createClient requires a baseUrl.')
  }
  if (typeof options.apiKey !== 'string' || options.apiKey === '') {
    throw new Error('createClient requires an apiKey.')
  }
  try {
    new URL(options.baseUrl)
  } catch {
    // Do not echo the input: it may carry userinfo.
    throw new Error('createClient requires an absolute baseUrl.')
  }
  return new Client(options)
}
