import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@nostro-labs/nostro'
import { apiKeys, buildOpenApi, createServer } from '../src/index.js'

const KEY = 'a'.repeat(64)

describe('OpenAPI request fuzz smoke test', () => {
  it('keeps arbitrary query values inside documented GET routes as HTTP responses', async () => {
    const app = createServer({ store: new MemoryStore(), authenticate: apiKeys({ [KEY]: 'tenant' }) })
    const paths = Object.keys(buildOpenApi().paths).filter((path) => path !== '/v1/openapi.json' && !path.includes('{'))
    const values = ['%', '\\u0000', 'not-a-number', '-1', '999999999999999999999999', 'a b', '☃']
    for (const path of paths) for (const value of values) {
      const response = await app.inject({ url: path + '?limit=' + encodeURIComponent(value), headers: { authorization: 'Bearer ' + KEY } })
      const what = `${path}?limit=${JSON.stringify(value)}: ${response.statusCode} ${response.body.slice(0, 200)}`
      // Never an internal error: an answer, a documented refusal, or the documented 501.
      expect(response.statusCode < 500 || response.statusCode === 501, what).toBe(true)
      expect(response.headers['content-type'], what).toMatch(
        response.statusCode >= 400 ? /^application\/problem\+json/ : /^(application\/json|text\/csv)/,
      )
    }
  })
})
