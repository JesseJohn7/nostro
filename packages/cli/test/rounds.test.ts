import { describe, expect, it } from 'vitest'
import { RoundManager } from '../src/rounds.js'
import { startLoop } from '../src/serve-loops.js'

const nothing = { movementsInserted: 0, movementsDecided: 0, errors: [] }

describe('RoundManager', () => {
  it('reports a failed round, and gives its place to the one queued behind it', async () => {
    const rounds = new RoundManager()
    const first = await rounds.triggerRound('acme', 'GA')
    expect(rounds.onRoundStart('acme')).toMatchObject({ id: first.id, state: 'running', account: 'GA' })
    const second = await rounds.triggerRound('acme')
    expect(rounds.hasQueued('acme')).toBe(true)
    rounds.onRoundFailed('acme', new Error('horizon down'))
    expect(await rounds.getRound('acme', first.id)).toMatchObject({ state: 'failed', error: 'horizon down', summary: null })

    expect(rounds.onRoundStart('acme')).toMatchObject({ id: second.id })
    expect(rounds.hasQueued('acme')).toBe(false)
    rounds.onRoundDone('acme', nothing)
    expect(await rounds.getRound('acme', second.id)).toMatchObject({ state: 'done', summary: nothing })
  })

  it('has no round to start, report or fail when none was asked for', async () => {
    const rounds = new RoundManager()
    expect(rounds.hasQueued('acme')).toBe(false)
    expect(rounds.onRoundStart('acme')).toBeNull()
    rounds.onRoundDone('acme', nothing)
    rounds.onRoundFailed('acme', new Error('x'))
    expect(await rounds.getRound('acme', 'missing')).toBeNull()
    expect(await rounds.getRound('nobody', 'missing')).toBeNull()
  })
})

describe('startLoop', () => {
  it('runs again at once while work is pending, even after a failure, then pauses', async () => {
    const stop = new AbortController()
    let pending = 2
    let steps = 0
    const errors: string[] = []
    const loop = startLoop({
      everySeconds: 3600,
      signal: stop.signal,
      step: async () => {
        steps++
        if (steps === 1) throw new Error('first')
      },
      onError: (err) => errors.push((err as Error).message),
      pending: () => pending-- > 0,
    })
    await new Promise((r) => setTimeout(r, 50))
    expect([steps, errors]).toEqual([3, ['first']])
    loop.wake()
    await new Promise((r) => setTimeout(r, 50))
    expect(steps).toBe(4)
    stop.abort()
    await loop.done
  })
})
