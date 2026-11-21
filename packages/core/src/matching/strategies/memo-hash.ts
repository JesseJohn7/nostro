import type { MatchStrategy } from '../types.js'

/**
 * Score 0.95, like a memo id. The movement's `MEMO_HASH` is exactly the hash
 * the expectation asked for. Both values are validated as 64 lowercase hex
 * characters on the way in, so this is an exact comparison with nothing to
 * normalise and no near misses to consider.
 *
 * False-positive risk: a payer can reuse or mistype an old hash. As with memo
 * ids, the settled and duplicate checks still run after matching.
 */
export const memoHashStrategy: MatchStrategy = {
  name: 'memo_hash',
  family: 'identifier',
  evaluate(movement, { expectation }) {
    if (movement.memo?.type !== 'hash') return null
    if (expectation.memo?.type !== 'hash' || expectation.memo.value !== movement.memo.value) return null
    return {
      strategy: 'memo_hash',
      family: 'identifier',
      score: 0.95,
      reason: `memo hash ${movement.memo.value} matches the hash asked for by ${expectation.reference}`,
    }
  },
}
