/**
 * What `nostro serve` works on: one plan per tenant, each with its own
 * accounts, network and webhook destination. Built either from the
 * single-tenant flags (one implicit tenant, as before) or from --config.
 * Secrets never come from the file: a webhook names the environment variable
 * that holds its secret.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MIN_WEBHOOK_SECRET_LENGTH, isAccountId, isValidAccountId } from '@nostro-labs/nostro'
import type { Args } from './args.js'
import { UsageError, accounts, network, networkNamed, string, strings, tenant } from './args.js'
import type { Network } from './args.js'
import type { Io } from './io.js'

export interface Webhook {
  readonly url: string
  readonly secret: string
}

export interface TenantPlan {
  readonly id: string
  /** The network the tenant's accounts are on, or null when it watches none. */
  readonly network: Network | null
  readonly accounts: readonly string[]
  /** Where the tenant's events go, or null when it has no webhook. */
  readonly webhook: Webhook | null
}

export const TENANT_ID = /^[^[\]:\s]+$/
const NETWORK_NAME = /^[a-z0-9][a-z0-9-]*$/
const CONFIG_KEYS = ['tenants'] as const
const TENANT_KEYS = ['id', 'network', 'accounts', 'webhook'] as const
const WEBHOOK_KEYS = ['url', 'secretEnv'] as const
/** Flags and environment variables that describe one tenant; a config file replaces them all. */
const SINGLE_TENANT_FLAGS = ['tenant', 'account', 'network', 'horizon', 'webhook-url'] as const
const SINGLE_TENANT_ENV = ['NOSTRO_TENANT', 'NOSTRO_ACCOUNTS', 'NOSTRO_NETWORK', 'NOSTRO_HORIZON_URL', 'NOSTRO_WEBHOOK_URL'] as const

/** A webhook destination; its secret must be strong enough to sign with. */
export function webhookDestination(url: string, secret: string | undefined, secretName: string, urlName = '--webhook-url'): Webhook {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new UsageError(`${urlName} must be a URL, not ${JSON.stringify(url)}.`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new UsageError(`${urlName} must be an http(s) URL.`)
  if (secret === undefined || secret.length < MIN_WEBHOOK_SECRET_LENGTH) {
    throw new UsageError(`A webhook needs ${secretName}, at least ${MIN_WEBHOOK_SECRET_LENGTH} characters: openssl rand -hex 32.`)
  }
  return { url, secret }
}

/** The plans from the single-tenant flags: one tenant, or none when it has nothing to do. */
function plansFromFlags(args: Args, io: Io): TenantPlan[] {
  const id = tenant(args, io)
  const watched = strings(args, 'account').length > 0 || (io.env.NOSTRO_ACCOUNTS ?? '').trim() !== '' ? accounts(args, io) : []
  const net = watched.length > 0 ? network(args, io) : null
  const url = string(args, 'webhook-url') ?? io.env.NOSTRO_WEBHOOK_URL
  const webhook = url === undefined ? null : webhookDestination(url, io.env.NOSTRO_WEBHOOK_SECRET, 'NOSTRO_WEBHOOK_SECRET')
  if (net === null && webhook === null) return []
  return [{ id, network: net, accounts: watched, webhook }]
}

/** Read and check a --config file. Every problem names its path, so the operator can find it. */
function plansFromConfig(file: string, io: Io): TenantPlan[] {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(resolve(io.cwd, file), 'utf8'))
  } catch (err) {
    throw new UsageError(`Cannot read --config ${file}: ${(err as Error).message}`)
  }
  const fail = (where: string, what: string): never => {
    throw new UsageError(`--config ${file}: ${where} ${what}.`)
  }
  const object = (value: unknown, where: string): Record<string, unknown> => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(where, 'must be an object')
    return value as Record<string, unknown>
  }
  const only = (obj: Record<string, unknown>, allowed: readonly string[], where: string) => {
    for (const key of Object.keys(obj)) if (!allowed.includes(key)) fail(where, `has an unknown field ${JSON.stringify(key)}`)
  }
  const top = object(raw, 'The file')
  only(top, CONFIG_KEYS, 'The file')
  if (!Array.isArray(top.tenants) || top.tenants.length === 0) fail('The file', 'needs a non-empty "tenants" list')

  const seen = new Set<string>()
  return (top.tenants as unknown[]).map((entry, i) => {
    const where = `tenants[${i}]`
    const t = object(entry, where)
    only(t, TENANT_KEYS, where)
    if (typeof t.id !== 'string' || !TENANT_ID.test(t.id)) fail(where, 'needs an "id" without spaces, [ ], or :')
    const id = t.id as string
    if (seen.has(id)) fail(where, `repeats tenant ${JSON.stringify(id)}`)
    seen.add(id)

    const list = t.accounts ?? []
    if (!Array.isArray(list) || list.some((a) => typeof a !== 'string')) fail(`${where} (${id})`, 'needs "accounts" as a list of G... strings')
    for (const a of list as string[]) {
      if (!isAccountId(a)) fail(`${where} (${id})`, `has an account that is not a G... address: ${JSON.stringify(a)}`)
      if (!isValidAccountId(a)) fail(`${where} (${id})`, `has an account with an invalid checksum: ${JSON.stringify(a)}`)
    }
    // A network is needed to sync; a tenant may name one with no accounts, so accounts added over the API sync.
    let net: Network | null = null
    if (t.network !== undefined) {
      if (typeof t.network !== 'string' || !NETWORK_NAME.test(t.network)) fail(`${where} (${id})`, 'needs a "network" such as testnet or public')
      net = networkNamed(t.network as string, undefined, io)
    } else if ((list as string[]).length > 0) {
      fail(`${where} (${id})`, 'needs a "network" such as testnet or public, for its accounts')
    }

    let webhook: Webhook | null = null
    if (t.webhook !== undefined) {
      const w = object(t.webhook, `${where}.webhook`)
      only(w, WEBHOOK_KEYS, `${where}.webhook`)
      if (typeof w.url !== 'string') fail(`${where} (${id})`, 'needs a webhook "url"')
      if (typeof w.secretEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(w.secretEnv)) {
        fail(`${where} (${id})`, 'needs "secretEnv": the name of the environment variable that holds the webhook secret')
      }
      webhook = webhookDestination(w.url as string, io.env[w.secretEnv as string], w.secretEnv as string, `${where} (${id}) webhook url`)
    }
    return { id, network: net, accounts: list as string[], webhook }
  })
}

/**
 * Every tenant serve works on. With --config, the file is the whole
 * configuration, so the single-tenant flags and their environment variables
 * are refused rather than guessed at.
 */
export function tenantPlans(args: Args, io: Io): TenantPlan[] {
  const file = string(args, 'config')
  if (file === undefined) return plansFromFlags(args, io)
  for (const name of SINGLE_TENANT_FLAGS) {
    if (args.values[name] !== undefined) throw new UsageError(`--config replaces --${name}; put it in the file instead.`)
  }
  for (const name of SINGLE_TENANT_ENV) {
    if ((io.env[name] ?? '') !== '') throw new UsageError(`--config replaces ${name}; put it in the file instead.`)
  }
  return plansFromConfig(file, io)
}

