/**
 * Who is calling. Every request but `/v1/health` carries
 * `Authorization: Bearer <key>`, and the key decides both the tenant and
 * what the caller may do: a caller never names a tenant, so it cannot ask
 * for another one's records, and a key without a scope gets 403 on the
 * routes that need it (see `scopes.ts`).
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { SCOPES, type Scope } from './scopes.js'

export { SCOPES, type Scope } from './scopes.js'

/** Who a valid key is: its tenant, the scopes it carries, and an id for logs when one is known. */
export interface Principal {
  readonly tenantId: string
  readonly scopes: ReadonlySet<Scope>
  readonly keyId?: string
}

/** Returns the principal a bearer token belongs to, or `null`. A wrong and a revoked key both return `null`. */
export type Authenticate = (token: string) => Principal | null | Promise<Principal | null>

/** Shorter keys can be guessed; generate them with `openssl rand -hex 32`. */
export const MIN_KEY_LENGTH = 32

/**
 * A key's grant. A bare tenant string is a grant of every scope: that is how
 * keys written before scopes existed keep working. Pass `scopes` to narrow it.
 */
export type KeyGrant = string | { readonly tenant: string; readonly scopes?: readonly Scope[] }

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest()

/**
 * Authenticate with a fixed set of API keys, each mapped to a tenant and
 * scopes. Keys are kept only as SHA-256 digests and compared in constant
 * time, every one of them on every request, so timing says nothing about
 * which key was close.
 */
export function apiKeys(keys: Readonly<Record<string, KeyGrant>>): Authenticate {
  const entries = Object.entries(keys).map(([key, grant]) => {
    if (key.length < MIN_KEY_LENGTH) throw new Error(`API keys must be at least ${MIN_KEY_LENGTH} characters.`)
    const tenant = typeof grant === 'string' ? grant : grant.tenant
    const scopes = typeof grant === 'string' || grant.scopes === undefined ? SCOPES : grant.scopes
    if (tenant.trim() === '') throw new Error('Every API key needs a tenant.')
    for (const s of scopes) if (!(SCOPES as readonly string[]).includes(s)) throw new Error(`Unknown scope: ${s}.`)
    return { hash: digest(key), principal: { tenantId: tenant, scopes: new Set(scopes) } as Principal }
  })
  if (entries.length === 0) throw new Error('Give at least one API key.')
  return (token) => {
    const hash = digest(token)
    let found: Principal | null = null
    for (const e of entries) if (timingSafeEqual(hash, e.hash)) found = e.principal
    return found
  }
}
