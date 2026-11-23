import { describe, expect, it } from 'vitest'
import { FakeHorizon } from 'nostro-testkit'
import { A, B, migrated, nostro, startServe } from './helpers.js'

/** Sync one payment from B to A with the given memo, after an expectation for it. */
async function workspace(payments: { ledger: number; amount: string; memo?: string }[], expectation?: { reference: string; amount: string }) {
  const h = new FakeHorizon()
  for (const p of payments) h.payment(p.ledger, B, A, p.amount, p.memo === undefined ? {} : { memo: p.memo })
  const cwd = await migrated()
  const synced = await nostro(cwd, ['sync', '--account', A], { fetch: h.fetch })
  if (synced.code !== 0) throw new Error(synced.stderr)
  if (expectation !== undefined) {
    const made = await nostro(cwd, ['expect', expectation.reference, '--account', A, '--amount', expectation.amount])
    if (made.code !== 0) throw new Error(made.stderr)
  }
  const reconciled = await nostro(cwd, ['reconcile'])
  if (reconciled.code !== 0) throw new Error(reconciled.stderr)
  return cwd
}

async function firstMovementId(cwd: string): Promise<string> {
  const listed = JSON.parse((await nostro(cwd, ['movements', '--json'])).stdout) as { id: string }[]
  return listed[0]!.id
}

describe('nostro movements', () => {
  it('lists movements with their disposition and memo', async () => {
    const cwd = await workspace([{ ledger: 10, amount: '25', memo: 'inv #1042' }], { reference: 'INV-1042', amount: '25' })
    const run = await nostro(cwd, ['movements'])
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('allocated')
    expect(run.stdout).toContain('text: inv #1042')
  })

  it('filters by disposition and refuses an unknown one', async () => {
    const cwd = await workspace([{ ledger: 10, amount: '25', memo: 'inv #1042' }], { reference: 'INV-1042', amount: '25' })
    expect((await nostro(cwd, ['movements', '--disposition', 'ignored'])).stdout).toBe('No movements.\n')
    const bad = await nostro(cwd, ['movements', '--disposition', 'settled'])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('--disposition takes')
  })
})

describe('nostro show', () => {
  it('traces a movement to its allocation and journal', async () => {
    const cwd = await workspace([{ ledger: 10, amount: '25', memo: 'inv #1042' }], { reference: 'INV-1042', amount: '25' })
    const run = await nostro(cwd, ['show', await firstMovementId(cwd)])
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('Allocations:')
    expect(run.stdout).toContain('via')
    expect(run.stdout).toContain('Journal:')
  })

  it('shows an expectation by its reference, with the movement that paid it', async () => {
    const cwd = await workspace([{ ledger: 10, amount: '25', memo: 'inv #1042' }], { reference: 'INV-1042', amount: '25' })
    const run = await nostro(cwd, ['show', 'INV-1042'])
    expect(run.code).toBe(0)
    expect(run.stdout).toMatch(/^Expectation INV-1042 /)
    expect(run.stdout).toContain('Paid by:')
  })

  it('shows an exception with its movement, after an overpayment', async () => {
    const cwd = await workspace([{ ledger: 10, amount: '30' }], { reference: 'INV-1042', amount: '25' })
    const listed = JSON.parse((await nostro(cwd, ['exceptions', '--json'])).stdout) as { id: string; code: string }[]
    const overpayment = listed.find((x) => x.code === 'OVERPAYMENT')
    expect(overpayment).toBeDefined()
    const run = await nostro(cwd, ['show', overpayment!.id])
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('OVERPAYMENT open')
    expect(run.stdout).toContain('movement ')
  })

  it('exits 1 with a clear message for an unknown id', async () => {
    const cwd = await workspace([{ ledger: 10, amount: '25' }])
    const run = await nostro(cwd, ['show', '00000000-0000-4000-8000-000000000000'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('No movement, exception or expectation matches')
  })

  it('escapes control characters in a payer memo', async () => {
    const cwd = await workspace([{ ledger: 10, amount: '25', memo: 'a\u0007b' }])
    const run = await nostro(cwd, ['show', await firstMovementId(cwd)])
    expect(run.stdout).toContain('\\u0007')
    expect(run.stdout).not.toContain('\u0007')
  })

  it('prints the same JSON as GET /v1/movements/:id for the same movement', async () => {
    const cwd = await workspace([{ ledger: 10, amount: '25', memo: 'inv #1042' }], { reference: 'INV-1042', amount: '25' })
    const id = await firstMovementId(cwd)
    const shown = JSON.parse((await nostro(cwd, ['show', id, '--json'])).stdout)

    const server = await startServe(cwd, [])
    try {
      const response = await server.get(`/v1/movements/${id}`)
      expect(response.status).toBe(200)
      expect(shown).toEqual(await response.json())
    } finally {
      await server.stop()
    }
  })
})
