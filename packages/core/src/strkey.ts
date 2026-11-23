/**
 * Stellar strkey encoding/decoding for account IDs and muxed account IDs.
 *
 * Format and checksum follow Stellar's strkey spec (CRC16-XModem, polynomial
 * 0x1021, checksum appended little-endian), as implemented by js-stellar-base:
 * https://github.com/stellar/js-stellar-base/blob/master/src/strkey.ts
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const BASE32_LOOKUP = new Uint8Array(256).fill(255)
for (let i = 0; i < BASE32_ALPHABET.length; i++) {
  BASE32_LOOKUP[BASE32_ALPHABET.charCodeAt(i)] = i
}

const VERSION_G = 6 << 3
const VERSION_C = 2 << 3
const VERSION_M = 12 << 3

const UINT64_MAX = (1n << 64n) - 1n

function crc16XModem(bytes: Uint8Array): number {
  let crc = 0x0000
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]! << 8
    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 0x8000) !== 0) crc = ((crc << 1) ^ 0x1021) & 0xffff
      else crc = (crc << 1) & 0xffff
    }
  }
  return crc
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function base32Decode(value: string): Uint8Array | null {
  if (value.length === 0) return null
  let bits = 0
  let acc = 0
  const out: number[] = []
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code > 255) return null
    const v = BASE32_LOOKUP[code]
    if (v === 255) return null
    acc = (acc << 5) | v
    bits += 5
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  // Reject non-canonical trailing bits.
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null
  return new Uint8Array(out)
}

function encodeStrkey(version: number, payload: Uint8Array): string {
  const body = new Uint8Array(1 + payload.length)
  body[0] = version
  body.set(payload, 1)
  const checksum = crc16XModem(body)
  const bytes = new Uint8Array(body.length + 2)
  bytes.set(body, 0)
  bytes[body.length] = checksum & 0xff
  bytes[body.length + 1] = (checksum >>> 8) & 0xff
  return base32Encode(bytes)
}

function decodeStrkey(value: string, expectedVersion: number, expectedPayloadLength: number): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0) return null
  // Strkeys are uppercase unpadded base32.
  if (value !== value.toUpperCase()) return null
  if (value.includes('=')) return null
  const bytes = base32Decode(value)
  if (bytes === null) return null
  if (bytes.length !== 1 + expectedPayloadLength + 2) return null
  if (bytes[0] !== expectedVersion) return null
  const body = bytes.subarray(0, bytes.length - 2)
  const expected = crc16XModem(body)
  const got = bytes[bytes.length - 2]! | (bytes[bytes.length - 1]! << 8)
  if (got !== expected) return null
  return body.subarray(1)
}

export function muxedAddress(account: string, id: bigint): string {
  const ed25519 = decodeStrkey(account, VERSION_G, 32)
  if (ed25519 === null) throw new Error('account must be a valid G... account id')
  if (typeof id !== 'bigint' || id < 0n || id > UINT64_MAX) {
    throw new Error('id must be a bigint in the uint64 range')
  }
  const payload = new Uint8Array(40)
  payload.set(ed25519, 0)
  let v = id
  for (let i = 39; i >= 32; i--) {
    payload[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return encodeStrkey(VERSION_M, payload)
}

export function parseMuxedAddress(m: string): { account: string; id: bigint } {
  const payload = decodeStrkey(m, VERSION_M, 40)
  if (payload === null) throw new Error('m must be a valid M... muxed account id')
  const account = encodeStrkey(VERSION_G, payload.subarray(0, 32))
  let id = 0n
  for (let i = 32; i < 40; i++) id = (id << 8n) | BigInt(payload[i]!)
  return { account, id }
}

export function isValidAccountId(value: string): boolean {
  if (typeof value !== 'string') return false
  return (
    decodeStrkey(value, VERSION_G, 32) !== null ||
    decodeStrkey(value, VERSION_M, 40) !== null ||
    decodeStrkey(value, VERSION_C, 32) !== null
  )
}
