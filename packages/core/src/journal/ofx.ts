import { createHash } from 'node:crypto'
import type { AssetId } from '../money/index.js'
import { Money, NATIVE, STROOP_DECIMALS } from '../money/index.js'
import type { JournalEntry, JournalLine } from '../model/index.js'
import { ValidationError } from '../model/index.js'
import type { Store } from '../store/index.js'

export interface WalletStatementOptions {
  readonly store: Store
  readonly tenantId: string
  readonly account: string
  readonly asset: AssetId
  readonly entityId?: string
  readonly from: Date
  readonly to: Date
  readonly currencyCode?: string
  readonly pageSize?: number
}

export interface WalletStatementLine {
  readonly id: string
  readonly effectiveAt: Date
  readonly amount: Money
  readonly direction: 'credit' | 'debit'
  readonly counterparty: string | null
  readonly txHash: string | null
  readonly expectationReference: string | null
  readonly description: string
}

export interface WalletStatement {
  readonly account: string
  readonly asset: AssetId
  readonly currencyCode: string
  readonly from: Date
  readonly to: Date
  readonly openingBalance: Money
  readonly closingBalance: Money
  readonly lines: readonly WalletStatementLine[]
}

export function isIso4217(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: code })
    const intlWithValues = Intl as typeof Intl & {
      supportedValuesOf?: (key: 'currency') => readonly string[]
    }
    const supported = intlWithValues.supportedValuesOf?.('currency')
    return supported === undefined || supported.includes(code)
  } catch {
    return false
  }
}

function resolveCurrencyCode(assetId: AssetId, supplied: string | undefined): string {
  if (supplied !== undefined) {
    if (!isIso4217(supplied)) {
      throw new ValidationError('currencyCode', `must be an ISO 4217 currency code, got ${JSON.stringify(supplied)}`)
    }
    return supplied
  }
  const separator = assetId.indexOf(':')
  const code = separator === -1 ? assetId : assetId.slice(0, separator)
  const issuer = separator === -1 ? null : assetId.slice(separator + 1)
  const inferred = assetId !== NATIVE && issuer === null && isIso4217(code) ? code : null
  if (inferred === null) {
    throw new ValidationError('currencyCode', `is required for asset ${assetId}`)
  }
  return inferred
}

function fitId(tenantId: string, account: string, assetId: AssetId, entryId: string, lineNo: number): string {
  return createHash('sha256')
    .update([tenantId, account, assetId, entryId, String(lineNo)].join('\u0000'))
    .digest('hex')
}

export async function walletStatement(options: WalletStatementOptions): Promise<WalletStatement> {
  const currencyCode = resolveCurrencyCode(options.asset, options.currencyCode)
  const pageSize = options.pageSize ?? 500
  let afterSeq: number | undefined
  let decimals = STROOP_DECIMALS
  let decimalsKnown = false
  let openingRaw = 0n
  let rangeRaw = 0n
  const lines: WalletStatementLine[] = []

  for (;;) {
    const page = await options.store.listJournalEntries({
      tenantId: options.tenantId,
      ...(options.entityId === undefined ? {} : { entityId: options.entityId }),
      limit: pageSize,
      ...(afterSeq === undefined ? {} : { afterSeq }),
      effectiveBefore: options.to,
    })
    if (page.length === 0) break
    afterSeq = page[page.length - 1]!.seq

    const selected: { readonly entry: JournalEntry; readonly line: JournalLine; readonly lineNo: number; readonly amount: Money }[] = []
    for (const entry of page) {
      for (const [index, line] of entry.lines.entries()) {
        if (options.entityId !== undefined && line.entityId !== options.entityId) continue
        if (line.role !== 'cash' || line.account !== options.account || line.amount.asset !== options.asset) continue
        if (decimalsKnown && line.amount.decimals !== decimals) {
          throw new ValidationError('asset', `has mixed decimals for ${options.asset}`)
        }
        if (!decimalsKnown) {
          decimals = line.amount.decimals
          decimalsKnown = true
        }
        const amount = line.side === 'debit' ? line.amount : line.amount.negate()
        if (entry.effectiveAt < options.from) openingRaw += amount.raw
        else {
          rangeRaw += amount.raw
          selected.push({ entry, line, lineNo: index + 1, amount })
        }
      }
    }

    const movementIds = [...new Set(selected.flatMap(({ entry }) => entry.movementId === null ? [] : [entry.movementId]))]
    const expectationIds = [...new Set(selected.flatMap(({ line }) => line.expectationId === null ? [] : [line.expectationId]))]
    const [movements, expectations] = await Promise.all([
      options.store.listMovements({ tenantId: options.tenantId, ids: movementIds }),
      options.store.listExpectations({ tenantId: options.tenantId, ids: expectationIds }),
    ])
    const txHashes = new Map(movements.map((movement) => [movement.id, movement.txHash]))
    const counterparties = new Map(movements.map((movement) => [movement.id, movement.counterparty]))
    const references = new Map(expectations.map((expectation) => [expectation.id, expectation.reference]))

    for (const { entry, line, lineNo, amount } of selected) {
      const txHash = entry.movementId === null ? null : (txHashes.get(entry.movementId) ?? null)
      lines.push({
        id: fitId(options.tenantId, options.account, options.asset, entry.id, lineNo),
        effectiveAt: entry.effectiveAt,
        amount,
        direction: amount.raw > 0n ? 'credit' : 'debit',
        counterparty: entry.movementId === null ? null : (counterparties.get(entry.movementId) ?? null),
        txHash,
        expectationReference: line.expectationId === null ? null : (references.get(line.expectationId) ?? null),
        description: entry.description,
      })
    }

    if (page.length < pageSize) break
  }

  const openingBalance = Money.fromRaw(openingRaw, options.asset, decimals)
  return {
    account: options.account,
    asset: options.asset,
    currencyCode,
    from: options.from,
    to: options.to,
    openingBalance,
    closingBalance: Money.fromRaw(openingRaw + rangeRaw, options.asset, decimals),
    lines,
  }
}

function ofxDate(date: Date): string {
  const iso = date.toISOString()
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}.${iso.slice(20, 23)}`
}

function cdata(text: string): string {
  return `<![CDATA[${text.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`
}

export function renderOfx(statement: WalletStatement): string {
  const rows: string[] = [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    'VERSION:202',
    'SECURITY:NONE',
    'ENCODING:UTF-8',
    'COMPRESSION:NONE',
    'OLDFILEUID:NONE',
    'NEWFILEUID:NONE',
    '',
    '<OFX>',
    '<SIGNONMSGSRSV1>',
    '<SONRS>',
    '<STATUS>',
    '<CODE>0',
    '<SEVERITY>INFO',
    '</STATUS>',
    `<DTSERVER>${ofxDate(statement.to)}`,
    '<LANGUAGE>ENG',
    '</SONRS>',
    '</SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1>',
    '<STMTTRNRS>',
    '<TRNUID>1',
    '<STATUS>',
    '<CODE>0',
    '<SEVERITY>INFO',
    '</STATUS>',
    '<STMTRS>',
    `<CURDEF>${statement.currencyCode}`,
    '<BANKACCTFROM>',
    '<BANKID>NOSTRO',
    `<ACCTID>${statement.account}`,
    '<ACCTTYPE>CHECKING',
    '</BANKACCTFROM>',
    '<BANKTRANLIST>',
    `<DTSTART>${ofxDate(statement.from)}`,
    `<DTEND>${ofxDate(statement.to)}`,
  ]

  for (const line of statement.lines) {
    const checkNumber = line.txHash ?? line.expectationReference
    rows.push(
      '<STMTTRN>',
      `<TRNTYPE>${line.amount.raw >= 0n ? 'CREDIT' : 'DEBIT'}`,
      `<DTPOSTED>${ofxDate(line.effectiveAt)}`,
      `<TRNAMT>${line.amount.toString()}`,
      `<FITID>${line.id}`,
    )
    if (checkNumber !== null) rows.push(`<CHECKNUM>${checkNumber}`)
    rows.push(`<NAME>${cdata(line.counterparty ?? 'NOSTRO')}`, `<MEMO>${cdata(line.description)}`, '</STMTTRN>')
  }

  rows.push(
    '</BANKTRANLIST>',
    '<LEDGERBAL>',
    `<BALAMT>${statement.closingBalance.toString()}`,
    `<BALDT>${ofxDate(statement.to)}`,
    '</LEDGERBAL>',
    '</STMTRS>',
    '</STMTTRNRS>',
    '</BANKMSGSRSV1>',
    '</OFX>',
  )
  return `${rows.join('\r\n')}\r\n`
}
