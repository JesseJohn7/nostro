import { describe, expect, it } from 'vitest'
import { A, migrated, nostro } from './helpers.js'

const USDC = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const create = ['schedule', 'create', 'RENT-{period}', '--account', A, '--amount', '1250.5', '--cadence', 'monthly:28', '--start-at', '2026-02-01']

describe('nostro schedule', () => {
  it('creates, lists and ends schedules', async () => {
    const cwd = await migrated()
    const made = await nostro(cwd, create)
    expect(made.code, made.stderr).toBe(0)
    const id = made.stdout.trim()

    const other = await nostro(cwd, ['schedule', 'create', 'PAY-{period}', '--account', A, '--amount', '5', '--asset', USDC, '--direction', 'debit', '--cadence', 'weekly:1', '--start-at', '2026-01-01', '--end-at', '2027-01-01', '--json'])
    expect(other.code, other.stderr).toBe(0)
    expect(JSON.parse(other.stdout)).toMatchObject({
      referencePattern: 'PAY-{period}', amount: '5.0000000', asset: USDC, direction: 'debit', cadence: { type: 'weekly', dayOfWeek: 1 },
      startAt: '2026-01-01T00:00:00.000Z', endAt: '2027-01-01T00:00:00.000Z', endedAt: null,
    })
    expect((await nostro(cwd, ['schedule', 'create', 'D-{period}', '--account', A, '--amount', '1', '--asset', 'xlm', '--cadence', 'daily', '--start-at', '2026-03-01'])).code).toBe(0)

    const list = async (...argv: string[]) => JSON.parse((await nostro(cwd, ['schedule', 'list', '--json', ...argv])).stdout) as { id: string; referencePattern: string }[]
    expect((await list()).map((s) => s.referencePattern)).toEqual(['PAY-{period}', 'RENT-{period}', 'D-{period}'])

    expect(await nostro(cwd, ['schedule', 'end', id])).toMatchObject({ code: 0, stdout: `${id}\n` })
    expect(JSON.parse((await nostro(cwd, ['schedule', 'end', id, '--json'])).stdout).endedAt).not.toBeNull()
    expect((await list('--active-only')).map((s) => s.referencePattern)).toEqual(['PAY-{period}', 'D-{period}'])
    const table = (await nostro(cwd, ['schedule', 'list'])).stdout
    expect(table).toMatch(/RENT-\{period\}.*1250\.5000000.*monthly  yes\n/)
    expect(table).toMatch(/PAY-\{period\}.*weekly   no\n/)
  })

  it('refuses a schedule it cannot make, and options that belong to another subcommand', async () => {
    const cwd = await migrated()
    const replace = (flag: string, value: string) => create.map((v, i) => (create[i - 1] === flag ? value : v))
    const without = (flag: string) => create.filter((v, i) => v !== flag && create[i - 1] !== flag)
    for (const [argv, message] of [
      [['schedule'], 'Use "nostro schedule create"'],
      [['schedule', 'stop'], 'Use "nostro schedule create"'],
      [['schedule', 'create', 'RENT'], 'must include {period}'],
      [without('--account'), '--account is required'],
      [without('--amount'), '--amount is required'],
      [without('--cadence'), '--cadence is required'],
      [without('--start-at'), '--start-at is required'],
      [replace('--amount', '1.00000001'), '--amount'],
      [replace('--cadence', 'yearly'), '--cadence must be'],
      [replace('--cadence', 'weekly:7'), '0-6'],
      [replace('--cadence', 'monthly:31'), '1-28'],
      [[...create, '--asset', 'USDC'], '--asset must be'],
      [[...create, '--direction', 'sideways'], '--direction must be'],
      [[...create, '--active-only'], '--active-only does not apply to schedule create'],
      [['schedule', 'list', '--amount', '1'], '--amount does not apply to schedule list'],
      [['schedule', 'end'], 'schedule id is required'],
    ] as const) {
      const run = await nostro(cwd, argv)
      expect(run.code, argv.join(' ')).toBe(2)
      expect(run.stderr, argv.join(' ')).toContain(message)
    }
    expect((await nostro(cwd, ['schedule', 'end', 'missing'])).code).toBe(1)
    expect((await nostro(cwd, ['schedule', '--help'])).stdout).toContain('--active-only')
  })
})
