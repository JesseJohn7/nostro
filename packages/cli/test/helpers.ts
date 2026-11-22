import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { main } from '../src/index.js'

export const A = `G${'A'.repeat(55)}`
export const B = `G${'B'.repeat(55)}`

const root = mkdtempSync(join(tmpdir(), 'nostro-cli-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let dirs = 0
/** A fresh, empty working directory. */
export function workspace(): string {
  const dir = join(root, `w${++dirs}`)
  mkdirSync(dir)
  return dir
}

export interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface RunOptions {
  readonly env?: Readonly<Record<string, string>>
  readonly fetch?: typeof globalThis.fetch
  /** Pretend stderr is a terminal. */
  readonly tty?: boolean
}

/** Run `nostro <argv>` in-process, in `cwd`. */
/** Start `nostro serve` in-process; returns its output so far, its address, and a way to stop it. */
/** The key and tenant `startServe` serves by default, as serve.test.ts uses. */
export const SERVE_KEY = 'k'.repeat(64)

export async function startServe(cwd: string, argv: readonly string[], options: { env?: Record<string, string>; fetch?: typeof fetch } = {}) {
  const out = { stdout: '', stderr: '' }
  const stop = new AbortController()
  const done = main(['serve', '--port', '0', ...argv], {
    stdout: { write: (s) => ((out.stdout += s), true) },
    stderr: { write: (s) => ((out.stderr += s), true) },
    env: options.env ?? { NOSTRO_API_KEYS: `acme:${SERVE_KEY}` },
    cwd,
    signal: stop.signal,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25))
    if (!check()) throw new Error(`timed out; stdout: ${out.stdout} stderr: ${out.stderr}`)
  }
  await until(() => out.stdout.includes('Listening on'))
  const address = /Listening on (\S+) /.exec(out.stdout)![1]!
  const get = async (path: string, key = SERVE_KEY) => fetch(`${address}${path}`, { headers: { authorization: `Bearer ${key}` } })
  return { out, address, get, until, stop: async () => (stop.abort(), done) }
}

export async function nostro(cwd: string, argv: readonly string[], options: RunOptions = {}): Promise<Run> {
  let stdout = ''
  let stderr = ''
  const code = await main(argv, {
    stdout: {
      write: (s) => {
        stdout += s
        return true
      },
    },
    stderr: {
      write: (s) => {
        stderr += s
        return true
      },
      ...(options.tty === undefined ? {} : { isTTY: options.tty }),
    },
    env: options.env ?? {},
    cwd,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
  return { code, stdout, stderr }
}

/** A working directory with a migrated `nostro.db`. */
export async function migrated(): Promise<string> {
  const cwd = workspace()
  const { code, stderr } = await nostro(cwd, ['migrate'])
  if (code !== 0) throw new Error(stderr)
  return cwd
}
