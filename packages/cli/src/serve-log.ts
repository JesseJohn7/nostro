import { redact } from './store.js'

/** How `nostro serve` writes a log record: readable text for a terminal, or one JSON object per line. */
export type LogFormat = 'text' | 'json'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogRecord {
  readonly level: LogLevel
  readonly msg: string
  readonly time?: Date
  /** Stable, machine-readable fields (tenant, account, stream, eventId, ...). */
  readonly fields?: Readonly<Record<string, unknown>>
}

const MASK = '***'

/** URLs with credentials (`postgres://user:secret@host`) and `Bearer <token>` values. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi
/** `key=value` / `"key":"value"` pairs whose name marks them as secret. */
const SECRET_PAIR =
  /("?(?:api[-_]?key|authorization|secret|password|token)"?\s*[:=]\s*)("[^"]*"|(?:(?:Bearer|Basic)\s+)?[^\s,;&]+)/gi

/**
 * Removes secrets from text before it is logged: every exact value in
 * `secrets` (API keys, webhook secrets), credentials inside URLs, bearer
 * tokens, and values of fields named like secrets. It is a safety net, not a
 * licence to log them: callers should still avoid putting secrets in messages.
 */
export function scrub(text: string, secrets: readonly string[] = []): string {
  let out = text
  // Longest first, so a secret that contains another is masked whole.
  for (const secret of [...secrets].filter((s) => s.length >= 8).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join(MASK)
  }
  // Named pairs first, so `Authorization: Bearer <t>` is masked as one value.
  return out
    .replace(SECRET_PAIR, (_m, name: string, value: string) => `${name}${value.startsWith('"') ? `"${MASK}"` : MASK}`)
    .replace(URL_CREDENTIALS, `$1${MASK}@`)
    .replace(BEARER, `$1 ${MASK}`)
}

/** Replaces `Error` values with `{name, message}` and scrubs every string, at any depth. */
function sanitize(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (typeof value === 'string') return scrub(value, secrets)
  if (value instanceof Error) return { name: value.name, message: scrub(value.message, secrets) }
  if (value instanceof Date) return value.toISOString()
  if (depth > 4 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => sanitize(v, secrets, depth + 1))
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, secrets, depth + 1)]))
}

/**
 * One log line, without the trailing newline. JSON lines have the stable keys
 * `time`, `level` and `msg`, followed by the record's fields; a field cannot
 * overwrite those three. Text lines read `<time> [k=v ...] <msg>`.
 */
export function formatLog(record: LogRecord, format: LogFormat, secrets: readonly string[] = []): string {
  const time = (record.time ?? new Date()).toISOString()
  const msg = scrub(record.msg, secrets)
  const fields = sanitize(record.fields ?? {}, secrets) as Record<string, unknown>
  if (format === 'json') {
    const { time: _t, level: _l, msg: _m, ...rest } = fields
    return JSON.stringify({ time, level: record.level, msg, ...rest })
  }
  const pairs = Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
  return `${time} ${pairs.length > 0 ? `[${pairs.join(' ')}] ` : ''}${msg}`
}

/** A database URL that is safe to log. */
export function safeDatabase(url: string): string {
  return scrub(redact(url))
}
