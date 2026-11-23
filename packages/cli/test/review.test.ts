import { describe, expect, it } from 'vitest'
import { FakeHorizon } from 'nostro-testkit'
import { main } from '../src/index.js'
import { A, B, migrated, nostro } from './helpers.js'

/** A synced payment from B to A that matches nothing, so reconcile raises one open exception. */
async function withOpenException(memo?: string): Promise<string> {
  const h = new FakeHorizon()
  h.payment(10, B, A, '30', memo === undefined ? {} : { memo })
  const cwd = await migrated()
  const synced = await nostro(cwd, ['sync', '--account', A], { fetch: h.fetch })
  if (synced.code !== 0) throw new Error(synced.stderr)
  const reconciled = await nostro(cwd, ['reconcile'])
  if (reconciled.code !== 0) throw new Error(reconciled.stderr)
  return cwd
}

/** Runs `nostro review` with scripted answers. When the answers run out, the prompt returns null, as at end of input. */
async function review(cwd: string, answers: readonly string[], options: { interactive?: boolean; argv?: string[] } = {}) {
  const queue = [...answers]
  let stdout = ''
  let stderr = ''
  const code = await main(options.argv ?? ['review'], {
    stdout: { write: (s) => ((stdout += s), true) },
    stderr: { write: (s) => ((stderr += s), true) },
    env: {},
    cwd,
    interactive: options.interactive ?? true,
    prompt: async (question) => {
      stdout += question
      return queue.length > 0 ? queue.shift()! : null
    },
  })
  return { code, stdout, stderr }
}

async function openCount(cwd: string): Promise<number> {
  return (JSON.parse((await nostro(cwd, ['exceptions', '--json'])).stdout) as unknown[]).length
}

describe('nostro review', () => {
  it('refuses to run without a terminal and points to resolve', async () => {
    const cwd = await withOpenException()
    const run = await review(cwd, [], { interactive: false })
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('nostro resolve')
    expect(await openCount(cwd)).toBe(1)
  })

  it('quits at once and leaves every exception untouched', async () => {
    const cwd = await withOpenException()
    const run = await review(cwd, ['q'])
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('Reviewed 1, decided 0.')
    expect(await openCount(cwd)).toBe(1)
  })

  it('skips an exception without changing it, then stops at end of input', async () => {
    const cwd = await withOpenException()
    const run = await review(cwd, ['s'])
    expect(run.stdout).toContain('Reviewed 1, decided 0.')
    expect(await openCount(cwd)).toBe(1)
  })

  it('asks again for a note, then ignores the exception once a note is given', async () => {
    const cwd = await withOpenException()
    const run = await review(cwd, ['i', '', 'checked with the payer'])
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('A note is required.')
    expect(run.stdout).toContain('Reviewed 1, decided 1.')
    expect(await openCount(cwd)).toBe(0)
  })

  it('shows a refusal with its reason and changes nothing', async () => {
    const cwd = await withOpenException()
    // A reference that does not exist is refused, so the exception stays open.
    const run = await review(cwd, ['r', 'NO-SUCH-INVOICE', '', 'trying a reference', 'q'])
    expect(run.code).toBe(0)
    expect(run.stdout).toMatch(/Refused:|Not applied:/)
    expect(await openCount(cwd)).toBe(1)
  })

  it('prints a hostile memo escaped, never raw', async () => {
    const cwd = await withOpenException('a\u0007b')
    const run = await review(cwd, ['q'])
    expect(run.stdout).toContain('\\u0007')
    expect(run.stdout).not.toContain('\u0007')
  })
})
