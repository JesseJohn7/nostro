/**
 * The auditable record of a matching decision.
 *
 * `decide()` is pure, so a decision can be replayed — but only from the inputs
 * it actually saw. Today's expectations are not those inputs: later invoices,
 * cancellations and amendments change them. Every automatic decision therefore
 * stores a JSON snapshot with the options in force, the engine version, the
 * evidence and the complete candidate inputs.
 *
 * Snapshots are JSON-safe by construction: amounts are decimal strings, ids
 * are decimal strings, and dates are ISO 8601 instants.
 */
import { Money } from '../money/index.js'
import type { AssetId } from '../money/index.js'
import type { Decision, DecideOptions } from './engine.js'
import { DEFAULT_STRATEGIES } from './strategies/index.js'
import type { Candidate, MatchStrategy } from './types.js'
import type {
  DecisionCandidateJson,
  DecisionInputsJson,
  DecisionOptionsJson,
  DecisionSnapshot,
  Expectation,
  Json,
  Memo,
  Movement,
  MovementJson,
} from '../model/index.js'
import { expectationJson, movementJson } from '../model/index.js'

/** The version of the matching engine that produced a snapshot. */
export const ENGINE_VERSION = '0.1.0'

export function resolvedOptions(options: DecideOptions = {}): DecisionOptionsJson {
  const strategies = options.strategies ?? DEFAULT_STRATEGIES
  return {
    threshold: options.threshold ?? 0.7,
    margin: options.margin ?? 0.15,
    strategies: strategies.map((s) => s.name),
  }
}

export function decisionResult(decision: Decision): Json {
  switch (decision.outcome) {
    case 'allocate':
      return {
        outcome: 'allocate',
        expectationId: decision.expectationId,
        amount: decision.amount.toString(),
        residual: decision.residual === null ? null : decision.residual.toString(),
        strategy: decision.strategy,
        score: decision.score,
      }
    case 'exception':
      return {
        outcome: 'exception',
        code: decision.code,
        expectationId: decision.expectationId,
        amount: decision.amount === null ? null : decision.amount.toString(),
        detail: decision.detail,
      }
    case 'ignore':
      return { outcome: 'ignore', reason: decision.reason }
  }
}

/** The JSON stored with an allocation and in the decisions table. */
export function snapshotDecision(
  movement: Movement,
  candidates: readonly Candidate[],
  decision: Decision,
  options: DecideOptions,
  decidedAt: Date = new Date(),
): DecisionSnapshot {
  return {
    engineVersion: ENGINE_VERSION,
    decidedAt: decidedAt.toISOString(),
    options: resolvedOptions(options),
    inputs: {
      movement: { tenantId: movement.tenantId, ...movementJson(movement) },
      candidates: candidates.map((candidate) => ({
        expectation: {
          tenantId: candidate.expectation.tenantId,
          fingerprintSuffix:
            candidate.expectation.fingerprintSuffix === null ? null : candidate.expectation.fingerprintSuffix.toString(),
          ...expectationJson(candidate.expectation),
        },
        remaining: candidate.remaining.toString(),
        decimals: candidate.remaining.decimals,
      })),
    },
    evidence: decision.outcome === 'ignore' ? { outcome: 'ignore', reason: decision.reason } : decision.evidence,
    result: decisionResult(decision),
  }
}

function memoOf(raw: MovementJson['memo']): Memo | null {
  if (raw === null) return null
  if (raw.type === 'id') return { type: 'id', value: BigInt(raw.value) }
  return { type: raw.type, value: raw.value }
}

function movementOf(raw: DecisionInputsJson['movement']): Movement {
  const { tenantId, amount, asset, memo, muxedId, occurredAt, createdAt, ...rest } = raw
  return {
    ...rest,
    tenantId,
    amount: Money.parse(amount, asset),
    muxedId: muxedId === null ? null : BigInt(muxedId),
    memo: memoOf(memo),
    occurredAt: new Date(occurredAt),
    createdAt: new Date(createdAt),
  }
}

function expectationOf(raw: DecisionCandidateJson['expectation']): Expectation {
  const { tenantId, fingerprintSuffix, amount, asset, memo, payers, metadata, muxedId, dueAt, expiresAt, createdAt, updatedAt, ...rest } =
    raw
  return {
    ...rest,
    tenantId,
    amount: Money.parse(amount, asset),
    muxedId: muxedId === null ? null : BigInt(muxedId),
    memo: memoOf(memo),
    payers: [...payers],
    metadata: { ...metadata },
    fingerprintSuffix: fingerprintSuffix === null ? null : BigInt(fingerprintSuffix),
    dueAt: dueAt === null ? null : new Date(dueAt),
    expiresAt: expiresAt === null ? null : new Date(expiresAt),
    createdAt: new Date(createdAt),
    updatedAt: new Date(updatedAt),
  }
}

export interface ReplayInputs {
  readonly movement: Movement
  readonly candidates: readonly Candidate[]
}

/** Rebuild the exact inputs the engine saw. Throws for malformed old snapshots. */
export function decodeInputs(inputs: DecisionInputsJson): ReplayInputs {
  const movement = movementOf(inputs.movement)
  return {
    movement,
    candidates: inputs.candidates.map((raw) => {
      const expectation = expectationOf(raw.expectation)
      return {
        expectation,
        remaining: Money.parse(raw.remaining, raw.expectation.asset as AssetId, raw.decimals),
      }
    }),
  }
}

/** Resolve the recorded strategy names; `extra` supplies custom strategies from tests or callers. */
export function resolveStrategies(
  names: readonly string[],
  extra: readonly MatchStrategy[] = [],
): readonly MatchStrategy[] | null {
  const known = new Map([...DEFAULT_STRATEGIES, ...extra].map((s) => [s.name, s]))
  const found: MatchStrategy[] = []
  for (const name of names) {
    const strategy = known.get(name)
    if (strategy === undefined) return null
    found.push(strategy)
  }
  return found
}
