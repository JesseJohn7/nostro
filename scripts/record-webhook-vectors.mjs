#!/usr/bin/env node
/**
 * Create the shared webhook signature vectors used by the TypeScript and
 * Python verifiers. Run from the repo root after `pnpm build`:
 *
 *   node scripts/record-webhook-vectors.mjs
 *
 * The signatures come from core's signWebhook(), so the vectors describe the
 * same wire format the server emits. It refuses to overwrite an existing file:
 * a vector that changes silently would hide a verifier regression.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { signWebhook } from '../packages/core/dist/index.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = join(root, 'fixtures', 'webhooks')
const file = join(dir, 'signatures.json')
if (existsSync(file)) {
  console.error(`${file} exists; refusing to overwrite it.`)
  process.exit(1)
}

const secret = '0123456789abcdef0123456789abcdef'
const otherSecret = 'ffffffffffffffffffffffffffffffff'
const t = 1_700_000_000
const body = JSON.stringify({ id: 'evt-1', type: 'movement.decided' })
const vectors = [
  { name: 'valid', body, t, header: signWebhook(secret, body, t), now: t + 100, valid: true },
  { name: 'expired', body, t, header: signWebhook(secret, body, t), now: t + 301, valid: false },
  {
    name: 'tampered',
    body: JSON.stringify({ id: 'evt-1', type: 'expectation.settled' }),
    t,
    header: signWebhook(secret, body, t),
    now: t + 100,
    valid: false,
  },
  { name: 'malformed-header', body, t, header: `t=${t},v1=nope`, now: t + 100, valid: false },
  { name: 'wrong-secret', body, t, header: signWebhook(otherSecret, body, t), now: t + 100, valid: false },
  { name: 'missing-header', body, t, header: null, now: t + 100, valid: false },
]

mkdirSync(dir, { recursive: true })
writeFileSync(file, `${JSON.stringify({ secret, tolerance: 300, vectors }, null, 2)}\n`)
console.log(`Wrote ${vectors.length} vectors to ${file}`)
