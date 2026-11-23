import { spawn } from 'node:child_process'
import { EVENT_TYPES, eventCursorKey, outboxEventJson } from '@nostro-labs/nostro'
import type { OutboxEvent } from '@nostro-labs/nostro'
import { COMMON, UsageError, flag, integer, string, strings, tenant } from '../args.js'
import type { Args } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, withStore } from '../command.js'
import type { Io } from '../io.js'
import { write } from '../io.js'

interface ExecSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly timeoutMs: number
}

function eventTypes(args: Args): string[] | undefined {
  const raw = strings(args, 'type')
  if (raw.length === 0) return undefined
  const out: string[] = []
  for (const value of raw) {
    for (const t of value.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
      if (!(EVENT_TYPES as readonly string[]).includes(t)) {
        throw new UsageError(`--type takes ${EVENT_TYPES.join(', ')}; not ${JSON.stringify(t)}.`)
      }
      if (!out.includes(t)) out.push(t)
    }
  }
  return out
}

function execSpec(args: Args): ExecSpec | undefined {
  const cmd = string(args, 'exec')
  if (cmd === undefined) return undefined
  if (cmd.trim() === '') throw new UsageError('--exec must name a command.')
  const dash = args.argv.indexOf('--')
  const childArgs = dash === -1 ? [] : args.argv.slice(dash + 1)
  return { command: cmd, args: childArgs, timeoutMs: integer(args, 'exec-timeout', 10_000, 1, 600_000) }
}

function validatePositionals(args: Args): void {
  const dash = args.argv.indexOf('--')
  if (dash === -1) {
    if (args.positionals.length > 0) throw new UsageError(`Unexpected argument ${JSON.stringify(args.positionals[0])}.`)
    return
  }
  const preDash = args.positionals.filter((p) => {
    const i = args.argv.indexOf(p)
    return i !== -1 && i < dash
  })
  if (preDash.length > 0) throw new UsageError(`Unexpected argument ${JSON.stringify(preDash[0])}.`)
  if (string(args, 'exec') === undefined) {
    throw new UsageError('Arguments after -- are only valid with --exec.')
  }
}

async function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return false
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
  return !signal?.aborted
}

async function runExec(exec: ExecSpec, event: OutboxEvent, io: Io): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(exec.command, [...exec.args], {
      shell: false,
      stdio: ['pipe', 'inherit', 'inherit'],
      env: {
        ...process.env,
        ...io.env,
        NOSTRO_EVENT_ID: event.id,
        NOSTRO_EVENT_TYPE: event.type,
        NOSTRO_EVENT_SEQ: String(event.seq),
      },
      signal: io.signal,
    })
    let settled = false
    const finish = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(code)
    }
    const timer = setTimeout(() => {
      if (settled) return
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
      }, 500).unref()
      finish(124)
    }, exec.timeoutMs)
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code, signal) => {
      if (signal !== null) finish(124)
      else finish(code ?? 1)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(`${JSON.stringify(outboxEventJson(event))}\n`)
  })
}

async function currentPosition(store: Parameters<Parameters<typeof withStore>[2]>[0], key: ReturnType<typeof eventCursorKey>, tenantId: string): Promise<number> {
  const saved = await store.getCursor(key)
  if (saved !== null) return Number(saved)
  const pruned = await store.getEventsPrunedThrough(tenantId)
  await store.transaction((tx) => tx.setCursor(key, String(pruned)))
  return pruned
}

export const events: Command = {
  name: 'events',
  summary: 'Stream the tenant event log as JSON Lines, or run a command per event',
  usage: '[options] [--exec <cmd> [-- <args...>]]',
  help: `Prints events after the saved consumer position as JSON Lines. With --follow, keeps polling
for new events until interrupted. Filtered-out events still advance the saved consumer position.

Options:
  --after <n>         Start after this event seq instead of the saved consumer position
  --follow            Keep polling for new events
  --poll <ms>         Poll interval in follow mode (default 1000)
  --limit <n>         Events fetched per batch (default 100)
  --consumer <name>   Saved cursor name (default "events"; "webhook" is reserved)
  --type <type>       Only emit these event types; repeat or comma-separate
  --exec <cmd>        Run command per event: JSON on stdin, NOSTRO_EVENT_ID/TYPE/SEQ in env
  --exec-timeout <ms> Command timeout in milliseconds (default 10000)
${COMMON_HELP}

--exec runs the command directly (no shell). Event data is never passed as argv; put child
arguments after --. The consumer cursor advances only when the command exits 0; a non-zero exit
stops processing. Delivery is at-least-once; consumers should dedupe on event id.`,
  options: {
    ...COMMON,
    after: { type: 'string' },
    follow: { type: 'boolean' },
    poll: { type: 'string' },
    limit: { type: 'string' },
    consumer: { type: 'string' },
    type: { type: 'string', multiple: true },
    exec: { type: 'string' },
    'exec-timeout': { type: 'string' },
  },
  async run(args, io) {
    validatePositionals(args)
    const tenantId = tenant(args, io)
    const consumer = string(args, 'consumer') ?? 'events'
    if (consumer.trim() === '' || consumer.includes(':') || /\s/.test(consumer)) {
      throw new UsageError('--consumer must be a name without spaces or colons.')
    }
    if (consumer === 'webhook') throw new UsageError('--consumer "webhook" is reserved for webhook delivery.')
    const follow = flag(args, 'follow')
    const pollMs = integer(args, 'poll', 1000, 1, 3_600_000)
    const limit = integer(args, 'limit', 100, 1, 10_000)
    const afterRaw = string(args, 'after')
    let after = afterRaw === undefined ? undefined : Number(afterRaw)
    if (after !== undefined && (!Number.isInteger(after) || after < 0)) {
      throw new UsageError('--after must be a whole number from 0 upward.')
    }
    const types = eventTypes(args)
    const exec = execSpec(args)
    const key = eventCursorKey(tenantId, consumer)
    const typeSet = types === undefined ? null : new Set(types)

    return await withStore(args, io, async (store) => {
      let position = after ?? await currentPosition(store, key, tenantId)
      if (after !== undefined) {
        await store.transaction((tx) => tx.setCursor(key, String(after)))
      }
      for (;;) {
        if (io.signal?.aborted) return 0
        const batch = await store.listEvents({ tenantId, afterSeq: position, limit })
        if (batch.length === 0) {
          if (!follow) return 0
          const ok = await sleep(pollMs, io.signal)
          if (!ok) return 0
          continue
        }
        for (const event of batch) {
          if (io.signal?.aborted) return 0
          const current = await store.getCursor(key)
          const currentPos = current === null ? 0 : Number(current)
          if (currentPos !== position) {
            position = currentPos
            break
          }
          const selected = typeSet === null || typeSet.has(event.type)
          if (selected) {
            if (exec) {
              const code = await runExec(exec, event, io)
              if (code !== 0) {
                await write(io.stderr, `nostro: --exec exited with status ${code} on event ${event.id}; cursor not advanced.\n`)
                return 1
              }
            } else {
              await write(io.stdout, `${JSON.stringify(outboxEventJson(event))}\n`)
            }
          }
          const moved = await store.transaction(async (tx) => {
            const cur = await tx.getCursor(key)
            const curPos = cur === null ? 0 : Number(cur)
            if (curPos !== position) return { ok: false as const, position: curPos }
            await tx.setCursor(key, String(event.seq))
            return { ok: true as const, position: event.seq }
          })
          if (!moved.ok) {
            position = moved.position
            break
          }
          position = moved.position
        }
      }
    })
  },
}
