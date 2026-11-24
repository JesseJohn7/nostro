import { describe, expect, it } from 'vitest'
import { buildOpenApi } from '@nostro-labs/server'
import { createClient } from '../src/index.js'

/**
 * The methods are hand-written, so this test is what keeps them honest: every
 * operation in the live OpenAPI document must have a same-named client method.
 * `health`, `openapi` and the webhook callback keys are not client calls.
 */
describe('operationId coverage', () => {
  it('has one client method per API operationId', () => {
    const client = createClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k'.repeat(32) }) as unknown as Record<string, unknown>
    const doc = buildOpenApi() as {
      paths: Record<string, Record<string, { operationId?: string }>>
    }
    const excluded = new Set(['health', 'openapi'])
    const ids: string[] = []
    for (const methods of Object.values(doc.paths)) {
      for (const operation of Object.values(methods)) {
        const id = operation.operationId
        if (id === undefined || excluded.has(id)) continue
        ids.push(id)
        expect(typeof client[id], `client.${id}`).toBe('function')
      }
    }
    expect(ids.length).toBeGreaterThan(30)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
