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
      expect(response.statusCode).toBeGreaterThanOrEqual(200)
      expect(response.statusCode).toBeLessThan(600)
      expect(response.headers['content-type']).toMatch(/application\\/json/)
    }
  })
})
