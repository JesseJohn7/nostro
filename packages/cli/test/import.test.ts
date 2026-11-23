import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../src/index.js'
import { A, B, migrated, nostro } from './helpers.js'

const HEADER = 'reference,account,amount,memo_text,payers,meta.note'

function writeFile(cwd: string, name: string, text: string): string {
  writeFileSync(join(cwd, name), text)
  return name
}

async function expectationsJson(cwd: string): Promise<{ reference: string; amount: string; metadata: Record<string, string> }[]> {
  return JSON.parse((await nostro(cwd, ['expectations', '--json'])).stdout)
}

describe('nostro import', () => {
  it('reads quoted cells holding commas and line breaks exactly', async () => {
    const cwd = await migrated()
    const note = 'first, then\nsecond "quoted"'
    const csv = `${HEADER}\nINV-1,${A},25,,,"${note.replace(/"/g, '""')}"\n`
    const run = await nostro(cwd, ['import', writeFile(cwd, 'a.csv', csv)])
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('Imported: 1 created')
    const [row] = await expectationsJson(cwd)
    expect(row!.metadata).toEqual({ note })
  })

  it('records each expectation once: a second run skips everything', async () => {
    const cwd = await migrated()
    const file = writeFile(cwd, 'b.csv', `${HEADER}\nINV-1,${A},25,,,a\nINV-2,${A},10,,${B},b\n`)
    expect((await nostro(cwd, ['import', file])).code).toBe(0)
    const again = await nostro(cwd, ['import', file, '--json'])
    expect(again.code).toBe(0)
    expect(JSON.parse(again.stdout)).toMatchObject({ created: 0, skipped: 2, conflicts: [], refused: [] })
    expect(await expectationsJson(cwd)).toHaveLength(2)
  })

  it('reports a changed row as a conflict and never changes the recorded expectation', async () => {
    const cwd = await migrated()
    expect((await nostro(cwd, ['import', writeFile(cwd, 'c1.csv', `${HEADER}\nINV-1,${A},25,,,a\n`)])).code).toBe(0)
    const run = await nostro(cwd, ['import', writeFile(cwd, 'c2.csv', `${HEADER}\nINV-1,${A},30,,,a\n`), '--json'])
    expect(run.code).toBe(1)
    const report = JSON.parse(run.stdout)
    expect(report.conflicts).toEqual([
      { line: 2, reference: 'INV-1', reason: 'differs in amount; the recorded expectation is unchanged' },
    ])
    const [row] = await expectationsJson(cwd)
    expect(row!.amount).toBe('25.0000000')
  })

  it('refuses a 29-byte memo with its line number and writes nothing', async () => {
    const cwd = await migrated()
    const twentyNine = 'x'.repeat(29)
    const csv = `${HEADER}\nINV-1,${A},25,ok,,\nINV-2,${A},10,${twentyNine},,\n`
    const run = await nostro(cwd, ['import', writeFile(cwd, 'd.csv', csv), '--json'])
    expect(run.code).toBe(1)
    const report = JSON.parse(run.stdout)
    expect(report.refused).toEqual([
      expect.objectContaining({ line: 3, error: expect.stringContaining('--memo-text must be 1 to 28 bytes') }),
    ])
    expect(report.created).toBe(0)
    expect(await expectationsJson(cwd)).toEqual([])
  })

  it('keeps an amount beyond 2^64 exact, with no rounding', async () => {
    const cwd = await migrated()
    const big = '18446744073709551616'
    const run = await nostro(cwd, ['import', writeFile(cwd, 'e.csv', `${HEADER}\nINV-BIG,${A},${big},,,\n`)])
    expect(run.code).toBe(0)
    const [row] = await expectationsJson(cwd)
    expect(row!.amount).toBe(`${big}.0000000`)
  })

  it('dry-run validates every row and writes nothing', async () => {
    const cwd = await migrated()
    const run = await nostro(cwd, ['import', writeFile(cwd, 'f.csv', `${HEADER}\nINV-1,${A},25,,,\n`), '--dry-run', '--json'])
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout)).toMatchObject({ dryRun: true, created: 0, wouldCreate: 1 })
    expect(await expectationsJson(cwd)).toEqual([])
  })

  it('refuses an unknown column before reading any rows', async () => {
    const cwd = await migrated()
    const run = await nostro(cwd, ['import', writeFile(cwd, 'g.csv', 'reference,account,amount,colour\nINV-1,' + A + ',1,red\n')])
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('Unknown column "colour"')
  })

  it('reads standard input with -', async () => {
    const cwd = await migrated()
    let out = ''
    const code = await main(['import', '-'], {
      stdout: { write: (s) => ((out += s), true) },
      stderr: { write: () => true },
      env: {},
      cwd,
      readStdin: async () => `${HEADER}\nINV-STDIN,${A},7,,,\n`,
    })
    expect(code).toBe(0)
    expect(out).toContain('Imported: 1 created')
    expect((await expectationsJson(cwd)).map((r) => r.reference)).toEqual(['INV-STDIN'])
  })

  it('reads JSON Lines with the same field names', async () => {
    const cwd = await migrated()
    const lines = [
      JSON.stringify({ reference: 'J-1', account: A, amount: '5', memo_text: 'J-1' }),
      JSON.stringify({ reference: 'J-2', account: A, amount: 6, 'meta.po': '77' }),
    ]
    const run = await nostro(cwd, ['import', writeFile(cwd, 'h.jsonl', lines.join('\n') + '\n')])
    expect(run.code).toBe(0)
    expect((await expectationsJson(cwd)).map((r) => r.reference).sort()).toEqual(['J-1', 'J-2'])
  })
})
