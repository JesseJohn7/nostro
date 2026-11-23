import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeHorizon } from 'nostro-testkit'
import { A, B, migrated, nostro, startServe as start } from './helpers.js'

const C = 'GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEBNS5'
const SECRET_ACME = 's'.repeat(64)
const SECRET_BETA = 't'.repeat(64)

/** Two tenants on two accounts, each with its own receiver, one Horizon serving both. */
async function twoTenants(config: unknown = undefined) {
  const cwd = await migrated()
  await nostro(cwd, ['expect', 'INV-A', '--account', A, '--amount', '25', '--tenant', 'acme'])
  await nostro(cwd, ['expect', 'INV-B', '--account', C, '--amount', '40', '--tenant', 'beta'])
  const h = new FakeHorizon()
  h.payment(10, B, A, '25', { memo: 'INV-A' })
  h.payment(11, B, C, '40', { memo: 'INV-B' })
  const file = join(cwd, 'tenants.json')
  writeFileSync(
    file,
    JSON.stringify(
      config ?? {
        tenants: [
          { id: 'acme', network: 'testnet', accounts: [A], webhook: { url: 'https://acme.example/n', secretEnv: 'SECRET_ACME' } },
          { id: 'beta', network: 'testnet', accounts: [C], webhook: { url: 'https://beta.example/n', secretEnv: 'SECRET_BETA' } },
        ],
      },
    ),
  )
  const env: Record<string, string> = { NOSTRO_API_KEYS: 'acme:' + 'k'.repeat(64), SECRET_ACME, SECRET_BETA }
  return { cwd, h, env }
}

/** Receivers by host, and a fetch that sends Horizon to the fake and webhooks to the receivers. */
function network(h: FakeHorizon, receivers: Record<string, (init: RequestInit) => Promise<Response>>) {
  const received: Record<string, string[]> = { acme: [], beta: [] }
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    for (const [tenant, host] of [['acme', 'https://acme.example/'], ['beta', 'https://beta.example/']] as const) {
      if (!u.startsWith(host)) continue
      const custom = receivers[tenant]
      if (custom !== undefined) return custom(init!)
      received[tenant]!.push(init!.body as string)
      return new Response(null, { status: 204 })
    }
    return h.fetch(url, init)
  }) as typeof globalThis.fetch
  return { received, fetch }
}

describe('nostro serve, several tenants', () => {
  it('syncs, reconciles and delivers every tenant, and each receiver gets only its own events', async () => {
    const { cwd, h, env } = await twoTenants()
    const { received, fetch } = network(h, {})
    const server = await start(cwd, ['--config', 'tenants.json', '--interval', '1', '--delivery-interval', '1'], { env, fetch })
    await server.until(() => received.acme!.length > 0 && received.beta!.length > 0)

    expect(server.out.stdout).toContain('[tenant=acme] ')
    expect(server.out.stdout).toContain('[tenant=beta] ')
    expect(received.acme!.some((b) => b.includes('INV-A'))).toBe(true)
    expect(received.acme!.some((b) => b.includes('INV-B'))).toBe(false)
    expect(received.beta!.some((b) => b.includes('INV-B'))).toBe(true)
    expect(received.beta!.some((b) => b.includes('INV-A'))).toBe(false)
    expect(await server.stop()).toBe(0)
  })

  it('keeps one tenant going when its Horizon fails, and says which tenant failed', async () => {
    const { cwd, h, env } = await twoTenants()
    const { received, fetch } = network(h, {})
    const horizonFails = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes(A)) {
        return new Response(JSON.stringify({ type: 'https://stellar.org/horizon-errors/bad_request', status: 400, title: 'Bad Request' }), { status: 400 })
      }
      return fetch(url, init)
    }) as typeof globalThis.fetch
    const server = await start(cwd, ['--config', 'tenants.json', '--interval', '1', '--delivery-interval', '1'], { env, fetch: horizonFails })
    await server.until(() => received.beta!.length > 0)
    expect(server.out.stderr).toMatch(new RegExp(`\\[tenant=acme\\] horizon ${A}:`))
    expect(server.out.stderr).not.toMatch(new RegExp(`\\[tenant=beta\\] horizon`))
    expect(await server.stop()).toBe(0)
  })

  it('keeps delivering to one tenant while another receiver hangs, and stops within the shutdown timeout', async () => {
    const { cwd, h, env } = await twoTenants()
    const hang = (init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    const { received, fetch } = network(h, { acme: hang })
    const server = await start(cwd, ['--config', 'tenants.json', '--interval', '1', '--delivery-interval', '1', '--shutdown-timeout', '1'], {
      env,
      fetch,
    })
    await server.until(() => received.beta!.some((b) => b.includes('INV-B')))
    expect(received.acme).toEqual([])
    const started = Date.now()
    expect(await server.stop()).toBe(0)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(server.out.stdout).toMatch(/Stopped\.\n$/)
  })

  it('refuses a config that also gives single-tenant flags, or a secret written into the file', async () => {
    const { cwd, env } = await twoTenants()
    const run = (argv: string[], e = env) => nostro(cwd, ['serve', ...argv], { env: e })
    expect((await run(['--config', 'tenants.json', '--account', A])).stderr).toContain('--config replaces --account')
    expect((await run(['--config', 'tenants.json'], { ...env, NOSTRO_WEBHOOK_URL: 'https://x.example/' })).stderr).toContain(
      '--config replaces NOSTRO_WEBHOOK_URL',
    )
    writeFileSync(join(cwd, 'secret.json'), JSON.stringify({ tenants: [{ id: 'acme', network: 'testnet', accounts: [A], webhook: { url: 'https://acme.example/n', secret: 'x'.repeat(64) } }] }))
    expect((await run(['--config', 'secret.json'], env)).stderr).toContain('has an unknown field "secret"')
    writeFileSync(join(cwd, 'bad.json'), JSON.stringify({ tenants: [{ id: 'acme', network: 'testnet', accounts: ['not-an-account'] }] }))
    expect((await run(['--config', 'bad.json'], env)).stderr).toContain('not a G... address')
    writeFileSync(join(cwd, 'dup.json'), JSON.stringify({ tenants: [{ id: 'acme' }, { id: 'acme' }] }))
    expect((await run(['--config', 'dup.json'], env)).stderr).toContain('repeats tenant "acme"')
    writeFileSync(join(cwd, 'nosecret.json'), JSON.stringify({ tenants: [{ id: 'acme', network: 'testnet', accounts: [A], webhook: { url: 'https://acme.example/n', secretEnv: 'MISSING_SECRET' } }] }))
    expect((await run(['--config', 'nosecret.json'], env)).stderr).toContain('needs MISSING_SECRET')
  })
})
