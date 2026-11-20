/**
 * The OpenAPI 3.1 document for the API, built from the same schemas the
 * server validates requests with. Served at `GET /v1/openapi.json`.
 */
import { readFileSync } from 'node:fs'
import { components, expectationBody, query, ref, resolveBody } from './schemas.js'

/** This package's version, which is the API's. */
const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ref('Problem') } },
})

const ok = (schemaName: string, description = 'OK') => ({
  description,
  content: { 'application/json': { schema: ref(schemaName) } },
})

const errors = {
  '400': problem('The request was malformed: an unknown or invalid parameter or field (`invalid_request`).'),
  '401': problem('No valid API key (`unauthorized`).'),
  '500': problem('Something failed inside the server (`internal`); the detail says nothing more.'),
}

/** Each property of a querystring schema, as an OpenAPI query parameter. */
function parameters(schema: { properties: Record<string, object> }) {
  return Object.entries(schema.properties).map(([name, s]) => ({ name, in: 'query', required: false, schema: s }))
}

const idParam = (what: string) => ({ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: `The ${what}'s id.` })

export function buildOpenApi() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'nostro',
      version: VERSION,
      summary: 'Payment reconciliation and ledger-to-accounting for Stellar.',
      description:
        'Every amount is an exact decimal string beside its asset, never a JSON number, in both directions. ' +
        'Lists page by `seq`: pass a response\'s `next` back as `after`. Errors are RFC 9457 problem details with a stable `code`.',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    security: [{ apiKey: [] }],
    paths: {
      '/v1/health': {
        get: {
          operationId: 'health',
          summary: 'Liveness',
          security: [],
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'object', required: ['ok'], properties: { ok: { const: true } } } } },
            },
          },
        },
      },
      '/v1/openapi.json': {
        get: {
          operationId: 'openapi',
          summary: 'This document',
          security: [],
          responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/v1/movements': {
        get: {
          operationId: 'listMovements',
          summary: 'Movements, in ingest order',
          parameters: parameters(query.movements),
          responses: { '200': ok('MovementPage'), ...errors },
        },
      },
      '/v1/movements/{id}': {
        get: {
          operationId: 'getMovement',
          summary: 'One movement, with its allocations, exceptions and journal entries',
          parameters: [idParam('movement')],
          responses: { '200': ok('MovementDetail'), '404': problem('No such movement in this tenant (`not_found`).'), ...errors },
        },
      },
      '/v1/expectations': {
        get: {
          operationId: 'listExpectations',
          summary: 'Expectations, in creation order',
          parameters: parameters(query.expectations),
          responses: { '200': ok('ExpectationPage'), ...errors },
        },
        post: {
          operationId: 'createExpectation',
          summary: 'Record what you are owed, or will pay',
          requestBody: { required: true, content: { 'application/json': { schema: expectationBody } } },
          responses: {
            '201': {
              ...ok('Expectation', 'Recorded'),
              headers: { Location: { description: 'Where it can be read back.', schema: { type: 'string' } } },
            },
            '409': problem('The reference or muxed id is already used in this tenant (`reference_taken`, `muxed_id_taken`).'),
            '422': problem('Well formed but not recordable exactly, e.g. more decimals than the asset has (`invalid_expectation`).'),
            ...errors,
          },
        },
      },
      '/v1/expectations/{id}': {
        get: {
          operationId: 'getExpectation',
          summary: 'One expectation, with what has been allocated to it',
          parameters: [idParam('expectation')],
          responses: { '200': ok('ExpectationDetail'), '404': problem('No such expectation in this tenant (`not_found`).'), ...errors },
        },
      },
      '/v1/expectations/{id}/cancel': {
        post: {
          operationId: 'cancelExpectation',
          summary: 'Cancel an open expectation with no allocations',
          parameters: [idParam('expectation')],
          requestBody: { required: true, content: { 'application/json': { schema: ref('CancelExpectationBody') } } },
          responses: {
            '200': ok('Expectation'),
            '404': problem('No such expectation in this tenant (`not_found`).'),
            '409': problem('Cannot be cancelled in its current state (`expectation_conflict`).'),
            '422': problem('The cancellation is not valid (`invalid_expectation`).'),
            ...errors,
          },
        },
      },
      '/v1/expectations/{id}/amend': {
        post: {
          operationId: 'amendExpectation',
          summary: 'Change an open or part-paid expectation',
          parameters: [idParam('expectation')],
          requestBody: { required: true, content: { 'application/json': { schema: ref('AmendExpectationBody') } } },
          responses: {
            '200': ok('Expectation'),
            '404': problem('No such expectation in this tenant (`not_found`).'),
            '409': problem('The amendment is refused (`expectation_conflict` or `muxed_id_taken`).'),
            '422': problem('The amendment is not valid (`invalid_expectation`).'),
            ...errors,
          },
        },
      },
      '/v1/exceptions': {
        get: {
          operationId: 'listExceptions',
          summary: 'Exceptions, in the order they were opened',
          parameters: parameters(query.exceptions),
          responses: { '200': ok('ExceptionPage'), ...errors },
        },
      },
      '/v1/exceptions/{id}/resolve': {
        post: {
          operationId: 'resolveException',
          summary: 'Decide an exception: apply its movement to invoices, ignore it, or close the exception',
          description:
            'In one transaction with its journal adjustment. Whatever an application leaves over stays open, under an exception for exactly that amount.',
          parameters: [idParam('exception')],
          requestBody: { required: true, content: { 'application/json': { schema: resolveBody } } },
          responses: {
            '200': ok('Resolution'),
            '404': problem('No such exception in this tenant (`not_found`).'),
            '409': problem('The rules refuse it: a lookalike asset, too much, a movement already decided (`resolution_refused`).'),
            '422': problem('It cannot be carried out as asked: an unknown reference, or more decimals than the asset has (`invalid_resolution`).'),
            ...errors,
          },
        },
      },
      '/v1/events': {
        get: {
          operationId: 'listEvents',
          summary: 'The event log, the same events webhooks deliver',
          parameters: parameters(query.events),
          responses: { '200': ok('EventPage'), ...errors },
        },
      },
      '/v1/journal': {
        get: {
          operationId: 'listJournalEntries',
          summary: 'Journal entries, in posting order',
          parameters: parameters(query.journal),
          responses: { '200': ok('JournalEntryPage'), ...errors },
        },
      },
      '/v1/journal.csv': {
        get: {
          operationId: 'exportJournal',
          summary: 'The journal as CSV (RFC 4180), one row per line, streamed',
          parameters: parameters(query.journalCsv),
          responses: { '200': { description: 'CSV', content: { 'text/csv': { schema: { type: 'string' } } } }, ...errors },
        },
      },
      '/v1/reports/trial-balance': {
        get: {
          operationId: 'trialBalance',
          summary: 'Trial balance: per-account, per-asset totals and net balances',
          description:
            'Totals debits, credits and the net balance per account and asset as of an instant. ' +
            'The `balanced` flag is `true` when every asset balances across all accounts.',
          parameters: [
            { name: 'asOf', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Balance as of this instant; omit for all-time.' },
          ],
          responses: { '200': ok('TrialBalanceReport'), ...errors },
        },
      },
      '/v1/reports/ledger': {
        get: {
          operationId: 'accountLedger',
          summary: 'Account ledger with opening balance and running total',
          description: 'Lists every line posted to an account for a given asset, with a running balance after each line.',
          parameters: [
            { name: 'account', in: 'query', required: true, schema: { type: 'string' }, description: 'Account code.' },
            { name: 'asset', in: 'query', required: true, schema: { type: 'string' }, description: 'Asset id, e.g. "native" or "USDC:GA5Z...".' },
            { name: 'from', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Range start (inclusive).' },
            { name: 'to', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Range end (exclusive).' },
          ],
          responses: { '200': ok('AccountLedgerReport'), ...errors },
        },
      },
      '/v1/reports/balance-sheet': {
        get: {
          operationId: 'balanceSheet',
          summary: 'Balance sheet: assets, liabilities, equity and current earnings',
          description:
            'Groups accounts by kind and adds a computed current-earnings line. ' +
            'One column per asset — no cross-asset arithmetic. ' +
            '`receivable` and `payable` normally run credit balances inside nostro; see docs/journal.md.',
          parameters: [
            { name: 'asOf', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Balance as of this instant; omit for all-time.' },
          ],
          responses: { '200': ok('BalanceSheetReport'), ...errors },
        },
      },
      '/v1/reports/income': {
        get: {
          operationId: 'incomeStatement',
          summary: 'Income statement for a period',
          description: 'Lists income and expense accounts and computes a net result per asset.',
          parameters: [
            { name: 'from', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Period start (inclusive).' },
            { name: 'to', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Period end (exclusive).' },
          ],
          responses: { '200': ok('IncomeStatementReport'), ...errors },
        },
      },
      '/v1/chart/move': {
        post: {
          operationId: 'moveAccount',
          summary: 'Move all balances from one account code to another',
          description:
            'Posts one manual journal entry per affected asset that zeroes `from` and credits `to`. ' +
            'Cash accounts (`assets:stellar:*`) are refused. ' +
            'If `from` already has a zero balance, nothing is posted and `moved` is 0.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['from', 'to'],
                  properties: {
                    from: { type: 'string', description: 'Source account code.' },
                    to: { type: 'string', description: 'Destination account code.' },
                    note: { type: 'string', description: 'Entry description.' },
                    effectiveAt: { type: 'string', format: 'date-time', description: 'Date the entry is posted; defaults to now.' },
                  },
                },
              },
            },
          },
          responses: {
            '200': ok('MoveAccountResult'),
            '409': problem('The effective date falls inside a closed accounting period (`resolution_refused`).'),
            '422': problem('`from` is a cash account (`invalid_request`).'),
            ...errors,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', description: 'An API key; it decides the tenant.' },
      },
      schemas: {
        ...components,
        TrialBalanceLine: {
          type: 'object',
          required: ['account', 'asset', 'totalDebits', 'totalCredits', 'netBalance'],
          properties: {
            account: { type: 'string' },
            asset: { type: 'string' },
            totalDebits: { type: 'string', description: 'Decimal string.' },
            totalCredits: { type: 'string', description: 'Decimal string.' },
            netBalance: { type: 'string', description: 'Signed decimal string; positive = debit balance.' },
          },
        },
        TrialBalanceReport: {
          type: 'object',
          required: ['balanced', 'assetTotals', 'lines'],
          properties: {
            balanced: { type: 'boolean' },
            assetTotals: {
              type: 'array',
              items: {
                type: 'object',
                required: ['asset', 'net'],
                properties: { asset: { type: 'string' }, net: { type: 'string' } },
              },
            },
            lines: { type: 'array', items: { $ref: '#/components/schemas/TrialBalanceLine' } },
          },
        },
        AccountLedgerLine: {
          type: 'object',
          required: ['entryId', 'seq', 'kind', 'effectiveAt', 'postedAt', 'description', 'side', 'amount', 'asset', 'movementId', 'runningBalance'],
          properties: {
            entryId: { type: 'string' },
            seq: { type: 'integer' },
            kind: { type: 'string' },
            effectiveAt: { type: 'string', format: 'date-time' },
            postedAt: { type: 'string', format: 'date-time' },
            description: { type: 'string' },
            side: { enum: ['debit', 'credit'] },
            amount: { type: 'string' },
            asset: { type: 'string' },
            movementId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            runningBalance: { type: 'string', description: 'Signed decimal string; positive = debit balance.' },
          },
        },
        AccountLedgerReport: {
          type: 'object',
          required: ['account', 'asset', 'openingBalance', 'closingBalance', 'lines'],
          properties: {
            account: { type: 'string' },
            asset: { type: 'string' },
            openingBalance: { type: 'string' },
            closingBalance: { type: 'string' },
            lines: { type: 'array', items: { $ref: '#/components/schemas/AccountLedgerLine' } },
          },
        },
        BalanceSheetSection: {
          type: 'object',
          required: ['kind', 'accounts'],
          properties: {
            kind: { enum: ['asset', 'liability', 'equity'] },
            accounts: {
              type: 'array',
              items: {
                type: 'object',
                required: ['account', 'asset', 'balance'],
                properties: { account: { type: 'string' }, asset: { type: 'string' }, balance: { type: 'string' } },
              },
            },
          },
        },
        BalanceSheetReport: {
          type: 'object',
          required: ['asOf', 'balanced', 'currentEarnings', 'sections'],
          properties: {
            asOf: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
            balanced: { type: 'boolean' },
            currentEarnings: {
              type: 'array',
              items: {
                type: 'object',
                required: ['asset', 'amount'],
                properties: { asset: { type: 'string' }, amount: { type: 'string' } },
              },
            },
            sections: { type: 'array', items: { $ref: '#/components/schemas/BalanceSheetSection' } },
          },
        },
        IncomeStatementLine: {
          type: 'object',
          required: ['account', 'kind', 'asset', 'amount'],
          properties: {
            account: { type: 'string' },
            kind: { enum: ['income', 'expense'] },
            asset: { type: 'string' },
            amount: { type: 'string', description: 'Positive = net income / net expense.' },
          },
        },
        IncomeStatementReport: {
          type: 'object',
          required: ['from', 'to', 'lines', 'netResult'],
          properties: {
            from: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
            to: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
            lines: { type: 'array', items: { $ref: '#/components/schemas/IncomeStatementLine' } },
            netResult: {
              type: 'array',
              items: {
                type: 'object',
                required: ['asset', 'amount'],
                properties: { asset: { type: 'string' }, amount: { type: 'string', description: 'Positive = profit.' } },
              },
            },
          },
        },
        MoveAccountResult: {
          type: 'object',
          required: ['moved', 'assets'],
          properties: {
            moved: { type: 'integer', description: 'Number of journal entries posted (one per asset).' },
            assets: { type: 'array', items: { type: 'string' }, description: 'Assets that had balances moved.' },
          },
        },
      },
    },
  }
}
