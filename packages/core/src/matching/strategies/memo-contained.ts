import { normalizeReference } from '../reference.js'
import type { MatchStrategy } from '../types.js'

const MIN_RAW_REF_LEN = 4
const MIN_NORMALIZED_REF_LEN = 3

function tokens(text: string): string[] {
  return text.split(/[\s,;:()[\]{}"']+/).filter((t) => t.length > 0)
}

function candidates(text: string): string[] {
  const out = new Set<string>()
  for (const t of tokens(text)) {
    const n = normalizeReference(t)
    if (n !== '') out.add(n)
  }
  const whole = normalizeReference(text)
  if (whole !== '') out.add(whole)
  return [...out]
}

/**
 * Corroborating identifier signal: a memo token or run of tokens normalises to a
 * candidate's reference. False positives are possible when a short or common
 * reference appears in unrelated text, so this never settles on its own.
 */
export const memoContainedStrategy: MatchStrategy = {
  name: 'memo_contained',
  family: 'identifier',
  evaluate(movement, { expectation }) {
    if (movement.memo?.type !== 'text') return null
    const raw = expectation.reference.trim()
    const ref = normalizeReference(raw)
    if (raw.length < MIN_RAW_REF_LEN || ref.length < MIN_NORMALIZED_REF_LEN) return null
    const memoNorm = normalizeReference(movement.memo.value)
    if (memoNorm === '' || memoNorm === ref) return null
    const asked = expectation.memo?.type === 'text' ? normalizeReference(expectation.memo.value) : null
    if (memoNorm === asked) return null

    const found = candidates(movement.memo.value).some((c) => c === ref && c !== memoNorm)
    const inside = !found && memoNorm.includes(ref) && memoNorm.length > ref.length
    if (!found && !inside) return null
    return {
      strategy: 'memo_contained',
      family: 'identifier',
      score: 0.6,
      reason: `memo ${JSON.stringify(movement.memo.value)} contains reference ${expectation.reference}`,
    }
  },
}
