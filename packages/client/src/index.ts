/**
 * `@nostro-labs/client` — a browser-safe client for the nostro HTTP API.
 *
 * The money, JSON and webhook helpers are re-exported from core's browser-safe
 * subpath exports rather than copied, so amounts and signature rules cannot
 * drift between the server and its callers.
 */
export { createClient } from './client.js'
export type { ClientOptions, NostroClient } from './client.js'
export { ApiError } from './error.js'
export type { ApiErrorFields } from './error.js'
export { pageIterable } from './page.js'
export type { Page, PageIterable } from './page.js'
export * from './types.js'

export { Money, NATIVE, parseAsset, moneyFromJson } from '@nostro-labs/nostro/money'
export type { AssetId } from '@nostro-labs/nostro/money'
export {
  movementFromJson,
  expectationFromJson,
  allocationFromJson,
  exceptionFromJson,
  journalEntryFromJson,
  scheduleFromJson,
  memoFromJson,
} from '@nostro-labs/nostro/json'
/** Web Crypto webhook verification; the same options shape as core's Node verifier. */
export { verifyWebhook } from '@nostro-labs/nostro/webhooks/verify'
export type { VerifyOptions } from '@nostro-labs/nostro/webhooks/verify'
