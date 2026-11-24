/**
 * Pure parsing and replay-window checking of `Nostro-Signature`.
 *
 * No Node (or browser) crypto here: both the Node verifier and the Web Crypto
 * verifier call `parseSignature`, so a header accepted or refused in one is
 * accepted or refused in the other. The header carries `t=<unix seconds>` and
 * `v1=<hex HMAC>`; the caller decides how to check the MAC itself.
 */

/** The request header carrying the signature. */
export const SIGNATURE_HEADER = 'nostro-signature'

/** What a caller needs to verify a webhook, whichever crypto backend it uses. */
export interface VerifyOptions {
  readonly secret: string
  /** The `Nostro-Signature` header as received. */
  readonly header: string | null | undefined
  /** The raw request body, exactly as received: verify before parsing. */
  readonly body: string
  /** How far `t` may be from now, in seconds. Default 300. */
  readonly toleranceSeconds?: number
  readonly now?: () => Date
}

export interface ParsedSignature {
  /** The timestamp from the header, as unix seconds. */
  readonly t: number
  /** The lower-case hex HMAC from the header. */
  readonly v1: string
}

/**
 * Parse a signature header and check it is inside the replay window. Returns
 * null for anything malformed or stale. The default tolerance is the caller's
 * job (300 seconds in both verifiers) so this function stays total.
 */
export function parseSignature(header: string, nowSeconds: number, tolerance: number): ParsedSignature | null {
  const parts = new Map(header.split(',').map((p) => [p.slice(0, p.indexOf('=')).trim(), p.slice(p.indexOf('=') + 1).trim()]))
  const t = parts.get('t')
  const v1 = parts.get('v1')
  if (t === undefined || v1 === undefined || !/^\d{1,12}$/.test(t) || !/^[0-9a-f]{64}$/.test(v1)) return null
  if (Math.abs(nowSeconds - Number(t)) > tolerance) return null
  return { t: Number(t), v1 }
}
