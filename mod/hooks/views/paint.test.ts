import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { begin, forget, isLive, paintTick, resetPaint, startClock, stopClock, track } from './paint'
import { encode, ring, sprite } from './raster'

// paint is driven straight here with a stand-in for `$` that records blits
// and holds the one clock callback. The registry is the module's, so each
// test starts with resetPaint().

type Blit = { requestId: string; key: string; cells: string }

type Fake = {
  $: EngineInterface
  blits: Blit[]
  timers: { ms: number; fn: () => void; cancelled: boolean }[]
  deny: string | undefined
}

function fake(): Fake {
  const out: Fake = { $: undefined as unknown as EngineInterface, blits: [], timers: [], deny: undefined }
  out.$ = {
    clock: {
      every: (ms: number, fn: () => void) => {
        const t = { ms, fn, cancelled: false }
        out.timers.push(t)
        return { cancel: () => (t.cancelled = true) }
      },
    },
    ui: {
      blit: async (args: Blit) => {
        out.blits.push(args)
        return out.deny === undefined ? {} : { deny: out.deny }
      },
      log: () => undefined,
    },
  } as unknown as EngineInterface
  return out
}

const pulse = () => [sprite('lead', 'working', 'L', { lamp: 'on' }), sprite('lead', 'working', 'L', { lamp: 'dim' })]
const still = () => [ring('CTX', 42)]

test('track returns the mounted size and the cells of the current beat', async () => {
  resetPaint()
  const got = track('pane', 'lead', 'lead:working', pulse)
  expect(got.columns).toBe(9)
  expect(got.rows).toBe(4)
  expect(got.cells).toBe(encode(pulse()[0]!))
})

test('a key is blitted only when its cells change: a still ring never, a pulse every beat', async () => {
  resetPaint()
  const f = fake()
  begin('pane')
  track('pane', 'ring', 'ctx:42', still)
  track('pane', 'lead', 'lead:working', pulse)
  expect(isLive()).toBe(true)

  await paintTick(f.$)
  await paintTick(f.$)
  await paintTick(f.$)

  expect(f.blits.map(b => b.key)).toEqual(['lead', 'lead', 'lead'])
  const [on, dim] = pulse().map(encode)
  expect(f.blits.map(b => b.cells)).toEqual([dim, on, dim])
  expect(f.blits.every(b => b.requestId === 'pane')).toBe(true)
})

test('nothing live, nothing painted: still instruments make no blits and isLive is false', async () => {
  resetPaint()
  const f = fake()
  begin('pane')
  track('pane', 'ring', 'ctx:42', still)
  track('pane', 'scout', 'scout:done', () => [sprite('scout', 'done', 'S')])
  expect(isLive()).toBe(false)
  expect(await paintTick(f.$)).toBe(0)
  expect(f.blits).toHaveLength(0)
})

test('frames are drawn and encoded only when the signature changes', async () => {
  resetPaint()
  let drawn = 0
  const counted = () => {
    drawn += 1
    return pulse()
  }
  begin('pane')
  track('pane', 'lead', 'a', counted)
  begin('pane')
  track('pane', 'lead', 'a', counted)
  track('pane', 'lead', 'a', counted)
  expect(drawn).toBe(1)
  track('pane', 'lead', 'b', counted)
  expect(drawn).toBe(2)
})

test('a redraw that already shows the beat\'s cells is not blitted again', async () => {
  resetPaint()
  const f = fake()
  begin('pane')
  track('pane', 'lead', 'a', pulse)
  await paintTick(f.$) // beat 1: dim
  begin('pane')
  track('pane', 'lead', 'a', pulse) // the redraw mounts beat 1's cells
  expect(f.blits).toHaveLength(1)
  await paintTick(f.$) // beat 2: on, a change
  expect(f.blits).toHaveLength(2)
})

test('a key the last draw left out, a forgotten site and a denied blit stop painting', async () => {
  resetPaint()
  const f = fake()
  begin('pane')
  track('pane', 'lead', 'a', pulse)
  track('pane', 'crew', 'c', pulse)
  begin('pane')
  track('pane', 'crew', 'c', pulse)
  await paintTick(f.$)
  expect(f.blits.map(b => b.key)).toEqual(['crew'])

  forget('pane')
  expect(isLive()).toBe(false)
  await paintTick(f.$)
  expect(f.blits).toHaveLength(1)

  begin('band')
  track('band', 'crew', 'c', pulse)
  f.deny = 'not mounted'
  await paintTick(f.$)
  expect(f.blits).toHaveLength(2)
  expect(isLive()).toBe(false)
  await paintTick(f.$)
  expect(f.blits).toHaveLength(2)
})

test('frames of different sizes are refused', async () => {
  resetPaint()
  expect(() => track('pane', 'x', 's', () => [ring('A', 1), sprite('lead', 'working', 'L')])).toThrow()
})

test('startClock owns one 1 s clock: a second start cancels the first; each period runs the tick, then paints', async () => {
  resetPaint()
  const f = fake()
  const ticks: number[] = []
  startClock(f.$, () => {
    ticks.push(1)
  })
  startClock(f.$, () => {
    ticks.push(2)
  })
  expect(f.timers).toHaveLength(2)
  expect(f.timers[0]!.cancelled).toBe(true)
  expect(f.timers[1]!.ms).toBe(1000)

  begin('pane')
  track('pane', 'lead', 'a', pulse)
  f.timers[1]!.fn()
  for (let i = 0; i < 3; i++) await Promise.resolve()
  expect(ticks).toEqual([2])
  expect(f.blits).toHaveLength(1)

  stopClock()
  expect(f.timers[1]!.cancelled).toBe(true)
})
