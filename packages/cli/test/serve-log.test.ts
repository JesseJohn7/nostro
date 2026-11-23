import { describe, expect, it } from 'vitest'
import { formatLog, safeDatabase, scrub } from '../src/serve-log.js'

const KEY = 'k'.repeat(40)
const WEBHOOK_SECRET = 'whsec_' + 'x'.repeat(30)
const T = new Date('2026-11-23T12:00:00.000Z')

describe('scrub', () => {
  it('masks exact secret values', () => {
    expect(scrub(`key ${KEY} used`, [KEY])).toBe('key *** used')
  })

  it('masks a secret that contains another one whole', () => {
    const inner = 'abcdefgh'
    expect(scrub(`${inner}1234`, [inner, `${inner}1234`])).toBe('***')
  })

  it('ignores secrets too short to be real, so it does not shred ordinary text', () => {
    expect(scrub('a short one', ['a'])).toBe('a short one')
  })

  it('masks the password in a postgres URL', () => {
    expect(scrub('connect postgres://nostro:hunter2pw@db:5432/n failed')).toBe('connect postgres://***@db:5432/n failed')
  })

  it('masks bearer tokens and key-like pairs', () => {
    expect(scrub('Authorization: Bearer abc.DEF-123')).toBe('Authorization: ***')
    expect(scrub('apiKey=abcdef123456 next')).toBe('apiKey=*** next')
    expect(scrub('{"password":"p4ss"}')).toBe('{"password":"***"}')
  })

  it('leaves ordinary text alone', () => {
    expect(scrub('synced 3 new movement(s), decided 2.')).toBe('synced 3 new movement(s), decided 2.')
  })
})

describe('formatLog', () => {
  it('writes one JSON object with stable keys first', () => {
    const line = formatLog({ level: 'info', msg: 'round done', time: T, fields: { tenant: 'acme', inserted: 3 } }, 'json')
    expect(JSON.parse(line)).toEqual({ time: T.toISOString(), level: 'info', msg: 'round done', tenant: 'acme', inserted: 3 })
    expect(Object.keys(JSON.parse(line)).slice(0, 3)).toEqual(['time', 'level', 'msg'])
    expect(line).not.toContain('\n')
  })

  it('does not let a field overwrite time, level or msg', () => {
    const line = formatLog({ level: 'warn', msg: 'real', time: T, fields: { level: 'fake', msg: 'fake', time: 'fake' } }, 'json')
    expect(JSON.parse(line)).toMatchObject({ level: 'warn', msg: 'real', time: T.toISOString() })
  })

  it('writes readable text with the fields in brackets', () => {
    const line = formatLog({ level: 'info', msg: 'delivered 2 event(s).', time: T, fields: { tenant: 'acme' } }, 'text')
    expect(line).toBe(`${T.toISOString()} [tenant=acme] delivered 2 event(s).`)
  })

  it('serialises errors as name and message, never a stack', () => {
    const line = formatLog({ level: 'error', msg: 'request failed', time: T, fields: { err: new TypeError('boom') } }, 'json')
    expect(JSON.parse(line).err).toEqual({ name: 'TypeError', message: 'boom' })
    expect(line).not.toContain('at ')
  })

  it.each(['json', 'text'] as const)('keeps keys, secrets and database passwords out of every path (%s)', (format) => {
    const line = formatLog(
      {
        level: 'error',
        msg: `failed with ${KEY} against postgres://u:dbpassword99@host/db`,
        time: T,
        fields: {
          webhook: `Bearer ${WEBHOOK_SECRET}`,
          nested: { header: `Authorization: Bearer ${KEY}`, list: [WEBHOOK_SECRET] },
          err: new Error(`bad key ${KEY}`),
        },
      },
      format,
      [KEY, WEBHOOK_SECRET],
    )
    expect(line).not.toContain(KEY)
    expect(line).not.toContain(WEBHOOK_SECRET)
    expect(line).not.toContain('dbpassword99')
  })
})

describe('safeDatabase', () => {
  it('never returns the password', () => {
    expect(safeDatabase('postgres://nostro:s3cretpw@db.example:5432/nostro')).not.toContain('s3cretpw')
  })
})
