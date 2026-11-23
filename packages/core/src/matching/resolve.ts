/**
 * What a person decides about a movement nostro would not decide alone.
 *
 * Closing an exception on its own can leave a movement's disposition with
 * nothing to support it (I1), so these move the movement, its exceptions and
 * the journal together, in one transaction:
 *
 * - `applyMovement`: this payment was for these expectations. Allocates by
 *   hand; anything left over stays open, for a person, under an exception
 *   for exactly what is left.
 * - `ignoreMovement`: this is not something to reconcile, for this reason.
 *   Part of a movement already allocated stays allocated; the rest of it
 *   leaves the exceptions queue for uncategorized income or expense.
 * - `closeException`: for an exception no movement depends on.
 *
 * The store's rules still apply to a person: a lookalike asset cannot settle
 * an invoice, money on one account cannot settle an invoice on another, nothing
 * can be over-allocated, and a cancelled invoice cannot be paid. An invoice
 * past its expiry can, because deciding that is what the person is here for. The movement is re-read under its lock, so two people
 * acting at once cannot both decide it.
 */
import type { PostOptions } from '../journal/index.js'
import { postMovement } from '../journal/index.js'
import type { Allocation, ExceptionCode, ExceptionRecord, JournalEntry, Movement } from '../model/index.js'
import { ValidationError, allocationJson, exceptionJson, journalEntryJson, movementJson } from '../model/index.js'
import { Money, PrecisionError } from '../money/index.js'
import type { Store, StoreTx } from '../store/index.js'
import { ConstraintError, NotFoundError, sumAmounts } from '../store/index.js'

export interface ResolutionReport {
  /** The movement as it now is; `null` for an exception about no movement. */
  readonly movement: Movement | null
  /** What this resolution allocated. */
  readonly allocations: readonly Allocation[]
  /** Exceptions this resolution closed. */
  readonly closed: readonly ExceptionRecord[]
  /** The exception now covering what is left, if anything is. */
  readonly opened: ExceptionRecord | null
  /** The adjustment posted, if the books needed one. */
  readonly journalEntry: JournalEntry | null
  /** True when a retried row was already in the requested state. */
  readonly alreadyApplied?: boolean
}

/** A resolution that acted on a movement, which it always has when it was asked to. */
export interface MovementResolution extends ResolutionReport {
  readonly movement: Movement
}

interface ResolveOptions extends PostOptions {
  readonly store: Store
  readonly tenantId: string
  readonly movementId: string
}

export interface ApplyOptions extends ResolveOptions {
  /** Where the money goes. Without an amount: as much as is left of the movement and still owing. */
  readonly allocations: readonly { readonly expectationId: string; readonly amount?: Money }[]
  /** Why; kept with the exceptions this closes. */
  readonly note: string
}

export interface IgnoreOptions extends ResolveOptions {
  /** Why; kept on the movement and the exceptions this closes. */
  readonly reason: string
}

function required(field: string, value: unknown): void {
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(field, 'must be a non-empty string')
}

/** The movement, under its lock, if a person still has something to decide about it. */
async function undecided(tx: StoreTx, tenantId: string, id: string): Promise<Movement> {
  const movement = await tx.getMovement(tenantId, id)
  if (movement === null) throw new NotFoundError('movement', id)
  if (movement.disposition !== 'exception' && movement.disposition !== 'partial') {
    throw new ConstraintError('movement_not_open', `movement ${id} is ${movement.disposition}; there is nothing to decide about it`)
  }
  return movement
}

/** Codes under which what is left is owed back to a known payer, as opposed to unexplained. */
const OWED_BACK: readonly ExceptionCode[] = ['OVERPAYMENT', 'DUPLICATE_PAYMENT']

async function applyMovementTx(tx: StoreTx, options: Omit<ApplyOptions, 'store'>): Promise<MovementResolution> {
  const { tenantId, movementId, note } = options
  required('note', note)
  if (options.allocations.length === 0) throw new ValidationError('allocations', 'name at least one expectation')
  const movement = await undecided(tx, tenantId, movementId)
  const already = await tx.listAllocations({ tenantId, movementId })
  let left = movement.amount.subtract(sumAmounts(already.map((a) => a.amount), movement.amount))

  const allocations: Allocation[] = []
  for (const { expectationId, amount } of options.allocations) {
    const expectation = await tx.getExpectation(tenantId, expectationId)
    if (expectation === null) throw new NotFoundError('expectation', expectationId)
    let applying = amount
    if (applying === undefined) {
      if (expectation.amount.asset !== left.asset || expectation.amount.decimals !== left.decimals) {
        throw new ConstraintError('allocation_asset', `the movement is in ${left.asset} but ${expectation.reference} is owed in ${expectation.amount.asset}`)
      }
      const paid = await tx.listAllocations({ tenantId, expectationId })
      const owing = expectation.amount.subtract(sumAmounts(paid.map((a) => a.amount), expectation.amount))
      applying = left.compare(owing) < 0 ? left : owing
      if (!owing.isPositive()) throw new ConstraintError('allocation_over_expectation', `nothing is left owing on ${expectation.reference}`)
      if (!left.isPositive()) throw new ConstraintError('allocation_over_movement', `nothing is left of movement ${movementId}`)
    }
    allocations.push(
      await tx.allocate({ tenantId, movementId, expectationId, amount: applying, strategy: 'manual', score: null }),
    )
    left = left.subtract(applying)
  }

  const open = await tx.listExceptions({ tenantId, movementId, status: 'open' })
  const closed: ExceptionRecord[] = []
  for (const x of open) closed.push(await tx.resolveException(tenantId, x.id, { status: 'resolved', note }))

  let opened: ExceptionRecord | null = null
  if (left.isPositive()) {
    const owedBack = open.find((x) => OWED_BACK.includes(x.code))
    opened = await tx.openException({
      tenantId,
      code: owedBack?.code ?? 'PARTIAL_UNRESOLVED',
      movementId,
      account: movement.account,
      amount: left,
      detail: `Applied by hand, with ${left.toString()} of ${movement.amount.toString()} left to explain.`,
      evidence: { note },
    })
  }
  const next = await tx.setDisposition(tenantId, movementId, left.isPositive() ? 'partial' : 'allocated')
  return { movement: next, allocations, closed, opened, journalEntry: await postMovement(tx, tenantId, movementId, options) }
}

export async function applyMovement(options: ApplyOptions): Promise<MovementResolution> {
  const { store, ...rest } = options
  return store.transaction((tx) => applyMovementTx(tx, rest))
}

async function ignoreMovementTx(tx: StoreTx, options: Omit<IgnoreOptions, 'store'>): Promise<MovementResolution> {
  const { tenantId, movementId, reason } = options
  required('reason', reason)
  await undecided(tx, tenantId, movementId)
  const closed: ExceptionRecord[] = []
  for (const x of await tx.listExceptions({ tenantId, movementId, status: 'open' })) {
    closed.push(await tx.resolveException(tenantId, x.id, { status: 'dismissed', note: reason }))
  }
  const next = await tx.setDisposition(tenantId, movementId, 'ignored', reason)
  return { movement: next, allocations: [], closed, opened: null, journalEntry: await postMovement(tx, tenantId, movementId, options) }
}

export async function ignoreMovement(options: IgnoreOptions): Promise<MovementResolution> {
  const { store, ...rest } = options
  return store.transaction((tx) => ignoreMovementTx(tx, rest))
}

export interface CloseOptions {
  readonly store: Store
  readonly tenantId: string
  readonly exceptionId: string
  readonly status: 'resolved' | 'dismissed'
  readonly note: string
}

/**
 * Close an exception a movement does not depend on: one about an expectation
 * or an account, or a further one on a movement something else explains.
 * Refuses the last open exception of an undecided movement, which needs
 * `applyMovement` or `ignoreMovement`.
 */
async function closeExceptionTx(tx: StoreTx, options: Omit<CloseOptions, 'store'>): Promise<ExceptionRecord> {
  const { tenantId, exceptionId, status, note } = options
  required('note', note)
  const exception = await tx.getException(tenantId, exceptionId)
  if (exception === null) throw new NotFoundError('exception', exceptionId)
  if (exception.movementId !== null) {
    const movement = await tx.getMovement(tenantId, exception.movementId)
    const undecidedMovement = movement!.disposition === 'exception' || movement!.disposition === 'partial'
    const open = await tx.listExceptions({ tenantId, movementId: exception.movementId, status: 'open' })
    if (undecidedMovement && !open.some((x) => x.id !== exceptionId)) {
      throw new ConstraintError(
        'disposition_unsupported',
        `movement ${exception.movementId} depends on exception ${exceptionId}: apply the movement or ignore it instead`,
      )
    }
  }
  return tx.resolveException(tenantId, exceptionId, { status, note })
}

export async function closeException(options: CloseOptions): Promise<ExceptionRecord> {
  const { store, ...rest } = options
  return store.transaction((tx) => closeExceptionTx(tx, rest))
}

/** A person's decision about an exception, in the terms they know it by. */
export type ExceptionDecision =
  /** The exception's movement was for these expectations, by reference; amounts are decimal strings. */
  | { readonly action: 'apply'; readonly allocations: readonly { readonly reference: string; readonly amount?: string }[]; readonly note: string }
  /** The exception's movement is not something to reconcile. */
  | { readonly action: 'ignore'; readonly note: string }
  /** The exception itself is dealt with; refused if an undecided movement depends on it. */
  | { readonly action: 'close'; readonly status?: 'resolved' | 'dismissed'; readonly note: string }

export interface DecideExceptionOptions extends PostOptions {
  readonly store: Store
  readonly tenantId: string
  readonly exceptionId: string
  readonly decision: ExceptionDecision
}

async function decideExceptionTx(tx: StoreTx, options: Omit<DecideExceptionOptions, 'store'>): Promise<ResolutionReport> {
  const { tenantId, exceptionId, decision } = options
  const exception = await tx.getException(tenantId, exceptionId)
  if (exception === null) throw new NotFoundError('exception', exceptionId)

  if (decision.action === 'close') {
    const closed = await closeExceptionTx(tx, { tenantId, exceptionId, status: decision.status ?? 'resolved', note: decision.note })
    const movement = closed.movementId === null ? null : await tx.getMovement(tenantId, closed.movementId)
    return { movement, allocations: [], closed: [closed], opened: null, journalEntry: null }
  }

  const movementId = exception.movementId
  if (movementId === null) throw new ValidationError('action', 'this exception is about no movement: close it instead')
  const shared = { tenantId, movementId, ...(options.chart === undefined ? {} : { chart: options.chart }) }
  if (decision.action === 'ignore') return ignoreMovementTx(tx, { ...shared, reason: decision.note })

  const movement = await tx.getMovement(tenantId, movementId)
  const allocations = []
  for (const { reference, amount } of decision.allocations) {
    const expectation = await tx.getExpectationByReference(tenantId, reference)
    if (expectation === null) throw new NotFoundError('expectation', reference)
    allocations.push({
      expectationId: expectation.id,
      ...(amount === undefined ? {} : { amount: Money.parse(amount, movement!.amount.asset, movement!.amount.decimals) }),
    })
  }
  return applyMovementTx(tx, { ...shared, allocations, note: decision.note })
}

/** Act on an exception: what the HTTP API and the command line both call. */
export async function decideException(options: DecideExceptionOptions): Promise<ResolutionReport> {
  const { store, ...rest } = options
  return store.transaction((tx) => decideExceptionTx(tx, rest))
}

/** A resolution as plain JSON, like every other record. */
export function resolutionJson(report: ResolutionReport) {
  return {
    movement: report.movement === null ? null : movementJson(report.movement),
    allocations: report.allocations.map(allocationJson),
    closed: report.closed.map(exceptionJson),
    opened: report.opened === null ? null : exceptionJson(report.opened),
    journalEntry: report.journalEntry === null ? null : journalEntryJson(report.journalEntry),
    alreadyApplied: report.alreadyApplied ?? false,
  }
}

export type BatchResolveMode = 'atomic' | 'row'

export interface BatchDecisionItem {
  readonly exceptionId: string
  readonly decision: ExceptionDecision
}

export interface BatchResolveResult {
  readonly index: number
  readonly exceptionId: string
  readonly result?: ResolutionReport
  readonly error?: { readonly code: string; readonly detail: string }
}

export interface BatchResolveReport {
  readonly mode: BatchResolveMode
  readonly applied: number
  readonly errors: number
  readonly results: readonly BatchResolveResult[]
}

export const BATCH_DECISION_LIMIT = 200

function asBatchError(err: unknown): { code: string; detail: string } {
  if (err instanceof NotFoundError) return { code: 'not_found', detail: `No ${err.entity} ${err.id}.` }
  if (err instanceof ConstraintError) return { code: 'resolution_refused', detail: err.message }
  if (err instanceof ValidationError || err instanceof PrecisionError) return { code: 'invalid_resolution', detail: err.message }
  if (err instanceof Error) return { code: 'invalid_resolution', detail: err.message }
  return { code: 'invalid_resolution', detail: 'unknown error' }
}

async function alreadyAppliedReport(store: Store, tenantId: string, item: BatchDecisionItem): Promise<ResolutionReport | null> {
  const exception = await store.getException(tenantId, item.exceptionId)
  if (exception === null) throw new NotFoundError('exception', item.exceptionId)
  const d = item.decision
  if (d.action === 'close') {
    const wanted = d.status ?? 'resolved'
    if (exception.status === wanted) {
      const movement = exception.movementId === null ? null : await store.getMovement(tenantId, exception.movementId)
      return { movement, allocations: [], closed: [exception], opened: null, journalEntry: null, alreadyApplied: true }
    }
    return null
  }
  if (exception.movementId === null) return null
  const movement = await store.getMovement(tenantId, exception.movementId)
  if (movement === null) return null
  if (d.action === 'ignore') {
    if (movement.disposition === 'ignored' && exception.status === 'dismissed') {
      return { movement, allocations: [], closed: [exception], opened: null, journalEntry: null, alreadyApplied: true }
    }
    return null
  }
  if (movement.disposition === 'exception' || movement.disposition === 'partial') return null
  const allocations = await store.listAllocations({ tenantId, movementId: movement.id })
  for (const a of d.allocations) {
    const expectation = await store.getExpectationByReference(tenantId, a.reference)
    if (expectation === null) return null
    const has = allocations.some((x) => x.expectationId === expectation.id)
    if (!has) return null
  }
  const closed = exception.status === 'resolved' ? [exception] : []
  return { movement, allocations, closed, opened: null, journalEntry: null, alreadyApplied: true }
}

async function decideOne(store: Store, options: Omit<DecideExceptionOptions, 'exceptionId' | 'decision'> & { item: BatchDecisionItem }): Promise<ResolutionReport> {
  const existing = await alreadyAppliedReport(store, options.tenantId, options.item)
  if (existing !== null) return existing
  return decideException({ ...options, exceptionId: options.item.exceptionId, decision: options.item.decision })
}

export async function decideExceptions(options: {
  readonly store: Store
  readonly tenantId: string
  readonly decisions: readonly BatchDecisionItem[]
  readonly mode: BatchResolveMode
  readonly chart?: DecideExceptionOptions['chart']
}): Promise<BatchResolveReport> {
  const { store, tenantId, decisions, mode } = options
  if (decisions.length === 0) throw new ValidationError('decisions', 'must not be empty')
  if (decisions.length > BATCH_DECISION_LIMIT) {
    throw new ValidationError('decisions', `must not exceed ${BATCH_DECISION_LIMIT} rows`)
  }

  if (mode === 'atomic') {
    const results: BatchResolveResult[] = []
    try {
      await store.transaction(async (tx) => {
        for (let i = 0; i < decisions.length; i++) {
          const item = decisions[i]!
          const existing = await alreadyAppliedReport({ getException: (t,id)=>tx.getException(t,id), getMovement:(t,id)=>tx.getMovement(t,id), listAllocations:(q)=>tx.listAllocations(q), getExpectationByReference:(t,r)=>tx.getExpectationByReference(t,r) } as Store, tenantId, item)
          const result = existing ?? await decideExceptionTx(tx, { tenantId, exceptionId: item.exceptionId, decision: item.decision, ...(options.chart === undefined ? {} : { chart: options.chart }) })
          results.push({ index: i, exceptionId: item.exceptionId, result })
        }
      })
    } catch (err) {
      const index = results.length
      const item = decisions[index]
      const error = asBatchError(err)
      return { mode, applied: 0, errors: 1, results: item === undefined ? [] : [{ index, exceptionId: item.exceptionId, error }] }
    }
    return { mode, applied: results.length, errors: 0, results }
  }

  const results: BatchResolveResult[] = []
  let applied = 0
  let errors = 0
  for (let i = 0; i < decisions.length; i++) {
    const item = decisions[i]!
    try {
      const result = await decideOne(store, { store, tenantId, item, ...(options.chart === undefined ? {} : { chart: options.chart }) })
      results.push({ index: i, exceptionId: item.exceptionId, result })
      applied++
    } catch (err) {
      results.push({ index: i, exceptionId: item.exceptionId, error: asBatchError(err) })
      errors++
    }
  }
  return { mode, applied, errors, results }
}
