/**
 * examples/invoicing: a small web app that settles invoices from webhooks.
 *
 * This is the end-to-end example the other two are not: create an invoice, give
 * the payer something to pay to, find out when it is paid, and handle what
 * nostro would not decide alone. It uses the library directly rather than the
 * HTTP API, because a single-process app that embeds the store has no network
 * hop to the API and no API key to manage — the README explains the trade-off.
 *
 * Nothing here signs a transaction or holds a secret key. It runs against a
 * simulated Horizon, so it works offline.
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  HorizonBalanceSource,
  HorizonEffectsSource,
  HorizonFeesSource,
  MemoryStore,
  Money,
  NATIVE,
  asset,
  doctor,
  deliverUntilDone,
  reconcileUntilDone,
  syncUntilCaughtUp,
  verifyWebhook,
  signWebhook,
  muxedAddress,
} from '@nostro-labs/nostro'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const TENANT = 'invoicing'
const NETWORK = 'testnet'
const ACCOUNT = 'G' + 'A'.repeat(55)
const PAYER = 'G' + 'B'.repeat(55)
const WEBHOOK_SECRET = 'a'.repeat(64) // In production: openssl rand -hex 32, from env

const store = new MemoryStore()

/**
 * A simulated Horizon, the same shape as examples/before-after/horizon.mjs.
 * Payments are recorded as effects, so sync() sees them whether or not they
 * appear on /payments (a SAC transfer or a claimable balance claim do not).
 */
class SimulatedHorizon {
  url = 'https://horizon.example'
  #ledger = 100
  #effects = []
  #operations = []

  payment({ amount, memo, muxedId }) {
    const ledger = ++this.#ledger
    const id = String((BigInt(ledger) << 32n) | 4097n)
    const fields = { asset_type: 'native' }
    const createdAt = new Date().toISOString()
    const tx = {
      hash: ledger.toString(16).padStart(64, '0'),
      paging_token: id,
      ledger,
      created_at: createdAt,
      successful: true,
      source_account: PAYER,
      fee_account: PAYER,
      fee_charged: '100',
      memo_type: memo === null ? 'none' : 'text',
      ...(memo === null ? {} : { memo }),
    }
    this.#operations.push({
      id,
      paging_token: id,
      type: 'payment',
      source_account: PAYER,
      transaction_hash: tx.hash,
      created_at: createdAt,
      transaction: tx,
      from: PAYER,
      to: ACCOUNT,
      amount: String(amount),
      ...fields,
    })
    this.#effects.push({
      id: `${id}-1`,
      paging_token: `${id}-1`,
      account: ACCOUNT,
      type: 'account_credited',
      created_at: createdAt,
      amount: String(amount),
      ...fields,
      ...(muxedId === undefined ? {} : { account_muxed_id: String(muxedId) }),
    })
    // Fee effect
    this.#effects.push({
      id: `${id}-2`,
      paging_token: `${id}-2`,
      account: ACCOUNT,
      type: 'account_debited',
      created_at: createdAt,
      amount: '0.00001',
      ...fields,
    })
  }

  fetch = async (input) => {
    const url = new URL(String(input))
    const q = url.searchParams
    const cursor = q.get('cursor')
    const limit = Number(q.get('limit') ?? 10)
    const records = cursor
      ? this.#effects.filter((r) => BigInt(r.paging_token) > BigInt(cursor))
      : this.#effects
    const sliced = records.slice(0, limit)
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'latest-ledger': String(this.#ledger) } })
    if (url.pathname.endsWith('/effects')) {
      return json({ _embedded: { records: sliced } })
    }
    if (url.pathname.endsWith('/operations')) {
      const ops = cursor
        ? this.#operations.filter((r) => BigInt(r.paging_token) > BigInt(cursor))
        : this.#operations
      return json({ _embedded: { records: ops.slice(0, limit) } })
    }
    if (url.pathname === `/accounts/${ACCOUNT}`) {
      return json({
        id: ACCOUNT,
        last_modified_ledger: this.#ledger,
        balances: [{ balance: '100.0000000', asset_type: 'native' }],
      }, 200, { 'latest-ledger': String(this.#ledger) })
    }
    return json({ status: 404 }, 404)
  }
}

const horizon = new SimulatedHorizon()
const client = new (class extends HorizonBalanceSource {
  // Reuse HorizonClient's interface with our fake fetch
  constructor() {
    super({ client: { url: horizon.url, fetch: horizon.fetch, network: NETWORK }, network: NETWORK })
  }
})

// Build a real HorizonClient with the simulated fetch
class FakeClient {
  url = horizon.url
  fetch = horizon.fetch
  network = NETWORK
  async resource(path, query = {}) {
    const qs = new URLSearchParams(query)
    const res = await this.fetch(`${this.url}${path}?${qs}`)
    const body = await res.json()
    const latestLedger = Number(res.headers.get('latest-ledger') ?? 0)
    return { body, latestLedger }
  }
  async page(path, query = {}) {
    const qs = new URLSearchParams(query)
    const res = await this.fetch(`${this.url}${path}?${qs}`)
    const body = await res.json()
    return { records: body._embedded?.records ?? [], lastCursor: null }
  }
}

const fakeClient = new FakeClient()
const sources = [
  new HorizonEffectsSource({ client: fakeClient, network: NETWORK }),
  new HorizonFeesSource({ client: fakeClient, network: NETWORK }),
]
const balanceSource = new HorizonBalanceSource({ client: fakeClient, network: NETWORK })

// ---------------------------------------------------------------------------
// Invoice state (in-memory; a real app uses SQLite)
// ---------------------------------------------------------------------------

const invoices = new Map()

async function createInvoice({ reference, amount, muxedId }) {
  await store.transaction((tx) =>
    tx.insertExpectation({
      tenantId: TENANT,
      reference,
      account: ACCOUNT,
      amount: Money.parse(String(amount), NATIVE),
      ...(muxedId === undefined ? {} : { muxedId: BigInt(muxedId) }),
    }),
  )
  const invoice = {
    id: randomUUID(),
    reference,
    amount,
    muxedId: muxedId ?? null,
    status: 'open',
    memo: reference,
    paymentAddress: muxedId ? muxedAddress(ACCOUNT, BigInt(muxedId)) : ACCOUNT,
    events: [],
  }
  invoices.set(reference, invoice)
  return invoice
}

async function syncAndReconcile() {
  await syncUntilCaughtUp({ store, tenantId: TENANT, accounts: [ACCOUNT], sources })
  await reconcileUntilDone({ store, tenantId: TENANT, limit: 100 })
}

async function deliverWebhooks() {
  return deliverUntilDone({
    store,
    tenantId: TENANT,
    url: `http://127.0.0.1:${PORT}/webhook`,
    secret: WEBHOOK_SECRET,
    fetch: localFetch,
  })
}

/** Update invoice statuses from the store. */
async function refreshInvoices() {
  for (const [ref, invoice] of invoices) {
    const exp = await store.getExpectationByReference(TENANT, ref)
    if (exp) invoice.status = exp.status
  }
}

/** Get open exceptions. */
async function getOpenExceptions() {
  const exceptions = await store.listExceptions({ tenantId: TENANT, status: 'open' })
  return exceptions.map((x) => ({
    id: x.id,
    code: x.code,
    detail: x.detail,
    movementId: x.movementId,
    resolve: `nostro resolve ${x.id} --apply ${refOfException(x)} --note "..."`,
  }))
}

function refOfException(x) {
  if (x.expectationId) {
    for (const [ref, inv] of invoices) {
      if (inv.reference === ref) return ref
    }
  }
  return '<reference>'
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 3001)
const seen = new Set()

function json(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body, null, 2))
}

function html(res, body) {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(body)
}

/** In-process fetch for webhook delivery to ourselves. */
async function localFetch(url, opts) {
  return new Promise((resolve) => {
    const { method, headers, body } = opts
    const req = require('node:http').request(url, { method, headers }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode, body: { cancel: async () => {} } }))
    })
    req.write(body)
    req.end()
  })
}

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    const url = new URL(req.url, `http://localhost:${PORT}`)

    // Create an invoice
    if (url.pathname === '/invoices' && req.method === 'POST') {
      const { reference, amount, muxedId } = JSON.parse(body)
      createInvoice({ reference, amount, muxedId }).then((inv) => json(res, inv))
      return
    }

    // List invoices
    if (url.pathname === '/invoices' && req.method === 'GET') {
      refreshInvoices().then(() => json(res, [...invoices.values()]))
      return
    }

    // Show a single invoice
    if (url.pathname.startsWith('/invoices/') && req.method === 'GET') {
      const ref = decodeURIComponent(url.pathname.slice('/invoices/'.length))
      const inv = invoices.get(ref)
      if (!inv) return json(res, { error: 'not found' }, 404)
      refreshInvoices().then(() => json(res, inv))
      return
    }

    // List exceptions
    if (url.pathname === '/exceptions' && req.method === 'GET') {
      getOpenExceptions().then((exs) => json(res, exs))
      return
    }

    // Sync and reconcile (in a real app, a timer does this)
    if (url.pathname === '/sync' && req.method === 'POST') {
      syncAndReconcile()
        .then(() => deliverWebhooks())
        .then(() => refreshInvoices())
        .then(() => json(res, { ok: true }))
      return
    }

    // Webhook receiver: verify the signature, deduplicate, update status
    if (url.pathname === '/webhook' && req.method === 'POST') {
      // 1. Verify the signature on the raw body before parsing.
      if (!verifyWebhook({ secret: WEBHOOK_SECRET, header: req.headers['nostro-signature'], body })) {
        return json(res, { error: 'bad signature' }, 401)
      }
      const event = JSON.parse(body)
      // 2. Deduplicate on the event id.
      if (seen.has(event.id)) {
        return json(res, { ok: true, duplicate: true }, 200)
      }
      seen.add(event.id)

      // 3. Update the invoice status from the event.
      if (event.type === 'expectation.settled' || event.type === 'expectation.partially_paid' || event.type === 'expectation.cancelled') {
        const data = event.data
        const exp = data?.expectation
        if (exp) {
          const inv = invoices.get(exp.reference)
          if (inv) {
            inv.status = exp.status
            inv.events.push({ id: event.id, type: event.type, at: event.createdAt })
          }
        }
      }
      return json(res, { ok: true }, 200)
    }

    // Doctor check
    if (url.pathname === '/doctor' && req.method === 'GET') {
      doctor({
        store,
        tenantId: TENANT,
        attest: { balances: balanceSource, sources, accounts: [ACCOUNT] },
      }).then((r) => json(res, { ok: r.ok, findings: r.findings.length, balances: r.balances }))
      return
    }

    // Index page
    if (url.pathname === '/' && req.method === 'GET') {
      html(
        res,
        `<!DOCTYPE html><html><body>
<h1>nostro invoicing example</h1>
<p>POST /invoices {"reference":"INV-1","amount":"25","muxedId":1} to create an invoice.</p>
<p>GET /invoices to list them. GET /exceptions for open exceptions.</p>
<p>POST /sync to sync, reconcile and deliver webhooks.</p>
</body></html>`,
      )
      return
    }

    json(res, { error: 'not found' }, 404)
  })
})

server.listen(PORT, () => {
  console.log(`invoicing example listening on http://127.0.0.1:${PORT}`)
})

export { server, store, horizon, createInvoice, syncAndReconcile, deliverWebhooks, refreshInvoices, getOpenExceptions }
