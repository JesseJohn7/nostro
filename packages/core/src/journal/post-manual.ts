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
    if (movementId != null) throw new ValidationError('movementId', 'manual entries cannot name a movement')
    return tx.postJournalEntry({
      tenantId,
      movementId: movementId ?? null,
      postingNo: null,
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
    let target: JournalEntry | undefined
    let afterSeq: number | undefined
    for (;;) {
      const entries = await tx.listJournalEntries({ tenantId, limit: 500, ...(afterSeq === undefined ? {} : { afterSeq }) })
      target = entries.find(e => e.id === entryId)
      if (target || entries.length < 500) break
      afterSeq = entries[entries.length - 1]!.seq
    }
    if (target === undefined) {
      throw new Error(`Manual entry ${entryId} not found in tenant ${tenantId}`)
    }

    if (target.kind !== 'manual') throw new ValidationError('entryId', 'only manual entries can be reversed here')

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

    if (options.postedBy) assertStorableText('postedBy', options.postedBy)
    if (options.note) assertStorableText('note', options.note)
    return tx.postJournalEntry({
      tenantId, kind: 'manual',
      effectiveAt: options.effectiveAt ?? new Date(),
      description: `${desc} (Reason: ${reason})${options.note ? ` (Note: ${options.note})` : ''}${options.postedBy ? ` [by ${options.postedBy}]` : ''}`,
      lines: reversedLines,
    })
  })
}
