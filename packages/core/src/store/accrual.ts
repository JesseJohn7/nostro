import type { Direction } from '../model/index.js'
import type { Money } from '../money/index.js'
import type { StoreTx } from './store.js'
import { ValidationError } from '../model/index.js'

/** Post the expectation's balanced accrual once, inside its insertion transaction. */
export async function postAccrual(tx: StoreTx, expectationId: string, tenantId: string, direction: Direction, amount: Money, reference: string): Promise<void> {
  const expectation = await tx.getExpectation(tenantId, expectationId)
  if (!expectation || expectation.direction !== direction || !expectation.amount.equals(amount) || expectation.reference !== reference) {
    throw new ValidationError('expectationId', 'accrual must match the stored expectation')
  }
  const description = `Accrual for expectation ${expectationId}`
  let afterSeq: number | undefined
  for (;;) {
    const page = await tx.listJournalEntries({ tenantId, limit: 500, ...(afterSeq === undefined ? {} : { afterSeq }) })
    if (page.some(e => e.description === description && e.lines.some(l => l.expectationId === expectationId))) return
    if (page.length < 500) break
    afterSeq = page[page.length - 1]!.seq
  }
  const credit = direction === 'credit'
  await tx.postJournalEntry({ tenantId, kind: 'manual', description, lines: [
    { account: credit ? 'assets:receivable' : 'expenses:uncategorized', role: credit ? 'receivable' : 'uncategorized_expense', side: 'debit', amount, expectationId },
    { account: credit ? 'income:uncategorized' : 'liabilities:payable', role: credit ? 'uncategorized_income' : 'payable', side: 'credit', amount, expectationId },
  ] })
}
