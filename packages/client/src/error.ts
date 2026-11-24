/**
 * An API error, carrying the stable RFC 9457 problem fields.
 *
 * Only the problem document's fields go into this object. The request URL,
 * headers and API key never do — error messages and stacks are safe to log
 * and to show to a user.
 */
export interface ApiErrorFields {
  readonly status: number
  readonly code: string
  readonly detail: string
  readonly title?: string
  readonly type?: string
}

export class ApiError extends Error {
  public readonly status: number
  public readonly code: string
  public readonly detail: string
  public readonly title: string
  public readonly type: string

  constructor(fields: ApiErrorFields) {
    const detail = fields.detail === '' ? 'The API refused the request.' : fields.detail
    super(detail)
    this.name = 'ApiError'
    this.status = fields.status
    this.code = fields.code
    this.detail = detail
    this.title = fields.title ?? 'Error'
    this.type = fields.type ?? 'about:blank'
  }
}
