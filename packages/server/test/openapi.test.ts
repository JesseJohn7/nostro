/**
 * The OpenAPI document is a contract: it must be valid, describe exactly the
 * routes the server has, and match what the server actually sends.
 */
import SwaggerParser from '@apidevtools/swagger-parser'
import { Ajv2020 } from 'ajv/dist/2020.js'
import formats from 'ajv-formats'
import { describe, expect, it } from 'vitest'
import { HorizonEffectsSource, HorizonFeesSource, MemoryStore, Money, NATIVE, reconcile, sync } from '@nostro-labs/nostro'
import { FakeHorizon } from 'nostro-testkit'
import { apiKeys, buildOpenApi, createServer } from '../src/index.js'

const A = `G${'A'.repeat(55)}`
const B = `G${'B'.repeat(55)}`
const KEY = 'a'.repeat(64)
// ajv-formats is CommonJS: under NodeNext its default export arrives wrapped.
const addFormats = (formats as unknown as { default: typeof formats.default }).default
const headers = { authorization: `Bearer ${KEY}` }

async function app() {
  const store = new MemoryStore()
  const h = new FakeHorizon()
  h.payment(10, B, A, '25', { memo: 'INV-1042' })
  h.payment(11, A, B, '5', { memo: 'refund' })
  const client = h.client()
  for (const source of [new HorizonEffectsSource({ client, network: 'testnet' }), new HorizonFeesSource({ client, network: 'testnet' })]) {
    await sync({ store, source, tenantId: 'acme', accounts: [A] })
  }
  await store.transaction((tx) =>
    tx.insertExpectation({ tenantId: 'acme', reference: 'INV-1042', account: A, amount: Money.parse('25', NATIVE), muxedId: 7n, memo: { type: 'id', value: 7n } }),
  )
  await reconcile({ store, tenantId: 'acme' })
  const server = createServer({ store, authenticate: apiKeys({ [KEY]: 'acme' }) })
  await server.ready()
  return server
}

/** `method path` for every route Fastify has, from its route tree, without HEAD. */
function routesOf(tree: string): string[] {
  const out: string[] = []
  const stack: string[] = []
  for (const line of tree.split('\n')) {
    const m = /^([│ ]*)[├└]── (\S+) \(([^)]+)\)/.exec(line)
    if (m === null) continue
    const depth = m[1]!.length / 4
    stack.length = depth
    const path = (stack[depth - 1] ?? '') + m[2]!
    stack.push(path)
    for (const method of m[3]!.split(', ')) if (method !== 'HEAD') out.push(`${method} ${path.replace(/:(\w+)/g, '{$1}')}`)
  }
  return out.sort()
}

interface DocumentedOperation {
  requestBody?: { content: Record<string, { schema: object }> }
  responses: Record<string, { content?: Record<string, { schema: object }> }>
}

const operation = (doc: ReturnType<typeof buildOpenApi>, method: string, path: string) =>
  (doc.paths as Record<string, Record<string, DocumentedOperation>>)[path]![method]!

const asSchema = (schema: object) => JSON.parse(JSON.stringify(schema).replaceAll('"#/components', '"nostro#/components'))

describe('the OpenAPI document', () => {
  it("carries this package's version", async () => {
    const { readFileSync } = await import('node:fs')
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(buildOpenApi().info.version).toBe(pkg.version)
    expect(pkg.version).toBe('0.1.0')
  })

  it('is valid OpenAPI 3.1', async () => {
    await expect(SwaggerParser.validate(structuredClone(buildOpenApi()) as never)).resolves.toBeDefined()
  })

  it('describes exactly the routes the server has', async () => {
    const server = await app()
    const doc = buildOpenApi()
    const documented = Object.entries(doc.paths)
      .flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`))
      .sort()
    expect(routesOf(server.printRoutes({ commonPrefix: false }))).toEqual(documented)
  })

  it('is what the server serves at /v1/openapi.json, without a key', async () => {
    const res = await (await app()).inject('/v1/openapi.json')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(JSON.parse(JSON.stringify(buildOpenApi())))
  })

  it('matches what the server actually sends', async () => {
    const server = await app()
    const doc = buildOpenApi()
    const ajv = new Ajv2020({ strict: false, allErrors: true })
    addFormats(ajv)
    ajv.addSchema({ $id: 'nostro', components: doc.components })
    const conforms = (status: number, body: unknown, method: string, path: string, payload?: object) => {
      const op = operation(doc, method, path)
      const response = op.responses[String(status)]
      expect(response, `${method} ${path} documents ${status}`).toBeDefined()
      const [, media] = Object.entries(response!.content!)[0]!
      const schema = asSchema(media.schema)
      const validate = ajv.compile(schema)
      expect(validate(body), `${method} ${path} ${status}: ${ajv.errorsText(validate.errors)}`).toBe(true)
      ajv.removeSchema(schema)
      if (payload !== undefined) {
        const request = op.requestBody?.content['application/json']
        expect(request, `${method} ${path} documents a JSON request body`).toBeDefined()
        const requestSchema = asSchema(request!.schema)
        const validateRequest = ajv.compile(requestSchema)
        expect(validateRequest(payload), `${method} ${path} request: ${ajv.errorsText(validateRequest.errors)}`).toBe(true)
        ajv.removeSchema(requestSchema)
      }
    }
    const call = async (method: 'GET' | 'POST', url: string, path: string, payload?: object, auth = true, documentedPayload = true) => {
      const res = await server.inject({ method, url, ...(auth ? { headers } : {}), ...(payload === undefined ? {} : { payload }) })
      conforms(res.statusCode, res.json(), method.toLowerCase(), path, documentedPayload ? payload : undefined)
      return res
    }

    await call('GET', '/v1/health', '/v1/health')
    const movements = (await call('GET', '/v1/movements', '/v1/movements')).json()
    expect(movements.data.length).toBeGreaterThan(0)
    for (const m of movements.data) await call('GET', `/v1/movements/${m.id}`, '/v1/movements/{id}')
    const expectations = (await call('GET', '/v1/expectations', '/v1/expectations')).json()
    await call('GET', `/v1/expectations/${expectations.data[0].id}`, '/v1/expectations/{id}')
    await call('GET', '/v1/exceptions?status=open', '/v1/exceptions')
    expect((await call('GET', '/v1/events', '/v1/events')).json().data.length).toBeGreaterThan(0)
    await call('GET', '/v1/journal?limit=1', '/v1/journal')
    const created = await call('POST', '/v1/expectations', '/v1/expectations', {
      reference: 'INV-9', account: A, amount: '3', payers: [B], dueAt: '2026-11-01T00:00:00Z', metadata: { po: '1' },
    })
    expect(created.statusCode).toBe(201)
    const toCancel = await call('POST', '/v1/expectations', '/v1/expectations', { reference: 'INV-10', account: A, amount: '2' })
    expect(toCancel.statusCode).toBe(201)

    const cancelPath = '/v1/expectations/{id}/cancel'
    expect((await call('POST', '/v1/expectations/nope/cancel', cancelPath, { reason: 'n' })).statusCode).toBe(404)
    expect((await call('POST', `/v1/expectations/${toCancel.json().id}/cancel`, cancelPath, {}, true, false)).statusCode).toBe(400)
    const cancelled = await call('POST', `/v1/expectations/${toCancel.json().id}/cancel`, cancelPath, { reason: 'no longer needed' })
    expect(cancelled.json()).toMatchObject({ status: 'cancelled', cancelReason: 'no longer needed' })
    expect((await call('POST', `/v1/expectations/${toCancel.json().id}/cancel`, cancelPath, { reason: 'again' })).statusCode).toBe(409)
    expect((await call('POST', `/v1/expectations/${created.json().id}/cancel`, cancelPath, { reason: 'bad\u0000reason' })).statusCode).toBe(422)
    const amendPath = '/v1/expectations/{id}/amend'
    expect((await call('POST', '/v1/expectations/nope/amend', amendPath, { reason: 'n' })).statusCode).toBe(404)
    expect((await call('POST', `/v1/expectations/${created.json().id}/amend`, amendPath, { reason: 'n', amount: 1 }, true, false)).statusCode).toBe(400)
    expect((await call('POST', `/v1/expectations/${created.json().id}/amend`, amendPath, { reason: 'n' })).statusCode).toBe(422)
    const amended = await call('POST', `/v1/expectations/${created.json().id}/amend`, amendPath, { reason: 'corrected', amount: '4', muxedId: null })
    expect(amended.json()).toMatchObject({ amount: '4.0000000', muxedId: null })

    const openExceptions = (await call('GET', '/v1/exceptions?status=open', '/v1/exceptions')).json().data as { id: string }[]
    const path = '/v1/exceptions/{id}/resolve'
    const debit = openExceptions[0]!.id
    expect((await call('POST', `/v1/exceptions/nope/resolve`, path, { action: 'ignore', note: 'n' })).statusCode).toBe(404)
    expect((await call('POST', `/v1/exceptions/${debit}/resolve`, path, { action: 'apply', allocations: [{ reference: 'nope' }], note: 'n' })).statusCode).toBe(422)
    expect((await call('POST', `/v1/exceptions/${debit}/resolve`, path, { action: 'close', note: 'n' })).statusCode).toBe(409)
    expect((await call('POST', `/v1/exceptions/${debit}/resolve`, path, { action: 'pay' }, true, false)).statusCode).toBe(400)
    const ignored = await call('POST', `/v1/exceptions/${debit}/resolve`, path, { action: 'ignore', note: 'paid a supplier' })
    expect(ignored.statusCode).toBe(200)
    expect(ignored.json().journalEntry.kind).toBe('reclass')

    // And every documented error, in the shape documented.
    expect((await call('GET', '/v1/movements', '/v1/movements', undefined, false)).statusCode).toBe(401)
    expect((await call('GET', '/v1/movements?limit=0', '/v1/movements')).statusCode).toBe(400)
    expect((await call('GET', '/v1/movements/nope', '/v1/movements/{id}')).statusCode).toBe(404)
    expect((await call('POST', '/v1/expectations', '/v1/expectations', { reference: 'INV-9', account: A, amount: '3' })).statusCode).toBe(409)
    expect((await call('POST', '/v1/expectations', '/v1/expectations', { reference: 'R', account: A, amount: '0' })).statusCode).toBe(422)
  })

  it('documents the cancel, amend and create request bodies, including an issued muxed id', async () => {
    const server = await app()
    const doc = buildOpenApi()
    const ajv = new Ajv2020({ strict: false, allErrors: true })
    addFormats(ajv)
    ajv.addSchema({ $id: 'nostro', components: doc.components })
    const bodyValidate = (path: string) => {
      const request = operation(doc, 'post', path).requestBody?.content['application/json']
      expect(request, `${path} documents a JSON request body`).toBeDefined()
      return ajv.compile(asSchema(request!.schema))
    }
    const cancelBody = bodyValidate('/v1/expectations/{id}/cancel')
    expect(cancelBody({ reason: 'n' }), ajv.errorsText(cancelBody.errors)).toBe(true)
    for (const payload of [{}, { reason: '' }, { reason: 1 }, { reason: 'n', amount: '1' }]) {
      expect(cancelBody(payload), JSON.stringify(payload)).toBe(false)
    }
    const amendBody = bodyValidate('/v1/expectations/{id}/amend')
    const amendment = { reason: 'n', amount: '1', muxedId: null, memo: null, payers: [A], dueAt: null, expiresAt: null, metadata: { po: '1' } }
    expect(amendBody(amendment), ajv.errorsText(amendBody.errors)).toBe(true)
    for (const payload of [{}, { reason: '' }, { reason: 'n', amount: 1 }, { reason: 'n', muxedId: 'issue' }, { reason: 'n', memo: { type: 'hash', value: 'aa' } }]) {
      expect(amendBody(payload), JSON.stringify(payload)).toBe(false)
    }
    const createBody = bodyValidate('/v1/expectations')
    const issued = { reference: 'INV-ISSUE', account: A, amount: '3', muxedId: 'issue' }
    expect(createBody(issued), ajv.errorsText(createBody.errors)).toBe(true)
    expect(createBody({ ...issued, muxedId: '7' }), ajv.errorsText(createBody.errors)).toBe(true)
    expect(createBody({ ...issued, muxedId: 7 })).toBe(false)
    expect(createBody({ ...issued, muxedId: 'n' })).toBe(false)
    const res = await server.inject({ method: 'POST', url: '/v1/expectations', headers, payload: issued })
    expect(res.statusCode).toBe(201)
    expect(res.json().muxedId).toMatch(/^[0-9]+$/)
    expect(BigInt(res.json().muxedId) > 0n).toBe(true)
  })
})
