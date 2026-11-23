import { describe, expect, it } from 'vitest'
import { A, migrated, nostro } from './helpers.js'

describe('--after paging', () => {
  it('returns each expectation exactly once across pages', async () => {
    const cwd = await migrated()
    const total = 12
    for (let i = 1; i <= total; i++) {
      const made = await nostro(cwd, ['expect', `PAGE-${i}`, '--account', A, '--amount', String(i)])
      expect(made.code).toBe(0)
    }

    const seen: string[] = []
    let after: number | undefined
    for (let page = 0; page < total; page++) {
      const args = ['expectations', '--json', '--limit', '5']
      if (after !== undefined) args.push(`--after=${after}`)
      const run = await nostro(cwd, args)
      expect(run.code).toBe(0)
      const rows = JSON.parse(run.stdout) as { reference: string; seq: number }[]
      seen.push(...rows.map((r) => r.reference))
      if (rows.length < 5) break
      after = rows[rows.length - 1]!.seq
    }

    expect(seen).toHaveLength(total)
    expect(new Set(seen).size).toBe(total)
    expect([...seen].sort()).toEqual(Array.from({ length: total }, (_, i) => `PAGE-${i + 1}`).sort())
  }, 300_000)
})
