/**
 * The local/remote split. Commands call a small Backend interface, so the
 * decision to use the database or the HTTP API is made once, here, rather than
 * as an `if` in every command. The Backend returns domain values (Money,
 * Dates, records), which is why the two modes print identical text and JSON.
 */
import type {
  Allocation,
  ExceptionDecision,
  ExceptionRecord,
  Expectation,
  NewExpectation,
  ResolutionReport,
} from '@nostro-labs/nostro'
import {
  ConstraintError,
  NotFoundError,
  PrecisionError,
  ValidationError,
  decideException,
  decideExceptions,
  journalCsvRows,
} from '@nostro-labs/nostro'
import type { MigratableStore, Store } from '@nostro-labs/nostro'
import type { CreateExpectationBody } from '@nostro-labs/client'
import {
  allocationFromJson,
  createClient,
  exceptionFromJson,
  expectationFromJson,
  journalEntryFromJson,
  movementFromJson,
} from '@nostro-labs/client'
import type { Args } from './args.js'
import { database } from './args.js'
import { CliError, UsageError } from './errors.js'
import { stringSetting } from './config.js'
import type { Io } from './io.js'
import { assertCurrent, openStore } from './store.js'

export interface ExpectationFilter {
  readonly tenantId: string
  readonly limit: number
  readonly afterSeq?: number
  readonly status?: readonly string[]
  readonly account?: string
}

export interface ExceptionFilter {
  readonly tenantId: string
  readonly limit: number
  readonly afterSeq?: number
  readonly status?: string
  readonly code?: string
}

export interface BatchReport {
  readonly applied: number
  readonly errors: number
  readonly results: readonly {
    readonly index: number
    readonly exceptionId: string
    readonly result?: ResolutionReport
    readonly error?: { readonly code: string; readonly detail: string }
  }[]
}

export interface JournalFilter {
  readonly tenantId: string
  readonly from?: Date
  readonly to?: Date
  readonly entityId?: string
}

export interface Backend {
  readonly kind: 'local' | 'remote'
  listExpectations(filter: ExpectationFilter): Promise<readonly Expectation[]>
  listAllocations(tenantId: string, expectationId: string): Promise<readonly Allocation[]>
  createExpectation(input: NewExpectation): Promise<Expectation>
  listExceptions(filter: ExceptionFilter): Promise<readonly ExceptionRecord[]>
  resolveException(tenantId: string, exceptionId: string, decision: ExceptionDecision): Promise<ResolutionReport>
  resolveExceptions(tenantId: string, decisions: readonly { exceptionId: string; decision: ExceptionDecision }[], mode: 'atomic' | 'row'): Promise<BatchReport>
  journalCsv(filter: JournalFilter): Promise<string>
  close(): Promise<void>
}

/** Commands that can run against the API. Everything else needs the database. */
export const REMOTE_COMMANDS = new Set(['expectations', 'expect', 'exceptions', 'resolve', 'export'])

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i

export interface Remote {
  readonly url: string
  readonly key: string
}

/** --api / NOSTRO_API_URL, or undefined for local mode. The key is env-only. */
export function remote(args: Args, io: Io): Remote | undefined {
  const raw = stringSetting('api', args, io).value
  if (raw === undefined) return undefined
  const key = io.env.NOSTRO_API_KEY
  if (key === undefined || key === '') {
    throw new CliError('Remote mode needs NOSTRO_API_KEY; the key is never a flag.')
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new UsageError('--api must be a URL, not a bare host.')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new UsageError('--api must not contain credentials; put the key in NOSTRO_API_KEY.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UsageError('--api must be an http(s) URL.')
  }
  if (parsed.protocol === 'http:' && !LOOPBACK.test(parsed.hostname) && !parsed.hostname.endsWith('.localhost')) {
    throw new UsageError('http:// is only allowed for localhost; use https:// for a remote API.')
  }
  return { url: parsed.toString(), key }
}

/** Problem codes that are the caller's mistake, as in local CLI usage errors. */
const USAGE_CODES = new Set(['invalid_request', 'invalid_expectation', 'invalid_resolution', 'invalid_replay'])

/** Turn an RFC 9457 problem into a CLI error carrying its code and the right exit status. */
export function problemError(err: unknown): unknown {
  if (typeof err !== 'object' || err === null) return err
  const p = err as { code?: unknown; detail?: unknown; status?: unknown }
  if (typeof p.code !== 'string' || typeof p.status !== 'number' || typeof p.detail !== 'string') return err
  const message = `${p.code}: ${p.detail}`
  return USAGE_CODES.has(p.code) ? new UsageError(message) : new CliError(message)
}

class LocalBackend implements Backend {
  readonly kind = 'local' as const
  constructor(private readonly store: MigratableStore) {}

  listExpectations(filter: ExpectationFilter): Promise<readonly Expectation[]> {
    return this.store.listExpectations({
      tenantId: filter.tenantId,
      limit: filter.limit,
      ...(filter.afterSeq === undefined ? {} : { afterSeq: filter.afterSeq }),
      ...(filter.status === undefined ? {} : { status: filter.status as never }),
      ...(filter.account === undefined ? {} : { account: filter.account }),
    })
  }

  listAllocations(tenantId: string, expectationId: string): Promise<readonly Allocation[]> {
    return this.store.listAllocations({ tenantId, expectationId })
  }

  async createExpectation(input: NewExpectation): Promise<Expectation> {
    return this.store.transaction(async (tx) => {
      try {
        const e = await tx.insertExpectation(input)
        if (await tx.accrualGetMode(input.tenantId)) {
          await tx.postAccrualExpectation(e.id, input.tenantId, e.direction, e.amount, e.reference)
        }
        return e
      } catch (err) {
        if (err instanceof ValidationError) throw new UsageError(err.message)
        if (err instanceof ConstraintError && err.constraint === 'expectation_reference_unique') {
          throw new CliError(`${input.reference} is already recorded in this tenant; references are unique.`)
        }
        if (err instanceof ConstraintError && err.constraint === 'expectation_muxed_id_unique') {
          throw new CliError(err.message)
        }
        throw err
      }
    })
  }

  listExceptions(filter: ExceptionFilter): Promise<readonly ExceptionRecord[]> {
    return this.store.listExceptions({
      tenantId: filter.tenantId,
      limit: filter.limit,
      ...(filter.afterSeq === undefined ? {} : { afterSeq: filter.afterSeq }),
      ...(filter.status === undefined || filter.status === 'all' ? {} : { status: filter.status as never }),
      ...(filter.code === undefined ? {} : { code: filter.code as never }),
    })
  }

  async resolveException(tenantId: string, exceptionId: string, decision: ExceptionDecision): Promise<ResolutionReport> {
    try {
      return await decideException({ store: this.store, tenantId, exceptionId, decision })
    } catch (err) {
      if (err instanceof NotFoundError) throw new CliError(`No ${err.entity} ${err.id}.`)
      if (err instanceof ConstraintError) throw new CliError(err.message)
      if (err instanceof ValidationError || err instanceof PrecisionError) throw new UsageError(err.message)
      throw err
    }
  }

  async resolveExceptions(tenantId: string, decisions: readonly { exceptionId: string; decision: ExceptionDecision }[], mode: 'atomic' | 'row'): Promise<BatchReport> {
    try {
      return await decideExceptions({ store: this.store as Store, tenantId, decisions: [...decisions], mode })
    } catch (err) {
      if (err instanceof ValidationError || err instanceof PrecisionError) throw new UsageError(err.message)
      throw err
    }
  }

  async journalCsv(filter: JournalFilter): Promise<string> {
    let text = ''
    for await (const row of journalCsvRows({
      store: this.store as Store,
      tenantId: filter.tenantId,
      ...(filter.from === undefined ? {} : { from: filter.from }),
      ...(filter.to === undefined ? {} : { to: filter.to }),
      ...(filter.entityId === undefined ? {} : { entityId: filter.entityId }),
    })) {
      text += row
    }
    return text
  }

  async close(): Promise<void> {
    await this.store.close()
  }
}

class ApiBackend implements Backend {
  readonly kind = 'remote' as const
  private readonly client: ReturnType<typeof createClient>
  constructor(remoteConfig: Remote) {
    this.client = createClient({ baseUrl: remoteConfig.url, apiKey: remoteConfig.key })
  }

  /** Collect up to `limit` rows, following `next` when a page is short. */
  private async collect<T>(page: { data: T[]; next: string | number | null }, limit: number, more: (after: string | number) => Promise<{ data: T[]; next: string | number | null }>): Promise<T[]> {
    const out: T[] = []
    let cursor = page
    while (out.length < limit) {
      out.push(...cursor.data.slice(0, limit - out.length))
      if (cursor.next === null || cursor.next === undefined || out.length >= limit) break
      cursor = await more(cursor.next)
    }
    return out
  }

  async listExpectations(filter: ExpectationFilter): Promise<readonly Expectation[]> {
    const first = await this.client.listExpectations({
      limit: filter.limit,
      ...(filter.afterSeq === undefined ? {} : { after: filter.afterSeq }),
      ...(filter.status === undefined ? {} : { status: filter.status.join(',') }),
      ...(filter.account === undefined ? {} : { account: filter.account }),
    }).page()
    const rows = await this.collect(first, filter.limit, (after) => this.client.listExpectations({ limit: filter.limit, after }).page())
    return rows.map((e) => expectationFromJson(e))
  }

  async listAllocations(tenantId: string, expectationId: string): Promise<readonly Allocation[]> {
    void tenantId
    const detail = await this.client.getExpectation(expectationId)
    const allocations = (detail as { allocations?: unknown[] }).allocations ?? []
    return allocations.map((a) => allocationFromJson(a as never))
  }

  async createExpectation(input: NewExpectation): Promise<Expectation> {
    const body: CreateExpectationBody = {
      reference: input.reference,
      account: input.account,
      amount: input.amount.toString(),
      asset: input.amount.asset,
      direction: input.direction ?? 'credit',
      ...(input.muxedId === undefined || input.muxedId === null
        ? {}
        : { muxedId: input.muxedId === 'issue' ? 'issue' : input.muxedId.toString() }),
      ...(input.memo === undefined || input.memo === null
        ? {}
        : { memo: { type: input.memo.type as 'text' | 'id' | 'hash', value: String(input.memo.value) } }),
      ...(input.payers === undefined || input.payers.length === 0 ? {} : { payers: [...input.payers] }),
      ...(input.dueAt === undefined || input.dueAt === null ? {} : { dueAt: input.dueAt.toISOString() }),
      ...(input.expiresAt === undefined || input.expiresAt === null ? {} : { expiresAt: input.expiresAt.toISOString() }),
      ...(input.metadata === undefined || Object.keys(input.metadata).length === 0
        ? {}
        : { metadata: { ...input.metadata } }),
    }
    return expectationFromJson(await this.client.createExpectation(body))
  }

  async listExceptions(filter: ExceptionFilter): Promise<readonly ExceptionRecord[]> {
    const first = await this.client.listExceptions({
      limit: filter.limit,
      ...(filter.afterSeq === undefined ? {} : { after: filter.afterSeq }),
      ...(filter.status === undefined || filter.status === 'all'
        ? {}
        : { status: filter.status as 'open' | 'resolved' | 'dismissed' }),
      ...(filter.code === undefined ? {} : { code: filter.code }),
    }).page()
    const rows = await this.collect(first, filter.limit, (after) => this.client.listExceptions({ limit: filter.limit, after }).page())
    return rows.map((e) => exceptionFromJson(e))
  }

  async resolveException(tenantId: string, exceptionId: string, decision: ExceptionDecision): Promise<ResolutionReport> {
    void tenantId
    const report = await this.client.resolveException(exceptionId, decision as never)
    return resolutionFromJson(report as never)
  }

  async resolveExceptions(tenantId: string, decisions: readonly { exceptionId: string; decision: ExceptionDecision }[], mode: 'atomic' | 'row'): Promise<BatchReport> {
    void tenantId
    const report = await this.client.resolveExceptions({
      mode,
      decisions: decisions.map((d) => ({ exceptionId: d.exceptionId, decision: d.decision })),
    })
    const r = report as {
      applied: number
      errors: number
      results: readonly { index: number; exceptionId: string; result?: unknown; error?: { code: string; detail: string } }[]
    }
    return {
      applied: r.applied,
      errors: r.errors,
      results: r.results.map((row) => ({
        index: row.index,
        exceptionId: row.exceptionId,
        ...(row.result === undefined || row.result === null ? {} : { result: resolutionFromJson(row.result as never) }),
        ...(row.error === undefined || row.error === null ? {} : { error: row.error }),
      })),
    }
  }

  async journalCsv(filter: JournalFilter): Promise<string> {
    return this.client.exportJournal({
      ...(filter.from === undefined ? {} : { from: filter.from.toISOString() }),
      ...(filter.to === undefined ? {} : { to: filter.to.toISOString() }),
      ...(filter.entityId === undefined ? {} : { entityId: filter.entityId }),
    })
  }

  async close(): Promise<void> {
    // The client holds no connection.
  }
}

function resolutionFromJson(j: {
  movement?: unknown | null
  allocations?: readonly unknown[]
  closed?: readonly unknown[]
  opened?: unknown | null
  journalEntry?: unknown | null
  alreadyApplied?: boolean
}): ResolutionReport {
  return {
    movement: j.movement == null ? null : movementFromJson(j.movement as never),
    allocations: (j.allocations ?? []).map((a) => allocationFromJson(a as never)),
    closed: (j.closed ?? []).map((x) => exceptionFromJson(x as never)),
    opened: j.opened == null ? null : exceptionFromJson(j.opened as never),
    journalEntry: j.journalEntry == null ? null : journalEntryFromJson(j.journalEntry as never),
    alreadyApplied: j.alreadyApplied ?? false,
  }
}

/** Open the store, or build the API client, and close it afterwards. */
export async function withBackend<T>(args: Args, io: Io, fn: (backend: Backend) => Promise<T>): Promise<T> {
  const mode = remote(args, io)
  if (mode === undefined) {
    const opened = await openStore(database(args, io), io, { create: false }, args)
    try {
      await assertCurrent(opened)
      return await fn(new LocalBackend(opened.store))
    } finally {
      await opened.store.close()
    }
  }
  const backend = new ApiBackend(mode)
  try {
    return await fn(backend)
  } finally {
    await backend.close()
  }
}

