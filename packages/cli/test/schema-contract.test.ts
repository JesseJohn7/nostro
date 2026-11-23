import { readFileSync } from 'node:fs'
import ajvModule from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { A, migrated, nostro, workspace } from './helpers.js'

/** The parts of an Ajv 2020-12 validator these tests use. */
interface Validator {
  (data: unknown): boolean
  errors?: unknown[] | null
}
interface AjvLike {
  addSchema(schema: object): unknown
  compile(schema: object): Validator
}
/** Ajv's CJS default export, typed here because the resolver does not see its constructor. */
const Ajv2020 = ajvModule as unknown as new (options: { allErrors: boolean; strict: boolean }) => AjvLike

const schemaUrl = new URL('../schemas/output.schema.json', import.meta.url)
const schema = JSON.parse(readFileSync(schemaUrl, 'utf8')) as { $id: string }
const ajv = new Ajv2020({ allErrors: true, strict: true })
ajv.addSchema(schema)

/** A validator for an array of the named `$defs` entry, e.g. `list('expectation')`. */
const list = (def: string): Validator => ajv.compile({ type: 'array', items: { $ref: `${schema.$id}#/$defs/${def}` } })
/** A validator for one `$defs` entry. */
const one = (def: string): Validator => ajv.compile({ $ref: `${schema.$id}#/$defs/${def}` })

/** Ajv's complaints, for a failing assertion message. */
const why = (v: Validator) => JSON.stringify(v.errors ?? [])

describe('CLI --json output matches schemas/output.schema.json', () => {
  it('expectations --json validates record for record', async () => {
    const cwd = await migrated()
    const made = await nostro(cwd, ['expect', 'INV-1042', '--account', A, '--amount', '25'])
    expect(made.code).toBe(0)
    const run = await nostro(cwd, ['expectations', '--json'])
    expect(run.code).toBe(0)
    const rows = JSON.parse(run.stdout) as unknown[]
    expect(rows).toHaveLength(1)
    const validate = list('expectation')
    expect(validate(rows), why(validate)).toBe(true)
  })

  it('expectations --jsonl gives one record per line, each valid', async () => {
    const cwd = await migrated()
    await nostro(cwd, ['expect', 'INV-1', '--account', A, '--amount', '1'])
    await nostro(cwd, ['expect', 'INV-2', '--account', A, '--amount', '2'])
    const run = await nostro(cwd, ['expectations', '--jsonl'])
    const records = run.stdout.trimEnd().split('\n').map((line) => JSON.parse(line) as unknown)
    expect(records).toHaveLength(2)
    const validate = one('expectation')
    for (const record of records) expect(validate(record), why(validate)).toBe(true)
  })

  it('exceptions --json validates (an empty list here; see the exceptions fixture tests)', async () => {
    const run = await nostro(await migrated(), ['exceptions', '--json'])
    expect(run.code).toBe(0)
    const validate = list('exception')
    expect(validate(JSON.parse(run.stdout)), why(validate)).toBe(true)
  })

  it('every error object a failing --json command prints validates', async () => {
    const cases = [
      ['exceptions', '--json', '--status', 'bogus'],
      ['exceptions', '--json'],
    ]
    const validate = one('error')
    for (const argv of cases) {
      const run = await nostro(workspace(), argv)
      expect(validate(JSON.parse(run.stderr)), `${argv.join(' ')}: ${why(validate)}`).toBe(true)
    }
  })

  it('rejects an expectation that is missing a required field', async () => {
    const cwd = await migrated()
    await nostro(cwd, ['expect', 'INV-9', '--account', A, '--amount', '9'])
    const [row] = JSON.parse((await nostro(cwd, ['expectations', '--json'])).stdout) as Record<string, unknown>[]
    const broken: Record<string, unknown> = { ...row }
    delete broken.paid
    expect(one('expectation')(broken)).toBe(false)
  })
})
