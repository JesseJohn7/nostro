/**
 * Post manual journal entries that cannot touch cash (Issue #61).
 *
 * Manual entries are append-only. They require a non-empty reason and record
 * who posted it. Reversals are also append-only: a reversal posts an equal and
 * opposite manual entry that zeroes out the original effect.
 */
import type { JournalEntry, NewJournalLine, Side } from '../model/index.js'
import { ValidationError, assertStorableText } from '../model/index.js'
import type { Store } from '../store/index.js'

export interface PostManualEntryOptions {
  readonly store: Store
  readonly tenantId: string
  readonly effectiveAt?: Date
  readonly description: string
  readonly lines: readonly NewJournalLine[]
  readonly note?: string
  readonly reason?: string
  readonly postedBy?: string | null
  readonly movementId?: string | null
}

export interface ReverseManualEntryOptions {
  readonly store: Store
  readonly tenantId: string
  readonly entryId: string
  readonly reason: string
  readonly note?: string
  readonly postedBy?: string | null
  readonly effectiveAt?: Date
}

function assertTenantId(tenantId: string): void {
  if (typeof tenantId !== 'string' || tenantId.trim() === '') {
    throw new ValidationError('tenantId', 'must be a non-empty string')
  }
  assertStorableText('tenantId', tenantId)
}

export async function postManualEntry(options: PostManualEntryOptions): Promise<JournalEntry> {
  const { store, tenantId, lines, movementId } = options
  assertTenantId(tenantId)

  const reason = options.reason ?? options.note
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new ValidationError('reason', 'must be a non-empty string')
  }
  assertStorableText('reason', reason)

  if (typeof options.description !== 'string' || options.description.trim() === '') {
    throw new ValidationError('description', 'must be a non-empty string')
  }
  assertStorableText('description', options.description)

  if (options.postedBy) {
    assertStorableText('postedBy', options.postedBy)
  }

  // Compose description including reason and postedBy if not already in description
  let desc = options.description
  if (options.reason && !desc.includes(options.reason)) {
    desc += ` (Reason: ${options.reason})`
  }
  if (options.note && options.note !== options.reason && !desc.includes(options.note)) {
    desc += ` (Note: ${options.note})`
  }
  if (options.postedBy && !desc.includes(options.postedBy)) {
    desc += ` [by ${options.postedBy}]`
  }

  return store.transaction(async (tx) => {
    let postingNo: number | null = null
    if (movementId != null && movementId !== '') {
      const existing = await tx.listJournalEntries({ tenantId, movementId })
      postingNo = existing.length + 1
    }

    return tx.postJournalEntry({
      tenantId,
      movementId: movementId ?? null,
      postingNo,
      kind: 'manual',
      ...(options.effectiveAt !== undefined ? { effectiveAt: options.effectiveAt } : {}),
      description: desc,
      lines,
    })
  })
}

export async function reverseManualEntry(options: ReverseManualEntryOptions): Promise<JournalEntry> {
  const { store, tenantId, entryId, reason } = options
  assertTenantId(tenantId)

  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new ValidationError('reason', 'must be a non-empty string')
  }
  assertStorableText('reason', reason)

  return store.transaction(async (tx) => {
    // Find entry
    const entries = await tx.listJournalEntries({ tenantId })
    const target = entries.find((e) => e.id === entryId)
    if (target === undefined) {
      throw new Error(`Manual entry ${entryId} not found in tenant ${tenantId}`)
    }

    // Invert lines: debit -> credit, credit -> debit
    const reversedLines: NewJournalLine[] = target.lines.map((l) => ({
      account: l.account,
      role: l.role,
      side: (l.side === 'debit' ? 'credit' : 'debit') as Side,
      amount: l.amount,
      expectationId: l.expectationId,
      exceptionId: l.exceptionId,
    }))

    const desc = `Reversal of ${entryId}: ${target.description}`

    return postManualEntry({
      store: { transaction: <T>(fn: (t: any) => Promise<T>) => fn(tx) } as Store,
      tenantId,
      effectiveAt: options.effectiveAt ?? new Date(),
      description: desc,
      lines: reversedLines,
      reason,
      ...(options.note !== undefined ? { note: options.note } : {}),
      ...(options.postedBy !== undefined ? { postedBy: options.postedBy } : {}),
      ...(target.movementId !== null ? { movementId: target.movementId } : {}),
    })
  })
}
