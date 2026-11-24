/**
 * The timers behind `nostro serve`: one loop per tenant per job, each
 * failing on its own, and a limiter bounding how much work runs at once.
 * Nothing here knows what a sync or a delivery is.
 */

/**
 * At most `max` tasks at once. A task that waits for a slot does not hold
 * one, and a finishing task hands its slot straight to the next waiter, so
 * the cap is never exceeded even in the instant between two tasks.
 */
export class Limiter {
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.max) this.active++
    else await new Promise<void>((take) => this.waiting.push(take))
    try {
      return await task()
    } finally {
      const next = this.waiting.shift()
      if (next !== undefined) next()
      else this.active--
    }
  }
}

export interface Loop {
  /** Resolves once the loop has stopped, after its current step. */
  readonly done: Promise<void>
  /** End the current pause early, so the next step runs now. A no-op while a step is running. */
  wake(): void
}

export interface LoopOptions {
  readonly everySeconds: number
  /** One round of work. A throw is reported to `onError`, and the loop backs off. */
  readonly step: () => Promise<void>
  readonly onError: (err: unknown) => void
  readonly signal: AbortSignal | undefined
  /** Asked after each step: true runs the next one at once, instead of pausing. */
  readonly pending?: () => boolean
}

/**
 * Run `step` now, then every `everySeconds`, until the signal fires. After a
 * failed step the pause doubles for each consecutive failure, up to ten times
 * `everySeconds`, and a success resets it. The loop finishes the step it is in
 * before it stops.
 */
export function startLoop(options: LoopOptions): Loop {
  const { signal } = options
  let wakeNow: (() => void) | null = null

  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', finish)
        wakeNow = null
        resolve()
      }
      const timer = setTimeout(finish, ms)
      signal?.addEventListener('abort', finish, { once: true })
      wakeNow = finish
    })

  // A function, so TypeScript does not narrow `aborted` to its value at the top of the loop.
  const aborted = () => signal?.aborted === true
  const done = (async () => {
    let failures = 0
    while (!aborted()) {
      try {
        await options.step()
        failures = 0
      } catch (err) {
        failures++
        options.onError(err)
      }
      if (aborted()) break
      // Work asked for while the step ran: wake() had no pause to end.
      if (options.pending?.() === true) continue
      const factor = failures === 0 ? 1 : Math.min(2 ** failures, 10)
      await pause(options.everySeconds * factor * 1000)
    }
  })()

  return {
    done,
    wake: () => wakeNow?.(),
  }
}
