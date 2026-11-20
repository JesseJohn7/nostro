import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SqliteStore } from '@nostro-labs/store-sqlite'
import { FakeHorizon } from 'nostro-testkit'
import { A, B, migrated, nostro } from './helpers.js'

const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

/** A synced workspace: A is paid 25 XLM for INV-1042, then pays B 5 XLM and the fee. */
async function synced(): Promise<string> {
  const h = new FakeHorizon()
  h.payment(10, B, A, '25', { memo: 'inv #1042' })
  h.payment(11, A, B, '5', { memo: 'refund' })
  const cwd = await migrated()
  const { code, stderr } = await nostro(cwd, ['sync', '--account', A], { fetch: h.fetch })
  if (code !== 0) throw new Error(stderr)
  return cwd
}

describe('nostro expect', () => {
  it('records what is owed, which reconcile then settles from the memo', async () => {
    const cwd = await synced()
    const run = await nostro(cwd, ['expect', 'INV-1042', '--account', A, '--amount', '25'])
    expect(run).toMatchObject({ code: 0, stdout: `Recorded INV-1042: 25.0000000 XLM owed to ${A}.\n` })
    await nostro(cwd, ['expect', 'INV-1043', '--account', A, '--amount', '10', '--asset', 'xlm', '--due', '2026-11-30'])
    expect((await nostro(cwd, ['reconcile'])).stdout).toMatch(/^Decided 3 movement\(s\): 1 allocated,/)

    const listed = await nostro(cwd, ['expectations'])
    expect(listed.stdout.split('\n')).toEqual([
      'REFERENCE  STATUS   AMOUNT      PAID        ASSET  DUE         ACCOUNT',
      `INV-1042   settled  25.0000000  25.0000000  XLM                ${A}`,
      `INV-1043   open     10.0000000  0.0000000   XLM    2026-11-30  ${A}`,
      '',
    ])
    expect((await nostro(cwd, ['expectations', '--status', 'open,partially_paid'])).stdout).not.toContain('INV-1042')
    expect((await nostro(cwd, ['expectations', '--account', B])).stdout).toBe('No expectations.\n')
    const asJson = JSON.parse((await nostro(cwd, ['expectations', '--json', '--limit', '1'])).stdout)
    expect(asJson).toEqual([expect.objectContaining({ reference: 'INV-1042', amount: '25.0000000', paid: '25.0000000', status: 'settled' })])
  })

  it('takes every field, and prints them exactly in JSON', async () => {
    const cwd = await migrated()
    const run = await nostro(cwd, [
      'expect',
      'PAYROLL-7',
      '--account', A,
      '--amount', '1200.5',
      '--asset', `USDC:${ISSUER}`,
      '--debit',
      '--muxed-id', '18446744073709551615',
      '--memo-id', '7',
      '--payer', B,
      '--due', '2026-11-01',
      '--expires', '2026-12-01T17:00:00+01:00',
      '--meta', 'po=77',
      '--meta', 'note=a=b',
      '--json',
    ]) // prettier-ignore
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout)).toMatchObject({
      reference: 'PAYROLL-7',
      account: A,
      direction: 'debit',
      amount: '1200.5000000',
      paid: '0.0000000',
      asset: `USDC:${ISSUER}`,
      muxedId: '18446744073709551615',
      memo: { type: 'id', value: '7' },
      payers: [B],
      dueAt: '2026-11-01T00:00:00.000Z',
      expiresAt: '2026-12-01T16:00:00.000Z',
      status: 'open',
      metadata: { po: '77', note: 'a=b' },
    })
    const listed = await nostro(cwd, ['expectations'])
    expect(listed.stdout).toContain(`PAYROLL-7  open (debit)  1200.5000000  0.0000000  USDC:${ISSUER}  2026-11-01`)
    const text = await nostro(cwd, ['expect', 'PAYROLL-8', '--account', A, '--amount', '1', '--debit', '--memo-text', 'May payroll'])
    expect(text.stdout).toBe(`Recorded PAYROLL-8: 1.0000000 XLM to pay from ${A}.\n`)
  })

  it('issues sequential muxed ids for an account, scoped by tenant', async () => {
    const cwd = await migrated()
    const first = await nostro(cwd, ['expect', 'INV-1', '--account', A, '--amount', '10', '--issue-muxed-id'])
    expect(first).toMatchObject({ code: 0, stdout: `Recorded INV-1: 10.0000000 XLM owed to ${A} (muxed id 1).\n` })
    await nostro(cwd, ['expect', 'INV-2', '--account', A, '--amount', '10', '--muxed-id', '10'])
    const second = await nostro(cwd, ['expect', 'INV-3', '--account', A, '--amount', '20', '--issue-muxed-id', '--json'])
    expect(JSON.parse(second.stdout)).toMatchObject({ reference: 'INV-3', account: A, muxedId: '11', status: 'open' })
    const other = await nostro(cwd, ['expect', 'INV-4', '--account', B, '--amount', '20', '--issue-muxed-id', '--json'])
    expect(JSON.parse(other.stdout)).toMatchObject({ reference: 'INV-4', account: B, muxedId: '1' })
    const elsewhere = await nostro(cwd, ['expect', 'INV-5', '--account', A, '--amount', '20', '--issue-muxed-id', '--tenant', 'acme', '--json'])
    expect(JSON.parse(elsewhere.stdout)).toMatchObject({ reference: 'INV-5', muxedId: '1' })
    const listed = await nostro(cwd, ['expectations', '--json'])
    expect(JSON.parse(listed.stdout).map((e: { muxedId: string | null }) => e.muxedId)).toEqual(['1', '10', '11', '1'])
  })

  it('refuses to issue a muxed id past the uint64 range', async () => {
    const cwd = await migrated()
    await nostro(cwd, ['expect', 'MAX', '--account', A, '--amount', '1', '--muxed-id', '18446744073709551615'])
    const run = await nostro(cwd, ['expect', 'NEXT', '--account', A, '--amount', '1', '--issue-muxed-id'])
    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('muxed id')
  })

  it('records a hash memo asked for with --memo-hash', async () => {
    const cwd = await migrated()
    const hash = 'a'.repeat(64)
    const run = await nostro(cwd, ['expect', 'HASH-1', '--account', A, '--amount', '1', '--memo-hash', hash, '--json'])
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout).memo).toEqual({ type: 'hash', value: hash })
  })

  it('refuses a reference already recorded in the tenant, but not in another', async () => {
    const cwd = await migrated()
    const argv = ['expect', 'INV-1', '--account', A, '--amount', '1']
    expect((await nostro(cwd, argv)).code).toBe(0)
    expect(await nostro(cwd, argv)).toMatchObject({
      code: 1,
      stderr: 'nostro: INV-1 is already recorded in this tenant; references are unique.\n',
    })
    expect((await nostro(cwd, [...argv, '--tenant', 'other'])).code).toBe(0)
  })

  it('exits 2, recording nothing, on anything it would have to guess at', async () => {
    const cwd = await migrated()
    const ok = ['--account', A, '--amount', '1']
    for (const [argv, message] of [
      [['--account', A, '--amount', '1'], 'Give the reference'],
      [[' ', ...ok], 'Give the reference'],
      [['R', 'S', ...ok], 'Unexpected argument "S"'],
      [['R', '--amount', '1'], '--account must be the G... account'],
      [['R', '--account', 'M123', '--amount', '1'], '--account must be the G... account'],
      [['R', '--account', A], '--amount is required'],
      [['R', '--account', A, '--amount', 'ten'], '--amount: Invalid amount "ten"'],
      [['R', '--account', A, '--amount', '1.00000001'], 'refusing to round'],
      [['R', '--account', A, '--amount=-1'], 'amount: must be positive'],
      [['R', ...ok, '--asset', 'USDC'], '--asset must be native (or XLM) or CODE:ISSUER, not "USDC"'],
      [['R', ...ok, '--memo-text', 'x', '--memo-id', '1'], 'not both'],
      [['R', ...ok, '--memo-text', 'x'.repeat(29)], '1 to 28 bytes'],
      [['R', ...ok, '--memo-text', '\u00e9'.repeat(15)], '1 to 28 bytes'],
      [['R', ...ok, '--memo-id', '18446744073709551616'], '--memo-id must be a whole number below 2^64'],
      [['R', ...ok, '--memo-hash', 'aa'], '--memo-hash must be exactly 64 lowercase hex characters'],
      [['R', ...ok, '--memo-hash', 'A'.repeat(64)], '--memo-hash must be exactly 64 lowercase hex characters'],
      [['R', ...ok, '--memo-hash', 'g'.repeat(64)], '--memo-hash must be exactly 64 lowercase hex characters'],
      [['R', ...ok, '--memo-hash', 'a'.repeat(64), '--memo-id', '1'], '--memo-hash on its own'],
      [['R', ...ok, '--muxed-id=-1'], '--muxed-id must be a whole number below 2^64'],
      [['R', ...ok, '--muxed-id', '1', '--issue-muxed-id'], 'Give --muxed-id or --issue-muxed-id, not both.'],
      [['R', ...ok, '--payer', 'GABC'], '--payer "GABC" is not a G... account id'],
      [['R', ...ok, '--due', 'tomorrow'], '--due must be a date'],
      [['R', ...ok, '--due', '2026-02-30'], '--due must be a date'],
      [['R', ...ok, '--due', '2026-13-01'], '--due must be a date'],
      [['R', ...ok, '--expires', '2026-10-31T17:00'], '--expires must be a date'],
      [['R', ...ok, '--meta', 'novalue'], '--meta must be key=value'],
      [['R', ...ok, '--meta', '=x'], '--meta must be key=value'],
      [['R'.repeat(257), ...ok], 'reference: must be at most 256 characters'],
    ] as const) {
      const run = await nostro(cwd, ['expect', ...argv])
      expect(run.code, argv.join(' ')).toBe(2)
      expect(run.stderr).toContain(message)
    }
    expect((await nostro(cwd, ['expectations'])).stdout).toBe('No expectations.\n')
    for (const argv of [['--status', 'paid'], ['--account', 'GABC'], ['--limit', '0']]) {
      expect((await nostro(cwd, ['expectations', ...argv])).code).toBe(2)
    }
  })
})

describe('nostro cancel', () => {
  it('cancels an open expectation with a reason, in text or JSON', async () => {
    const cwd = await migrated()
    await nostro(cwd, ['expect', 'INV-1', '--account', A, '--amount', '10'])
    expect(await nostro(cwd, ['cancel', 'INV-1', '--reason', 'customer changed their mind'])).toMatchObject({
      code: 0,
      stdout: 'Cancelled INV-1.\n',
      stderr: '',
    })
    await nostro(cwd, ['expect', 'INV-2', '--account', A, '--amount', '20'])
    const asJson = await nostro(cwd, ['cancel', 'INV-2', '--reason', 'duplicate', '--json'])
    expect(asJson.code).toBe(0)
    expect(JSON.parse(asJson.stdout)).toMatchObject({
      reference: 'INV-2',
      status: 'cancelled',
      cancelReason: 'duplicate',
      paid: '0.0000000',
    })
    const listed = await nostro(cwd, ['expectations', '--status', 'cancelled', '--json'])
    expect(JSON.parse(listed.stdout).map((e: { reference: string }) => e.reference)).toEqual(['INV-1', 'INV-2'])
  })

  it('exits 2 on a bad command line and 1 on a reference it cannot cancel', async () => {
    const cwd = await migrated()
    await nostro(cwd, ['expect', 'INV-1', '--account', A, '--amount', '10'])
    for (const [argv, message] of [
      [[], 'Give the expectation reference'],
      [['INV-1'], '--reason is required'],
      [['INV-1', '--reason', ' '], '--reason is required'],
      [['INV-1', '--reason', 'x', 'extra'], 'Unexpected argument "extra"'],
    ] as const) {
      const run = await nostro(cwd, ['cancel', ...argv])
      expect(run.code, argv.join(' ')).toBe(2)
      expect(run.stderr).toContain(message)
    }
    expect(await nostro(cwd, ['cancel', 'MISSING', '--reason', 'x'])).toMatchObject({
      code: 1,
      stderr: 'nostro: No expectation MISSING.\n',
    })
    expect((await nostro(cwd, ['cancel', 'INV-1', '--reason', 'x'])).code).toBe(0)
    expect((await nostro(cwd, ['cancel', 'INV-1', '--reason', 'x'])).stderr).toContain('already cancelled')
  })

  it('refuses to cancel an expectation with allocations', async () => {
    const cwd = await synced()
    await nostro(cwd, ['expect', 'INV-1042', '--account', A, '--amount', '25'])
    await nostro(cwd, ['reconcile'])
    const run = await nostro(cwd, ['cancel', 'INV-1042', '--reason', 'paid already'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('reverse its allocations before cancelling')
    expect((await nostro(cwd, ['expectations', '--status', 'settled'])).stdout).toContain('INV-1042')
  })
})

describe('nostro amend', () => {
  const C = `G${'C'.repeat(55)}`

  it('changes the mutable fields and prints the resulting status', async () => {
    const cwd = await migrated()
    await nostro(cwd, [
      'expect', 'PAYROLL-7', '--account', A, '--amount', '1200.5',
      '--muxed-id', '5', '--memo-text', 'old', '--payer', B,
      '--due', '2026-11-01', '--expires', '2026-12-01', '--meta', 'po=1',
    ])
    const run = await nostro(cwd, [
      'amend', 'PAYROLL-7', '--reason', 'invoice corrected', '--amount', '1300',
      '--muxed-id', '6', '--memo-id', '42', '--payer', C,
      '--due', '2026-11-15', '--expires', '2026-12-15', '--meta', 'po=2',
    ])
    expect(run).toMatchObject({ code: 0, stdout: 'Amended PAYROLL-7 (open).\n' })
    const body = JSON.parse((await nostro(cwd, ['expectations', '--json'])).stdout)[0]
    expect(body).toMatchObject({
      reference: 'PAYROLL-7',
      account: A,
      direction: 'credit',
      amount: '1300.0000000',
      muxedId: '6',
      memo: { type: 'id', value: '42' },
      payers: [C],
      dueAt: '2026-11-15T00:00:00.000Z',
      expiresAt: '2026-12-15T00:00:00.000Z',
      status: 'open',
      metadata: { po: '2' },
    })
    const cleared = await nostro(cwd, [
      'amend', 'PAYROLL-7', '--reason', 'drop the extras', '--muxed-id', 'none',
      '--clear-memo', '--clear-due', '--clear-expires', '--json',
    ])
    expect(cleared.code).toBe(0)
    expect(JSON.parse(cleared.stdout)).toMatchObject({
      muxedId: null,
      memo: null,
      dueAt: null,
      expiresAt: null,
      payers: [C],
      metadata: { po: '2' },
      status: 'open',
    })
  })

  it('recomputes status against allocations and reports what is paid', async () => {
    const cwd = await synced()
    await nostro(cwd, ['expect', 'INV-1042', '--account', A, '--amount', '40'])
    await nostro(cwd, ['reconcile'])
    expect(JSON.parse((await nostro(cwd, ['expectations', '--json'])).stdout)[0]).toMatchObject({
      status: 'partially_paid',
      paid: '25.0000000',
    })
    const lowered = await nostro(cwd, ['amend', 'INV-1042', '--reason', 'correct amount', '--amount', '30'])
    expect(lowered).toMatchObject({ code: 0, stdout: 'Amended INV-1042 (partially_paid).\n' })
    const again = await nostro(cwd, ['amend', 'INV-1042', '--reason', 'again', '--amount', '31', '--json'])
    expect(JSON.parse(again.stdout)).toMatchObject({ amount: '31.0000000', status: 'partially_paid', paid: '25.0000000' })
  })

  it('refuses to amend a settled expectation', async () => {
    const cwd = await synced()
    await nostro(cwd, ['expect', 'INV-1042', '--account', A, '--amount', '25'])
    await nostro(cwd, ['reconcile'])
    const run = await nostro(cwd, ['amend', 'INV-1042', '--reason', 'late change', '--amount', '30'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('is settled')
  })

  it('refuses to lower an amount below what is allocated', async () => {
    const cwd = await synced()
    await nostro(cwd, ['expect', 'INV-1042', '--account', A, '--amount', '40'])
    await nostro(cwd, ['reconcile'])
    const run = await nostro(cwd, ['amend', 'INV-1042', '--reason', 'down', '--amount', '24'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('is below 25.0000000 already allocated')
  })

  it('maps not-found, constraint and validation failures to their exit codes', async () => {
    const cwd = await migrated()
    await nostro(cwd, ['expect', 'R', '--account', A, '--amount', '10', '--muxed-id', '5'])
    await nostro(cwd, ['expect', 'OTHER', '--account', A, '--amount', '10', '--muxed-id', '6'])
    expect(await nostro(cwd, ['amend', 'MISSING', '--reason', 'x', '--amount', '1'])).toMatchObject({
      code: 1,
      stderr: 'nostro: No expectation MISSING.\n',
    })
    const taken = await nostro(cwd, ['amend', 'R', '--reason', 'x', '--muxed-id', '6'])
    expect(taken.code).toBe(1)
    expect(taken.stderr).toContain('muxed id 6 is already used on account')
    expect((await nostro(cwd, ['cancel', 'OTHER', '--reason', 'x'])).code).toBe(0)
    const cancelled = await nostro(cwd, ['amend', 'OTHER', '--reason', 'x', '--amount', '1'])
    expect(cancelled.code).toBe(1)
    expect(cancelled.stderr).toContain('is cancelled')
  })

  it('exits 2, changing nothing, on anything it would have to guess at', async () => {
    const cwd = await migrated()
    await nostro(cwd, ['expect', 'R', '--account', A, '--amount', '10'])
    for (const [argv, message] of [
      [[], 'Give the expectation reference'],
      [['R', '--amount', '11'], '--reason is required'],
      [['R', '--reason', ' '], '--reason is required'],
      [['R', '--reason', 'x'], 'changes: must include at least one field to change'],
      [['R', '--reason', 'x', '--amount', 'ten'], '--amount: Invalid amount'],
      [['R', '--reason', 'x', '--amount', '1.00000001'], 'refusing to round'],
      [['R', '--reason', 'x', '--amount=-1'], 'amount: must be positive'],
      [['R', '--reason', 'x', '--muxed-id', '18446744073709551616'], '--muxed-id must be a whole number below 2^64'],
      [['R', '--reason', 'x', '--memo-text', 'x'.repeat(29)], '--memo-text must be 1 to 28 bytes'],
      [['R', '--reason', 'x', '--memo-text', 'x', '--memo-id', '1'], 'not both'],
      [['R', '--reason', 'x', '--clear-memo', '--memo-id', '1'], 'Use --clear-memo alone'],
      [['R', '--reason', 'x', '--payer', 'GABC'], 'payers[0]: must be a G... account id'],
      [['R', '--reason', 'x', '--due', 'tomorrow'], '--due must be a date'],
      [['R', '--reason', 'x', '--expires', '2026-10-31T17:00'], '--expires must be a date'],
      [['R', '--reason', 'x', '--meta', 'novalue'], '--meta must be key=value'],
      [['R', '--reason', 'x', 'extra'], 'Unexpected argument "extra"'],
    ] as const) {
      const run = await nostro(cwd, ['amend', ...argv])
      expect(run.code, argv.join(' ')).toBe(2)
      expect(run.stderr).toContain(message)
    }
    const unchanged = JSON.parse((await nostro(cwd, ['expectations', '--json'])).stdout)[0]
    expect(unchanged).toMatchObject({ reference: 'R', amount: '10.0000000', status: 'open' })
  })
})

describe('nostro resolve', () => {
  const openExceptions = async (cwd: string) =>
    JSON.parse((await nostro(cwd, ['exceptions', '--json'])).stdout) as { id: string; code: string; amount: string }[]

  it('applies a payment to an invoice, which settles it and moves it in the books', async () => {
    const cwd = await synced()
    await nostro(cwd, ['reconcile'])
    const credit = (await openExceptions(cwd)).find((x) => x.amount === '25.0000000')!
    await nostro(cwd, ['expect', 'INV-9', '--account', A, '--amount', '25'])

    const run = await nostro(cwd, ['resolve', credit.id, '--apply', 'INV-9', '--note', 'customer called'])
    expect(run).toMatchObject({ code: 0, stderr: '' })
    expect(run.stdout).toMatch(
      /^Applied 25\.0000000 XLM to INV-9\.\nMovement \S+ is now allocated\.\nException \S+ \(UNMATCHED_NO_CANDIDATE\) is resolved\.\nPosted a reclass entry to the journal\.\n$/,
    )
    expect((await nostro(cwd, ['expectations', '--status', 'settled'])).stdout).toContain('INV-9')
    expect((await openExceptions(cwd)).map((x) => x.id)).not.toContain(credit.id)
    expect((await nostro(cwd, ['doctor'])).code).toBe(0)
    expect((await nostro(cwd, ['export'])).stdout).toContain(',reclass,')
  })

  it('splits a payment, with amounts where given, and says what is still open', async () => {
    const cwd = await synced()
    await nostro(cwd, ['reconcile'])
    const credit = (await openExceptions(cwd)).find((x) => x.amount === '25.0000000')!
    await nostro(cwd, ['expect', 'A=1', '--account', A, '--amount', '10'])
    await nostro(cwd, ['expect', 'B', '--account', A, '--amount', '100'])

    const run = await nostro(cwd, ['resolve', credit.id, '--apply', 'A=1=10', '--apply', 'B=5.5', '--note', 'two invoices', '--json'])
    expect(run.code).toBe(0)
    const body = JSON.parse(run.stdout)
    expect(body.allocations.map((a: { amount: string }) => a.amount)).toEqual(['10.0000000', '5.5000000'])
    expect(body).toMatchObject({ movement: { disposition: 'partial' }, opened: { code: 'PARTIAL_UNRESOLVED', amount: '9.5000000' }, journalEntry: { kind: 'reclass' } })

    const rest = await nostro(cwd, ['resolve', body.opened.id, '--ignore', '--note', 'keep the rest'])
    expect(rest.stdout).toMatch(/is now ignored\.\nException \S+ \(PARTIAL_UNRESOLVED\) is dismissed\.\nPosted a reclass entry/)
    expect((await nostro(cwd, ['doctor'])).code).toBe(0)
  })

  it('closes an exception no movement depends on, and refuses one that would strand a movement', async () => {
    const cwd = await synced()
    await nostro(cwd, ['reconcile'])
    const debit = (await openExceptions(cwd)).find((x) => x.code === 'UNEXPECTED_DEBIT')!
    expect(await nostro(cwd, ['resolve', debit.id, '--close', '--note', 'n'])).toMatchObject({ code: 1 })
    expect((await nostro(cwd, ['resolve', debit.id, '--close', '--note', 'n'])).stderr).toMatch(/apply the movement or ignore it instead/)

    const store = new SqliteStore({ filename: join(cwd, 'nostro.db') })
    const about = await store.transaction((tx) => tx.openException({ tenantId: 'default', code: 'MEMO_MALFORMED', account: A, detail: 'x' }))
    await store.close()
    const closed = await nostro(cwd, ['resolve', about.id, '--close', '--dismiss', '--note', 'seen'])
    expect(closed.stdout).toBe(`Exception ${about.id} (MEMO_MALFORMED) is dismissed.\n`)
    const noMovement = await nostro(cwd, ['resolve', about.id, '--apply', 'X', '--note', 'n'])
    expect(noMovement.code).toBe(2)
    expect(noMovement.stderr).toContain('this exception is about no movement')
  })

  it('exits 1 on what the rules refuse, leaving everything alone, and 2 on a bad command line', async () => {
    const cwd = await synced()
    await nostro(cwd, ['reconcile'])
    const credit = (await openExceptions(cwd)).find((x) => x.amount === '25.0000000')!
    await nostro(cwd, ['expect', 'INV-USDC', '--account', A, '--amount', '25', '--asset', `USDC:${ISSUER}`])
    await nostro(cwd, ['expect', 'SMALL', '--account', A, '--amount', '1'])
    for (const [argv, message] of [
      [[credit.id, '--apply', 'NOPE', '--note', 'n'], 'No expectation NOPE.'],
      [['nope', '--ignore', '--note', 'n'], 'No exception nope.'],
      [[credit.id, '--apply', 'INV-USDC', '--note', 'n'], 'allocation_asset'],
      [[credit.id, '--apply', 'SMALL=2', '--note', 'n'], 'allocation_over_expectation'],
    ] as const) {
      const run = await nostro(cwd, ['resolve', ...argv])
      expect(run.code, argv.join(' ')).toBe(1)
      expect(run.stderr).toContain(message)
    }
    expect((await openExceptions(cwd)).map((x) => x.id)).toContain(credit.id)

    for (const [argv, message] of [
      [[], 'Give the exception id'],
      [[credit.id, '--note', 'n'], 'Say what to do'],
      [[credit.id, '--ignore', '--close', '--note', 'n'], 'Say what to do'],
      [[credit.id, '--apply', 'SMALL', '--ignore', '--note', 'n'], 'Say what to do'],
      [[credit.id, '--ignore'], '--note is required'],
      [[credit.id, '--ignore', '--note', ' '], '--note is required'],
      [[credit.id, '--ignore', '--dismiss', '--note', 'n'], '--dismiss only applies with --close'],
      [[credit.id, 'extra', '--ignore', '--note', 'n'], 'Unexpected argument'],
      [[credit.id, '--apply', 'SMALL=1.00000001', '--note', 'n'], 'refusing to round'],
    ] as const) {
      const run = await nostro(cwd, ['resolve', ...argv])
      expect(run.code, argv.join(' ')).toBe(2)
      expect(run.stderr).toContain(message)
    }
  })

  it('escapes a hostile reference in what it prints', async () => {
    const cwd = await synced()
    await nostro(cwd, ['reconcile'])
    const credit = (await openExceptions(cwd)).find((x) => x.amount === '25.0000000')!
    await nostro(cwd, ['expect', 'X\u001b[2J', '--account', A, '--amount', '25'])
    const run = await nostro(cwd, ['resolve', credit.id, '--apply', 'X\u001b[2J', '--note', 'n'])
    expect(run.stdout).toContain('to X\\u001b[2J.')
    expect(run.stdout).not.toContain('\u001b')
  })
})

describe('nostro exceptions', () => {
  it('lists the open exceptions, oldest first, filtered by code or status', async () => {
    const cwd = await synced()
    expect((await nostro(cwd, ['exceptions'])).stdout).toBe('No open exceptions.\n')
    await nostro(cwd, ['reconcile'])
    const open = await nostro(cwd, ['exceptions'])
    const lines = open.stdout.trimEnd().split('\n')
    expect(lines[0]).toMatch(/^OPENED \(UTC\) +CODE +STATUS +AMOUNT +ID +DETAIL$/)
    expect(lines.slice(1).map((l) => l.split(/ {2,}/).slice(1, 4))).toEqual([
      ['UNMATCHED_NO_CANDIDATE', 'open', '25.0000000 XLM'],
      ['UNEXPECTED_DEBIT', 'open', '5.0000000 XLM'],
    ])
    const debits = await nostro(cwd, ['exceptions', '--code', 'UNEXPECTED_DEBIT', '--json'])
    expect(JSON.parse(debits.stdout)).toEqual([
      expect.objectContaining({ code: 'UNEXPECTED_DEBIT', status: 'open', account: A, amount: '5.0000000', asset: 'native' }),
    ])
    expect((await nostro(cwd, ['exceptions', '--status', 'resolved'])).stdout).toBe('No exceptions.\n')
    expect(JSON.parse((await nostro(cwd, ['exceptions', '--status', 'all', '--limit', '1', '--json'])).stdout)).toHaveLength(1)
  })

  it('escapes control characters in what it prints, and keeps them exact in JSON', async () => {
    const cwd = await migrated()
    const store = new SqliteStore({ filename: join(cwd, 'nostro.db') })
    await store.transaction((tx) =>
      tx.openException({ tenantId: 'default', code: 'MEMO_MALFORMED', account: A, detail: 'memo \u001b[2Jgone' }),
    )
    await store.close()
    expect((await nostro(cwd, ['exceptions'])).stdout).toContain('memo \\u001b[2Jgone\n')
    expect(JSON.parse((await nostro(cwd, ['exceptions', '--json'])).stdout)[0].detail).toBe('memo \u001b[2Jgone')
  })

  it('exits 2 on a status or code it does not know', async () => {
    const cwd = await migrated()
    for (const argv of [['--status', 'closed'], ['--code', 'unexpected_credit'], ['--limit', 'x']]) {
      const run = await nostro(cwd, ['exceptions', ...argv])
      expect(run.code).toBe(2)
    }
    expect((await nostro(cwd, ['exceptions', '--code', 'NOPE'])).stderr).toContain('--code takes one of UNMATCHED_NO_CANDIDATE,')
  })
})
