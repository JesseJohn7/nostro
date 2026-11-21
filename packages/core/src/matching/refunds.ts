import type { Movement } from '../model/index.js'
import type { StoreTx } from '../store/index.js'
import { ConstraintError, refundCoverage, sumAmounts } from '../store/index.js'
import { postMovement } from '../journal/index.js'
import type { PostOptions } from '../journal/index.js'

export async function recogniseRefund(
  tx: StoreTx,
  refund: Movement,
  options: PostOptions,
  prepareCredit: (id: string) => Promise<void>,
  onPost: () => void,
): Promise<'allocated' | 'REFUND_UNLINKED'> {
  const tenantId = refund.tenantId
  const unmatched = async (detail: string): Promise<'REFUND_UNLINKED'> => {
    await tx.openException({
      tenantId,
      movementId: refund.id,
      account: refund.account,
      amount: refund.amount,
      code: 'REFUND_UNLINKED',
      detail,
      evidence: { returnHash: String(refund.memo?.value ?? '') },
    })
    await tx.setDisposition(tenantId, refund.id, 'exception')
    return 'REFUND_UNLINKED'
  }
  const candidates = (
    await tx.listMovements({ tenantId, account: refund.account, txHash: String(refund.memo?.value) })
  ).filter(
    (m) =>
      m.direction === 'credit' &&
      m.network === refund.network &&
      m.amount.asset === refund.amount.asset &&
      m.amount.decimals === refund.amount.decimals &&
      m.occurredAt <= refund.occurredAt,
  )
  if (candidates.length !== 1)
    return unmatched('Return memo does not identify one earlier credit in this wallet, network and asset')
  let credit = candidates[0]!
  if (credit.disposition === 'pending') await prepareCredit(credit.id)
  credit = (await tx.getMovement(tenantId, credit.id))!
  try {
    await tx.linkRefund(tenantId, credit.id, refund.id)
  } catch (err) {
    if (err instanceof ConstraintError) return unmatched(err.message)
    throw err
  }
  const links = await tx.listRefundLinks({ tenantId, creditMovementId: credit.id })
  const allocations = await tx.listAllocations({ tenantId, movementId: credit.id })
  const covered = sumAmounts(
    allocations.map((a) => a.amount),
    credit.amount,
  ).add(refundCoverage(credit, links))
  if (credit.disposition !== 'ignored') {
    const open = await tx.listExceptions({ tenantId, movementId: credit.id, status: 'open' })
    for (const e of open)
      await tx.resolveException(tenantId, e.id, { status: 'resolved', note: `Refund ${refund.id} recorded` })
    if (covered.equals(credit.amount)) await tx.setDisposition(tenantId, credit.id, 'allocated')
    else {
      await tx.openException({
        tenantId,
        movementId: credit.id,
        account: credit.account,
        amount: credit.amount.subtract(covered),
        code: open[open.length - 1]?.code ?? 'PARTIAL_UNRESOLVED',
        detail: 'Amount remaining after recorded refunds',
      })
      await tx.setDisposition(tenantId, credit.id, covered.isPositive() ? 'partial' : 'exception')
    }
  }
  if (await postMovement(tx, tenantId, credit.id, options)) onPost()
  await tx.setDisposition(tenantId, refund.id, 'allocated')
  return 'allocated'
}
