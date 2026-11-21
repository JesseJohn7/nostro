import type { Movement } from '../../model/index.js'
import type { Candidate, MatchStrategy } from '../types.js'

/** How long before an expectation is recorded a payment for it may arrive. */
const EARLY_PAYMENT_MS = 7 * 24 * 60 * 60 * 1000

function fits(movement: Movement, { expectation, remaining }: Candidate): boolean {
  if (expectation.fingerprintSuffix === null) return false
  if (remaining.asset !== movement.amount.asset || remaining.decimals !== movement.amount.decimals) return false
  // The fingerprinted amount is the full invoiced amount (base + suffix).
  // The movement must match the remaining owed exactly.
  if (!remaining.equals(movement.amount)) return false
  const at = movement.occurredAt.getTime()
  if (expectation.expiresAt !== null && at > expectation.expiresAt.getTime()) return false
  return at >= expectation.createdAt.getTime() - EARLY_PAYMENT_MS
}

/**
 * Score 0.65 when the payment amount exactly matches the remaining owed on a
 * fingerprinted expectation (one with a non-null `fingerprintSuffix`), inside
 * its time window.
 *
 * This is higher than `exact_amount` (0.60) because the suffix makes the
 * amount intentionally unique: a payer coincidentally sending the same
 * sub-unit amount is far less likely than a payer sending a round amount.
 * 0.65 is still below the 0.70 settle threshold, so a fingerprint alone is
 * strong evidence but not proof. Combined with any second-family signal
 * (e.g. `known_payer` at 0.40) the combined score crosses 0.70 and settles
 * automatically.
 *
 * A rounded-off payment (25 instead of 25.0000137) does not match here and
 * falls back to `exact_amount` against the base amount.
 */
export const fingerprintAmountStrategy: MatchStrategy = {
  name: 'fingerprint_amount',
  family: 'amount',
  evaluate(movement: Movement, candidate: Candidate, _all: readonly Candidate[]): import('../types.js').Signal | null {
    if (!fits(movement, candidate)) return null
    return {
      strategy: 'fingerprint_amount',
      family: 'amount',
      score: 0.65,
      reason: `amount matches fingerprinted invoice (suffix ${candidate.expectation.fingerprintSuffix!.toString()} raw units)`,
    }
  },
}
