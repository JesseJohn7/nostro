/**
 * Read-only tools for asking what a different engine or different options would
 * have decided. Both take a `StoreReader`, so they cannot write by construction.
 */
import { decide } from './engine.js'
import type { DecideOptions, Decision } from './engine.js'
import type { MatchStrategy } from './types.js'
import type { DecisionQuery } from '../store/store.js'
import { decodeInputs, decisionResult, ENGINE_VERSION, resolveStrategies } from './decisions.js'
import type { DecisionSnapshot } from '../model/index.js'
import type { Json } from '../model/index.js'
import type { StoreReader } from '../store/index.js'

export interface ExplainOptions {
  readonly store: StoreReader
  readonly tenantId: string
  readonly movementId: string
  /** Custom strategies must be supplied to replay a snapshot that used them. */
  readonly strategies?: readonly import('./types.js').MatchStrategy[]
}

export interface ExplainReport {
  readonly movementId: string
  readonly status: 'agree' | 'disagree' | 'unreplayable'
  readonly engineVersion: string
  readonly recordedEngineVersion: string
  readonly recorded: Json
  /** What today's engine decides; null when the snapshot cannot be replayed. */
  readonly current: Json | null
  readonly reason: string | null
}

const same = (a: Json, b: Json) => JSON.stringify(a) === JSON.stringify(b)

function replay(snapshot: DecisionSnapshot, options: DecideOptions): { decision: Decision; options: DecideOptions } | string {
  let inputs
  try {
    inputs = decodeInputs(snapshot.inputs)
  } catch (err) {
    return `recorded inputs cannot be decoded: ${(err as Error).message}`
  }
  const strategies = options.strategies ?? resolveStrategies(snapshot.options.strategies)
  if (strategies === null) return 'the strategies used for this decision are not available'
  const resolved: DecideOptions = {
    threshold: options.threshold ?? snapshot.options.threshold,
    margin: options.margin ?? snapshot.options.margin,
    strategies,
  }
  return { decision: decide(inputs.movement, inputs.candidates, resolved), options: resolved }
}

/** Re-run the recorded decision with today's engine and say whether it agrees. */
export async function explainMovement(options: ExplainOptions): Promise<ExplainReport> {
  const { store, tenantId, movementId } = options
  const record = await store.getDecision(tenantId, movementId)
  if (record === null) {
    return {
      movementId,
      status: 'unreplayable',
      engineVersion: ENGINE_VERSION,
      recordedEngineVersion: 'unknown',
      recorded: null,
      current: null,
      reason: 'no recorded decision for this movement',
    }
  }
  const snapshot = record.snapshot
  const outcome = replay(snapshot, options.strategies === undefined ? {} : { strategies: options.strategies })
  if (typeof outcome === 'string') {
    return {
      movementId,
      status: 'unreplayable',
      engineVersion: ENGINE_VERSION,
      recordedEngineVersion: snapshot.engineVersion,
      recorded: snapshot.result,
      current: null,
      reason: outcome,
    }
  }
  const current = decisionResult(outcome.decision)
  const agrees = same(current, snapshot.result)
  return {
    movementId,
    status: agrees ? 'agree' : 'disagree',
    engineVersion: ENGINE_VERSION,
    recordedEngineVersion: snapshot.engineVersion,
    recorded: snapshot.result,
    current,
    reason: agrees ? null : 'the current engine would decide this movement differently',
  }
}

export interface ReplayOptions {
  readonly store: StoreReader
  readonly tenantId: string
  readonly from?: Date | undefined
  readonly to?: Date | undefined
  /** Options to try. Omitted fields keep the values recorded with each decision. */
  readonly options?: DecideOptions | undefined
  readonly strategies?: readonly MatchStrategy[] | undefined
  readonly limit?: number | undefined
}

export type ReplayChange = 'none' | 'would_settle' | 'would_go_to_person' | 'would_change_expectation' | 'unreplayable'

export interface ReplayRow {
  readonly movementId: string
  readonly decidedAt: string
  readonly recorded: Json
  readonly proposed: Json | null
  readonly change: ReplayChange
  /** The person's later manual answer, when one exists. */
  readonly laterManual: { readonly expectationId: string; readonly agrees: boolean } | null
  readonly reason: string | null
}

export interface ReplayReport {
  readonly engineVersion: string
  readonly replayed: number
  readonly unchanged: number
  readonly wouldSettle: number
  readonly wouldGoToPerson: number
  readonly wouldChangeExpectation: number
  readonly unreplayable: number
  readonly rows: readonly ReplayRow[]
}

function changeOf(recorded: Json, proposed: Json): ReplayChange {
  if (same(recorded, proposed)) return 'none'
  const a = recorded as { outcome?: string; expectationId?: string | null }
  const b = proposed as { outcome?: string; expectationId?: string | null }
  if (a.outcome !== 'allocate' && b.outcome === 'allocate') return 'would_settle'
  if (a.outcome === 'allocate' && b.outcome !== 'allocate') return 'would_go_to_person'
  if (a.expectationId !== b.expectationId) return 'would_change_expectation'
  return 'would_go_to_person'
}

/** Replay every decision in a range under the proposed options, without writing. */
export async function replayDecisions(options: ReplayOptions): Promise<ReplayReport> {
  const { store, tenantId, from, to, limit } = options
  const query: DecisionQuery = { tenantId, limit: limit ?? 1000 }
  if (from !== undefined) (query as { from?: Date }).from = from
  if (to !== undefined) (query as { to?: Date }).to = to
  const records = await store.listDecisions(query)
  const movements = records.map((r) => r.movementId)
  const allocations = movements.length === 0 ? [] : await store.listAllocations({ tenantId, movementIds: movements })
  const manual = new Map<string, (typeof allocations)[number]>()
  for (const a of allocations) {
    if (a.strategy !== 'manual') continue
    const decided = records.find((r) => r.movementId === a.movementId)
    if (decided !== undefined && a.createdAt >= decided.decidedAt && !manual.has(a.movementId)) {
      manual.set(a.movementId, a)
    }
  }

  const rows: ReplayRow[] = []
  const totals = { unchanged: 0, wouldSettle: 0, wouldGoToPerson: 0, wouldChangeExpectation: 0, unreplayable: 0 }
  for (const record of records) {
    const strategies = options.options?.strategies ?? options.strategies
    const outcome = replay(record.snapshot, strategies === undefined ? { ...options.options } : { ...options.options, strategies })
    if (typeof outcome === 'string') {
      totals.unreplayable++
      rows.push({
        movementId: record.movementId,
        decidedAt: record.decidedAt.toISOString(),
        recorded: record.snapshot.result,
        proposed: null,
        change: 'unreplayable',
        laterManual: null,
        reason: outcome,
      })
      continue
    }
    const proposed = decisionResult(outcome.decision)
    const change = changeOf(record.snapshot.result, proposed)
    if (change === 'none') totals.unchanged++
    else if (change === 'would_settle') totals.wouldSettle++
    else if (change === 'would_go_to_person') totals.wouldGoToPerson++
    else if (change === 'would_change_expectation') totals.wouldChangeExpectation++
    const person = manual.get(record.movementId)
    const expected = proposed as { expectationId?: string | null }
    rows.push({
      movementId: record.movementId,
      decidedAt: record.decidedAt.toISOString(),
      recorded: record.snapshot.result,
      proposed,
      change,
      laterManual:
        person === null || person === undefined
          ? null
          : { expectationId: person.expectationId, agrees: person.expectationId === expected.expectationId },
      reason: null,
    })
  }
  return { engineVersion: ENGINE_VERSION, replayed: records.length, ...totals, rows }
}
