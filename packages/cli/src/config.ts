/**
 * Named profiles: a JSON file that supplies the values the CLI already reads
 * from flags and the environment. Parsing is as strict as `parseArgs`: an
 * unknown key, a bad type or a secret in the file is an error, not something to
 * ignore. With no file, every accessor falls through to the exact behaviour
 * args.ts had before profiles existed.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { Args } from './args.js'
import { UsageError } from './errors.js'
import type { Io } from './io.js'

export type Source = 'flag' | 'environment' | 'profile' | 'default'

export type SettingKey =
  | 'db'
  | 'tenant'
  | 'network'
  | 'horizon'
  | 'accounts'
  | 'schema'
  | 'port'
  | 'host'
  | 'interval'
  /** A selector for remote mode, never written in a profile. */
  | 'api'

export const SETTING_KEYS: readonly SettingKey[] = [
  'db',
  'tenant',
  'network',
  'horizon',
  'accounts',
  'schema',
  'port',
  'host',
  'interval',
]

export interface Profile {
  readonly db?: string
  readonly tenant?: string
  readonly network?: string
  readonly horizon?: string
  readonly accounts?: readonly string[]
  readonly schema?: string
  readonly port?: number
  readonly host?: string
  readonly interval?: number
  /** Forward-compatible extension area, opaque to this version. */
  readonly settings?: Readonly<Record<string, unknown>>
}

export interface ConfigFile {
  readonly version: number
  readonly defaultProfile?: string
  readonly profiles: Readonly<Record<string, Profile>>
  /** `nostro serve` multi-tenant plans. Validated by serve-tenants.ts. */
  readonly tenants?: unknown
}

export interface LoadedConfig {
  readonly path: string
  readonly file: ConfigFile
  /** The profile named by --profile, NOSTRO_PROFILE or defaultProfile. */
  readonly selected?: string
  /** Where the file itself came from. */
  readonly pathSource: 'flag' | 'environment' | 'discovered'
}

const TOP_KEYS = ['version', 'defaultProfile', 'profiles', 'tenants'] as const
const PROFILE_KEYS = [
  'db',
  'tenant',
  'network',
  'horizon',
  'accounts',
  'schema',
  'port',
  'host',
  'interval',
  'settings',
] as const
/** No setting in a config file may be a secret, including inside `settings`. */
const SECRET_NAMES = new Set([
  'secret',
  'secrets',
  'apikey',
  'apikeys',
  'webhooksecret',
  'password',
  'passwords',
  'passwd',
  'token',
  'tokens',
  'privatekey',
])

// Which flag and environment variable supply each setting. An empty flag name
// means the setting has never had a flag (the PostgreSQL schema today comes
// only from the environment).
const FLAG: Readonly<Record<SettingKey, string>> = {
  db: 'db',
  tenant: 'tenant',
  network: 'network',
  horizon: 'horizon',
  accounts: 'account',
  schema: '',
  port: 'port',
  host: 'host',
  interval: 'interval',
  api: 'api',
}
const ENV: Readonly<Record<SettingKey, string>> = {
  db: 'NOSTRO_DB',
  tenant: 'NOSTRO_TENANT',
  network: 'NOSTRO_NETWORK',
  horizon: 'NOSTRO_HORIZON_URL',
  accounts: 'NOSTRO_ACCOUNTS',
  schema: 'NOSTRO_PG_SCHEMA',
  port: 'NOSTRO_PORT',
  host: 'NOSTRO_HOST',
  interval: 'NOSTRO_INTERVAL',
  api: 'NOSTRO_API_URL',
}

export const labelFor = (key: SettingKey, source: Source, io: Io): string =>
  source === 'flag'
    ? `--${FLAG[key]}`
    : source === 'environment'
      ? ENV[key]
      : source === 'profile'
        ? `profile "${io.config?.selected ?? ''}" ${key}`
        : `--${FLAG[key] || key}`

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Refuse embedded credentials and secret-named keys anywhere in a value. */
function assertNoSecrets(value: unknown, where: string): void {
  if (typeof value === 'string') {
    if (/:\/\/[^/@\s]*@/.test(value)) {
      throw new UsageError(`${where} contains a password. Put credentials in the environment, never in the config file.`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoSecrets(item, `${where}[${i}]`))
    return
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_NAMES.has(key.toLowerCase().replace(/[-_]/g, ''))) {
        throw new UsageError(`${where}.${key} is not allowed: secrets never go in a config file.`)
      }
      assertNoSecrets(item, `${where}.${key}`)
    }
  }
}

function parseProfile(raw: unknown, name: string): Profile {
  const where = `profiles.${name}`
  if (!isObject(raw)) throw new UsageError(`${where} must be an object.`)
  for (const key of Object.keys(raw)) {
    if (!(PROFILE_KEYS as readonly string[]).includes(key)) {
      throw new UsageError(`${where} has an unknown field ${JSON.stringify(key)}.`)
    }
  }
  assertNoSecrets(raw, where)
  const out: Record<string, unknown> = {}
  for (const key of ['db', 'tenant', 'network', 'horizon', 'schema', 'host'] as const) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || value.trim() === '') {
      throw new UsageError(`${where}.${key} must be a non-empty string.`)
    }
    out[key] = value
  }
  if (raw.accounts !== undefined) {
    if (!Array.isArray(raw.accounts) || raw.accounts.some((a) => typeof a !== 'string')) {
      throw new UsageError(`${where}.accounts must be a list of strings.`)
    }
    out.accounts = [...raw.accounts]
  }
  for (const key of ['port', 'interval'] as const) {
    const value = raw[key]
    if (value === undefined) continue
    const min = key === 'port' ? 0 : 1
    const max = key === 'port' ? 65_535 : 86_400
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
      throw new UsageError(`${where}.${key} must be a whole number from ${min} to ${max}.`)
    }
    out[key] = value
  }
  if (raw.settings !== undefined && !isObject(raw.settings)) {
    throw new UsageError(`${where}.settings must be an object.`)
  }
  if (raw.settings !== undefined) out.settings = raw.settings
  return out as unknown as Profile
}

function parseFile(raw: unknown, path: string): ConfigFile {
  if (!isObject(raw)) throw new UsageError(`Config ${path} must be a JSON object.`)
  for (const key of Object.keys(raw)) {
    if (!(TOP_KEYS as readonly string[]).includes(key)) {
      throw new UsageError(`Config ${path} has an unknown field ${JSON.stringify(key)}.`)
    }
  }
  // `tenants` is the existing serve multi-tenant format; it is validated by
  // serve-tenants.ts and must keep its exact error messages. Secrets are
  // rejected inside profiles (see parseProfile) and by the strict key checks.
  const version = raw.version ?? 1
  if (version !== 1) throw new UsageError(`Config ${path} has unsupported version ${version}; this nostro understands version 1.`)
  if (raw.defaultProfile !== undefined && (typeof raw.defaultProfile !== 'string' || raw.defaultProfile === '')) {
    throw new UsageError(`Config ${path} defaultProfile must be a non-empty string.`)
  }
  const rawProfiles = raw.profiles ?? {}
  if (!isObject(rawProfiles)) throw new UsageError(`Config ${path} profiles must be an object.`)
  const profiles: Record<string, Profile> = {}
  for (const [name, value] of Object.entries(rawProfiles)) {
    profiles[name] = parseProfile(value, name)
  }
  const defaultProfile = raw.defaultProfile as string | undefined
  if (defaultProfile !== undefined && profiles[defaultProfile] === undefined) {
    throw new UsageError(`Config ${path} defaultProfile ${JSON.stringify(defaultProfile)} names no profile.`)
  }
  return {
    version: 1,
    profiles,
    ...(defaultProfile === undefined ? {} : { defaultProfile }),
    ...(raw.tenants === undefined ? {} : { tenants: raw.tenants }),
  }
}

function defaultPaths(io: Io): readonly string[] {
  const xdg = io.env.XDG_CONFIG_HOME?.trim()
  const base = xdg !== undefined && xdg !== '' ? xdg : resolve(homedir(), '.config')
  return [resolve(io.cwd, 'nostro.json'), resolve(base, 'nostro', 'nostro.json')]
}

/**
 * Load the config once. `explicit` is --config or NOSTRO_CONFIG; when absent
 * the working directory is searched before the XDG directory, first file wins.
 */
export function loadConfig(io: Io, explicit: string | undefined, selected: string | undefined): LoadedConfig | undefined {
  let path: string
  let pathSource: LoadedConfig['pathSource']
  if (explicit !== undefined && explicit !== '') {
    path = resolve(io.cwd, explicit)
    pathSource = io.env.NOSTRO_CONFIG === explicit ? 'environment' : 'flag'
    if (!existsSync(path)) throw new UsageError(`Cannot read config ${explicit}: no such file.`)
  } else {
    const found = defaultPaths(io).find((p) => existsSync(p))
    if (found === undefined) {
      if (selected !== undefined) {
        throw new UsageError(`No profile ${JSON.stringify(selected)}: no config file was found (pass --config or set NOSTRO_CONFIG).`)
      }
      return undefined
    }
    path = found
    pathSource = 'discovered'
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new UsageError(`Cannot read config ${path}: ${(err as Error).message}`)
  }
  const file = parseFile(raw, path)
  const name = selected ?? file.defaultProfile
  if (name !== undefined && file.profiles[name] === undefined) {
    throw new UsageError(
      `No profile ${JSON.stringify(name)} in ${path}. Available: ${Object.keys(file.profiles).join(', ') || '(none)'}.`,
    )
  }
  return { path, file, pathSource, ...(name === undefined ? {} : { selected: name }) }
}

/** The selected profile, or undefined when no file/profile was selected. */
export function selectedProfile(io: Io): Profile | undefined {
  if (io.config === undefined || io.config.selected === undefined) return undefined
  return io.config.file.profiles[io.config.selected]
}

/** Flag first, then profile, then environment; undefined when nothing supplied it. */
export function rawSetting<T = unknown>(key: SettingKey, args: Args, io: Io): { value: T; source: Source } | undefined {
  const flag = FLAG[key]
  if (flag !== '' && args.values[flag] !== undefined) {
    return { value: args.values[flag] as T, source: 'flag' }
  }
  const fromProfile = (selectedProfile(io) as Record<string, unknown> | undefined)?.[key]
  if (fromProfile !== undefined) return { value: fromProfile as T, source: 'profile' }
  const fromEnv = io.env[ENV[key]]
  if (fromEnv !== undefined && fromEnv !== '') return { value: fromEnv as T, source: 'environment' }
  return undefined
}

export interface Resolved<T> {
  readonly value: T
  readonly source: Source
}

export function stringSetting(key: SettingKey, args: Args, io: Io, fallback?: string): Resolved<string | undefined> {
  const found = rawSetting(key, args, io)
  if (found === undefined) return { value: fallback, source: 'default' }
  if (typeof found.value === 'string') return { value: found.value, source: found.source }
  if (typeof found.value === 'number' || typeof found.value === 'boolean') {
    return { value: String(found.value), source: found.source }
  }
  throw new UsageError(`${labelFor(key, found.source, io)} must be a string.`)
}

export function stringsSetting(key: SettingKey, args: Args, io: Io): Resolved<string[]> {
  const found = rawSetting(key, args, io)
  if (found === undefined) return { value: [], source: 'default' }
  const list =
    Array.isArray(found.value)
      ? found.value.filter((v): v is string => typeof v === 'string')
      : typeof found.value === 'string'
        ? found.value.split(/[\s,]+/).filter((v) => v !== '')
        : []
  return { value: list, source: found.source }
}

export function numberSetting(
  key: SettingKey,
  args: Args,
  io: Io,
  fallback: number,
  min: number,
  max: number,
): Resolved<number> {
  const found = rawSetting(key, args, io)
  if (found === undefined) return { value: fallback, source: 'default' }
  const raw = found.value
  const ok =
    typeof raw === 'number'
      ? Number.isInteger(raw)
      : typeof raw === 'string' && /^\d+$/.test(raw)
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!ok || value < min || value > max) {
    throw new UsageError(`${labelFor(key, found.source, io)} must be a whole number from ${min} to ${max}.`)
  }
  return { value, source: found.source }
}
