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

function isOneEditApart(a: string, b: string): boolean {
  if (a === b) return false
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > 1) return false
  if (la === lb) {
    let first = -1
    let second = -1
    for (let i = 0; i < la; i++) {
      if (a[i] === b[i]) continue
      if (first === -1) first = i
      else if (second === -1) second = i
      else return false
    }
    if (second === -1) return true
    return second === first + 1 && a[first] === b[second] && a[second] === b[first]
  }
  const [shorter, longer] = la < lb ? [a, b] : [b, a]
  let i = 0
  let j = 0
  let diff = false
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++
      j++
    } else {
      if (diff) return false
      diff = true
      j++
    }
  }
  return true
}

/**
 * Corroborating identifier signal: the memo is one edit (substitution, insertion,
 * deletion, or adjacent transposition) away from the reference after normalisation.
 * False positives are possible when an unrelated memo is near a short or common
 * reference, so this never settles on its own.
 */
export const memoNearMissStrategy: MatchStrategy = {
  name: 'memo_near_miss',
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

    const near = candidates(movement.memo.value).some((c) => c !== ref && isOneEditApart(c, ref))
    if (!near) return null
    return {
      strategy: 'memo_near_miss',
      family: 'identifier',
      score: 0.5,
      reason: `memo ${JSON.stringify(movement.memo.value)} is one edit from reference ${expectation.reference}`,
    }
  },
}
