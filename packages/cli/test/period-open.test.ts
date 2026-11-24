import { describe, expect, it } from 'vitest'
import { FakeHorizon } from 'nostro-testkit'
import { A, B, migrated, nostro } from './helpers.js'

const post = (...more: string[]) => ['journal', 'post', '--description', 'd', '--reason', 'r', '--line', 'a:other:debit:1', '--line', 'b:other:credit:1', ...more]

describe('nostro period', () => {
  it('closes through a whole UTC day, refuses entries in it, and reopens with a reason', async () => {
    const cwd = await migrated()
    expect(await nostro(cwd, ['period', 'close', '--through', '2026-09-30', '--note', 'Q3'])).toMatchObject({ code: 0, stdout: 'Closed default through 2026-09-30T23:59:59.999Z.\n' })
    expect((await nostro(cwd, post('--effective-at', '2026-09-30T23:00:00Z'))).code).not.toBe(0)
    expect((await nostro(cwd, post('--effective-at', '2026-10-01'))).code).toBe(0)
    expect(await nostro(cwd, ['period', 'reopen', '--reason', 'late invoice'])).toMatchObject({ code: 0, stdout: 'Reopened default: late invoice\n' })
    expect((await nostro(cwd, post('--effective-at', '2026-09-30T23:00:00Z'))).code).toBe(0)
    const closed = JSON.parse((await nostro(cwd, ['period', 'close', '--through', '2026-09-30T12:00:00Z', '--json'])).stdout)
    expect(closed).toEqual({ action: 'closed', tenantId: 'default', through: '2026-09-30T12:00:00.000Z', note: null })
    expect(JSON.parse((await nostro(cwd, ['period', 'reopen', '--reason', 'x', '--json'])).stdout)).toEqual({ action: 'reopened', tenantId: 'default', reason: 'x' })
  })

  it('refuses options that belong to the other action, or are missing', async () => {
    const cwd = await migrated()
    for (const [argv, message] of [
      [[], 'Use "nostro period close"'],
      [['close'], 'requires --through'],
      [['close', '--through', '2026-09-30', '--reason', 'x'], '--reason only applies to period reopen'],
      [['reopen'], 'requires --reason'],
      [['reopen', '--reason', 'x', '--note', 'n'], 'only apply to period close'],
    ] as const) {
      const run = await nostro(cwd, ['period', ...argv])
      expect(run.code, argv.join(' ')).toBe(2)
      expect(run.stderr, argv.join(' ')).toContain(message)
    }
  })
})

describe('nostro open', () => {
  it('prints the opening balances, and refuses an account it cannot open from', async () => {
    const cwd = await migrated()
    const h = new FakeHorizon()
    h.latestLedger = 100
    h.accounts.set(A, { id: A, last_modified_ledger: 90, balances: [{ balance: '10', asset_type: 'native' }] })
    const open = (...argv: string[]) => nostro(cwd, ['open', ...argv], { fetch: h.fetch })
    const run = await open('--account', A)
    expect(run.code, run.stderr).toBe(0)
    expect(run.stdout).toMatch(new RegExp(`^ACCOUNT +NETWORK +LEDGER +ASSET +BALANCE +LAST CHANGED\\n${A}  testnet  100 +XLM +10\\.0000000  90\\n$`))
    expect((await open('--account', A, '--account', B)).stderr).toContain('exactly one --account')
    expect((await open('--account', B)).code).not.toBe(0)
    h.accounts.set(B, { id: B, last_modified_ledger: 90, balances: [] })
    expect(await open('--account', B)).toMatchObject({ code: 2, stderr: expect.stringContaining('has no on-chain balances') })
  })
})
