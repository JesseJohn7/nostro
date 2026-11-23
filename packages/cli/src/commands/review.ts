import type { ExceptionCode, ExceptionDecision, ExceptionRecord, Movement } from '@nostro-labs/nostro'
import { EXCEPTION_CODES, ConstraintError, NotFoundError, PrecisionError, ValidationError, decideException } from '@nostro-labs/nostro'
import { COMMON, UsageError, string, tenant } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, withStore } from '../command.js'
import { assetLabel, memoLabel, money, when } from '../format.js'
import { clean, write } from '../io.js'
import type { Io } from '../io.js'

const PAGE = 50
const AMOUNT = /^[0-9]+(\.[0-9]+)?$/

/** One candidate expectation from the exception's evidence, as the decision engine recorded it. */
export interface Candidate {
  readonly reference: string
  readonly remaining: string
  readonly asset: string
  readonly score: number
  readonly reasons: readonly string[]
}

/**
 * Reads the candidates from the evidence. The engine writes `{ candidates: [...] }`. Anything else
 * returns null, and the review says so instead of guessing at the shape.
 */
export function candidatesOf(evidence: unknown): Candidate[] | null {
  if (typeof evidence !== 'object' || evidence === null) return null
  const list = (evidence as { candidates?: unknown }).candidates
  if (!Array.isArray(list)) return null
  const out: Candidate[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const c = item as Record<string, unknown>
    if (typeof c.reference !== 'string' || typeof c.remaining !== 'string' || typeof c.score !== 'number') continue
    const signals = Array.isArray(c.signals) ? (c.signals as unknown[]) : []
    const reasons = signals.flatMap((s) => {
      const reason = typeof s === 'object' && s !== null ? (s as Record<string, unknown>).reason : undefined
      return typeof reason === 'string' ? [reason] : []
    })
    out.push({
      reference: c.reference,
      remaining: c.remaining,
      asset: typeof c.asset === 'string' ? c.asset : '',
      score: c.score,
      reasons,
    })
  }
  return out
}

/** What the review shows for one exception. Every payer-written string is cleaned. */
export function describe(x: ExceptionRecord, movement: Movement | null, candidates: Candidate[] | null): string {
  const lines = [`${x.code}  ${x.status}  opened ${when(x.openedAt)} UTC  (${x.id})`, `  ${clean(x.detail)}`]
  if (movement !== null) {
    lines.push(
      `  payment: ${movement.direction} ${money(movement.amount)} from ${clean(movement.counterparty ?? '-')}`,
      `  memo: ${clean(memoLabel(movement.memo) || '-')}   ledger ${movement.ledger}   transaction ${clean(movement.txHash ?? '-')}`,
    )
  }
  if (candidates === null) {
    lines.push('  evidence: not in a form this review shows (see "nostro exceptions --json")')
  } else if (candidates.length === 0) {
    lines.push('  candidates: none')
  } else {
    lines.push('  candidates:')
    candidates.forEach((c, i) => {
      const reasons = c.reasons.length === 0 ? '' : `  (${c.reasons.map(clean).join('; ')})`
      lines.push(`    ${i + 1}. ${clean(c.reference)}  owing ${clean(c.remaining)} ${clean(c.asset)}  score ${c.score.toFixed(2)}${reasons}`)
    })
  }
  return `${lines.join('\n')}\n`
}

type Ask = (question: string) => Promise<string | null>
type Action = 'apply-candidate' | 'apply-reference' | 'ignore' | 'close' | 'dismiss' | 'skip' | 'quit'

/** Asks until the answer is a known action. End of input means quit. */
async function chooseAction(ask: Ask, out: Io['stdout'], hasCandidates: boolean): Promise<Action> {
  const menu = hasCandidates
    ? '[a] apply to candidate  [r] apply to a reference  [i] ignore  [c] close  [d] dismiss  [s] skip  [q] quit'
    : '[r] apply to a reference  [i] ignore  [c] close  [d] dismiss  [s] skip  [q] quit'
  for (;;) {
    const answer = await ask(`${menu}\n> `)
    if (answer === null) return 'quit'
    switch (answer.trim().toLowerCase()) {
      case 'q':
      case 'quit':
        return 'quit'
      case 's':
      case 'skip':
        return 'skip'
      case 'i':
      case 'ignore':
        return 'ignore'
      case 'c':
      case 'close':
        return 'close'
      case 'd':
      case 'dismiss':
        return 'dismiss'
      case 'r':
      case 'reference':
        return 'apply-reference'
      case 'a':
      case 'apply':
        if (hasCandidates) return 'apply-candidate'
        await write(out, 'There are no candidates; use r to type a reference.\n')
        break
      default:
        await write(out, 'Choose one of the letters shown.\n')
    }
  }
}

/** A non-empty note, asked until one is given. Null when input has ended. */
async function askNote(ask: Ask, out: Io['stdout']): Promise<string | null> {
  for (;;) {
    const answer = await ask('Note (required, why this is right): ')
    if (answer === null) return null
    if (answer.trim() !== '') return answer.trim()
    await write(out, 'A note is required.\n')
  }
}

/** A payment amount, '' for "all it still owes", or undefined when input has ended. */
async function askAmount(ask: Ask, out: Io['stdout']): Promise<string | undefined> {
  for (;;) {
    const answer = await ask('Amount (blank for all it still owes): ')
    if (answer === null) return undefined
    const trimmed = answer.trim()
    if (trimmed === '' || AMOUNT.test(trimmed)) return trimmed
    await write(out, 'An amount is digits, optionally with a decimal point, e.g. 25 or 25.5.\n')
  }
}

async function askCandidate(ask: Ask, out: Io['stdout'], count: number): Promise<number | null> {
  for (;;) {
    const answer = await ask(`Candidate (1-${count}): `)
    if (answer === null) return null
    const n = Number(answer.trim())
    if (Number.isInteger(n) && n >= 1 && n <= count) return n
    await write(out, `Type a number from 1 to ${count}.\n`)
  }
}

async function askReference(ask: Ask, out: Io['stdout']): Promise<string | null> {
  for (;;) {
    const answer = await ask('Invoice reference: ')
    if (answer === null) return null
    if (answer.trim() !== '') return answer.trim()
    await write(out, 'A reference is needed.\n')
  }
}

/** The decision for a chosen action, or null when input ended partway. */
async function buildDecision(
  action: 'apply-candidate' | 'apply-reference' | 'ignore' | 'close' | 'dismiss',
  ask: Ask,
  out: Io['stdout'],
  candidates: readonly Candidate[],
): Promise<ExceptionDecision | null> {
  if (action === 'ignore' || action === 'close' || action === 'dismiss') {
    const note = await askNote(ask, out)
    if (note === null) return null
    if (action === 'ignore') return { action: 'ignore', note }
    return { action: 'close', status: action === 'dismiss' ? 'dismissed' : 'resolved', note }
  }
  let reference: string | null
  if (action === 'apply-candidate') {
    const pick = await askCandidate(ask, out, candidates.length)
    if (pick === null) return null
    reference = candidates[pick - 1]!.reference
  } else {
    reference = await askReference(ask, out)
    if (reference === null) return null
  }
  const amount = await askAmount(ask, out)
  if (amount === undefined) return null
  const note = await askNote(ask, out)
  if (note === null) return null
  return { action: 'apply', allocations: [amount === '' ? { reference } : { reference, amount }], note }
}

export const review: Command = {
  name: 'review',
  summary: 'Work through open exceptions one at a time, in a terminal',
  usage: '[options]',
  help: `Walks through the open exceptions, oldest first. For each one it shows the payment, the exception and
the candidate invoices the engine found, then asks what to do:

  a  apply the payment to a candidate, by its number, optionally for an amount
  r  apply the payment to an invoice you type, optionally for an amount
  i  ignore it: this is not something to reconcile
  c  close it as resolved;  d  close it as dismissed
  s  skip it for now;  q  stop here, leaving the rest untouched

A note is always required. Every choice goes through the rules "nostro resolve" uses: a refusal is shown
with its reason and changes nothing, and so does a change someone else made while it was on screen.

Needs a terminal on standard input and output. In scripts, use "nostro resolve".

Options:
  --code <CODE>       Only exceptions with this reason, e.g. AMBIGUOUS_MATCH
${COMMON_HELP}`,
  options: { ...COMMON, code: { type: 'string' } },
  async run(args, io) {
    if (!io.interactive || io.prompt === undefined) {
      throw new UsageError('nostro review needs a terminal on standard input and output. In scripts, use "nostro resolve".')
    }
    const prompt = io.prompt
    const ask: Ask = (question) => prompt(question)
    const tenantId = tenant(args, io)
    const code = string(args, 'code')
    if (code !== undefined && !(EXCEPTION_CODES as readonly string[]).includes(code)) {
      throw new UsageError(`--code takes one of ${EXCEPTION_CODES.join(', ')}; not ${JSON.stringify(code)}.`)
    }

    return withStore(args, io, async (store) => {
      let seq: number | undefined
      let reviewed = 0
      let decided = 0
      let quit = false
      while (!quit) {
        const page = await store.listExceptions({
          tenantId,
          status: 'open',
          limit: PAGE,
          ...(code === undefined ? {} : { code: code as ExceptionCode }),
          ...(seq === undefined ? {} : { afterSeq: seq }),
        })
        if (page.length === 0) break
        for (const x of page) {
          seq = x.seq
          reviewed++
          const movement = x.movementId === null ? null : await store.getMovement(tenantId, x.movementId)
          const candidates = candidatesOf(x.evidence)
          await write(io.stdout, `\n${describe(x, movement, candidates)}`)
          const action = await chooseAction(ask, io.stdout, (candidates?.length ?? 0) > 0)
          if (action === 'quit') {
            quit = true
            break
          }
          if (action === 'skip') continue
          const decision = await buildDecision(action, ask, io.stdout, candidates ?? [])
          if (decision === null) {
            quit = true
            break
          }
          try {
            const report = await decideException({ store, tenantId, exceptionId: x.id, decision })
            decided++
            await write(io.stdout, outcome(report))
          } catch (err) {
            if (err instanceof ValidationError || err instanceof PrecisionError) {
              await write(io.stdout, `Refused: ${clean(err.message)} Nothing was changed.\n`)
            } else if (err instanceof ConstraintError) {
              await write(io.stdout, `Not applied: ${clean(err.message)} Someone else changed it; moving on.\n`)
            } else if (err instanceof NotFoundError) {
              await write(io.stdout, `Not applied: no ${clean(err.entity)} ${clean(err.id)}.\n`)
            } else {
              throw err
            }
          }
        }
        if (page.length < PAGE) break
      }
      await write(io.stdout, reviewed === 0 ? 'No open exceptions.\n' : `Reviewed ${reviewed}, decided ${decided}.\n`)
      return 0
    })
  },
}

/** What a decision did, in the words "nostro resolve" uses. */
function outcome(report: Awaited<ReturnType<typeof decideException>>): string {
  let out = ''
  for (const a of report.allocations) out += `Applied ${a.amount.toString()} ${assetLabel(a.amount.asset)}.\n`
  if (report.movement !== null) out += `Movement ${report.movement.id} is now ${report.movement.disposition}.\n`
  for (const x of report.closed) out += `Exception ${x.id} (${x.code}) is ${x.status}.\n`
  if (report.opened !== null && report.opened.amount !== null) {
    out += `Still open: ${report.opened.code} for ${report.opened.amount.toString()} ${assetLabel(report.opened.amount.asset)}.\n`
  }
  return out === '' ? 'Done.\n' : out
}
