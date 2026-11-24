/**
 * Webhook signature verification with Web Crypto — browsers, Cloudflare
 * Workers, Deno, Bun and Node 22 all provide `globalThis.crypto.subtle`.
 *
 * Header parsing and the replay window are shared with the Node verifier via
 * `parse.ts`; only the HMAC backend differs. SubtleCrypto is available only in
 * secure contexts (HTTPS, localhost), so a plain-HTTP browser page cannot
 * verify a signature.
 */
import { parseSignature, type VerifyOptions } from './parse.js'

export type { VerifyOptions } from './parse.js'

/** The small slice of Web Crypto this verifier needs, stated without DOM libs. */
interface WebCrypto {
  readonly subtle: {
    importKey(
      format: 'raw',
      keyData: Uint8Array,
      algorithm: { name: 'HMAC'; hash: 'SHA-256' },
      extractable: false,
      keyUsages: readonly ['verify'],
    ): Promise<unknown>
    verify(algorithm: 'HMAC', key: unknown, signature: Uint8Array, data: Uint8Array): Promise<boolean>
  }
}

const HEX = '0123456789abcdef'

/** `v1` has already been checked to be 64 lower-case hex characters. */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (HEX.indexOf(hex[i * 2]!) << 4) | HEX.indexOf(hex[i * 2 + 1]!)
  }
  return bytes
}

/** True only for a body signed with `secret` within the tolerance. */
export async function verifyWebhook(options: VerifyOptions): Promise<boolean> {
  const { secret, header, body } = options
  if (typeof header !== 'string') return false
  const crypto = (globalThis as unknown as { crypto?: WebCrypto }).crypto
  if (crypto?.subtle === undefined) return false
  const now = Math.floor((options.now ?? (() => new Date()))().getTime() / 1000)
  const signature = parseSignature(header, now, options.toleranceSeconds ?? 300)
  if (signature === null) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  return crypto.subtle.verify('HMAC', key, hexToBytes(signature.v1), new TextEncoder().encode(`${signature.t}.${body}`))
}
