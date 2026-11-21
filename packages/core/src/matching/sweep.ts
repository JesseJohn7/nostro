import type { Store } from '../store/index.js'

export interface SweepExpectationsOptions {
  readonly store: Store
  readonly tenantId: string
  readonly asOf?: Date
  readonly limit?: number
}

export interface SweepExpectationsReport {
  readonly scanned: number
  readonly expired: number
  readonly skipped: number
}

export async function sweepExpectations(options: SweepExpectationsOptions): Promise<SweepExpectationsReport> {
  const { store, tenantId } = options
  const asOf = options.asOf ?? new Date()
  const limit = options.limit ?? 500
  let scanned = 0
  let expired = 0
  let skipped = 0
  let afterSeq: number | undefined
  for (;;) {
    const page = await store.listExpectations({
      tenantId,
      status: ['open', 'partially_paid'],
      limit,
      ...(afterSeq === undefined ? {} : { afterSeq }),
    })
    if (page.length === 0) break
    for (const e of page) {
      afterSeq = e.seq
      if (e.expiresAt === null || e.expiresAt.getTime() > asOf.getTime()) continue
      scanned += 1
      const existing = await store.listExceptions({ tenantId, expectationId: e.id })
      if (existing.some((x) => x.code === 'EXPECTATION_EXPIRED')) {
        skipped += 1
        continue
      }
      try {
        const opened = await store.transaction(async (tx) => {
          const current = await tx.getExpectation(tenantId, e.id)
          if (current === null) return false
          if (current.status === 'settled' || current.status === 'cancelled') return false
          if (current.expiresAt === null || current.expiresAt.getTime() > asOf.getTime()) return false
          const already = await tx.listExceptions({ tenantId, expectationId: e.id })
          if (already.some((x) => x.code === 'EXPECTATION_EXPIRED')) return false
          await tx.openException({
            tenantId,
            code: 'EXPECTATION_EXPIRED',
            expectationId: e.id,
            account: e.account,
            amount: current.amount,
            detail: `${current.reference} expired ${current.expiresAt.toISOString()} without being fully paid.`,
            evidence: { asOf: asOf.toISOString(), status: current.status },
          })
          return true
        })
        if (opened) expired += 1
        else skipped += 1
      } catch {
        skipped += 1
      }
    }
    if (page.length < limit) break
  }
  return { scanned, expired, skipped }
}
