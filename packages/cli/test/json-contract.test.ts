import { describe, expect, it } from 'vitest'
import { nostro, workspace } from './helpers.js'

/** Parses the single JSON object a `--json` failure writes to stderr. */
function jsonError(stderr: string): { code: string; message: string } {
  const lines = stderr.trimEnd().split('\n')
  expect(lines).toHaveLength(1)
  return (JSON.parse(lines[0]!) as { error: { code: string; message: string } }).error
}

describe('--json errors', () => {
  it('reports a usage error as one JSON object with code usage and exit 2', async () => {
    const run = await nostro(workspace(), ['exceptions', '--json', '--status', 'bogus'])
    expect(run.code).toBe(2)
    expect(jsonError(run.stderr)).toEqual({ code: 'usage', message: expect.stringContaining('--status takes') })
  })

  it('reports a missing database with code no_database and exit 1', async () => {
    const run = await nostro(workspace(), ['exceptions', '--json'])
    expect(run.code).toBe(1)
    expect(jsonError(run.stderr).code).toBe('no_database')
  })

  it('keeps plain text errors when --json is not given', async () => {
    const run = await nostro(workspace(), ['exceptions'])
    expect(run.code).toBe(1)
    expect(run.stderr).toMatch(/^nostro: No database at /)
    expect(run.stderr).not.toContain('"code"')
  })

  it('keeps a message that quotes the input valid JSON', async () => {
    const run = await nostro(workspace(), ['exceptions', '--json', '--status', 'a"b\u001b'])
    expect(run.code).toBe(2)
    expect(jsonError(run.stderr).message).toContain('--status takes')
  })
})

describe('--json and --jsonl', () => {
  it('refuses both at once', async () => {
    const run = await nostro(workspace(), ['exceptions', '--json', '--jsonl'])
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('Give --json or --jsonl, not both.')
  })

  it('refuses a --after that is not a sequence number', async () => {
    for (const bad of ['-1', 'abc', '1.5']) {
      const run = await nostro(workspace(), ['exceptions', `--after=${bad}`])
      expect(run.code, bad).toBe(2)
      expect(run.stderr, bad).toContain('--after takes the seq of the last record')
    }
  })

  it('accepts --after and --jsonl on expectations and exceptions', async () => {
    for (const command of ['exceptions', 'expectations']) {
      const run = await nostro(workspace(), [command, '--after', '0', '--jsonl'])
      expect(run.code, command).toBe(1) // no database yet, not a usage error
      expect(run.stderr, command).toContain('No database')
    }
  })
})
