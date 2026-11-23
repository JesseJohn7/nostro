import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import type { HorizonRateLimit, MovementSource, Store } from '@nostro-labs/nostro'
import { StreamWatcher, deliverWebhooks, generateExpectations, sweepExpectations } from '@nostro-labs/nostro'
import type { KeyGrant, Scope } from '@nostro-labs/server'
import { SCOPES, apiKeys, createServer, firstOf, storedKeys } from '@nostro-labs/server'
import type { StoredKeys } from '@nostro-labs/server'
import type { Args, Network } from '../args.js'
import { CliError, NETWORK, RATE_LIMIT, UsageError, database, flag, integer, positionals, rateLimit, string } from '../args.js'
import type { Command } from '../command.js'
import { NETWORK_HELP, RATE_LIMIT_HELP, horizonClient, movementSources } from '../command.js'
import type { Io } from '../io.js'
import { clean, write } from '../io.js'
import { Limiter, startLoop } from '../serve-loops.js'
import type { Loop } from '../serve-loops.js'
import { tenantPlans } from '../serve-tenants.js'
import type { TenantPlan, Webhook } from '../serve-tenants.js'
import { assertCurrent, openStore, redact } from '../store.js'
import type { StreamProgress } from '../work.js'
import { reconcileAll, syncAll } from '../work.js'

/** Tenant ids cannot hold the characters the key syntax uses. */
const TENANT_ID = /^[^[\]:\s]+$/

/**
 * One API key entry: `tenant:key`, or `tenant[scope,scope]:key` to narrow it.
 * The key is everything after the first colon, so keys may contain colons.
 * A bracket counts only before that first colon, so `tenant:key` reads as
 * it always did, with every scope.
 */
function parseKeyEntry(entry: string): { key: string; tenant: string; scopes?: Scope[] } {
  const colon = entry.indexOf(':')
  if (colon < 1) throw new UsageError('Each API key is tenant:key, or tenant[scope,...]:key.')
  const head = entry.slice(0, colon)
  const key = entry.slice(colon + 1)
  const open = head.indexOf('[')
  if (open === -1) {
    if (!TENANT_ID.test(head)) throw new UsageError(`Tenant ids cannot contain [ ] : or spaces: ${clean(head)}.`)
    return { key, tenant: head }
  }
  const tenant = head.slice(0, open)
  if (!TENANT_ID.test(tenant) || !head.endsWith(']')) throw new UsageError('Scoped API keys are tenant[scope,...]:key.')
  const names = head.slice(open + 1, -1).split(',').map((n) => n.trim())
  for (const name of names) {
    if (!(SCOPES as readonly string[]).includes(name)) {
      throw new UsageError(`Unknown scope ${clean(name)}; scopes are ${SCOPES.join(', ')}.`)
    }
  }
  return { key, tenant, scopes: names as Scope[] }
}

/** Split NOSTRO_API_KEYS on commas that are not inside a tenant[scope,...] bracket. */
function splitEntries(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if (ch === '[') depth++
    else if (ch === ']') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      out.push(current.trim())
      current = ''
    } else current += ch
  }
  out.push(current.trim())
  return out.filter((e) => e !== '')
}

/**
 * API keys: comma-separated in NOSTRO_API_KEYS, or one per line in --keys-file
 * (blank lines and `#` comments skipped). Never on the command line, where `ps`
 * would show them. Keys written without scopes keep every scope, and their
 * numbers are returned so serve can warn about them without printing a key.
 */
function keys(args: Args, io: Io): { grants: Record<string, KeyGrant>; unscoped: { n: number; tenant: string }[] } {
  const file = string(args, 'keys-file')
  let entries: string[]
  if (file !== undefined) {
    let text: string
    try {
      text = readFileSync(resolve(io.cwd, file), 'utf8')
    } catch (err) {
      throw new CliError(`Cannot read --keys-file: ${(err as Error).message}`)
    }
    entries = text.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'))
  } else {
    entries = splitEntries(io.env.NOSTRO_API_KEYS ?? '')
  }
  const grants: Record<string, KeyGrant> = {}
  const unscoped: { n: number; tenant: string }[] = []
  entries.forEach((entry, i) => {
    const parsed = parseKeyEntry(entry)
    grants[parsed.key] = parsed.scopes === undefined ? parsed.tenant : { tenant: parsed.tenant, scopes: parsed.scopes }
    if (parsed.scopes === undefined) unscoped.push({ n: i + 1, tenant: parsed.tenant })
  })
  return { grants, unscoped }
}

export const serve: Command = {
  name: 'serve',
  summary: 'Run the HTTP API; keep every tenant\'s accounts synced and reconciled, and deliver their webhooks',
  usage: '[--config <file> | --account <G...>] [options]',
  help: `Serves the HTTP API (see packages/server) over the database. It works on one or more tenants:
with --config, each tenant in the file has its own accounts, network and webhook; without it, the
single-tenant flags describe one tenant (--tenant, --account, --webhook-url), as they always have.

Accounts come from the configuration and from the watch list in the store: POST /v1/accounts adds
one, and it is synced on the next round. Each tenant runs two timers, so one never waits for the other: a sync round (sync and reconcile its
accounts every --interval seconds, as "nostro sync" and "nostro reconcile" would) and a delivery
round (its events to its webhook every --delivery-interval seconds, signed with that webhook's
secret, docs/webhooks.md). A delivery round also runs right after a sync round that decided
something. A failing tenant is reported with its id and backs off on its own; the others carry on.
--concurrency bounds how many rounds run at once across all tenants. Stops cleanly on Ctrl-C or
SIGTERM, finishing the rounds in progress (up to --shutdown-timeout seconds).

--config file (JSON):
  { "tenants": [
      { "id": "acme", "network": "testnet", "accounts": ["G..."],
        "webhook": { "url": "https://acme.example/nostro", "secretEnv": "NOSTRO_WEBHOOK_SECRET_ACME" } },
      { "id": "beta", "network": "public", "accounts": ["G..."] } ] }
A webhook names the environment variable that holds its secret; the secret is never in the file.
The file replaces --tenant, --account, --network, --horizon and --webhook-url, and their environment
variables. API keys still come from NOSTRO_API_KEYS or --keys-file.

API keys decide the tenant and the scopes each request may use. They come from the store
(nostro keys create: a key created or revoked while serve runs takes effect on its next request),
and from NOSTRO_API_KEYS (tenant:key,tenant:key) or --keys-file (one tenant:key per line), never the
command line. A key can be
narrowed: tenant[read,events]:key. Each key must be at least 32 characters: openssl rand -hex 32.

Options:
  --port <n>          Port to listen on (env NOSTRO_PORT; default 8080; 0 picks a free one)
  --host <address>    Address to listen on (env NOSTRO_HOST; default 127.0.0.1; 0.0.0.0 in a container)
  --keys-file <file>  API keys, one tenant:key (or tenant[scope,...]:key) per line
  --config <file>     Every tenant to serve, as JSON (see above)
  --interval <s>      Seconds between sync rounds, per tenant (default 30)
  --delivery-interval <s>  Seconds between delivery rounds, per tenant (default 5)
  --concurrency <n>   Rounds that may run at once across all tenants (default 4, 1 to 64)
  --shutdown-timeout <s>   Seconds to wait for rounds in progress on Ctrl-C (default 30; 0 does not wait)
  --sse               Enable Horizon SSE streams to wake a tenant's sync round early (off by default; ADR 0005)
  --webhook-url <url> Deliver events here (env NOSTRO_WEBHOOK_URL); the secret comes only from
                      NOSTRO_WEBHOOK_SECRET
${NETWORK_HELP}
${RATE_LIMIT_HELP}
  --db <path|url>     SQLite file, or a postgres:// URL (env NOSTRO_DB; default ./nostro.db)
  --tenant <id>       The tenant the watched accounts belong to (env NOSTRO_TENANT; default "default")
  -h, --help          Show this help

SSE accelerator (--sse):
  When enabled, each tenant with accounts opens a Horizon SSE /ledgers?cursor=now stream. A new
  ledger wakes that tenant's sync round early; bursts are coalesced. The timed rounds keep running
  regardless, so a dropped or stalled stream loses nothing. See ADR 0005.`,
  options: {
    db: { type: 'string' },
    tenant: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    ...NETWORK,
    ...RATE_LIMIT,
    port: { type: 'string' },
    host: { type: 'string' },
    'keys-file': { type: 'string' },
    config: { type: 'string' },
    interval: { type: 'string' },
    'delivery-interval': { type: 'string' },
    concurrency: { type: 'string' },
    'shutdown-timeout': { type: 'string' },
    sse: { type: 'boolean' },
    'webhook-url': { type: 'string' },
  },
  async run(args, io) {
    positionals(args, 0)
    let unscoped: { n: number; tenant: string }[] = []
    let fileGrants: Record<string, KeyGrant> = {}
    try {
      const parsed = keys(args, io)
      unscoped = parsed.unscoped
      fileGrants = parsed.grants
    } catch (err) {
      if (err instanceof UsageError) throw err
      throw new CliError((err as Error).message)
    }
    const rawPort = string(args, 'port') ?? io.env.NOSTRO_PORT
    if (rawPort !== undefined && (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) > 65_535)) {
      throw new UsageError('--port must be a whole number from 0 to 65535.')
    }
    const port = rawPort === undefined ? 8080 : Number(rawPort)
    const host = string(args, 'host') ?? io.env.NOSTRO_HOST ?? '127.0.0.1'
    const interval = integer(args, 'interval', 30, 1, 86_400)
    const deliveryInterval = integer(args, 'delivery-interval', 5, 1, 86_400)
    const concurrency = integer(args, 'concurrency', 4, 1, 64)
    const shutdownTimeout = integer(args, 'shutdown-timeout', 30, 0, 86_400)
    const useSse = flag(args, 'sse')
    const plans = tenantPlans(args, io)
    const rate = rateLimit(args)

    const opened = await openStore(database(args, io), io, { create: false })
    const { store } = opened
    let stored: StoredKeys | null = null
    try {
      await assertCurrent(opened)
      // Keys from the environment or a file are checked first (a constant-time scan); then keys in the store.
      stored = storedKeys(store)
      const hasFileKeys = Object.keys(fileGrants).length > 0
      if (!hasFileKeys && (await store.listApiKeys()).length === 0) {
        throw new UsageError(
          'serve needs API keys: create one with "nostro keys create", or set NOSTRO_API_KEYS=tenant:key[,tenant:key...] or pass --keys-file.',
        )
      }
      let authenticate = stored.authenticate
      if (hasFileKeys) {
        try {
          authenticate = firstOf(apiKeys(fileGrants), stored.authenticate)
        } catch (err) {
          throw new CliError((err as Error).message)
        }
      }
      const app = createServer({ store, authenticate })
      await app.listen({ port, host })
      // Fastify reports one loopback address even when bound to every interface; say what was asked for.
      const bound = (app.server.address() as AddressInfo).port
      const address = `http://${host.includes(':') ? `[${host}]` : host}:${bound}`
      await write(io.stdout, `Listening on ${address} (database ${opened.label}).\n`)
      for (const u of unscoped) {
        await write(
          io.stderr,
          `Warning: API key #${u.n} (tenant ${clean(u.tenant)}) has no scopes and keeps every scope. Scope it as ${clean(u.tenant)}[read,...]:key.\n`,
        )
      }

      if (plans.length === 0) {
        await write(io.stdout, 'No accounts to watch and no webhook: serving the API only.\n')
        await stopped(io.signal)
      } else {
        await runTenants({ store, plans, interval, deliveryInterval, concurrency, shutdownTimeout, useSse, rate, io })
      }
      await app.close()
      await write(io.stdout, 'Stopped.\n')
      return 0
    } finally {
      // Last-used times that have not been written yet go to the store before it closes.
      await stored?.flush()
      await store.close()
    }
  },
}

interface RunOptions {
  readonly store: Store
  readonly plans: readonly TenantPlan[]
  readonly interval: number
  readonly deliveryInterval: number
  readonly concurrency: number
  readonly shutdownTimeout: number
  readonly useSse: boolean
  readonly rate: HorizonRateLimit | undefined
  readonly io: Io
}

/** One log line, with the tenant it is about, so an operator can tell which one a line is about. */
function line(out: Io['stdout'], tenantId: string, text: string): Promise<void> {
  return write(out, `${new Date().toISOString()} [tenant=${clean(tenantId)}] ${text}\n`)
}

/**
 * Start a sync and a delivery loop for every tenant, then wait for the
 * signal. Each loop reports its own failures, so a tenant whose Horizon or
 * receiver is down does not hold up any other.
 */
async function runTenants(o: RunOptions): Promise<void> {
  const { store, io } = o
  const limiter = new Limiter(o.concurrency)
  // One client per Horizon, shared by the tenants that use it, so --rate-limit is one budget per Horizon.
  const sourcesByHorizon = new Map<string, MovementSource[]>()
  const sourcesFor = (net: Network) => {
    let sources = sourcesByHorizon.get(net.horizon)
    if (sources === undefined) {
      sources = movementSources(horizonClient(net, io, o.rate), net)
      sourcesByHorizon.set(net.horizon, sources)
    }
    return sources
  }

  // The configured accounts seed the watch list; accounts added over the API join it on the next round.
  for (const plan of o.plans) {
    await store.transaction(async (tx) => {
      for (const account of plan.accounts) {
        await tx.addWatchedAccount({ tenantId: plan.id, account, source: 'config', addedAt: new Date() })
      }
    })
  }

  const loops: Loop[] = []
  const watchers: StreamWatcher[] = []
  for (const plan of o.plans) {
    const id = plan.id
    const warn = (text: string) => line(io.stderr, id, text)
    if (plan.network !== null) {
      await line(io.stdout, id, `Syncing and reconciling ${plan.accounts.length} account(s) on ${plan.network.name} for tenant ${clean(id)} every ${o.interval}s.`)
    }
    if (plan.webhook !== null) await line(io.stdout, id, `Delivering tenant ${clean(id)}'s events to ${redact(plan.webhook.url)}.`)

    const webhook = plan.webhook
    const delivery =
      webhook === null
        ? null
        : startLoop({
            everySeconds: o.deliveryInterval,
            signal: io.signal,
            step: () => limiter.run(() => deliver(store, id, webhook, io)),
            onError: (err) => void warn(`Delivery round failed: ${clean((err as Error).message)}`),
          })
    if (delivery !== null) loops.push(delivery)

    const sync = startLoop({
      everySeconds: o.interval,
      signal: io.signal,
      step: () =>
        limiter.run(async () => {
          await generateExpectations({ store, tenantId: id, until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) })
          if (plan.network === null) {
            await sweepExpectations({ store, tenantId: id })
          } else {
            await syncRound(store, plan, plan.network, sourcesFor(plan.network), io)
          }
          // New events are delivered now, not at the next delivery round.
          delivery?.wake()
        }),
      onError: (err) => void warn(`Round failed: ${clean((err as Error).message)}`),
    })
    loops.push(sync)

    if (o.useSse && plan.network !== null) {
      await line(io.stdout, id, `SSE accelerator enabled on ${plan.network.horizon}.`)
      const watcher = new StreamWatcher({
        horizonUrl: plan.network.horizon,
        onWake: () => sync.wake(),
        ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
      })
      watcher.start()
      watchers.push(watcher)
    }
  }

  await stopped(io.signal)
  for (const watcher of watchers) watcher.stop()
  // Each loop finishes its current round, then stops. Wait for them, but not forever.
  const finished = Promise.allSettled(loops.map((l) => l.done))
  const timedOut = await waitUpTo(finished, o.shutdownTimeout)
  if (timedOut) {
    await write(io.stderr, `Shutdown timed out after ${o.shutdownTimeout}s; stopping with rounds still in progress.\n`)
  }
}

/** Resolves true if `promise` has not settled after `seconds`, false once it has. */
async function waitUpTo(promise: Promise<unknown>, seconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), seconds * 1000)
  })
  const done = promise.then(() => false)
  const result = await Promise.race([done, late])
  clearTimeout(timer)
  return result
}

/**
 * One sync and reconcile round for a tenant's watched accounts, reporting each
 * stream's failures. What each pull did is recorded, so the API can show it.
 */
async function syncRound(store: Store, plan: TenantPlan, net: Network, sources: readonly MovementSource[], io: Io): Promise<void> {
  const id = plan.id
  const accounts = (await store.listWatchedAccounts(id)).map((w) => w.account)
  const streams = accounts.length === 0 ? [] : await syncAll({ store, tenantId: id, accounts, sources: [...sources] })
  if (streams.length > 0) await recordSync(store, id, net, streams)
  const totals = await reconcileAll(store, id, 100)
  const inserted = streams.reduce((n, s) => n + s.inserted, 0)
  if (inserted > 0 || totals.decided > 0) {
    await line(io.stdout, id, `synced ${inserted} new movement(s), decided ${totals.decided}.`)
  }
  for (const s of streams) {
    if (s.error !== null) await line(io.stderr, id, `${s.source} ${s.account}: ${clean(s.error.message)}`)
  }
  for (const [movementId, error] of totals.errors) await line(io.stderr, id, `Failed on movement ${movementId}: ${clean(error)}`)
}

/** Record where each stream stands after this round. A failed pull keeps the last time it succeeded. */
async function recordSync(store: Store, tenantId: string, net: Network, streams: readonly StreamProgress[]): Promise<void> {
  const now = new Date()
  const before = new Map(
    (await store.listSyncState(tenantId)).map((r) => [`${r.network}\n${r.source}\n${r.account}`, r] as const),
  )
  await store.transaction(async (tx) => {
    for (const s of streams) {
      const prior = before.get(`${net.name}\n${s.source}\n${s.account}`)
      await tx.recordSyncState({
        tenantId,
        network: net.name,
        source: s.source,
        account: s.account,
        cursor: s.cursor,
        lastAttemptAt: now,
        lastSuccessAt: s.error === null ? now : (prior?.lastSuccessAt ?? null),
        caughtUp: s.error === null && s.caughtUp,
        lastError: s.error === null ? null : s.error.message,
        lastErrorAt: s.error === null ? null : now,
      })
    }
  })
}

/** Deliver until caught up or a delivery fails; a failed event is retried next round. */
async function deliver(store: Store, tenantId: string, hook: Webhook, io: Io): Promise<void> {
  let total = 0
  for (;;) {
    const report = await deliverWebhooks({
      store,
      tenantId,
      url: hook.url,
      secret: hook.secret,
      ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
    })
    total += report.delivered
    if (report.failure !== null) {
      await line(io.stderr, tenantId, `Webhook failed on event ${report.failure.eventId}: ${clean(report.failure.reason)}; retrying next round.`)
    }
    if (report.delivered === 0 || report.failure !== null || report.contended) break
  }
  if (total > 0) await line(io.stdout, tenantId, `delivered ${total} event(s).`)
}

/** Resolves when the signal fires; never, without one. */
function stopped(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((done) => {
    if (signal === undefined) return
    if (signal.aborted) done()
    else signal.addEventListener('abort', () => done(), { once: true })
  })
}
