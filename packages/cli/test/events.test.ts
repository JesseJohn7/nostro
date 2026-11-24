import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { eventCursorKey } from '@nostro-labs/nostro'
import { SqliteStore } from '@nostro-labs/store-sqlite'
import { main } from '../src/index.js'
import { A, migrated, nostro } from './helpers.js'

/** Three invoices, so three `expectation.created` events; the last is cancelled, so a fourth event. */
async function logged(): Promise<string> {
  const cwd = await migrated()
  for (const ref of ['INV-1', 'INV-2', 'INV-3']) await nostro(cwd, ['expect', ref, '--account', A, '--amount', '1'])
  await nostro(cwd, ['cancel', 'INV-3', '--reason', 'mistake'])
  return cwd
}

const lines = (stdout: string) => stdout.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as { type: string; seq: number; id: string })

async function position(cwd: string, consumer = 'events'): Promise<string | null> {
  const store = new SqliteStore({ filename: join(cwd, 'nostro.db') })
  try {
    return await store.getCursor(eventCursorKey('default', consumer))
  } finally {
    await store.close()
  }
}

describe('nostro events', () => {
  it('prints each event once as JSON Lines, and remembers where each consumer got to', async () => {
    const cwd = await logged()
    const first = await nostro(cwd, ['events', '--limit', '2'])
    expect(first.code, first.stderr).toBe(0)
    expect(lines(first.stdout).map((e) => e.type)).toEqual(['expectation.created', 'expectation.created', 'expectation.created', 'expectation.cancelled'])
    expect(await nostro(cwd, ['events'])).toMatchObject({ code: 0, stdout: '' })
    expect(lines((await nostro(cwd, ['events', '--consumer', 'audit'])).stdout)).toHaveLength(4)
    expect(await position(cwd)).toBe(String(lines(first.stdout).at(-1)!.seq))

    const seqs = lines(first.stdout).map((e) => e.seq)
    expect(lines((await nostro(cwd, ['events', '--after', String(seqs[1])])).stdout).map((e) => e.seq)).toEqual(seqs.slice(2))
  })

  it('emits only the types asked for, and still moves past the rest', async () => {
    const cwd = await logged()
    const run = await nostro(cwd, ['events', '--type', 'expectation.cancelled,journal.posted', '--type', 'expectation.cancelled'])
    expect(lines(run.stdout).map((e) => e.type)).toEqual(['expectation.cancelled'])
    expect((await nostro(cwd, ['events'])).stdout).toBe('')
  })

  it('runs a command per event, with the event on stdin and in the environment, never in argv', async () => {
    const cwd = await logged()
    const out = join(cwd, 'seen')
    const script = join(cwd, 'consume.mjs')
    writeFileSync(script, `
      import { appendFileSync, readFileSync } from 'node:fs'
      const event = JSON.parse(readFileSync(0, 'utf8'))
      appendFileSync(process.argv[2], JSON.stringify([event.id === process.env.NOSTRO_EVENT_ID, event.type === process.env.NOSTRO_EVENT_TYPE, String(event.seq) === process.env.NOSTRO_EVENT_SEQ, process.argv.length]) + '\\n')
    `)
    const run = await nostro(cwd, ['events', '--exec', process.execPath, '--', script, out], { env: {} })
    expect(run, run.stderr).toMatchObject({ code: 0, stdout: '' })
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l))).toEqual(Array.from({ length: 4 }, () => [true, true, true, 3]))
  })

  it('stops at an event its command refuses, or takes too long over, and offers it again', async () => {
    const cwd = await logged()
    const refused = await nostro(cwd, ['events', '--exec', process.execPath, '--', '-e', 'process.exit(3)'])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toMatch(/--exec exited with status 3 on event \S+; cursor not advanced/)
    expect(await position(cwd)).toBe('0')
    const slow = await nostro(cwd, ['events', '--exec-timeout', '100', '--exec', process.execPath, '--', '-e', 'setTimeout(() => {}, 60000)'])
    expect(slow).toMatchObject({ code: 1 })
    expect(slow.stderr).toContain('status 124')
    expect((await nostro(cwd, ['events', '--exec', join(cwd, 'no-such-command')])).code).not.toBe(0)
    expect(lines((await nostro(cwd, ['events'])).stdout)).toHaveLength(4)
  })

  it('follows the log until it is told to stop', async () => {
    const cwd = await logged()
    const stop = new AbortController()
    let stdout = ''
    const done = main(['events', '--follow', '--poll', '20'], {
      stdout: { write: (s) => ((stdout += s), true) },
      stderr: { write: () => true },
      env: {},
      cwd,
      signal: stop.signal,
    })
    const until = async (n: number) => {
      for (let i = 0; i < 150 && lines(stdout).length < n; i++) await new Promise((r) => setTimeout(r, 20))
      expect(lines(stdout)).toHaveLength(n)
    }
    await until(4)
    await nostro(cwd, ['expect', 'INV-4', '--account', A, '--amount', '1'])
    await until(5)
    stop.abort()
    expect(await done).toBe(0)
  })

  it('refuses options that do not make sense', async () => {
    const cwd = await migrated()
    for (const [argv, message] of [
      [['--type', 'nope'], '--type takes'],
      [['--consumer', 'webhook'], 'reserved'],
      [['--consumer', 'a b'], 'without spaces or colons'],
      [['--after=-1'], '--after must be a whole number'],
      [['--after', '1.5'], '--after must be a whole number'],
      [['--exec', ' '], '--exec must name a command'],
      [['extra'], 'Unexpected argument "extra"'],
      [['--', 'arg'], 'only valid with --exec'],
      [['extra', '--exec', 'true', '--', 'x'], 'Unexpected argument "extra"'],
    ] as const) {
      const run = await nostro(cwd, ['events', ...argv])
      expect(run.code, argv.join(' ')).toBe(2)
      expect(run.stderr, argv.join(' ')).toContain(message)
    }
  })
})
