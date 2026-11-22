/**
 * Scopes, checked on every route. The cases come from the OpenAPI document,
 * not from a hand-kept list, so a new route with no scope fails here too.
 */
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@nostro-labs/nostro'
import { SCOPES, type Scope, apiKeys, buildOpenApi, createServer } from '../src/index.js'

const keyFor = (name: string) => `${name}-`.padEnd(40, 'k')
const ONLY = Object.fromEntries(SCOPES.map((s) => [s, keyFor(`only-${s}`)])) as Record<Scope, string>
const ALL_BUT = Object.fromEntries(SCOPES.map((s) => [s, keyFor(`but-${s}`)])) as Record<Scope, string>

function grants() {
  const out: Record<string, { tenant: string; scopes: Scope[] }> = {}
  for (const s of SCOPES) {
    out[ONLY[s]] = { tenant: 'acme', scopes: [s] }
    out[ALL_BUT[s]] = { tenant: 'acme', scopes: SCOPES.filter((x) => x !== s) }
  }
  return out
}

interface Operation {
  method: 'GET' | 'POST'
  path: string
  scope: Scope
}

/** Every operation in the document that names a scope. Health and the document itself name none. */
function operations(): Operation[] {
  const doc = buildOpenApi() as unknown as { paths: Record<string, Record<string, { security?: { apiKey: Scope[] }[] }>> }
  const out: Operation[] = []
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const scope = op.security?.[0]?.apiKey[0]
      if (scope !== undefined) out.push({ method: method.toUpperCase() as Operation['method'], path, scope })
    }
  }
  return out
}

describe('API key scopes', () => {
  const server = createServer({ store: new MemoryStore(), authenticate: apiKeys(grants()) })
  const ops = operations()

  it('names a scope on every operation that is not health or the document', () => {
    const doc = buildOpenApi() as unknown as { paths: Record<string, Record<string, { security?: unknown }>> }
    const unscoped = Object.entries(doc.paths).flatMap(([p, ms]) => Object.entries(ms).filter(([, op]) => op.security === undefined).map(([m]) => `${m} ${p}`))
    expect(unscoped).toEqual([])
    expect(ops.length).toBeGreaterThan(20)
  })

  it.each(ops.map((o) => [`${o.method} ${o.path}`, o] as const))('%s: 403 without its scope, not 403 with it', async (_label, op) => {
    const url = op.path.replace(/\{\w+\}/g, 'x')
    const call = (token: string) =>
      server.inject({ method: op.method, url, headers: { authorization: `Bearer ${token}` }, ...(op.method === 'POST' ? { payload: {} } : {}) })

    const withScope = await call(ONLY[op.scope])
    expect(withScope.statusCode).not.toBe(403)

    const withoutScope = await call(ALL_BUT[op.scope])
    expect(withoutScope.statusCode).toBe(403)
    expect(withoutScope.headers['content-type']).toContain('application/problem+json')
    expect(withoutScope.json()).toMatchObject({ type: 'about:blank', status: 403, code: 'forbidden', title: 'Forbidden' })
    expect(withoutScope.json().detail).not.toContain(ALL_BUT[op.scope])
  })

  it('still answers 401 for a missing or unknown key, not 403', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/movements', headers: { authorization: `Bearer ${'z'.repeat(40)}` } })
    expect(res.statusCode).toBe(401)
  })

  it('refuses keys with a scope the server does not know', () => {
    expect(() => apiKeys({ [keyFor('bad')]: { tenant: 'acme', scopes: ['admin' as Scope] } })).toThrow(/Unknown scope: admin/)
  })
})
