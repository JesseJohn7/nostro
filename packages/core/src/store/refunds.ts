import type { Movement } from '../model/index.js'
import { Money } from '../money/index.js'
import type { AssetId } from '../money/index.js'
import { ConstraintError, NotFoundError } from './store.js'
import type { RefundLink, StoreTx } from './store.js'

/** Amount already disposed of by refund, beyond ordinary expectation allocations. */
export function refundCoverage(movement: Movement, links: readonly RefundLink[]): Money {
  return links.reduce(
    (sum, link) =>
      sum.add(
        link.creditMovementId === movement.id
          ? link.residualAmount
          : link.refundMovementId === movement.id
            ? link.amount
            : Money.zero(movement.amount.asset, movement.amount.decimals),
      ),
    Money.zero(movement.amount.asset, movement.amount.decimals),
  )
}

/** Both movements are read under their transaction locks before the link is written. */
export async function refundParts(
  tx: StoreTx,
  tenantId: string,
  creditMovementId: string,
  refundMovementId: string,
) {
  const credit = await tx.getMovement(tenantId, creditMovementId)
  const refund = await tx.getMovement(tenantId, refundMovementId)
  if (!credit || !refund) throw new NotFoundError('movement', !credit ? creditMovementId : refundMovementId)
  if (
    credit.direction !== 'credit' ||
    refund.direction !== 'debit' ||
    refund.kind !== 'transfer' ||
    credit.network !== refund.network ||
    credit.account !== refund.account ||
    credit.amount.asset !== refund.amount.asset ||
    credit.amount.decimals !== refund.amount.decimals ||
    credit.txHash === null ||
    refund.memo?.type !== 'return' ||
    refund.memo.value !== credit.txHash ||
    refund.occurredAt < credit.occurredAt
  ) {
    throw new ConstraintError(
      'refund_invalid',
      'refund must name an earlier credit on the same wallet, network and exact asset',
    )
  }
  const links = await tx.listRefundLinks({ tenantId, creditMovementId })
  const returned = links.reduce(
    (sum, link) => sum.add(link.amount),
    Money.zero(credit.amount.asset, credit.amount.decimals),
  )
  if (returned.add(refund.amount).compare(credit.amount) > 0)
    throw new ConstraintError('refund_over_credit', 'refund exceeds the remaining original credit')
  const allocations = await tx.listAllocations({ tenantId, movementId: creditMovementId })
  const allocated = allocations.reduce(
    (sum, a) => sum.add(a.amount),
    Money.zero(credit.amount.asset, credit.amount.decimals),
  )
  const remaining = credit.amount.subtract(allocated).subtract(refundCoverage(credit, links))
  const residualAmount =
    credit.disposition === 'ignored'
      ? Money.zero(credit.amount.asset, credit.amount.decimals)
      : remaining.compare(refund.amount) < 0
        ? remaining
        : refund.amount
  return { tenantId, creditMovementId, refundMovementId, amount: refund.amount, residualAmount }
}

export function refundLinkFromRow(row: Record<string, unknown>): RefundLink {
  const asset = row.asset as AssetId
  const decimals = Number(row.decimals)
  return Object.freeze({
    id: String(row.id),
    tenantId: String(row.tenant_id),
    creditMovementId: String(row.credit_movement_id),
    refundMovementId: String(row.refund_movement_id),
    amount: Money.fromRaw(BigInt(String(row.amount)), asset, decimals),
    residualAmount: Money.fromRaw(BigInt(String(row.residual_amount)), asset, decimals),
    createdAt: row.created_at instanceof Date ? new Date(row.created_at) : new Date(Number(row.created_at)),
  })
}
