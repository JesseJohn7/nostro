import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeHorizon } from 'nostro-testkit'
import { A, B, migrated, nostro } from './helpers.js'

type Exception = { id: string; code: string; status: string; movementId: string | null }

/** INV-1 is paid by memo; two payments have memos nothing matches, so two exceptions. */
async function books() {
  const cwd = await migrated()
  const h = new FakeHorizon()
  h.payment(10, B, A, '25', { memo: 'INV-1' })
  h.payment(11, B, A, '7', { memo: 'what is this' })
  h.payment(12, B, A, '3', { memo: 'nor this' })
  for (const argv of [
    ['sync', '--account', A],
    ['expect', 'INV-1', '--account', A, '--amount', '25'],
    ['expect', 'INV-2', '--account', A, '--amount', '9'],
    ['reconcile'],
  ]) {
    const run = await nostro(cwd, argv, { fetch: h.fetch })
    if (run.code !== 0) throw new Error(run.stderr)
  }
  const exceptions = JSON.parse((await nostro(cwd, ['exceptions', '--json'])).stdout) as Exception[]
  const movements = JSON.parse((await nostro(cwd, ['movements', '--json'])).stdout) as { id: string; amount: string; disposition: string }[]
  return { cwd, exceptions, movements }
}

describe('nostro replay', () => {
  it('says nothing changes under the options the decisions were made with', async () => {
    const { cwd, movements } = await books()
    const run = await nostro(cwd, ['replay'])
    expect(run.code, run.stderr).toBe(0)
    expect(run.stdout).toContain('Replayed 3: unchanged 3, would settle 0, would go to person 0, would change expectation 0, unreplayable 0.\n')
    expect(JSON.parse((await nostro(cwd, ['replay', '--json'])).stdout)).toMatchObject({ replayed: 3, unchanged: 3 })
    expect((await nostro(cwd, ['replay', '--to', '2020-01-01'])).stdout).toContain('Replayed 0:')
    expect((await nostro(cwd, ['replay', '--from', '2020-01-01', '--limit', '1'])).stdout).toContain('Replayed 1:')

    const paid = movements.find((m) => m.disposition === 'allocated')!
    expect(await nostro(cwd, ['replay', paid.id])).toMatchObject({ code: 0, stdout: `Movement ${paid.id}: agree\n` })
    expect(JSON.parse((await nostro(cwd, ['replay', paid.id, '--json'])).stdout)).toMatchObject({ movementId: paid.id, status: 'agree' })
    expect((await nostro(cwd, ['replay', 'missing'])).stdout).toContain('unreplayable')
  })

  it('exits 1 and shows what would change under other options', async () => {
    const { cwd, movements } = await books()
    const paid = movements.find((m) => m.disposition === 'allocated')!
    // Without the memo strategies, the paid invoice goes to a person.
    const run = await nostro(cwd, ['replay', '--strategy', 'muxed_id', '--threshold', '0.9', '--margin', '0.5'])
    expect(run.code).toBe(1)
    expect(run.stdout).toMatch(new RegExp(`${paid.id}  would_go_to_person  allocate \\S+  exception \\S+`))
    expect(run.stdout).toContain('would go to person 1')
    expect((await nostro(cwd, ['replay', '--strategy', 'muxed_id', '--json'])).code).toBe(1)
    const one = await nostro(cwd, ['replay', paid.id, '--strategy', 'muxed_id'])
    expect(one.code).toBe(1)
    expect(one.stdout).toContain(`Movement ${paid.id}: disagree\nthe current engine would decide this movement differently\n`)
  })

  it('refuses options that do not make sense', async () => {
    const cwd = await migrated()
    for (const [argv, message] of [
      [['--threshold', '2'], '--threshold must be a number from 0 to 1'],
      [['--margin', 'x'], '--margin must be a number from 0 to 1'],
      [['--strategy', 'guess'], 'Unknown strategy: guess'],
    ] as const) {
      const run = await nostro(cwd, ['replay', ...argv])
      expect(run.code, argv.join(' ')).toBe(2)
      expect(run.stderr).toContain(message)
    }
  })
})

describe('nostro resolve --file', () => {
  it('applies a file of decisions, and is safe to run again', async () => {
    const { cwd, exceptions } = await books()
    const [first, second] = exceptions as [Exception, Exception]
    writeFileSync(join(cwd, 'decisions.csv'), `exception id,action,reference[=amount],note\r\n${first.id},apply,INV-2=7,"customer said, by phone"\r\n\r\n${second.id},ignore,,a ""test"" payment\r\n`)
    const run = await nostro(cwd, ['resolve', '--file', 'decisions.csv'])
    expect(run.code, run.stdout + run.stderr).toBe(0)
    expect(run.stdout).toBe(`0: ${first.id} ok\n1: ${second.id} ok\nApplied 2, errors 0.\n`)
    const open = JSON.parse((await nostro(cwd, ['exceptions', '--json'])).stdout) as Exception[]
    expect(open).toEqual([])
    const invoice = (JSON.parse((await nostro(cwd, ['expectations', '--json'])).stdout) as { reference: string; paid: string }[]).find((e) => e.reference === 'INV-2')!
    expect(invoice.paid).toBe('7.0000000')
    const again = await nostro(cwd, ['resolve', '--file', 'decisions.csv', '--mode', 'row'])
    expect(again.stdout).toContain('already applied')
    expect((await nostro(cwd, ['doctor'])).code).toBe(0)
  })

  it('in row mode keeps the good rows; in atomic mode keeps none if one is refused', async () => {
    const { cwd, exceptions } = await books()
    const [first, second] = exceptions as [Exception, Exception]
    writeFileSync(join(cwd, 'mixed.csv'), `${first.id},apply,NO-SUCH-INVOICE,typo\n${second.id},ignore,,not ours\n`)
    const atomic = await nostro(cwd, ['resolve', '--file', 'mixed.csv'])
    expect(atomic.code).toBe(1)
    expect(atomic.stdout).toMatch(new RegExp(`0: ${first.id} ERROR \\S+ .*NO-SUCH-INVOICE`))
    expect(JSON.parse((await nostro(cwd, ['exceptions', '--json'])).stdout)).toHaveLength(2)

    const rows = await nostro(cwd, ['resolve', '--file', 'mixed.csv', '--mode', 'row', '--json'])
    expect(rows.code).toBe(1)
    expect(JSON.parse(rows.stdout)).toMatchObject({ applied: 1, errors: 1 })
    expect((JSON.parse((await nostro(cwd, ['exceptions', '--json'])).stdout) as Exception[]).map((x) => x.id)).toEqual([first.id])
  })

  it('refuses to close an exception an undecided movement depends on, and a file it cannot read', async () => {
    const { cwd, exceptions } = await books()
    writeFileSync(join(cwd, 'close.csv'), `${exceptions[0]!.id},close,,dealt with\n`)
    const run = await nostro(cwd, ['resolve', '--file', 'close.csv'])
    expect(run.code).toBe(1)
    expect(run.stdout).toContain(`0: ${exceptions[0]!.id} ERROR`)
    for (const [text, message] of [['', 'empty'], ['x,frobnicate,,n\n', 'unknown action frobnicate'], [',ignore,,n\n', 'Bad batch row 1']] as const) {
      writeFileSync(join(cwd, 'bad.csv'), text)
      expect(await nostro(cwd, ['resolve', '--file', 'bad.csv'])).toMatchObject({ code: 2, stderr: expect.stringContaining(message) })
    }
    expect((await nostro(cwd, ['resolve', '--file', 'close.csv', '--mode', 'some'])).stderr).toContain('--mode must be atomic or row')
  })
})

describe('nostro journal post', () => {
  const post = ['journal', 'post', '--description', 'Office rent', '--reason', 'Lease 7']
  const balanced = ['--line', 'expenses:rent:uncategorized_expense:debit:5', '--line', 'liabilities:rent:other:credit:5:native']

  it('posts a balanced entry from lines or JSON, and prints it', async () => {
    const cwd = await migrated()
    const run = await nostro(cwd, [...post, ...balanced, '--note', 'October', '--posted-by', 'ada', '--effective-at', '2026-10-01'])
    expect(run.code, run.stderr).toBe(0)
    expect(run.stdout).toMatch(/^Posted manual entry \S+ \(seq 1\)\.\n$/)
    const lines = JSON.stringify([
      { account: 'expenses:rent', role: 'uncategorized_expense', side: 'debit', amount: '2.5' },
      { account: 'liabilities:rent', role: 'other', side: 'credit', amount: '2.5', asset: 'native' },
    ])
    const asJson = JSON.parse((await nostro(cwd, [...post, '--lines-json', lines, '--json'])).stdout)
    expect(asJson).toMatchObject({ seq: 2, kind: 'manual', movementId: null, postingNo: null })
    expect(asJson.lines.map((l: { side: string; amount: string; asset: string }) => [l.side, l.amount, l.asset])).toEqual([['debit', '2.5000000', 'native'], ['credit', '2.5000000', 'native']])
  })

  it('refuses an entry that is incomplete, unbalanced, or touches cash', async () => {
    const cwd = await migrated()
    for (const [argv, code, message] of [
      [['journal', 'list'], 2, 'Unknown journal subcommand'],
      [['journal', 'post', '--reason', 'x', ...balanced], 2, '--description'],
      [['journal', 'post', '--description', 'x', ...balanced], 2, '--reason'],
      [[...post, '--line', 'a:other:debit:5'], 2, 'at least two lines'],
      [[...post, '--line', 'nonsense'], 2, 'Invalid --line format'],
      [[...post, '--line', 'a:banana:debit:5'], 2, 'Unknown journal role banana'],
      [[...post, '--lines-json', '{}'], 2, 'must be an array'],
      [[...post, '--lines-json', '['], 2, 'Invalid --lines-json'],
    ] as const) {
      const run = await nostro(cwd, argv)
      expect(run.code, argv.join(' ')).toBe(code)
      expect(run.stderr, argv.join(' ')).toContain(message)
    }
    for (const lines of [
      ['--line', 'a:other:debit:5', '--line', 'b:other:credit:4'],
      ['--line', 'assets:x:cash:debit:5', '--line', 'b:other:credit:5'],
    ]) expect((await nostro(cwd, [...post, ...lines])).code, lines.join(' ')).not.toBe(0)
    expect((await nostro(cwd, ['export'])).stdout.trim().split('\n')).toHaveLength(1)
  })
})

describe('nostro export for accounting packages', () => {
  it('exports only what is new for a destination, and remembers it', async () => {
    const { cwd } = await books()
    const rows = async () => (await nostro(cwd, ['export', '--destination', 'books'])).stdout.trim().split('\r\n').length - 1
    expect(await rows()).toBeGreaterThan(0)
    expect(await rows()).toBe(0)
    await nostro(cwd, ['journal', 'post', '--description', 'd', '--reason', 'r', '--line', 'a:other:debit:1', '--line', 'b:other:credit:1'])
    expect(await rows()).toBe(2)
    expect((await nostro(cwd, ['export', '--destination', 'elsewhere'])).stdout.trim().split('\r\n').length - 1).toBeGreaterThan(2)
  })

  it('maps accounts for QuickBooks and Xero, and refuses a map it cannot use', async () => {
    const { cwd } = await books()
    const accounts = new Set((await nostro(cwd, ['export'])).stdout.split('\r\n').slice(1).filter(Boolean).flatMap((row) => row.split(',').filter((c) => /^(assets|liabilities|income|expenses|equity):/.test(c))))
    writeFileSync(join(cwd, 'map.json'), JSON.stringify(Object.fromEntries([...accounts].map((a, i) => [a, `10${i}`]))))
    for (const format of ['quickbooks', 'xero']) {
      const run = await nostro(cwd, ['export', '--format', format, '--account-map', 'map.json', '--output', `${format}.csv`, ...(format === 'xero' ? ['--tax-rate', 'Exempt'] : [])])
      expect(run.code, run.stderr).toBe(0)
      expect(existsSync(join(cwd, `${format}.csv`))).toBe(true)
      expect(readFileSync(join(cwd, `${format}.csv`), 'utf8')).toContain('100')
    }
    expect(readFileSync(join(cwd, 'xero.csv'), 'utf8')).toContain('Exempt')
    for (const [text, message] of [['{', 'Cannot read account JSON map'], ['[]', 'must be a JSON object'], ['{"a":1}', 'must be a JSON object'], ['{"a":" "}', 'must be a JSON object']] as const) {
      writeFileSync(join(cwd, 'bad.json'), text)
      expect(await nostro(cwd, ['export', '--format', 'xero', '--account-map', 'bad.json'])).toMatchObject({ code: 2, stderr: expect.stringContaining(message) })
    }
  })

  it('refuses options that do not go together', async () => {
    const cwd = await migrated()
    for (const [argv, message] of [
      [['invoices'], 'Unknown export type "invoices"'],
      [['movements', '--format', 'ofx'], '--format only applies to journal exports'],
      [['exceptions', '--include-memo'], '--include-memo only applies to movements'],
      [['--include-memo'], '--include-memo only applies to movements'],
      [['--format', 'pdf'], '--format must be'],
      [['--format', 'beancount', '--decimals', '2'], '--decimals only applies to CSV'],
      [['--account', A], 'only apply to OFX'],
      [['--format', 'ofx', '--account', A], 'requires --asset'],
      [['--format', 'ofx', '--account', A, '--asset', 'native'], 'requires --from and --to'],
      [['--account-map', 'x'], '--account-map only applies'],
      [['--commodity-map', 'x'], '--commodity-map only applies'],
      [['--tax-rate', 'x'], '--tax-rate only applies'],
      [['--force'], '--force only applies with --output'],
    ] as const) {
      const run = await nostro(cwd, ['export', ...argv])
      expect(run.code, argv.join(' ')).toBe(2)
      expect(run.stderr, argv.join(' ')).toContain(message)
    }
  })
})
