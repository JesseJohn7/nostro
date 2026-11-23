import type { Schedule, ScheduleCadence, NewExpectation } from '../model/index.js'
import type { Store } from '../store/store.js'
import { ConstraintError } from '../store/store.js'

export interface GenerateExpectationsOptions {
  readonly store: Store
  readonly tenantId: string
  readonly until: Date
}

export interface GenerateExpectationsResult {
  readonly created: number
  readonly schedules: number
}

function pad(n: number): string { return String(n).padStart(2, '0') }

function periodKey(cadence: ScheduleCadence, at: Date): string {
  const y = at.getUTCFullYear()
  const m = at.getUTCMonth() + 1
  const d = at.getUTCDate()
  if (cadence.type === 'daily') return `${y}-${pad(m)}-${pad(d)}`
  if (cadence.type === 'monthly') return `${y}-${pad(m)}`
  const date = new Date(Date.UTC(y, m - 1, d))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${date.getUTCFullYear()}-W${pad(week)}`
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
}

function nextOccurrence(cadence: ScheduleCadence, after: Date): Date {
  if (cadence.type === 'daily') return new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate() + 1))
  if (cadence.type === 'weekly') {
    const base = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate()))
    const dow = base.getUTCDay()
    let delta = (cadence.dayOfWeek - dow + 7) % 7
    if (delta === 0) delta = 7
    return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + delta))
  }
  const y = after.getUTCFullYear()
  const m = after.getUTCMonth() + 1
  return new Date(Date.UTC(y, m, Math.min(cadence.dayOfMonth, daysInMonth(y, m))))
}

function firstOccurrence(cadence: ScheduleCadence, startAt: Date): Date {
  const base = new Date(Date.UTC(startAt.getUTCFullYear(), startAt.getUTCMonth(), startAt.getUTCDate()))
  if (cadence.type === 'daily') return base
  if (cadence.type === 'weekly') {
    const dow = base.getUTCDay()
    const delta = (cadence.dayOfWeek - dow + 7) % 7
    return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + delta))
  }
  const y = base.getUTCFullYear()
  const m = base.getUTCMonth()
  const candidate = new Date(Date.UTC(y, m, Math.min(cadence.dayOfMonth, daysInMonth(y, m))))
  if (candidate.getTime() < base.getTime()) return new Date(Date.UTC(y, m + 1, Math.min(cadence.dayOfMonth, daysInMonth(y, m + 1))))
  return candidate
}

function renderReference(pattern: string, period: string): string { return pattern.replaceAll('{period}', period) }

export function scheduleOccurrences(sc: Schedule, until: Date): { at: Date; period: string; reference: string }[] {
  const end = sc.endAt && sc.endAt.getTime() < until.getTime() ? sc.endAt : until
  let cur = firstOccurrence(sc.cadence, sc.startAt)
  const out: { at: Date; period: string; reference: string }[] = []
  let guard = 0
  while (cur.getTime() <= end.getTime() && guard++ < 10000) {
    const period = periodKey(sc.cadence, cur)
    out.push({ at: cur, period, reference: renderReference(sc.referencePattern, period) })
    cur = nextOccurrence(sc.cadence, cur)
  }
  return out
}

export async function generateExpectations(opts: GenerateExpectationsOptions): Promise<GenerateExpectationsResult> {
  const schedules = await opts.store.listSchedules({ tenantId: opts.tenantId, activeOnly: true })
  let created = 0
  for (const sc of schedules) {
    if (sc.endedAt) continue
    for (const occ of scheduleOccurrences(sc, opts.until)) {
      const existing = await opts.store.getExpectationByReference(opts.tenantId, occ.reference)
      if (existing) continue
      const n: NewExpectation = {
        tenantId: sc.tenantId,
        reference: occ.reference,
        account: sc.account,
        direction: sc.direction,
        amount: sc.amount,
        ...(sc.memo ? { memo: sc.memo } : {}),
        payers: [...sc.payers],
        metadata: { scheduleId: sc.id, schedulePeriod: occ.period },
      }
      try {
        await opts.store.transaction(async (tx) => {
          const again = await tx.getExpectationByReference(opts.tenantId, occ.reference)
          if (again) return
          await tx.insertExpectation(n)
        })
        const check = await opts.store.getExpectationByReference(opts.tenantId, occ.reference)
        if (check) created++
      } catch (e) {
        if (e instanceof ConstraintError && e.constraint === 'expectation_reference_unique') continue
        throw e
      }
    }
  }
  return { created, schedules: schedules.length }
}
