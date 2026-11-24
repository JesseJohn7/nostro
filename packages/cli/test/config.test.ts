import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { A, B, workspace, nostro } from './helpers.js'

const C = `G${'C'.repeat(55)}`

const PROFILE = {
  version: 1,
  defaultProfile: 'testnet',
  profiles: {
    testnet: {
      db: 'profile.db',
      tenant: 'profile-tenant',
      network: 'testnet',
      horizon: 'https://profile.example',
      accounts: [C],
      schema: 'profile_schema',
      port: 9000,
      host: 'profile.example',
      interval: 99,
    },
  },
}

const ENV = {
  NOSTRO_DB: 'env.db',
  NOSTRO_TENANT: 'env-tenant',
  NOSTRO_NETWORK: 'public',
  NOSTRO_HORIZON_URL: 'https://env.example',
  NOSTRO_ACCOUNTS: B,
  NOSTRO_PG_SCHEMA: 'env_schema',
  NOSTRO_PORT: '8000',
  NOSTRO_HOST: 'env.example',
  NOSTRO_INTERVAL: '88',
}

const FLAGS = [
  '--db', 'flag.db',
  '--tenant', 'flag-tenant',
  '--network', 'custom',
  '--horizon', 'https://flag.example',
  '--account', A,
  '--port', '7000',
  '--host', 'flag.example',
  '--interval', '77',
]

async function rows(cwd: string, argv: readonly string[], env: Record<string, string> = {}) {
  const run = await nostro(cwd, ['config', '--json', ...argv], { env })
  expect(run.code).toBe(0)
  return Object.fromEntries(
    (JSON.parse(run.stdout) as { setting: string; value: string; source: string }[]).map((r) => [r.setting, r]),
  ) as Record<string, { setting: string; value: string; source: string }>
}

function withProfile(extra: object = {}) {
  const cwd = workspace()
  writeFileSync(join(cwd, 'nostro.json'), JSON.stringify({ ...PROFILE, profiles: { testnet: { ...PROFILE.profiles.testnet, ...extra } } }))
  return cwd
}

describe('config profiles', () => {
  it('shows the built-in defaults when there is no file: no silent change', async () => {
    const r = await rows(workspace(), [])
    expect(r.db).toMatchObject({ value: 'nostro.db', source: 'default' })
    expect(r.tenant).toMatchObject({ value: 'default', source: 'default' })
    expect(r.network).toMatchObject({ value: 'testnet', source: 'default' })
    expect(r.schema).toMatchObject({ value: 'nostro', source: 'default' })
    expect(r.port).toMatchObject({ value: '8080', source: 'default' })
    expect(r.host).toMatchObject({ value: '127.0.0.1', source: 'default' })
    expect(r.interval).toMatchObject({ value: '30', source: 'default' })
    expect(r.accounts!.source).toBe('default')
    expect(r.config!.value).toBe('(none; built-in defaults)')
  })

  it('uses the environment when there is no file', async () => {
    const r = await rows(workspace(), [], ENV)
    expect(r.db).toMatchObject({ value: 'env.db', source: 'environment' })
    expect(r.tenant).toMatchObject({ value: 'env-tenant', source: 'environment' })
    expect(r.network).toMatchObject({ value: 'public', source: 'environment' })
    expect(r.horizon!.value).toBe('https://env.example')
    expect(r.accounts!.value).toBe(B)
    expect(r.schema).toMatchObject({ value: 'env_schema', source: 'environment' })
    expect(r.port).toMatchObject({ value: '8000', source: 'environment' })
    expect(r.host!.value).toBe('env.example')
    expect(r.interval!.value).toBe('88')
  })

  it('resolves every setting from the profile, ahead of the environment', async () => {
    const r = await rows(withProfile(), [], ENV)
    expect(r.db).toMatchObject({ value: 'profile.db', source: 'profile' })
    expect(r.tenant).toMatchObject({ value: 'profile-tenant', source: 'profile' })
    expect(r.network).toMatchObject({ value: 'testnet', source: 'profile' })
    expect(r.horizon!.value).toBe('https://profile.example')
    expect(r.accounts!.value).toBe(C)
    expect(r.schema).toMatchObject({ value: 'profile_schema', source: 'profile' })
    expect(r.port).toMatchObject({ value: '9000', source: 'profile' })
    expect(r.host!.value).toBe('profile.example')
    expect(r.interval!.value).toBe('99')
    expect(r.profile).toMatchObject({ value: 'testnet', source: 'default' })
  })

  it('lets flags win over both profile and environment, except schema which has no flag', async () => {
    const r = await rows(withProfile(), FLAGS, ENV)
    expect(r.db).toMatchObject({ value: 'flag.db', source: 'flag' })
    expect(r.tenant).toMatchObject({ value: 'flag-tenant', source: 'flag' })
    expect(r.network).toMatchObject({ value: 'custom', source: 'flag' })
    expect(r.horizon!.value).toBe('https://flag.example')
    expect(r.accounts!.value).toBe(A)
    expect(r.port).toMatchObject({ value: '7000', source: 'flag' })
    expect(r.host!.value).toBe('flag.example')
    expect(r.interval!.value).toBe('77')
    expect(r.schema).toMatchObject({ value: 'profile_schema', source: 'profile' })
  })

  it('selects a named profile with --profile and NOSTRO_PROFILE', async () => {
    const cwd = workspace()
    writeFileSync(join(cwd, 'nostro.json'), JSON.stringify({
      profiles: { one: { tenant: 'one' }, two: { tenant: 'two' } },
    }))
    expect((await rows(cwd, ['--profile', 'two'])).tenant!.value).toBe('two')
    expect((await rows(cwd, [], { NOSTRO_PROFILE: 'one' })).tenant!.value).toBe('one')
  })

  it('refuses a missing profile, an unknown key and a bad type', async () => {
    const missingDir = withProfile()
    const missing = await nostro(missingDir, ['config', '--profile', 'nope'])
    expect(missing.code).toBe(2)
    expect(missing.stderr).toMatch(/No profile "nope"/)
    expect(missing.stderr).toMatch(/Available: testnet/)

    const unknown = workspace()
    writeFileSync(join(unknown, 'nostro.json'), JSON.stringify({ profiles: { p: { typo: 'x' } } }))
    const bad = await nostro(unknown, ['config', '--profile', 'p'])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toMatch(/unknown field "typo"/)

    const type = workspace()
    writeFileSync(join(type, 'nostro.json'), JSON.stringify({ profiles: { p: { port: 'not a number' } } }))
    const wrong = await nostro(type, ['config', '--profile', 'p'])
    expect(wrong.code).toBe(2)
    expect(wrong.stderr).toMatch(/port must be a whole number/)
  })

  it('refuses secrets in the file, naming no secret value', async () => {
    const cases: object[] = [
      { profiles: { p: { db: 'postgres://u:supersecret@example/db' } } },
      { profiles: { p: { webhookSecret: 'supersecret' } } },
      { profiles: { p: { apiKey: 'supersecret' } } },
      { profiles: { p: { settings: { apiKey: 'supersecret' } } } },
      { profiles: { p: { horizon: 'https://u:supersecret@example' } } },
    ]
    for (const [i, config] of cases.entries()) {
      const cwd = workspace()
      writeFileSync(join(cwd, 'nostro.json'), JSON.stringify(config))
      const run = await nostro(cwd, ['config', '--profile', 'p'])
      expect(run.code, `case ${i}`).toBe(2)
      expect(run.stderr, `case ${i}`).not.toContain('supersecret')
    }
  })

  it('never prints a password from a flag or environment URL, in text or JSON', async () => {
    const secretDb = 'postgres://alice:supersecret@db.example/pubnet'
    const cwd = workspace()
    const env = { NOSTRO_DB: secretDb }
    const text = await nostro(cwd, ['config'], { env })
    expect(text.code).toBe(0)
    expect(text.stdout).not.toContain('supersecret')
    expect(text.stdout).toContain('***@')
    const jsonRun = await nostro(cwd, ['config', '--json'], { env })
    expect(jsonRun.code).toBe(0)
    expect(jsonRun.stdout).not.toContain('supersecret')
    expect(jsonRun.stdout).toContain('***@')
    const flagged = await nostro(cwd, ['config', '--db', secretDb])
    expect(flagged.stdout).not.toContain('supersecret')
  })

  it('does not need a config file for the existing commands', async () => {
    const cwd = workspace()
    const clean = await nostro(cwd, ['expect', 'INV-1', '--account', A, '--amount', '25'])
    expect(clean.code).not.toBe(2)
  })
})
