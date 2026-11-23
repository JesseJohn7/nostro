import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifyWebhook } from '@nostro-labs/nostro'
import { FakeHorizon } from 'nostro-testkit'
import { A, B, migrated, nostro, startServe as start } from './helpers.js'

type Page = { data: { reference: string }[] }

const KEY = 'k'.repeat(64)
const env = { NOSTRO_API_KEYS: `acme:${KEY}` }

describe('nostro serve', () => {
  it('serves the API, and syncs and reconciles the watched accounts every interval', async () => {
    const cwd = await migrated()
    const h = new FakeHorizon()
    h.payment(10, B, A, '25', { memo: 'INV-1042' })
    await nostro(cwd, ['expect', 'INV-1042', '--account', A, '--amount', '25', '--tenant', 'acme'])
    await nostro(cwd, ['expect', 'INV-1043', '--account', A, '--amount', '10', '--tenant', 'acme'])
    const server = await start(cwd, ['--account', A, '--tenant', 'acme', '--interval', '1'], { fetch: h.fetch })
    expect(server.out.stdout).toContain(`Syncing and reconciling 1 account(s) on testnet for tenant acme every 1s.\n`)

    expect(await (await fetch(`${server.address}/v1/health`)).json()).toEqual({ ok: true })
    expect((await server.get('/v1/movements', 'x'.repeat(64))).status).toBe(401)
    await server.until(() => server.out.stdout.includes('synced 1 new movement(s), decided 1.'))
    const settled = (await (await server.get('/v1/expectations?status=settled')).json()) as Page
    expect(settled.data.map((e) => e.reference)).toEqual(['INV-1042'])

    // A payment arriving later is picked up by a later round.
    h.payment(12, B, A, '10', { memo: 'INV-1043' })
    await server.until(() => server.out.stdout.split('synced 1 new movement(s), decided 1.').length === 3)
    const all = (await (await server.get('/v1/expectations?status=settled')).json()) as Page
    expect(all.data.map((e) => e.reference)).toEqual(['INV-1042', 'INV-1043'])

    expect(await server.stop()).toBe(0)
    expect(server.out.stdout).toMatch(/Stopped\.\n$/)
    await expect(fetch(`${server.address}/v1/health`)).rejects.toThrow()
  })

  it('delivers each decision to the webhook, signed, and retries one that failed', async () => {
    const cwd = await migrated()
    const h = new FakeHorizon()
    h.payment(10, B, A, '25', { memo: 'INV-1042' })
    await nostro(cwd, ['expect', 'INV-1042', '--account', A, '--amount', '25', '--tenant', 'acme'])
    const secret = 'w'.repeat(64)
    const received: { headers: Record<string, string>; body: string }[] = []
    let refuse = 1
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).startsWith('https://hooks.example/')) return h.fetch(url, init)
      if (refuse-- > 0) return new Response('busy', { status: 503 })
      received.push({ headers: init!.headers as Record<string, string>, body: init!.body as string })
      return new Response(null, { status: 204 })
    }) as typeof globalThis.fetch
    const server = await start(cwd, ['--account', A, '--tenant', 'acme', '--interval', '1', '--webhook-url', 'https://hooks.example/n'], {
      env: { ...env, NOSTRO_WEBHOOK_SECRET: secret },
      fetch,
    })
    expect(server.out.stdout).toContain("Delivering tenant acme's events to https://hooks.example/n.\n")
    // One payment to A (B paid the fee): the invoice settles and the movement is decided.
    await server.until(() => server.out.stdout.includes('delivered 2 event(s).'))
    expect(server.out.stderr).toMatch(/Webhook failed on event \S+: HTTP 503; retrying next round\.\n/)
    expect(received.map((r) => JSON.parse(r.body).type)).toEqual(['expectation.settled', 'movement.decided'])
    expect(received.every((r) => verifyWebhook({ secret, header: r.headers['nostro-signature'], body: r.body }))).toBe(true)
    expect(await server.stop()).toBe(0)
  })

  it('serves the API alone when no account is watched, with keys from a file', async () => {
    const cwd = await migrated()
    writeFileSync(join(cwd, 'keys'), `# tenants\n\nacme:${KEY}\nother:${'o'.repeat(40)}\n`)
    const server = await start(cwd, ['--keys-file', 'keys'], { env: {} })
    expect(server.out.stdout).toContain('No accounts to watch and no webhook: serving the API only.\n')
    expect((await server.get('/v1/movements')).status).toBe(200)
    expect((await server.get('/v1/movements', 'o'.repeat(40))).status).toBe(200)
    expect(await server.stop()).toBe(0)
  })

  it('reports a failing round and keeps going', async () => {
    const cwd = await migrated()
    const fetchFails = (async () =>
      new Response(JSON.stringify({ type: 'https://stellar.org/horizon-errors/bad_request', status: 400, title: 'Bad Request' }), {
        status: 400,
      })) as typeof fetch
    const server = await start(cwd, ['--account', A, '--interval', '1'], { fetch: fetchFails })
    await server.until(() => server.out.stderr.split(`horizon ${A}:`).length >= 3)
    expect((await server.get('/v1/health')).status).toBe(200)
    expect(await server.stop()).toBe(0)
  })

  it('includes issued muxed ids in API output', async () => {
    const cwd = await migrated()
    const created = await nostro(cwd, ['expect', 'INV-M1', '--account', A, '--amount', '1', '--issue-muxed-id', '--tenant', 'acme', '--json'])
    const first = JSON.parse(created.stdout) as { id: string; muxedId: string }
    const second = await nostro(cwd, ['expect', 'INV-M2', '--account', A, '--amount', '2', '--issue-muxed-id', '--tenant', 'acme', '--json'])
    expect([first.muxedId, JSON.parse(second.stdout).muxedId]).toEqual(['1', '2'])
    const server = await start(cwd, [])
    try {
      const listed = (await (await server.get('/v1/expectations')).json()) as { data: { reference: string; muxedId: string | null }[] }
      expect(listed.data.map((e) => [e.reference, e.muxedId])).toEqual([['INV-M1', '1'], ['INV-M2', '2']])
      const one = (await (await server.get(`/v1/expectations/${first.id}`)).json()) as { expectation: { muxedId: string } }
      expect(one.expectation.muxedId).toBe('1')
    } finally {
      await server.stop()
    }
  })

  it('says which address it is bound to', async () => {
    const cwd = await migrated()
    const server = await start(cwd, ['--host', '0.0.0.0'])
    expect(server.address).toMatch(/^http:\/\/0\.0\.0\.0:\d+$/)
    expect((await fetch(server.address.replace('0.0.0.0', '127.0.0.1') + '/v1/health')).status).toBe(200)
    expect(await server.stop()).toBe(0)
  })

  it('reads scoped keys, keeps legacy keys whole, and warns about unscoped ones without printing them', async () => {
    const cwd = await migrated()
    const READ = 'r'.repeat(40)
    const LEGACY = `legacy-${'l'.repeat(40)}`
    const scopedEnv = { NOSTRO_API_KEYS: `acme[read,events]:${READ},acme:${LEGACY}` }
    const server = await start(cwd, [], { env: scopedEnv })
    const as = (key: string, path: string) => fetch(`${server.address}${path}`, { headers: { authorization: `Bearer ${key}` } })
    expect((await as(READ, '/v1/movements')).status).toBe(200)
    expect((await as(READ, '/v1/events')).status).toBe(200)
    expect((await as(READ, '/v1/expectations/none/cancel')).status).toBe(404)
    const refused = await fetch(`${server.address}/v1/journal`, { method: 'POST', headers: { authorization: `Bearer ${READ}`, 'content-type': 'application/json' }, body: '{}' })
    expect(refused.status).toBe(403)
    expect((await as(LEGACY, '/v1/events')).status).toBe(200)
    expect(server.out.stderr).toContain('API key #2 (tenant acme) has no scopes')
    expect(server.out.stderr).not.toContain(LEGACY)
    expect(server.out.stdout + server.out.stderr).not.toContain(READ)
    expect(await server.stop()).toBe(0)
  })

  it('refuses a scoped key entry it cannot read', async () => {
    const cwd = await migrated()
    const KEY_ = 'x'.repeat(40)
    expect((await nostro(cwd, ['serve'], { env: { NOSTRO_API_KEYS: `acme[read,admin]:${KEY_}` } })).stderr).toContain('Unknown scope admin')
    expect((await nostro(cwd, ['serve'], { env: { NOSTRO_API_KEYS: `ac me[read]:${KEY_}` } })).stderr).toContain('Scoped API keys are tenant[scope,...]:key')
    expect((await nostro(cwd, ['serve'], { env: { NOSTRO_API_KEYS: `acme[]:${KEY_}` } })).stderr).toContain('Unknown scope')
  })

  it('refuses to start without usable keys, a usable port, or an up-to-date database', async () => {
    const cwd = await migrated()
    const run = (argv: string[], e: Record<string, string> = env) => nostro(cwd, ['serve', ...argv], { env: e })
    expect(await run([], {})).toMatchObject({ code: 2 })
    expect((await run([], {})).stderr).toContain('serve needs API keys')
    expect((await run([], { NOSTRO_API_KEYS: KEY })).stderr).toContain('Each API key is tenant:key, or tenant[scope,...]:key.')
    expect(await run([], { NOSTRO_API_KEYS: 'acme:short' })).toMatchObject({ code: 1, stderr: 'nostro: API keys must be at least 32 characters.\n' })
    expect((await run(['--keys-file', 'missing'])).stderr).toContain('Cannot read --keys-file')
    expect((await run(['--port', '70000'])).code).toBe(2)
    expect((await run([], { ...env, NOSTRO_PORT: 'http' })).code).toBe(2)
    expect((await run(['--interval', '0'])).code).toBe(2)
    expect((await run(['--webhook-url', 'https://hooks.example/n'])).stderr).toContain('A webhook needs NOSTRO_WEBHOOK_SECRET')
    expect((await run(['--webhook-url', 'https://hooks.example/n'], { ...env, NOSTRO_WEBHOOK_SECRET: 'short' })).code).toBe(2)
    expect((await run(['--webhook-url', 'hooks'])).stderr).toContain('--webhook-url must be a URL')
    expect((await run(['--webhook-url', 'ftp://hooks.example'])).stderr).toContain('must be an http(s) URL')
    expect((await nostro(await migrated(), ['serve', '--db', 'missing.db'], { env })).stderr).toContain('No database at')
  })

  it('runs a round immediately when requested via POST /v1/rounds without waiting for --interval', async () => {
    const cwd = await migrated()
    const h = new FakeHorizon()
    h.payment(10, B, A, '50', { memo: 'INV-ROUND' })
    await nostro(cwd, ['expect', 'INV-ROUND', '--account', A, '--amount', '50', '--tenant', 'acme'])

    // Long interval (1 hour): serve would never sync on its own without manual trigger
    const server = await start(cwd, ['--account', A, '--tenant', 'acme', '--interval', '3600'], { fetch: h.fetch })

    const triggerRes = await server.post('/v1/rounds', { account: A })
    expect(triggerRes.status).toBe(202)
    const location = triggerRes.headers.get('location')
    expect(location).toMatch(/^\/v1\/rounds\//)
    const initial = (await triggerRes.json()) as { id: string; state: string }
    expect(['queued', 'running']).toContain(initial.state)

    let round: any
    await server.until(async () => {
      const res = await server.get(location!)
      if (res.status !== 200) return false
      round = await res.json()
      return round.state === 'done'
    })

    expect(round.state).toBe('done')
    expect(round.summary).toMatchObject({
      movementsInserted: 1,
      movementsDecided: 1,
      errors: [],
    })

    const settled = (await (await server.get('/v1/expectations?status=settled')).json()) as Page
    expect(settled.data.map((e) => e.reference)).toContain('INV-ROUND')
    expect(await server.stop()).toBe(0)
  })

  it('coalesces multiple round requests, enforces per-tenant rate limit, and preserves tenant isolation', async () => {
    const cwd = await migrated()
    const OTHER_KEY = 'o'.repeat(64)
    const server = await start(cwd, ['--account', A, '--tenant', 'acme', '--interval', '3600'], {
      env: { NOSTRO_API_KEYS: `acme:${KEY},other:${OTHER_KEY}` },
    })

    // Coalescing: two rapid requests coalesce into the same queued round
    const [res1, res2] = await Promise.all([
      server.post('/v1/rounds', { account: A }),
      server.post('/v1/rounds', { account: A }),
    ])
    expect(res1.status).toBe(202)
    expect(res2.status).toBe(202)
    const body1 = (await res1.json()) as { id: string }
    const body2 = (await res2.json()) as { id: string }
    expect(body1.id).toBe(body2.id)

    // Rate limiting: 5 requests per minute per tenant
    const res3 = await server.post('/v1/rounds')
    const res4 = await server.post('/v1/rounds')
    const res5 = await server.post('/v1/rounds')
    expect([res3.status, res4.status, res5.status]).toEqual([202, 202, 202])

    // 6th request within a minute exceeds rate limit
    const res6 = await server.post('/v1/rounds')
    expect(res6.status).toBe(429)
    const rateLimited = (await res6.json()) as { code: string }
    expect(rateLimited.code).toBe('too_many_requests')

    // Tenant isolation: other tenant is not rate limited
    const otherTrigger = await server.post('/v1/rounds', {}, OTHER_KEY)
    expect(otherTrigger.status).toBe(202)

    // Tenant isolation: other tenant cannot read acme's round
    const otherRead = await server.get(`/v1/rounds/${body1.id}`, OTHER_KEY)
    expect(otherRead.status).toBe(404)

    expect(await server.stop()).toBe(0)
  })
})
