/**
 * The chart of accounts: which account code each journal role posts to.
 *
 * Journal arithmetic works on roles, not codes, so changing the chart only
 * affects lines posted from then on; it never re-posts history.
 *
 * | role                  | default                          | used for                                   |
 * |-----------------------|----------------------------------|--------------------------------------------|
 * | cash                  | assets:stellar:<network>:<G...>  | every movement on a wallet                 |
 * | issued                | liabilities:issued               | the issuer's own asset (no wallet balance) |
 * | receivable            | assets:receivable                | incoming payments applied to expectations  |
 * | payable               | liabilities:payable              | outgoing payments applied to payouts       |
 * | customer_credit       | liabilities:customer-credit      | overpaid or paid twice: owed back          |
 * | unapplied             | liabilities:unapplied-receipts   | money in, not yet explained                |
 * | unexplained           | assets:suspense                  | money out, not yet explained               |
 * | network_fees          | expenses:network-fees            | transaction fees                           |
 * | uncategorized_income  | income:uncategorized             | ignored incoming movements                 |
 * | uncategorized_expense | expenses:uncategorized           | ignored outgoing movements                 |
 *
 * Money out that nobody explained is a suspense *asset*, not a liability:
 * it was usually exchanged for something (a DEX trade, a bill booked
 * elsewhere), and netting it against unexplained receipts would hide both.
 *
 * ## Posting rules (issue #54)
 *
 * Ordered rules are checked before the chart. The first rule whose predicate
 * matches wins and returns the account code; the chart is the fallback.
 * Rules are pure and deterministic: the same movement and rule list always
 * give the same account. A rule never re-posts history: `planPosting` keeps
 * every slot in the account it was first posted to.
 *
 * A rule may match on:
 *   - `role`         — the line role
 *   - `asset`        — full asset id (e.g. "USDC:GA5Z...")
 *   - `account`      — the watched Stellar account
 *   - `counterparty` — the other side of the payment
 *   - `direction`    — "credit" or "debit"
 *   - `kind`         — movement kind (transfer, fee, …)
 *   - `expectationRef` — the expectation's reference prefix (lines with an
 *                        expectation only)
 *   - `metadataKey` + `metadataValue` — an exact metadata entry on the
 *                        expectation (lines with an expectation only)
 *
 * All specified fields must match (AND semantics). An empty rule matches
 * everything.
 *
 * The optional `rule` field on a posted line records which rule index (0-based)
 * chose the account, or `null` when the chart was the fallback. This lets you
 * audit which rule fired.
 */
import type { Direction, LineRole, MovementKind } from '../model/index.js'
import type { AssetId } from '../money/index.js'

export interface ChartOfAccounts {
  readonly cash: (network: string, account: string) => string
  readonly issued: string
  readonly receivable: string
  readonly payable: string
  readonly customer_credit: string
  readonly unapplied: string
  readonly unexplained: string
  readonly network_fees: string
  readonly uncategorized_income: string
  readonly conversion: string
  readonly refund_clearing: string
  readonly deposit_clearing: string
  readonly redemption_payable: string
  readonly clawback: string
  readonly due_to: string
  readonly due_from: string
  readonly in_transit: string
  readonly opening_balance: string
  readonly other: string
  readonly uncategorized_expense: string
}

export const DEFAULT_CHART: ChartOfAccounts = {
  cash: (network, account) => `assets:stellar:${network}:${account}`,
  issued: 'liabilities:issued',
  receivable: 'assets:receivable',
  payable: 'liabilities:payable',
  customer_credit: 'liabilities:customer-credit',
  unapplied: 'liabilities:unapplied-receipts',
  unexplained: 'assets:suspense',
  network_fees: 'expenses:network-fees',
  uncategorized_income: 'income:uncategorized',
  uncategorized_expense: 'expenses:uncategorized',
  conversion: 'equity:conversion',
  other: 'equity:adjustments',
  refund_clearing: 'liabilities:refund-clearing',
  deposit_clearing: 'liabilities:deposits-received',
  redemption_payable: 'liabilities:redemptions-payable',
  clawback: 'equity:clawback',
  due_to: 'liabilities:due-to',
  due_from: 'assets:due-from',
  in_transit: 'assets:in-transit',
  opening_balance: 'equity:opening-balances',
}

/** The account a role posts to for a movement on `account` in `network`. */
export function accountFor(chart: ChartOfAccounts, role: LineRole, network: string, account: string): string {
  return role === 'cash' ? chart.cash(network, account) : chart[role]
}

// ---------------------------------------------------------------------------
// Posting rules
// ---------------------------------------------------------------------------

/**
 * Context supplied to each rule predicate when a line is about to be posted.
 * All fields come from facts that are already known at posting time.
 */
export interface PostingRuleContext {
  /** The line role being posted. */
  readonly role: LineRole
  /** The full asset id of the line amount, e.g. "USDC:GA5Z..." or "native". */
  readonly asset: AssetId
  /** The watched Stellar account (G...). */
  readonly account: string
  /** The network label, e.g. "testnet". */
  readonly network: string
  /** Credit or debit, from the movement's perspective. */
  readonly direction: Direction
  /** The movement kind: transfer, fee, etc. */
  readonly kind: MovementKind
  /** The other side of the payment, if the movement has one. */
  readonly counterparty: string | null
  /** The expectation's reference, if this line is tied to an expectation. */
  readonly expectationRef: string | null
  /** The expectation's metadata, if this line is tied to an expectation. */
  readonly expectationMetadata: Readonly<Record<string, string>> | null
}

/**
 * A single posting rule. All specified filter fields must match for the rule
 * to fire (AND semantics). An unspecified field is a wildcard.
 *
 * When the rule matches, `account` is used as the line's account code.
 */
export interface PostingRule {
  /** Human-readable label for audit logs and the `rule` field on a line. */
  readonly label?: string
  /** Match on line role. */
  readonly role?: LineRole
  /** Match on asset id (exact string match). */
  readonly asset?: AssetId
  /** Match on the watched account (exact). */
  readonly account?: string
  /** Match on the counterparty account (exact). */
  readonly counterparty?: string
  /** Match on movement direction. */
  readonly direction?: Direction
  /** Match on movement kind. */
  readonly kind?: MovementKind
  /** Match if the expectation reference starts with this string. */
  readonly expectationRefPrefix?: string
  /** Match if the expectation has this metadata key. */
  readonly metadataKey?: string
  /** Match if the expectation has this metadata key set to exactly this value.
   *  Only meaningful when `metadataKey` is also set. */
  readonly metadataValue?: string
  /** The account code to use when this rule matches. */
  readonly account_code: string
}

/**
 * Returns `true` when `rule` matches `ctx`.
 *
 * Every field that is set on the rule must match the context value. Fields
 * that are `undefined` are wildcards.
 */
export function ruleMatches(rule: PostingRule, ctx: PostingRuleContext): boolean {
  if (rule.role !== undefined && rule.role !== ctx.role) return false
  if (rule.asset !== undefined && rule.asset !== ctx.asset) return false
  if (rule.account !== undefined && rule.account !== ctx.account) return false
  if (rule.counterparty !== undefined && rule.counterparty !== ctx.counterparty) return false
  if (rule.direction !== undefined && rule.direction !== ctx.direction) return false
  if (rule.kind !== undefined && rule.kind !== ctx.kind) return false
  if (rule.expectationRefPrefix !== undefined) {
    if (ctx.expectationRef === null) return false
    if (!ctx.expectationRef.startsWith(rule.expectationRefPrefix)) return false
  }
  if (rule.metadataKey !== undefined) {
    if (ctx.expectationMetadata === null) return false
    if (!(rule.metadataKey in ctx.expectationMetadata)) return false
    if (rule.metadataValue !== undefined && ctx.expectationMetadata[rule.metadataKey] !== rule.metadataValue) return false
  }
  return true
}

/**
 * Find the first rule in `rules` that matches `ctx`.
 * Returns `{ account, ruleIndex }` or `null` if no rule matched.
 */
export function applyRules(
  rules: readonly PostingRule[],
  ctx: PostingRuleContext,
): { account: string; ruleIndex: number } | null {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!
    if (ruleMatches(rule, ctx)) {
      return { account: rule.account_code, ruleIndex: i }
    }
  }
  return null
}

/**
 * Account kinds — every code belongs to exactly one (issue #57).
 *
 * Codes that start with a known prefix inherit the prefix's kind by default.
 * Custom codes with no recognisable prefix must be given an explicit kind.
 */
export type AccountKind = 'asset' | 'liability' | 'equity' | 'income' | 'expense'

/** Prefix-to-kind mapping for the standard nostro account codes. */
const KIND_BY_PREFIX: ReadonlyMap<string, AccountKind> = new Map([
  ['assets:', 'asset'],
  ['liabilities:', 'liability'],
  ['equity:', 'equity'],
  ['income:', 'income'],
  ['expenses:', 'expense'],
])

/**
 * Infer an `AccountKind` from an account code by its prefix.
 * Returns `null` when no prefix matches (a custom code).
 */
export function kindFromPrefix(code: string): AccountKind | null {
  for (const [prefix, kind] of KIND_BY_PREFIX) {
    if (code.startsWith(prefix)) return kind
  }
  return null
}

/**
 * A registry of explicit kinds for account codes that have no recognisable
 * prefix. If a code has a standard prefix its kind is inferred automatically;
 * listing it here overrides the inference.
 */
export type AccountKindMap = Readonly<Record<string, AccountKind>>

/**
 * Resolve the kind of `code`:
 * 1. Check the explicit `kindMap` first.
 * 2. Fall back to prefix inference.
 * 3. Throw if neither works.
 */
export function resolveKind(code: string, kindMap: AccountKindMap = {}): AccountKind {
  if (code in kindMap) return kindMap[code]!
  const inferred = kindFromPrefix(code)
  if (inferred !== null) return inferred
  throw new Error(
    `Account code "${code}" has no recognisable prefix (assets:, liabilities:, equity:, income:, expenses:) ` +
      `and no explicit kind. Add it to the AccountKindMap.`,
  )
}
