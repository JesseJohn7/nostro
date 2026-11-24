/**
 * List endpoints hand back a lazy page iterable. Call `page()` for one page,
 * or `for await (const row of client.listMovements())` to follow the server's
 * `next` cursor into `after` until the last page.
 */
import type { Query, QueryValue } from './types.js'

export interface Page<T> {
  readonly data: T[]
  readonly next: string | number | null
}

export interface PageIterable<T> extends AsyncIterable<T> {
  /** Fetch exactly one page, merging overrides into the method's query. */
  page(params?: Query): Promise<Page<T>>
  [Symbol.asyncIterator](): AsyncIterator<T>
}

/** Wrap a page loader in both a one-page and an all-pages interface. */
export function pageIterable<T>(load: (query: Query) => Promise<Page<T>>, initial: Query = {}): PageIterable<T> {
  return {
    page: (params: Query = {}) => load({ ...initial, ...params }),
    async *[Symbol.asyncIterator]() {
      const seen = new Set<string>()
      let next: QueryValue = initial.after
      if (next !== undefined && next !== null) seen.add(String(next))
      for (;;) {
        const query: Query = { ...initial }
        if (next !== undefined && next !== null) query.after = next
        const page = await load(query)
        yield* page.data
        if (page.next === null || page.next === undefined) return
        const cursor = String(page.next)
        // A broken server must not be able to spin this loop forever.
        if (seen.has(cursor)) return
        seen.add(cursor)
        next = page.next
      }
    },
  }
}
