import type { Expectation, NewExpectation } from '../model/index.js'

/** Compare invoice fields after parsing; Money equality includes asset and raw units. */
export function expectationMatches(input: NewExpectation, existing: Expectation): boolean {
  const memo = input.memo ?? null
  const payers = input.payers ?? []
  const dateValue = (value: Date | null | undefined) => value == null ? null : value.getTime()
  const sameMemo = memo === null
    ? existing.memo === null
    : existing.memo !== null && memo.type === existing.memo.type && memo.value === existing.memo.value
  const sameRecord = (a: Record<string, string>, b: Readonly<Record<string, string>>) => {
    const ak = Object.keys(a).sort()
    const bk = Object.keys(b).sort()
    return ak.length === bk.length && ak.every((key, i) => key === bk[i] && a[key] === b[key])
  }
  return input.tenantId === existing.tenantId && input.reference === existing.reference &&
    input.account === existing.account && (input.direction ?? 'credit') === existing.direction &&
    input.amount.asset === existing.amount.asset && input.amount.raw === existing.amount.raw && input.amount.decimals === existing.amount.decimals &&
    (input.muxedId === 'issue' || (input.muxedId ?? null) === existing.muxedId) && sameMemo &&
    payers.length === existing.payers.length && payers.every((payer, i) => payer === existing.payers[i]) &&
    dateValue(input.dueAt) === dateValue(existing.dueAt) &&
    dateValue(input.expiresAt) === dateValue(existing.expiresAt) &&
    sameRecord({ ...(input.metadata ?? {}) }, existing.metadata)
}
