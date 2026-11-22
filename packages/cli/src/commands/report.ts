/**
 * `nostro report <kind> [options]`
 *
 * Supported sub-commands (issues #56 and #57):
 *   trial-balance   Per-account, per-asset totals and net balances
 *   ledger          Account ledger with opening balance and running total
 *   balance-sheet   Assets, liabilities, equity and current earnings
 *   income          Income and expense accounts for a period
 */
import {
  accountLedger,
  balanceSheet,
  incomeStatement,
  trialBalance,
  agingReport,
  costBasis,
  parseAsset,
  journalCsvCell,
  journalCsvRow,
} from '@nostro-labs/nostro'
import type { CostBasisMethod, AssetId } from '@nostro-labs/nostro'
import { COMMON, UsageError, date, flag, positionals, string, tenant } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, withStore } from '../command.js'
import { json, table, write } from '../io.js'

/** Format a bigint amount into a human-readable decimal string. */
function fmt(raw: bigint, decimals: number): string {
  const neg = raw < 0n
  const abs = neg ? -raw : raw
  if (decimals === 0) return `${neg ? '-' : ''}${abs}`
  const str = abs.toString().padStart(decimals + 1, '0')
  const whole = str.slice(0, str.length - decimals) || '0'
  const frac = str.slice(str.length - decimals)
  return `${neg ? '-' : ''}${whole}.${frac}`
}

function shortAsset(asset: string): string {
  if (asset === 'native') return 'XLM'
  const colon = asset.indexOf(':')
  return colon === -1 ? asset : asset.slice(0, colon)
}

export const report: Command = {
  name: 'report',
  summary: 'Trial balance, account ledger, balance sheet, income statement, aging, and gains',
  usage: '<trial-balance|ledger|balance-sheet|income|aging|gains> [options]',
  help: `Run accounting reports.

Subcommands:
  trial-balance        Per-account, per-asset totals and net balances as of --as-of
  ledger               Account ledger with running balance; requires --account and --asset
  balance-sheet        Assets, liabilities, equity + current earnings as of --as-of
  income               Income and expense accounts for a period
  aging                Aging of open expectations and unexplained money as of --as-of
  gains                Realised gains and open lots for a period (--from and --to)

Options:
  --as-of <date>       Balance as of this instant (trial-balance, balance-sheet, aging)
  --account <code>     Account code (ledger, gains)
  --asset <id>         Asset id, e.g. "native" or "USDC:GA5Z..." (ledger, gains)
  --entity <id>        Only lines belonging to this entity
  --from <date>        Period start, inclusive (ledger, income, gains)
  --to <date>          Period end, exclusive (ledger, income, gains)
  --buckets <n,n,...>  Aging bucket boundaries, comma-separated (default 30,60,90)
  --method <fifo|lifo> Cost basis lot matching method (default fifo)
  --csv                Output aging report as CSV
${COMMON_HELP}`,
  options: {
    ...COMMON,
    'as-of': { type: 'string' },
    account: { type: 'string' },
    asset: { type: 'string' },
    entity: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    buckets: { type: 'string' },
    method: { type: 'string' },
    csv: { type: 'boolean' },
  },
  async run(args, io) {
    const [sub] = positionals(args, 1)
    const tenantId = tenant(args, io)
    const isJson = flag(args, 'json')
    const entityId = string(args, 'entity')
    const entity = entityId === undefined ? {} : { entityId }

    if (sub === 'trial-balance') {
      const asOf = date(args, 'as-of')
      return withStore(args, io, async (store) => {
        const report = await trialBalance({ store, tenantId, ...(asOf !== undefined ? { asOf } : {}), ...entity })
        if (isJson) {
          await write(io.stdout, json({
            balanced: report.balanced,
            assetTotals: report.assetTotals.map(t => ({ asset: t.asset, net: t.net.toString() })),
            lines: report.lines.map(l => ({
              account: l.account,
              asset: l.asset,
              totalDebits: l.totalDebits.toString(),
              totalCredits: l.totalCredits.toString(),
              netBalance: l.netBalance.toString(),
            })),
          }))
        } else {
          const rows: string[][] = [['Account', 'Asset', 'Debits', 'Credits', 'Net']]
          for (const l of report.lines) {
            rows.push([
              l.account,
              shortAsset(l.asset),
              fmt(l.totalDebits, l.decimals),
              fmt(l.totalCredits, l.decimals),
              fmt(l.netBalance, l.decimals),
            ])
          }
          await write(io.stdout, table(rows))
          await write(io.stdout, `\nBalanced: ${report.balanced ? 'yes' : 'NO — entries do not balance'}\n`)
        }
        return report.balanced ? 0 : 1
      })
    }

    if (sub === 'ledger') {
      const account = string(args, 'account')
      const assetId = string(args, 'asset')
      if (account === undefined) throw new UsageError('ledger requires --account <code>.')
      if (assetId === undefined) throw new UsageError('ledger requires --asset <id>.')
      const from = date(args, 'from')
      const to = date(args, 'to')
      return withStore(args, io, async (store) => {
        const ledger = await accountLedger({ store, tenantId, account, asset: assetId, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }), ...entity })
        if (isJson) {
          await write(io.stdout, json({
            account: ledger.account,
            asset: ledger.asset,
            openingBalance: ledger.openingBalance.toString(),
            closingBalance: ledger.closingBalance.toString(),
            lines: ledger.lines.map(l => ({
              entryId: l.entryId,
              seq: l.seq,
              kind: l.kind,
              effectiveAt: l.effectiveAt.toISOString(),
              description: l.description,
              side: l.side,
              amount: l.amount.toString(),
              movementId: l.movementId,
              runningBalance: l.runningBalance.toString(),
            })),
          }))
        } else {
          const { decimals } = ledger.lines[0]?.amount ?? { decimals: 7 }
          await write(io.stdout, `Account: ${account}  Asset: ${shortAsset(assetId)}\n`)
          await write(io.stdout, `Opening balance: ${fmt(ledger.openingBalance, decimals)}\n\n`)
          const rows: string[][] = [['Date', 'Entry', 'Description', 'Dr', 'Cr', 'Balance']]
          for (const l of ledger.lines) {
            rows.push([
              l.effectiveAt.toISOString().slice(0, 10),
              l.entryId.slice(0, 8),
              l.description.slice(0, 40),
              l.side === 'debit' ? fmt(l.amount.raw, l.amount.decimals) : '',
              l.side === 'credit' ? fmt(l.amount.raw, l.amount.decimals) : '',
              fmt(l.runningBalance, l.amount.decimals),
            ])
          }
          await write(io.stdout, table(rows))
          await write(io.stdout, `\nClosing balance: ${fmt(ledger.closingBalance, decimals)}\n`)
        }
        return 0
      })
    }

    if (sub === 'balance-sheet') {
      const asOf = date(args, 'as-of')
      return withStore(args, io, async (store) => {
        const bs = await balanceSheet({ store, tenantId, ...(asOf !== undefined ? { asOf } : {}), ...entity })
        if (isJson) {
          await write(io.stdout, json({
            asOf: bs.asOf?.toISOString() ?? null,
            balanced: bs.balanced,
            currentEarnings: bs.currentEarnings.map(e => ({ asset: e.asset, amount: e.amount.toString() })),
            sections: bs.sections.map(s => ({
              kind: s.kind,
              accounts: s.accounts.map(a => ({ account: a.account, asset: a.asset, balance: a.balance.toString() })),
            })),
          }))
        } else {
          for (const section of bs.sections) {
            if (section.accounts.length === 0) continue
            await write(io.stdout, `\n=== ${section.kind.toUpperCase()} ===\n`)
            const rows = section.accounts.map(a => [a.account, shortAsset(a.asset), fmt(a.balance, a.decimals)])
            await write(io.stdout, table(rows))
          }
          if (bs.currentEarnings.length > 0) {
            await write(io.stdout, `\n=== CURRENT EARNINGS ===\n`)
            const rows = bs.currentEarnings.map(e => ['(net income)', shortAsset(e.asset), fmt(e.amount, e.decimals)])
            await write(io.stdout, table(rows))
          }
          await write(io.stdout, `\nBalanced: ${bs.balanced ? 'yes' : 'NO'}\n`)
        }
        return bs.balanced ? 0 : 1
      })
    }

    if (sub === 'income') {
      const from = date(args, 'from')
      const to = date(args, 'to')
      return withStore(args, io, async (store) => {
        const stmt = await incomeStatement({ store, tenantId, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }), ...entity })
        if (isJson) {
          await write(io.stdout, json({
            from: stmt.from?.toISOString() ?? null,
            to: stmt.to?.toISOString() ?? null,
            netResult: stmt.netResult.map(r => ({ asset: r.asset, amount: r.amount.toString() })),
            lines: stmt.lines.map(l => ({
              account: l.account,
              kind: l.kind,
              asset: l.asset,
              amount: l.amount.toString(),
            })),
          }))
        } else {
          await write(io.stdout, `\n=== INCOME ===\n`)
          const income = stmt.lines.filter(l => l.kind === 'income')
          if (income.length > 0) await write(io.stdout, table(income.map(l => [l.account, shortAsset(l.asset), fmt(l.amount, l.decimals)])))
          await write(io.stdout, `\n=== EXPENSES ===\n`)
          const expenses = stmt.lines.filter(l => l.kind === 'expense')
          if (expenses.length > 0) await write(io.stdout, table(expenses.map(l => [l.account, shortAsset(l.asset), fmt(l.amount, l.decimals)])))
          await write(io.stdout, `\n=== NET RESULT ===\n`)
          if (stmt.netResult.length > 0) await write(io.stdout, table(stmt.netResult.map(r => [shortAsset(r.asset), fmt(r.amount, r.decimals)])))
        }
        return 0
      })
    }

    if (sub === 'aging') {
      const asOf = date(args, 'as-of')
      const bucketsArg = string(args, 'buckets')
      const buckets = bucketsArg !== undefined
        ? bucketsArg.split(',').map((s) => { const n = parseInt(s.trim(), 10); if (isNaN(n)) throw new UsageError(`--buckets: ${s} is not an integer`); return n })
        : undefined
      const isCsv = flag(args, 'csv')
      return withStore(args, io, async (store) => {
        const report = await agingReport({
          store,
          tenantId,
          ...(asOf !== undefined ? { asOf } : {}),
          ...(buckets !== undefined ? { buckets } : {}),
          ...entity,
        })
        if (isJson) {
          await write(io.stdout, json({
            tenantId: report.tenantId,
            asOf: report.asOf.toISOString(),
            buckets: [...report.buckets],
            receivables: {
              items: report.receivables.items.map((i) => ({
                expectationId: i.expectationId,
                reference: i.reference,
                account: i.account,
                direction: i.direction,
                asset: i.asset,
                originalAmount: i.originalAmount.toString(),
                remainingAmount: i.remainingAmount.toString(),
                dueAt: i.dueAt?.toISOString() ?? null,
                daysPastDue: i.daysPastDue,
                bucket: i.bucket,
              })),
              byAsset: report.receivables.byAsset.map((a) => ({
                asset: a.asset,
                totalRemaining: a.totalRemaining.toString(),
                buckets: a.buckets.map((b) => ({ bucket: b.bucket, count: b.count, total: b.total.toString() })),
              })),
            },
            payables: {
              items: report.payables.items.map((i) => ({
                expectationId: i.expectationId,
                reference: i.reference,
                account: i.account,
                direction: i.direction,
                asset: i.asset,
                originalAmount: i.originalAmount.toString(),
                remainingAmount: i.remainingAmount.toString(),
                dueAt: i.dueAt?.toISOString() ?? null,
                daysPastDue: i.daysPastDue,
                bucket: i.bucket,
              })),
              byAsset: report.payables.byAsset.map((a) => ({
                asset: a.asset,
                totalRemaining: a.totalRemaining.toString(),
                buckets: a.buckets.map((b) => ({ bucket: b.bucket, count: b.count, total: b.total.toString() })),
              })),
            },
            unexplainedMoney: {
              items: report.unexplainedMoney.items.map((i) => ({
                movementId: i.movementId,
                occurredAt: i.occurredAt.toISOString(),
                account: i.account,
                role: i.role,
                asset: i.asset,
                amount: i.amount.toString(),
                daysSinceMovement: i.daysSinceMovement,
                bucket: i.bucket,
                exceptionCode: i.exceptionCode,
              })),
              byRoleAndAsset: report.unexplainedMoney.byRoleAndAsset.map((g) => ({
                role: g.role,
                asset: g.asset,
                total: g.total.toString(),
                buckets: g.buckets.map((b) => ({ bucket: b.bucket, count: b.count, total: b.total.toString() })),
              })),
            },
          }))
        } else if (isCsv) {
          // CSV for unexplained money
          const header = journalCsvRow([
            journalCsvCell('type'),
            journalCsvCell('expectation_id'),
            journalCsvCell('reference'),
            journalCsvCell('movement_id'),
            journalCsvCell('account'),
            journalCsvCell('direction_or_role'),
            journalCsvCell('asset'),
            journalCsvCell('original_amount'),
            journalCsvCell('remaining_amount'),
            journalCsvCell('due_at'),
            journalCsvCell('days_past_due'),
            journalCsvCell('bucket'),
            journalCsvCell('exception_code'),
          ])
          await write(io.stdout, header)
          for (const item of report.receivables.items) {
            await write(io.stdout, journalCsvRow([
              journalCsvCell('receivable'),
              journalCsvCell(item.expectationId),
              journalCsvCell(item.reference, true),
              journalCsvCell(null),
              journalCsvCell(item.account),
              journalCsvCell(item.direction),
              journalCsvCell(shortAsset(item.asset)),
              journalCsvCell(fmt(item.originalAmount.raw, item.originalAmount.decimals)),
              journalCsvCell(fmt(item.remainingAmount.raw, item.remainingAmount.decimals)),
              journalCsvCell(item.dueAt?.toISOString().slice(0, 10) ?? null),
              journalCsvCell(item.daysPastDue),
              journalCsvCell(item.bucket),
              journalCsvCell(null),
            ]))
          }
          for (const item of report.payables.items) {
            await write(io.stdout, journalCsvRow([
              journalCsvCell('payable'),
              journalCsvCell(item.expectationId),
              journalCsvCell(item.reference, true),
              journalCsvCell(null),
              journalCsvCell(item.account),
              journalCsvCell(item.direction),
              journalCsvCell(shortAsset(item.asset)),
              journalCsvCell(fmt(item.originalAmount.raw, item.originalAmount.decimals)),
              journalCsvCell(fmt(item.remainingAmount.raw, item.remainingAmount.decimals)),
              journalCsvCell(item.dueAt?.toISOString().slice(0, 10) ?? null),
              journalCsvCell(item.daysPastDue),
              journalCsvCell(item.bucket),
              journalCsvCell(null),
            ]))
          }
          for (const item of report.unexplainedMoney.items) {
            await write(io.stdout, journalCsvRow([
              journalCsvCell('unexplained'),
              journalCsvCell(null),
              journalCsvCell(null),
              journalCsvCell(item.movementId),
              journalCsvCell(item.account),
              journalCsvCell(item.role),
              journalCsvCell(shortAsset(item.asset)),
              journalCsvCell(fmt(item.amount.raw, item.amount.decimals)),
              journalCsvCell(fmt(item.amount.raw, item.amount.decimals)),
              journalCsvCell(item.occurredAt.toISOString().slice(0, 10)),
              journalCsvCell(item.daysSinceMovement),
              journalCsvCell(item.bucket),
              journalCsvCell(item.exceptionCode),
            ]))
          }
        } else {
          await write(io.stdout, `\nAging report as of ${report.asOf.toISOString().slice(0, 10)}\n`)
          if (report.receivables.items.length > 0) {
            await write(io.stdout, `\n=== RECEIVABLES ===\n`)
            for (const a of report.receivables.byAsset) {
              await write(io.stdout, `\n${shortAsset(a.asset)}  Total remaining: ${fmt(a.totalRemaining.raw, a.totalRemaining.decimals)}\n`)
              const rows: string[][] = [['Bucket', 'Count', 'Total']]
              for (const b of a.buckets) {
                if (b.count > 0) rows.push([b.bucket, String(b.count), fmt(b.total.raw, b.total.decimals)])
              }
              await write(io.stdout, table(rows))
            }
          } else {
            await write(io.stdout, '\nNo open receivables.\n')
          }
          if (report.payables.items.length > 0) {
            await write(io.stdout, `\n=== PAYABLES ===\n`)
            for (const a of report.payables.byAsset) {
              await write(io.stdout, `\n${shortAsset(a.asset)}  Total remaining: ${fmt(a.totalRemaining.raw, a.totalRemaining.decimals)}\n`)
              const rows: string[][] = [['Bucket', 'Count', 'Total']]
              for (const b of a.buckets) {
                if (b.count > 0) rows.push([b.bucket, String(b.count), fmt(b.total.raw, b.total.decimals)])
              }
              await write(io.stdout, table(rows))
            }
          } else {
            await write(io.stdout, '\nNo open payables.\n')
          }
          if (report.unexplainedMoney.items.length > 0) {
            await write(io.stdout, `\n=== UNEXPLAINED MONEY ===\n`)
            const rows: string[][] = [['Role', 'Asset', 'Bucket', 'Count', 'Total']]
            for (const g of report.unexplainedMoney.byRoleAndAsset) {
              for (const b of g.buckets) {
                if (b.count > 0) rows.push([g.role, shortAsset(g.asset), b.bucket, String(b.count), fmt(b.total.raw, b.total.decimals)])
              }
            }
            await write(io.stdout, table(rows))
          } else {
            await write(io.stdout, '\nNo unexplained money.\n')
          }
        }
        return 0
      })
    }

    if (sub === 'gains') {
      const assetIdStr = string(args, 'asset')
      if (assetIdStr === undefined) throw new UsageError('gains requires --asset <id>.')
      const assetId = parseAsset(assetIdStr) as AssetId
      const account = string(args, 'account')
      const from = date(args, 'from')
      const to = date(args, 'to')
      const methodArg = string(args, 'method')
      const method = (methodArg === 'lifo' ? 'lifo' : 'fifo') as CostBasisMethod
      return withStore(args, io, async (store) => {
        const report = await costBasis({
          store,
          tenantId,
          asset: assetId,
          method,
          ...(account !== undefined ? { account } : {}),
          ...(from !== undefined ? { from } : {}),
          ...(to !== undefined ? { to } : {}),
          ...entity,
        })
        if (isJson) {
          await write(io.stdout, json({
            tenantId: report.tenantId,
            asset: report.asset,
            reportingAsset: report.reportingAsset,
            method: report.method,
            from: report.from?.toISOString() ?? null,
            to: report.to?.toISOString() ?? null,
            realizedGain: report.realizedGain?.toString() ?? null,
            totalProceeds: report.totalProceeds?.toString() ?? null,
            totalCost: report.totalCost.toString(),
            unvaluedCredits: report.unvaluedCredits.length,
            openLots: report.openLots.map((l) => ({
              movementId: l.movementId,
              occurredAt: l.occurredAt.toISOString(),
              account: l.account,
              remainingAmount: l.remainingAmount.toString(),
              remainingCost: l.remainingCost.toString(),
            })),
            disposals: report.disposals.map((d) => ({
              movementId: d.movementId,
              occurredAt: d.occurredAt.toISOString(),
              account: d.account,
              amount: d.amount.toString(),
              proceeds: d.proceeds?.toString() ?? null,
              cost: d.cost.toString(),
              gain: d.gain?.toString() ?? null,
            })),
          }))
        } else {
          await write(io.stdout, `\nRealised gains: ${shortAsset(report.asset)} (${report.method.toUpperCase()}) → ${shortAsset(report.reportingAsset)}\n`)
          if (report.from || report.to) {
            await write(io.stdout, `Period: ${report.from?.toISOString().slice(0, 10) ?? '(all)'} – ${report.to?.toISOString().slice(0, 10) ?? '(present)'}\n`)
          }
          if (report.disposals.length > 0) {
            await write(io.stdout, `\n=== DISPOSALS ===\n`)
            const rows: string[][] = [['Date', 'Movement', 'Amount', 'Proceeds', 'Cost', 'Gain/Loss']]
            for (const d of report.disposals) {
              rows.push([
                d.occurredAt.toISOString().slice(0, 10),
                d.movementId.slice(0, 8),
                fmt(d.amount.raw, d.amount.decimals),
                d.proceeds !== null ? fmt(d.proceeds.raw, d.proceeds.decimals) : '—',
                fmt(d.cost.raw, d.cost.decimals),
                d.gain !== null ? fmt(d.gain.raw, d.gain.decimals) : '—',
              ])
            }
            await write(io.stdout, table(rows))
            const { totalProceeds, totalCost, realizedGain } = report
            await write(io.stdout, `\nTotal proceeds: ${totalProceeds !== null ? fmt(totalProceeds.raw, totalProceeds.decimals) : '—'}\n`)
            await write(io.stdout, `Total cost:     ${fmt(totalCost.raw, totalCost.decimals)}\n`)
            await write(io.stdout, `Realised gain:  ${realizedGain !== null ? fmt(realizedGain.raw, realizedGain.decimals) : '—'}\n`)
          } else {
            await write(io.stdout, '\nNo disposals in period.\n')
          }
          if (report.openLots.length > 0) {
            await write(io.stdout, `\n=== OPEN LOTS ===\n`)
            const rows: string[][] = [['Opened', 'Movement', 'Remaining', 'Cost']]
            for (const l of report.openLots) {
              rows.push([
                l.occurredAt.toISOString().slice(0, 10),
                l.movementId.slice(0, 8),
                fmt(l.remainingAmount.raw, l.remainingAmount.decimals),
                fmt(l.remainingCost.raw, l.remainingCost.decimals),
              ])
            }
            await write(io.stdout, table(rows))
          }
          if (report.unvaluedCredits.length > 0) {
            await write(io.stdout, `\nNote: ${report.unvaluedCredits.length} credit(s) had no valuation and could not open a lot.\n`)
            await write(io.stdout, `Run "nostro value" to fetch prices, then re-run this report.\n`)
          }
          await write(io.stdout, `\nThis report is bookkeeping only — not tax advice. Local tax rules differ.\n`)
        }
        return 0
      })
    }

    throw new UsageError(`Unknown report type ${JSON.stringify(sub)}. Use trial-balance, ledger, balance-sheet, income, aging or gains.`)
  },
}
