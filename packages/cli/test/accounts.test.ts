import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeHorizon } from 'nostro-testkit'
import { A, B, migrated, nostro, startServe as start } from './helpers.js'

const C = 'GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA'
const KEY = 'k'.repeat(64)
const env = { NOSTRO_API_KEYS: `acme:${KEY}` }

type Sync = { network: string; source: string; cursor: string | null; lastSuccessAt: string | null; caughtUp: boolean; lastError: string | null }
type Watched = { account: string; source: 'config' | 'api'; sync: Sync[] }

async function api(server: { address: string }, method: string, path: string, body?: unknown) {
  const res = await fetch(`${server.address}${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, json: text === '' ? null : JSON.parse(text), text }
}

/** Poll until an async check passes; `until` in the helpers is for synchronous checks only. */
async function eventually(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const watchedOf = async (server: { address: string }) => ((await api(server, 'GET', '/v1/accounts')).json.data as Watched[])

describe('watched accounts over the API', () => {
  it('starts syncing an account added while serve runs, and shows its sync state', async () => {
    const cwd = await migrated()
    writeFileSync(join(cwd, 'tenants.json'), JSON.stringify({ tenants: [{ id: 'acme', network: 'testnet' }] }))
    const h = new FakeHorizon()
    h.payment(10, B, A, '25', { memo: 'INV-1042' })
    await nostro(cwd, ['expect', 'INV-1042', '--account', A, '--amount', '25', '--tenant', 'acme'])
    const server = await start(cwd, ['--config', 'tenants.json', '--interval', '1'], { env, fetch: h.fetch })

    expect((await api(server, 'GET', '/v1/accounts')).json.data).toEqual([])
    const added = await api(server, 'POST', '/v1/accounts', { account: A })
    expect(added.status).toBe(201)
    expect(added.json).toMatchObject({ account: A, source: 'api' })
    expect((await api(server, 'POST', '/v1/accounts', { account: A })).status).toBe(200)

    // The next round syncs it: the payment is recorded and the invoice settles.
    await server.until(() => server.out.stdout.includes('synced 1 new movement(s), decided 1.'))
    const settled = (await (await server.get('/v1/expectations?status=settled')).json()) as { data: { reference: string }[] }
    expect(settled.data.map((e) => e.reference)).toEqual(['INV-1042'])
    const [row] = await watchedOf(server)
    expect(row!.sync).toEqual([
      expect.objectContaining({ network: 'testnet', source: expect.any(String), caughtUp: true, lastError: null, lastSuccessAt: expect.any(String) }),
      expect.objectContaining({ network: 'testnet', caughtUp: true, lastError: null }),
    ])
    expect(await server.stop()).toBe(0)
  })

  it('shows a Horizon error for an account, and clears it after a good round', async () => {
    const cwd = await migrated()
    writeFileSync(join(cwd, 'tenants.json'), JSON.stringify({ tenants: [{ id: 'acme', network: 'testnet', accounts: [A] }] }))
    const h = new FakeHorizon()
    let failing = true
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (failing && String(url).includes(A)) {
        return new Response(JSON.stringify({ type: 'https://stellar.org/horizon-errors/bad_request', status: 400, title: 'Bad Request' }), { status: 400 })
      }
      return h.fetch(url, init)
    }) as typeof globalThis.fetch
    const server = await start(cwd, ['--config', 'tenants.json', '--interval', '1'], { env, fetch })

    await eventually(async () => ((await watchedOf(server))[0]?.sync ?? []).some((s) => s.lastError !== null), 'a Horizon error')
    const broken = (await watchedOf(server))[0]!.sync.find((s) => s.lastError !== null)!
    expect(broken.lastError).toMatch(/400|Bad Request|bad_request/i)
    expect(broken.caughtUp).toBe(false)

    failing = false
    await eventually(async () => (await watchedOf(server))[0]!.sync.every((s) => s.lastError === null && s.lastSuccessAt !== null), 'the error to clear')
    expect(await server.stop()).toBe(0)
  })

  it('stops syncing a removed account, keeps what it has, and resumes when it is added back', async () => {
    const cwd = await migrated()
    writeFileSync(join(cwd, 'tenants.json'), JSON.stringify({ tenants: [{ id: 'acme', network: 'testnet' }] }))
    const h = new FakeHorizon()
    h.payment(10, B, A, '25', { memo: 'INV-1' })
    const server = await start(cwd, ['--config', 'tenants.json', '--interval', '1'], { env, fetch: h.fetch })
    await api(server, 'POST', '/v1/accounts', { account: A })
    await server.until(() => server.out.stdout.includes('synced 1 new movement(s)'))

    expect((await api(server, 'DELETE', `/v1/accounts/${A}`)).status).toBe(204)
    expect(await watchedOf(server)).toEqual([])
    const movementsBefore = ((await (await server.get('/v1/movements')).json()) as { data: unknown[] }).data.length

    h.payment(11, B, A, '5', { memo: 'later' })
    const stdoutBefore = server.out.stdout.length
    await new Promise((r) => setTimeout(r, 1500))
    expect(server.out.stdout.slice(stdoutBefore)).not.toContain('synced')
    expect(((await (await server.get('/v1/movements')).json()) as { data: unknown[] }).data.length).toBe(movementsBefore)

    expect((await api(server, 'POST', '/v1/accounts', { account: A })).status).toBe(201)
    await server.until(() => server.out.stdout.slice(stdoutBefore).includes('synced 1 new movement(s)'))
    expect(((await (await server.get('/v1/movements')).json()) as { data: unknown[] }).data.length).toBe(movementsBefore + 1)
    expect(await server.stop()).toBe(0)
  })

  it('refuses to remove a configured account, or one with open expectations unless forced', async () => {
    const cwd = await migrated()
    writeFileSync(join(cwd, 'tenants.json'), JSON.stringify({ tenants: [{ id: 'acme', network: 'testnet', accounts: [A] }] }))
    await nostro(cwd, ['expect', 'INV-OPEN', '--account', C, '--amount', '10', '--tenant', 'acme'])
    const server = await start(cwd, ['--config', 'tenants.json', '--interval', '60'], { env, fetch: new FakeHorizon().fetch })
    await api(server, 'POST', '/v1/accounts', { account: C })

    const configured = await api(server, 'DELETE', `/v1/accounts/${A}`)
    expect(configured.status).toBe(409)
    expect(configured.json).toMatchObject({ code: 'config_managed', status: 409 })

    const open = await api(server, 'DELETE', `/v1/accounts/${C}`)
    expect(open.status).toBe(409)
    expect(open.json).toMatchObject({ code: 'has_open_expectations' })

    expect((await api(server, 'DELETE', `/v1/accounts/${C}?force=true`)).status).toBe(204)
    expect((await api(server, 'DELETE', `/v1/accounts/${C}`)).status).toBe(404)
    expect(await server.stop()).toBe(0)
  })

  it('accepts only G... accounts', async () => {
    const cwd = await migrated()
    const server = await start(cwd, [])
    expect((await api(server, 'POST', '/v1/accounts', { account: 'C'.repeat(56) })).status).toBe(400)
    expect((await api(server, 'DELETE', '/v1/accounts/not-an-account')).status).toBe(400)
    expect(await server.stop()).toBe(0)
  })
})
