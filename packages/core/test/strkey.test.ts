import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { isValidAccountId, muxedAddress, parseMuxedAddress } from '../src/index.js'

// Fixture reference: js-stellar-base strkey implementation behavior.
// https://github.com/stellar/js-stellar-base/blob/master/src/strkey.ts
const ACCOUNT = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ'
const MUXED_ID_0 = 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ'
const MUXED_ID_MAX = 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJV7777777777775ZO4'

describe('strkey', () => {
  it('round-trips muxed ids over uint64 including edges', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), (id) => {
        const m = muxedAddress(ACCOUNT, id)
        expect(isValidAccountId(m)).toBe(true)
        expect(parseMuxedAddress(m)).toEqual({ account: ACCOUNT, id })
      }),
    )
  })

  it('matches committed reference vectors and edges', () => {
    expect(muxedAddress(ACCOUNT, 0n)).toBe(MUXED_ID_0)
    expect(parseMuxedAddress(MUXED_ID_0)).toEqual({ account: ACCOUNT, id: 0n })
    expect(parseMuxedAddress(MUXED_ID_MAX)).toEqual({ account: ACCOUNT, id: (1n << 64n) - 1n })
    expect(muxedAddress(ACCOUNT, (1n << 64n) - 1n)).toBe(MUXED_ID_MAX)
  })

  it('rejects bad checksums and non-canonical forms', () => {
    expect(isValidAccountId(ACCOUNT)).toBe(true)
    expect(isValidAccountId(MUXED_ID_0)).toBe(true)
    const badChecksum = `${MUXED_ID_0.slice(0, -1)}A`
    expect(isValidAccountId(badChecksum)).toBe(false)
    expect(isValidAccountId(MUXED_ID_0.toLowerCase())).toBe(false)
    expect(isValidAccountId(`${MUXED_ID_0}=`)).toBe(false)
  })
})
