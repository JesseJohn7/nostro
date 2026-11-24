import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Money, NATIVE, reconcile } from '@nostro-labs/nostro'
import { SqliteStore } from '@nostro-labs/store-sqlite'
import { A, B, SERVE_KEY, migrated, nostro, startServe, workspace } from './helpers.js'

vi.setConfig({ testTimeout: 20_000 })

/** One expectation, one overpayment and >1 page of expectations, in the default tenant. */
async function seed(): Promise<string> {
  const cwd = await migrated()
  const store = new SqliteStore({ filename: join(cwd, 'nostro.db') })
  await store.transaction(async (tx) => {
    await tx.insertExpectation({
      tenantId: 'default',
      reference: 'INV-1',
      account: A,
      amount: Money.parse('25', NATIVE),
    })
    await tx.insertMovements([
      {
        tenantId: 'default',
        network: 'testnet',
        source: 'horizon',
        externalId: 'payment-1',
        account: A,
        direction: 'credit',
        kind: 'transfer',
        amount: Money.parse('30', NATIVE),
        counterparty: B,
        memo: { type: 'text', value: 'INV-1' },
        ledger: 10,
        occurredAt: new Date(),
      },
    ])
    for (let i = 0; i < 150; i++) {
      await tx.insertExpectation({
        tenantId: 'default',
        reference: `EXTRA-${i}`,
        account: A,
        amount: Money.parse('1', NATIVE),
      })
    }
  })
  const report = await reconcile({ store, tenantId: 'default' })
  expect(report.partial).toBe(1)
  await store.close()
  return cwd
}

async function pair() {
  const local = await seed()
  const apiDir = workspace()
  copyFileSync(join(local, 'nostro.db'), join(apiDir, 'nostro.db'))
  const server = await startServe(apiDir, [], { env: { NOSTRO_API_KEYS: `default:${SERVE_KEY}` } })
  return { local, apiDir, server, key: { NOSTRO_API_KEY: SERVE_KEY } }
}

describe('remote mode', () => {
  it('prints identical text and JSON in local and remote mode, following the next cursor', async () => {
    const { local, apiDir, server, key } = await pair()
    try {
      for (const argv of [
        ['expectations'],
        ['expectations', '--json'],
        ['expectations', '--limit', '200', '--json'],
        ['exceptions'],
        ['exceptions', '--json'],
        ['export', '--format', 'csv'],
      ]) {
        const a = await nostro(local, argv)
        const b = await nostro(apiDir, [...argv, '--api', server.address], { env: key })
        expect(b.code, argv.join(' ')).toBe(a.code)
        expect(b.stdout, argv.join(' ')).toBe(a.stdout)
        expect(b.stderr, argv.join(' ')).toBe(a.stderr)
      }
      const paged = JSON.parse((await nostro(apiDir, ['expectations', '--limit', '200', '--json', '--api', server.address], { env: key })).stdout)
      expect(paged.length).toBe(151)
    } finally {
      await server.stop()
    }
  })

  it('resolves the same exception with the same output in both modes', async () => {
    const { local, apiDir, server, key } = await pair()
    try {
      const listed = await nostro(local, ['exceptions', '--json'])
      const [exception] = JSON.parse(listed.stdout) as { id: string }[]
      expect(exception).toBeDefined()
      const argv = ['resolve', exception!.id, '--ignore', '--note', 'handled by test']
      const a = await nostro(local, argv)
      const b = await nostro(apiDir, [...argv, '--api', server.address], { env: key })
      expect(b.code).toBe(a.code)
      expect(b.stdout).toBe(a.stdout)
      expect(b.stderr).toBe(a.stderr)
    } finally {
      await server.stop()
    }
  })

  it('refuses a local-only command, a wrong key and a refused resolution', async () => {
    const { apiDir, server, key } = await pair()
    try {
      const localOnly = await nostro(apiDir, ['reconcile', '--api', server.address], { env: key })
      expect(localOnly.code).toBe(1)
      expect(localOnly.stderr).toContain('needs a local database')

      const wrong = await nostro(apiDir, ['exceptions', '--api', server.address], { env: { NOSTRO_API_KEY: 'wrong-key' } })
      expect(wrong.code).toBe(1)
      expect(wrong.stderr).toContain('unauthorized')
      expect(wrong.stderr).not.toContain('wrong-key')

      const listed = await nostro(apiDir, ['exceptions', '--json', '--api', server.address], { env: key })
      const [exception] = JSON.parse(listed.stdout) as { id: string }[]
      // Applying to an unknown reference is refused by the server with 422.
      const refused = await nostro(apiDir, ['resolve', exception!.id, '--apply', 'NO-SUCH-REF', '--note', 'n', '--api', server.address], { env: key })
      expect(refused.code).toBe(2)
      expect(refused.stderr).toContain('invalid_resolution')
    } finally {
      await server.stop()
    }
  })

  it('never prints the key, even with NOSTRO_DEBUG, and refuses URL credentials', async () => {
    const { apiDir, server, key } = await pair()
    try {
      const debug = await nostro(apiDir, ['exceptions', '--api', server.address], { env: { ...key, NOSTRO_DEBUG: '1' } })
      expect(debug.stdout).not.toContain(SERVE_KEY)
      expect(debug.stderr).not.toContain(SERVE_KEY)

      const withCredentials = server.address.replace('http://', 'http://user:secret@')
      const refused = await nostro(apiDir, ['exceptions', '--api', withCredentials], { env: key })
      expect(refused.code).toBe(2)
      expect(refused.stdout).not.toContain('secret')
      expect(refused.stderr).not.toContain('secret')

      const plain = await nostro(apiDir, ['exceptions', '--api', 'http://example.com'], { env: key })
      expect(plain.code).toBe(2)
      expect(plain.stderr).toContain('https://')
    } finally {
      await server.stop()
    }
  })
})
