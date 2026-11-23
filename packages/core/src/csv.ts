export const FORMULA = /^[=+\-@\t\r]/

export function csvCell(value: string | number | bigint | null, text = false): string {
  if (value === null) return ''
  let s = String(value)
  if (text && FORMULA.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

export const csvRow = (cells: readonly string[]) => `${cells.join(',')}\r\n`
