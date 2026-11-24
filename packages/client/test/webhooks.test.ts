import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { signWebhook, verifyWebhook as verifyNode } from '@nostro-labs/nostro'
import { verifyWebhook as verifyBrowser, type VerifyOptions } from '../src/index.js'

interface Vector {
  readonly name: string
  readonly body: string
  readonly t: number
  readonly header: string | null
  readonly now: number
  readonly valid: boolean
}
const fixture = JSON.parse(
  readFileSync(new URL('../../../fixtures/webhooks/signatures.json', import.meta.url), 'utf8'),
) as { readonly secret: string; readonly tolerance: number; readonly vectors: readonly Vector[] }

describe('webhook signature vectors', () => {
  it('accepts and refuses exactly the same requests in Node and Web Crypto', async () => {
    for (const vector of fixture.vectors) {
      const options: VerifyOptions = {
        secret: fixture.secret,
        header: vector.header,
        body: vector.body,
        toleranceSeconds: fixture.tolerance,
        now: () => new Date(vector.now * 1000),
      }
      expect(verifyNode(options), `node: ${vector.name}`).toBe(vector.valid)
      expect(await verifyBrowser(options), `browser: ${vector.name}`).toBe(vector.valid)
    }
  })

  it('accepts a freshly signed body and refuses a stale or malformed one', async () => {
    const secret = 's'.repeat(32)
    const body = '{"id":"evt-1"}'
    const t = 1_700_000_000
    const header = signWebhook(secret, body, t)
    const options = (now: number, h: string | null): VerifyOptions => ({
      secret,
      header: h,
      body,
      now: () => new Date(now * 1000),
    })
    expect(await verifyBrowser(options(t + 299, header))).toBe(true)
    expect(await verifyBrowser(options(t + 301, header))).toBe(false)
    expect(await verifyBrowser(options(t, 'not-a-signature'))).toBe(false)
    expect(await verifyBrowser(options(t, null))).toBe(false)
  })
})
