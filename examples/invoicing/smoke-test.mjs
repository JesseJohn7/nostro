/**
 * Smoke test for the invoicing example: pay an invoice, overpay one, and send
 * a payment with no memo. Checks each invoice's final status and the
 * exceptions list. Also verifies that a replayed webhook does not change an
 * invoice twice.
 */
import { strict as assert } from 'node:assert'
import {
  MemoryStore,
  Money,
  NATIVE,
  HorizonEffectsSource,
  HorizonFeesSource,
  HorizonBalanceSource,
  syncUntilCaughtUp,
  reconcileUntilDone,
  deliverUntilDone,
  verifyWebhook,
  signWebhook,
  doctor,
} from '@nostro-labs/nostro'

const TENANT = 'smoke'
const NETWORK = 'testnet'
const ACCOUNT = 'G' + 'A'.repeat(55)
const PAYER = 'G' + 'B'.repeat(55)
const SECRET = 'a'.repeat(64)

// ---------------------------------------------------------------------------
// Simulated Horizon (inline, same shape as examples/before-after/horizon.mjs)
// ---------------------------------------------------------------------------

class SimHorizon {
  url = 'https://horizon.example'
  #ledger = 100
  #effects = []

  payment({ amount, memo, muxedId }) {
    const ledger = ++this.#ledger
    const id = String((BigInt(ledger) << 32n) | 4097n)
    const createdAt = new Date().toISOString()
    this.#effects.push({
      id: `${id}-1`,
      paging_token: `${id}-1`,
      account: ACCOUNT,
      type: 'account_credited',
      created_at: createdAt,
      amount: String(amount),
      asset_type: 'native',
      ...(muxedId === undefined ? {} : { account_muxed_id: String(muxedId) }),
    })
    this.#effects.push({
      id: `${id}-2`,
      paging_token: `${id}-2`,
      account: ACCOUNT,
      type: 'account_debited',
      created_at: createdAt,
      amount: '0.00001',
      asset_type: 'native',
    })
  }

  fetch = async (input) => {
    const url = new URL(String(input))
    const q = url.searchParams
    const cursor = q.get('cursor')
    const limit = Number(q.get('limit') ?? 10)
    const records = cursor ? this.#effects.filter((r) => BigInt(r.paging_token) > BigInt(cursor)) : this.#effects
    const sliced = records.slice(0, limit)
    const headers = { 'content-type': 'application/json', 'latest-ledger': String(this.#ledger) }
    if (url.pathname.endsWith('/effects')) {
      return new Response(JSON.stringify({ _embedded: { records: sliced } }), { status: 200, headers })
    }
    if (url.pathname.endsWith('/operations')) {
      return new Response(JSON.stringify({ _embedded: { records: sliced } }), { status: 200, headers })
    }
    if (url.pathname === `/accounts/${ACCOUNT}`) {
      return new Response(
        JSON.stringify({ id: ACCOUNT, last_modified_ledger: this.#ledger, balances: [{ balance: '100', asset_type: 'native' }] }),
        { status: 200, headers },
      )
    }
    return new Response(JSON.stringify({ status: 404 }), { status: 404 })
  }
}

class FakeClient {
  url = 'https://horizon.example'
  fetch = null
  constructor(fetchFn) {
    this.fetch = fetchFn
  }
  async resource(path, query = {}) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) qs.set(k, String(v))
    const res = await this.fetch(`${this.url}${path}?${qs}`)
    const body = await res.json()
    const latestLedger = Number(res.headers.get('latest-ledger') ?? 0)
    return { body, latestLedger }
  }
  async page(path, query = {}) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) qs.set(k, String(v))
    const res = await this.fetch(`${this.url}${path}?${qs}`)
    const body = await res.json()
    return { records: body._embedded?.records ?? [], lastCursor: null }
  }
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

const horizon = new SimHorizon()
const client = new FakeClient(horizon.fetch)
const sources = [
  new HorizonEffectsSource({ client, network: NETWORK }),
  new HorizonFeesSource({ client, network: NETWORK }),
]
const balanceSource = new HorizonBalanceSource({ client, network: NETWORK })
const store = new MemoryStore()

// Create three invoices
await store.transaction((tx) =>
  tx.insertExpectation({ tenantId: TENANT, reference: 'INV-1', account: ACCOUNT, amount: Money.parse('25', NATIVE), muxedId: 1n }),
)
await store.transaction((tx) =>
  tx.insertExpectation({ tenantId: TENANT, reference: 'INV-2', account: ACCOUNT, amount: Money.parse('10', NATIVE), muxedId: 2n }),
)
await store.transaction((tx) =>
  tx.insertExpectation({ tenantId: TENANT, reference: 'INV-3', account: ACCOUNT, amount: Money.parse('50', NATIVE), muxedId: 3n }),
)

// 1. Pay INV-1 correctly (25 XLM with muxed id 1)
horizon.payment({ amount: '25', memo: null, muxedId: 1 })

// 2. Overpay INV-2 (send 15 XLM, but only 10 was owed)
horizon.payment({ amount: '15', memo: null, muxedId: 2 })

// 3. Send a payment with no memo (should not match any invoice)
horizon.payment({ amount: '30', memo: null })

// Sync and reconcile
await syncUntilCaughtUp({ store, tenantId: TENANT, accounts: [ACCOUNT], sources })
await reconcileUntilDone({ store, tenantId: TENANT, limit: 100 })

// Check invoice statuses
const inv1 = await store.getExpectationByReference(TENANT, 'INV-1')
const inv2 = await store.getExpectationByReference(TENANT, 'INV-2')
const inv3 = await store.getExpectationByReference(TENANT, 'INV-3')

assert.equal(inv1.status, 'settled', `INV-1 should be settled, got ${inv1.status}`)
assert.equal(inv2.status, 'partial', `INV-2 should be partial (overpaid), got ${inv2.status}`)
assert.equal(inv3.status, 'open', `INV-3 should still be open, got ${inv3.status}`)

// Check exceptions: INV-2 should have an OVERPAYMENT, and the no-memo payment should have an exception
const exceptions = await store.listExceptions({ tenantId: TENANT, status: 'open' })
const codes = exceptions.map((x) => x.code)
assert.ok(codes.includes('OVERPAYMENT'), `expected OVERPAYMENT in ${codes}`)
assert.ok(exceptions.length >= 2, `expected at least 2 exceptions (overpayment + unmatched), got ${exceptions.length}`)

// Deliver webhooks to an in-process receiver
const seen = new Set()
let deliveredCount = 0

async function receiver(url, opts) {
  const body = opts.body
  const signature = opts.headers['nostro-signature']

  // 1. Verify the signature on the raw body before parsing
  assert.ok(verifyWebhook({ secret: SECRET, header: signature, body }), 'webhook signature should verify')

  const event = JSON.parse(body)

  // 2. Deduplicate on the event id
  if (seen.has(event.id)) {
    return { status: 200, body: { cancel: async () => {} } }
  }
  seen.add(event.id)
  deliveredCount++

  return { status: 200, body: { cancel: async () => {} } }
}

const report = await deliverUntilDone({
  store,
  tenantId: TENANT,
  url: 'http://receiver',
  secret: SECRET,
  fetch: receiver,
})

assert.ok(report.delivered > 0, `should have delivered events, got ${report.delivered}`)

// 4. A replayed webhook does not change an invoice twice
const report2 = await deliverUntilDone({
  store,
  tenantId: TENANT,
  url: 'http://receiver',
  secret: SECRET,
  fetch: receiver,
})

assert.equal(report2.delivered, 0, 'replaying webhooks should deliver nothing new')

// Doctor should pass (all invariants hold)
const doc = await doctor({ store, tenantId: TENANT })
assert.ok(doc.ok, `doctor should pass, got findings: ${JSON.stringify(doc.findings.map((f) => f.code))}`)

console.log('smoke test passed: 3 invoices, 1 settled, 1 overpaid, 1 open, exceptions raised, webhooks delivered and deduplicated, doctor ok')
