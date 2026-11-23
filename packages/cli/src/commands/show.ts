import type { Expectation, ExceptionRecord, JournalEntryJson, Movement, StoreReader } from '@nostro-labs/nostro'
import { allocationJson, exceptionJson, expectationJson, movementDetail } from '@nostro-labs/nostro'
import { COMMON, CliError, UsageError, flag, positionals, tenant } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, withStore } from '../command.js'
import { assetLabel, memoLabel, money, when } from '../format.js'
import { clean, json, write } from '../io.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What `show` found for the id or reference it was given. */
export type Found =
  | { readonly kind: 'movement'; readonly movement: Movement }
  | { readonly kind: 'exception'; readonly exception: ExceptionRecord }
  | { readonly kind: 'expectation'; readonly expectation: Expectation }

/**
 * Finds the record for an id or reference. An id is tried as a movement, then
 * an exception, then an expectation; a reference is tried only when no id
 * matched. An id that matches two kinds is refused rather than guessed at.
 */
export async function locate(store: StoreReader, tenantId: string, given: string): Promise<Found> {
  const matches: Found[] = []
  if (UUID.test(given)) {
    const movement = await store.getMovement(tenantId, given)
    if (movement !== null) matches.push({ kind: 'movement', movement })
    const exception = await store.getException(tenantId, given)
    if (exception !== null) matches.push({ kind: 'exception', exception })
    const expectation = await store.getExpectation(tenantId, given)
    if (expectation !== null) matches.push({ kind: 'expectation', expectation })
  }
  if (matches.length > 1) {
    throw new CliError(`${JSON.stringify(given)} matches more than one record; nothing is shown.`)
  }
  if (matches.length === 1) return matches[0]!
  const byReference = await store.getExpectationByReference(tenantId, given)
  if (byReference !== null) return { kind: 'expectation', expectation: byReference }
  throw new CliError(`No movement, exception or expectation matches ${JSON.stringify(given)}.`)
}

export const show: Command = {
  name: 'show',
  summary: "Trace one payment: its movement, allocations, exceptions and journal, or an expectation's payments",
  usage: '<id-or-reference> [options]',
  help: `Takes a movement id, an exception id, an expectation id, or an expectation reference (its invoice
number, say), and prints the record with everything linked to it.

A movement shows its allocations, exceptions, journal entries and decision. An exception shows its
movement and expectation. An expectation shows the allocations that paid it and its exceptions.
An id that matches more than one kind is refused, not guessed at.

--json for a movement prints the same shape as GET /v1/movements/:id.

Options:
${COMMON_HELP}`,
  options: { ...COMMON },
  async run(args, io) {
    const [given] = positionals(args, 1)
    if (given === undefined) throw new UsageError('Give a movement id, exception id, expectation id or reference.')
    const tenantId = tenant(args, io)
    const asJson = flag(args, 'json')

    return withStore(args, io, async (store) => {
      const found = await locate(store, tenantId, given)

      if (found.kind === 'movement') {
        const detail = await movementDetail({ store, tenantId, movement: found.movement })
        if (asJson) {
          await write(io.stdout, json(detail))
          return 0
        }
        const m = found.movement
        await write(
          io.stdout,
          lines([
            `Movement ${m.id}`,
            `  ${m.direction} ${money(m.amount)}   occurred ${when(m.occurredAt)} UTC   ledger ${m.ledger}   ${m.disposition}`,
            `  counterparty ${clean(m.counterparty ?? '-')}   memo ${clean(memoLabel(m.memo) || '-')}`,
            `  account ${clean(m.account)}   transaction ${clean(m.txHash ?? '-')}`,
            section('Allocations', detail.allocations.map((a) => allocationLine({ expectationId: a.expectationId, strategy: a.strategy, score: a.score, amountText: `${a.amount} ${assetLabel(a.asset)}` }))),
            section('Exceptions', detail.exceptions.map((x) => `${x.code} ${x.status}: ${clean(x.detail)}`)),
            section('Journal', detail.journal.map((j) => journalLine(j))),
            detail.decision === null ? '' : 'Decision: recorded (see --json for the snapshot)',
          ]),
        )
        return 0
      }

      if (found.kind === 'exception') {
        const x = found.exception
        const movement = x.movementId === null ? null : await store.getMovement(tenantId, x.movementId)
        const expectation = x.expectationId === null ? null : await store.getExpectation(tenantId, x.expectationId)
        if (asJson) {
          const detail = movement === null ? null : await movementDetail({ store, tenantId, movement })
          await write(
            io.stdout,
            json({
              exception: exceptionJson(x),
              movement: detail,
              expectation: expectation === null ? null : expectationJson(expectation),
            }),
          )
          return 0
        }
        await write(
          io.stdout,
          lines([
            `Exception ${x.id}`,
            `  ${x.code} ${x.status}, opened ${when(x.openedAt)} UTC`,
            `  ${clean(x.detail)}`,
            movement === null ? '' : `  movement ${movement.id}: ${money(movement.amount)} from ${clean(movement.counterparty ?? '-')}`,
            expectation === null ? '' : `  expectation ${clean(expectation.reference)}: ${money(expectation.amount)}`,
          ]),
        )
        return 0
      }

      const e = found.expectation
      const allocations = await store.listAllocations({ tenantId, expectationId: e.id })
      const exceptions = await store.listExceptions({ tenantId, expectationId: e.id })
      if (asJson) {
        await write(
          io.stdout,
          json({
            expectation: expectationJson(e),
            allocations: allocations.map(allocationJson),
            exceptions: exceptions.map(exceptionJson),
          }),
        )
        return 0
      }
      await write(
        io.stdout,
        lines([
          `Expectation ${clean(e.reference)} (${e.id})`,
          `  ${e.direction} ${money(e.amount)}   status ${e.status}   account ${clean(e.account)}`,
          section('Paid by', allocations.map((a) => allocationLine({ expectationId: a.expectationId, strategy: a.strategy, score: a.score, amountText: money(a.amount) }))),
          section('Exceptions', exceptions.map((x) => `${x.code} ${x.status}: ${clean(x.detail)}`)),
        ]),
      )
      return 0
    })
  },
}

/** Joins the non-empty lines, with a trailing newline. */
const lines = (parts: readonly string[]): string => `${parts.filter((p) => p !== '').join('\n')}\n`

/** A titled, indented block; empty when there is nothing to list. */
function section(title: string, items: readonly string[]): string {
  return items.length === 0 ? '' : `${title}:\n${items.map((i) => `  ${i}`).join('\n')}`
}

const allocationLine = (a: { expectationId: string; strategy: string; score: number | null; amountText: string }): string =>
  `${a.amountText} to ${clean(a.expectationId)} via ${clean(a.strategy)}${a.score === null ? '' : `, score ${a.score.toFixed(2)}`}`

const journalLine = (j: JournalEntryJson): string =>
  `#${j.postingNo ?? '-'} ${j.effectiveAt.slice(0, 16).replace('T', ' ')} ${clean(j.description)} (${j.lines.length} lines)`
