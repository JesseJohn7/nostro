import type { AccountOpening, NewAccountOpening, NewJournalLine } from '../model/index.js'
import type { Store, StoreTx } from '../store/index.js'
import { DEFAULT_CHART } from './chart.js'
import { cursorAfterLedger } from '../sources/horizon/records.js'

const OPENING_SOURCES = ['horizon', 'horizon-fees'] as const

async function postOpeningEntry(tx: StoreTx, opening: AccountOpening): Promise<void> {
  const lines: NewJournalLine[] = []
  for (const balance of opening.balances) {
    lines.push(
      {
        account: DEFAULT_CHART.cash(opening.network, opening.account),
        role: 'cash',
        side: 'debit',
        amount: balance.amount,
        accrual: false,
      },
      {
        account: DEFAULT_CHART.opening_balance,
        role: 'opening_balance',
        side: 'credit',
        amount: balance.amount,
        accrual: false,
      },
    )
  }
  await tx.postJournalEntry({
    tenantId: opening.tenantId,
    kind: 'opening',
    effectiveAt: opening.occurredAt,
    description: opening.note ?? `Opening balance at ledger ${opening.ledger}`,
    lines,
  })
}

export async function openAccount(store: Store, input: NewAccountOpening): Promise<AccountOpening> {
  return store.transaction(async (tx) => {
    const opening = await tx.insertAccountOpening(input)
    const cursor = cursorAfterLedger(opening.ledger)
    for (const source of OPENING_SOURCES) {
      await tx.setCursor(
        { tenantId: opening.tenantId, network: opening.network, source, account: opening.account },
        cursor,
      )
    }
    await postOpeningEntry(tx, opening)
    return opening
  })
}
