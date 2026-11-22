import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeHorizon } from 'nostro-testkit'
import { A, B, migrated, nostro, startServe as start } from './helpers.js'

const KEY_RE = /nstk_[A-Za-z0-9_-]{43}/

async function create(cwd: string, label: string, scopes: string, tenant = 'acme') {
  const res = await nostro(cwd, ['keys', 'create', '--tenant', tenant, '--label', label, '--scopes', scopes, '--json'])
  expect(res.code).toBe(0)
  return JSON.parse(res.stdout) as { id: string; key: string }
}

describe('nostro keys', () => {
  it('creates a key once, never lists it, and never stores it', async () => {
    const cwd = await migrated()
    const plain = await nostro(cwd, ['keys', 'create', '--tenant', 'acme', '--label', 'dashboard', '--scopes', 'read,events'])
    const key = KEY_RE.exec(plain.stdout)![0]
    expect(plain.stdout).toContain('shown once')

    const listed = await nostro(cwd, ['keys', 'list'])
    expect(listed.stdout).toContain('dashboard')
    expect(listed.stdout).toContain('read,events')
    expect(listed.stdout).not.toContain(key)
    expect((await nostro(cwd, ['keys', 'list', '--json'])).stdout).not.toContain(key)

    // The database holds a digest, never the key itself.
    expect(readFileSync(join(cwd, 'nostro.db')).includes(Buffer.from(key))).toBe(false)
  })

  it('needs a tenant, a label and scopes, and refuses a scope it does not know', async () => {
    const cwd = await migrated()
    const run = (argv: string[]) => nostro(cwd, ['keys', ...argv])
    expect((await run(['create', '--label', 'x', '--scopes', 'read'])).stderr).toContain('needs --tenant')
    expect((await run(['create', '--tenant', 'acme', '--scopes', 'read'])).stderr).toContain('needs --label')
    expect((await run(['create', '--tenant', 'acme', '--label', 'x'])).stderr).toContain('--scopes needs at least one scope')
    expect((await run(['create', '--tenant', 'acme', '--label', 'x', '--scopes', 'admin'])).stderr).toContain('Unknown scope admin')
    expect((await run(['bogus'])).stderr).toContain('keys needs one of')
  })

  it('revokes a key, and says so when it is revoked again', async () => {
    const cwd = await migrated()
    const made = await create(cwd, 'old', 'read')
    expect((await nostro(cwd, ['keys', 'revoke', made.id])).stdout).toMatch(/is revoked \(since /)
    expect((await nostro(cwd, ['keys', 'revoke', made.id])).stdout).toMatch(/is revoked/)
    expect((await nostro(cwd, ['keys', 'revoke', 'nope'])).stderr).toContain('No key with id nope.')
  })

  it('serves a key created while serve runs, and refuses it on the next request once revoked, with the same answer as a wrong key', async () => {
    const cwd = await migrated()
    const h = new FakeHorizon()
    h.payment(10, B, A, '25', { memo: 'INV-1042' })
    await nostro(cwd, ['expect', 'INV-1042', '--account', A, '--amount', '25', '--tenant', 'acme'])
    const made = await create(cwd, 'live', 'read')
    const server = await start(cwd, [], { env: {}, fetch: h.fetch })

    // A key stored after serve started works without a restart.
    const live = await server.get('/v1/expectations', made.key)
    expect(live.status).toBe(200)
    expect((await server.get('/v1/expectations', 'z'.repeat(48))).status).toBe(401)

    await nostro(cwd, ['keys', 'revoke', made.id])
    const revoked = await server.get('/v1/expectations', made.key)
    expect(revoked.status).toBe(401)
    const wrong = await server.get('/v1/expectations', 'z'.repeat(48))
    // A revoked key and a wrong key are indistinguishable to the caller.
    expect(await revoked.json()).toEqual(await wrong.json())
    expect(await server.stop()).toBe(0)

    // The last use was written when serve stopped, so the list now shows it.
    const after = JSON.parse((await nostro(cwd, ['keys', 'list', '--json'])).stdout) as { id: string; lastUsedAt: string | null }[]
    expect(after.find((k) => k.id === made.id)?.lastUsedAt).not.toBeNull()
  })

  it('refuses to serve with no keys at all, from the file or the store', async () => {
    const cwd = await migrated()
    expect((await nostro(cwd, ['serve'], { env: {} })).stderr).toContain('serve needs API keys: create one with "nostro keys create"')
  })
})
