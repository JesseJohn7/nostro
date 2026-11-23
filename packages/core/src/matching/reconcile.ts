/**
 * Reconcile pending movements against expectations.
 *
 * `reconcile()` is the step after `sync()`: it takes movements still marked
 * `pending`, decides each with the pure engine, and records the outcome:
 * an allocation, an exception for a person, or an explicit ignore. Every
 * movement it touches leaves `pending` with a disposition that satisfies
 * invariant I1 (the store refuses one that does not).
 *
 * The journal is posted in the same transaction as each decision, so the
 * books never lag the decisions (see `postMovement`).
 *
 * Each movement is handled in its own transaction, and the movement is
 * re-read there with a locking read, so two reconcilers running at once skip
 * what the other has done instead of colliding. Bounded like `sync()`: call
 * it again for the next batch.
 *
 * Candidates are the account's open and part-paid expectations in the same
 * direction, plus any expectation (whatever its status, except cancelled)
 * whose muxed id the movement carries in its address or its memo id, and any
 * expectation whose normalised reference or requested text memo equals the
 * movement's normalised text memo. The last two find settled invoices too, so
 * a second payment is caught as DUPLICATE_PAYMENT whether the payer used the
 * muxed address or quoted the reference again. Settled candidates have nothing
 * owing, which the engine already refuses; no engine change is needed.
 */
import { recogniseRefund } from './refunds.js'
import type { PostOptions } from '../journal/index.js'
import { postMovement } from '../journal/index.js'
import type { ExceptionCode, Expectation, Movement } from '../model/index.js'
import type { Store, StoreTx } from '../store/index.js'
import { sumAmounts } from '../store/index.js'
import type { DecideOptions } from './engine.js'
import { decide } from './engine.js'
import { snapshotDecision } from './decisions.js'
import type { Candidate } from './types.js'
import { normalizeReference } from './reference.js'

export interface ReconcileOptions extends DecideOptions, PostOptions {
  readonly store: Store
  readonly tenantId: string
  /** Pending movements to take per call. Default 100. */
  readonly limit?: number
}

export interface ReconcileReport {
  /** Movements this call decided. */
  readonly processed: number
  /** Fully allocated. */
  readonly allocated: number
  /** Allocated, with an overpayment exception for the rest. */
  readonly partial: number
  /** Exceptions raised, by code. */
  readonly exceptions: Readonly<Partial<Record<ExceptionCode, number>>>
  readonly ignored: number
  /** Journal entries posted for the movements decided. */
  readonly journalEntries: number
  /** Already handled by another reconciler by the time this one got to it. */
  readonly skipped: number
  readonly errors: readonly { readonly movementId: string; readonly error: Error }[]
}

async function candidatesFor(tx: StoreTx, movement: Movement): Promise<Candidate[]> {
  const { tenantId, account, direction } = movement
  const found = new Map<string, Expectation>()
  const add = (list: readonly Expectation[]) => {
    for (const e of list) {
      // A muxed id only means something on its own base account.
      if (e.status !== 'cancelled' && e.account === account && e.direction === direction) found.set(e.id, e)
    }
  }
  add(await tx.listExpectations({ tenantId, account, direction, status: ['open', 'partially_paid'] }))
  if (movement.muxedId !== null) add(await tx.listExpectations({ tenantId, muxedId: movement.muxedId }))
  if (movement.memo?.type === 'id') add(await tx.listExpectations({ tenantId, muxedId: movement.memo.value }))
  if (movement.memo?.type === 'text') {
    const normalized = normalizeReference(movement.memo.value)
    if (normalized !== '') add(await tx.getExpectationsByNormalizedReference(tenantId, normalized))
  }

  const allocations = await tx.listAllocations({
    tenantId,
    expectationIds: [...found.keys()],
  })
  const allocationsByExpectation = new Map<string, typeof allocations>()
  for (const allocation of allocations) {
    allocationsByExpectation.set(allocation.expectationId, [
      ...(allocationsByExpectation.get(allocation.expectationId) ?? []),
      allocation,
    ])
  }

  const candidates: Candidate[] = []
  for (const expectation of found.values()) {
    const paid = sumAmounts(
      (allocationsByExpectation.get(expectation.id) ?? []).map((a) => a.amount),
      expectation.amount,
    )
    candidates.push({ expectation, remaining: expectation.amount.subtract(paid) })
  }
  return candidates
}

type Outcome = 'allocated' | 'partial' | 'ignored' | 'skipped' | ExceptionCode

const INTERNAL_TRANSFER_REASON = 'internal transfer between watched accounts'

async function recogniseInternalTransfer(
  tx: StoreTx,
  movement: Movement,
  options: ReconcileOptions,
): Promise<number | null> {
  if (movement.txHash === null || movement.kind !== 'transfer') return null
  const tenantId = movement.tenantId
  if ((await candidatesFor(tx, movement)).length > 0) return null
  if ((await tx.listAllocations({ tenantId, movementId: movement.id })).length > 0) return null
  if ((await tx.listInternalTransferLinks({ tenantId, movementIds: [movement.id] })).length > 0) return null
  const partners = (await tx.listMovements({ tenantId, txHash: movement.txHash })).filter(
    (m) =>
      m.id !== movement.id &&
      m.kind === 'transfer' &&
      (m.disposition === 'pending' || m.disposition === 'ignored' || m.disposition === 'exception') &&
      m.network === movement.network &&
      m.account === movement.counterparty &&
      m.counterparty === movement.account &&
      m.direction !== movement.direction &&
      m.amount.asset === movement.amount.asset &&
      m.amount.decimals === movement.amount.decimals &&
      m.amount.equals(movement.amount),
  )
  if (partners.length !== 1) return null
  const partner = partners[0]!
  if ((await candidatesFor(tx, partner)).length > 0) return null
  if ((await tx.listAllocations({ tenantId, movementId: partner.id })).length > 0) return null
  if ((await tx.listInternalTransferLinks({ tenantId, movementIds: [partner.id] })).length > 0) return null

  await tx.linkInternalTransfer({
    tenantId,
    network: movement.network,
    txHash: movement.txHash,
    movementIds: [movement.id, partner.id],
    sameEntity: movement.entityId === partner.entityId,
  })
  await tx.setDisposition(tenantId, movement.id, 'ignored', INTERNAL_TRANSFER_REASON)
  await tx.setDisposition(tenantId, partner.id, 'ignored', INTERNAL_TRANSFER_REASON)
  for (const id of [movement.id, partner.id]) {
    const open = (await tx.listExceptions({ tenantId, movementId: id })).filter((e) => e.status === 'open')
    for (const exception of open) {
      await tx.resolveException(tenantId, exception.id, { status: 'dismissed', note: INTERNAL_TRANSFER_REASON })
    }
  }
  let posted = 0
  if ((await postMovement(tx, tenantId, movement.id, options)) !== null) posted++
  if ((await postMovement(tx, tenantId, partner.id, options)) !== null) posted++
  return posted
}

async function reconcileOne(
  tx: StoreTx,
  tenantId: string,
  id: string,
  options: ReconcileOptions,
): Promise<{ outcome: Outcome; posted: number }> {
  const movement = await tx.getMovement(tenantId, id)
  if (movement === null || movement.disposition !== 'pending') return { outcome: 'skipped', posted: 0 }
  const internal = await recogniseInternalTransfer(tx, movement, options)
  if (internal !== null) return { outcome: 'ignored', posted: internal }

  let extraPostings = 0
  const outcome = await decideOne(tx, tenantId, id, options, () => {
    extraPostings++
  })
  if (outcome === 'skipped') return { outcome, posted: 0 }
  return { outcome, posted: extraPostings + Number((await postMovement(tx, tenantId, id, options)) !== null) }
}

async function decideOne(
  tx: StoreTx,
  tenantId: string,
  id: string,
  options: ReconcileOptions,
  onPost: () => void = () => {},
): Promise<Outcome> {
  const movement = await tx.getMovement(tenantId, id)
  if (movement === null || movement.disposition !== 'pending') return 'skipped'

  if (movement.direction === 'debit' && movement.kind === 'transfer' && movement.memo?.type === 'return') {
    return recogniseRefund(
      tx,
      movement,
      options,
      async (creditId) => {
        await decideOne(tx, tenantId, creditId, options, onPost)
        if (await postMovement(tx, tenantId, creditId, options)) onPost()
      },
      onPost,
    )
  }

  const candidates = await candidatesFor(tx, movement)
  const decision = decide(movement, candidates, options)
  const decidedAt = new Date()
  const snapshot = snapshotDecision(movement, candidates, decision, options, decidedAt)
  await tx.recordDecision({ tenantId, movementId: id, decidedAt, snapshot })
  switch (decision.outcome) {
    case 'ignore':
      await tx.setDisposition(tenantId, id, 'ignored', decision.reason)
      return 'ignored'
    case 'exception':
      await tx.openException({
        tenantId,
        code: decision.code,
        movementId: id,
        expectationId: decision.expectationId,
        account: movement.account,
        amount: decision.amount,
        detail: decision.detail,
        evidence: decision.evidence,
      })
      await tx.setDisposition(tenantId, id, 'exception')
      return decision.code
    case 'allocate': {
      await tx.allocate({
        tenantId,
        movementId: id,
        expectationId: decision.expectationId,
        amount: decision.amount,
        strategy: decision.strategy,
        score: decision.score,
        decision: snapshot,
      })
      if (decision.residual === null) {
        await tx.setDisposition(tenantId, id, 'allocated')
        return 'allocated'
      }
      await tx.openException({
        tenantId,
        code: 'OVERPAYMENT',
        movementId: id,
        expectationId: decision.expectationId,
        account: movement.account,
        amount: decision.residual,
        detail:
          `Paid ${movement.amount.toString()}; ${decision.amount.toString()} settled the expectation, ` +
          `${decision.residual.toString()} is left over.`,
        evidence: decision.evidence,
      })
      await tx.setDisposition(tenantId, id, 'partial')
      return 'partial'
    }
  }
}

export async function reconcile(options: ReconcileOptions): Promise<ReconcileReport> {
  const { store, tenantId } = options
  const pending = await store.listMovements({ tenantId, disposition: 'pending', limit: options.limit ?? 100 })
  const counts = { allocated: 0, partial: 0, ignored: 0, skipped: 0 }
  let journalEntries = 0
  const exceptions: Partial<Record<ExceptionCode, number>> = {}
  const errors: { movementId: string; error: Error }[] = []

  for (const { id } of pending) {
    try {
      const { outcome, posted } = await store.transaction((tx) => reconcileOne(tx, tenantId, id, options))
      journalEntries += posted
      if (outcome in counts) counts[outcome as keyof typeof counts] += 1
      else exceptions[outcome as ExceptionCode] = (exceptions[outcome as ExceptionCode] ?? 0) + 1
    } catch (err) {
      errors.push({ movementId: id, error: err instanceof Error ? err : new Error(String(err)) })
    }
  }

  return {
    processed: pending.length - counts.skipped - errors.length,
    ...counts,
    journalEntries,
    exceptions,
    errors,
  }
}
