import type { MatchStrategy } from '../types.js'
import { exactAmountStrategy } from './exact-amount.js'
import { knownPayerStrategy } from './known-payer.js'
import { memoCrossTypeStrategy } from './memo-cross-type.js'
import { memoHashStrategy } from './memo-hash.js'
import { memoIdStrategy } from './memo-id.js'
import { memoTextStrategy } from './memo-text.js'
import { memoTruncatedStrategy } from './memo-truncated.js'
import { muxedIdStrategy } from './muxed-id.js'

export { exactAmountStrategy, knownPayerStrategy, memoCrossTypeStrategy, memoHashStrategy, memoIdStrategy, memoTextStrategy, memoTruncatedStrategy, muxedIdStrategy }

/**
 * The default strategies, strongest first. The ordering and scores are
 * opinionated and documented on purpose: configurable matching rules are how
 * reconciliation systems become impossible to audit.
 */
export const DEFAULT_STRATEGIES: readonly MatchStrategy[] = [
  muxedIdStrategy,
  memoIdStrategy,
  memoHashStrategy,
  memoTextStrategy,
  memoCrossTypeStrategy,
  memoTruncatedStrategy,
  exactAmountStrategy,
  knownPayerStrategy,
]
