import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { begin, bursting, clockRunning, cue, cueOn, forget, isLive, paintTick, peek, resetPaint, startClock, tagOf, track, trackBurst } from './paint'
import type { Burst } from './paint'
import { critterBox, critterFrames, critterPoseBox, encode, MOVE_MS, moveFrames, ring } from './raster'
import type { Grid, Move } from './raster'
import { critterArgs, critterMove } from './style'
import { todoBar } from './fit'
import { TODO_FLASH_MS, todoSegs } from './overview'
import type { PodState } from './style'

// The one-shot bursts (motion sketches 1 to 10), driven straight with a
// stand-in for `$`: it records blits, redraws and every timer asked, and
// fires the `clock.after` timers in time order. No real time passes.

type Blit = { requestId: string; key: string; cells: string; at: number }
type Timer = { due: number; ms: number; fn: () => void; cancelled: boolean }

type Fake = {
  $: EngineInterface
  now: number
  blits: Blit[]
  redraws: number[]
  afters: Timer[]
  everies: number
  /** The `every` timers asked: `ticks()` fires each one still running. */
  ticks: () => Promise<void>
  deny: string | undefined
  /** Moves the fake clock on by `ms`, firing each timer that falls due, in order. */
  advance: (ms: number) => Promise<void>
}

function fake(): Fake {
  const everyFns: { fn: () => void; cancelled: boolean }[] = []
  const f: Fake = {
    $: undefined as unknown as EngineInterface,
    now: 0,
    blits: [],
    redraws: [],
    afters: [],
    everies: 0,
    ticks: async () => {
      for (const h of everyFns) if (!h.cancelled) h.fn()
      for (let i = 0; i < 12; i++) await Promise.resolve()
    },
    deny: undefined,
    advance: async (ms: number) => {
      const until = f.now + ms
      for (;;) {
        const next = f.afters.filter(t => !t.cancelled && t.due <= until).sort((a, b) => a.due - b.due)[0]
        if (next === undefined) break
        f.now = next.due
        next.cancelled = true
        next.fn()
        for (let i = 0; i < 6; i++) await Promise.resolve()
      }
      f.now = until
    },
  }
  f.$ = {
    clock: {
      after: (ms: number, fn: () => void) => {
        const t: Timer = { due: f.now + ms, ms, fn, cancelled: false }
        f.afters.push(t)
        return { cancel: () => (t.cancelled = true) }
      },
      every: (_ms: number, fn: () => void) => {
        f.everies += 1
        const h = { fn, cancelled: false }
        everyFns.push(h)
        return { cancel: () => (h.cancelled = true) }
      },
    },
    ui: {
      blit: async (args: Omit<Blit, 'at'>) => {
        f.blits.push({ ...args, at: f.now })
        return f.deny === undefined ? {} : { deny: f.deny }
      },
      invalidate: () => {
        f.redraws.push(f.now)
      },
      log: () => undefined,
    },
  } as unknown as EngineInterface
  return f
}

const box = (g: Grid): string => encode(g)

/** Draws a critter the way `inst` does: a tagged instrument through `trackBurst`. */
function drawCritter(f: Fake, key: string, state: PodState, o: { since?: number; role?: 'lead' | 'general' | 'scout'; fold?: boolean } = {}): string {
  const c = critterArgs(o.role ?? 'general', state, { motion: true, ...(o.fold === true ? { fold: true } : {}), ...(o.since !== undefined ? { since: o.since } : {}) })
  begin('pane')
  return trackBurst(f.$, 'pane', key, c.sig, c.frames, c.tag!, c.burst, f.now).cells
}

/** The frames a move blits after the mounted first one, then the end state (when it differs). */
function expectMove(f: Fake, key: string, move: Move, role: 'lead' | 'general' | 'scout', end: PodState, mounted: string, from: number): void {
  const frames = moveFrames(move).map(x => box(critterPoseBox(role, 'small', x)))
  expect(mounted).toBe(frames[0])
  const mine = f.blits.filter(b => b.key === key && b.at >= from)
  const ends = critterFrames(role, end, 'small', { motion: true }).map(box)
  const want = [...frames.slice(1), ...(frames[frames.length - 1] === ends[0] ? [] : [ends[0]])]
  expect(mine.map(b => b.cells)).toEqual(want)
  // Each frame shows for its own time: the blits land at the running sums of MOVE_MS.
  const sums = MOVE_MS[move].map((_, i) => MOVE_MS[move].slice(0, i + 1).reduce((n, ms) => n + ms, 0))
  expect(mine.map(b => b.at - from)).toEqual(sums.slice(0, mine.length))
}

test('motion 2: a card that just started lands squashed and dim, hops (2 x 120 ms), then settles working; never again', async () => {
  resetPaint()
  const f = fake()
  f.now = 1000
  const mounted = drawCritter(f, 'card', 'working', { since: 500 })
  expect(bursting('pane', 'card')).toBe(true)
  await f.advance(119)
  expect(f.blits).toHaveLength(0)
  await f.advance(500)
  expectMove(f, 'card', 'wake', 'general', 'working', mounted, 1000)
  expect(bursting('pane', 'card')).toBe(false)
  // No loop: nothing more however long the clock runs, no redraw, no standing clock.
  await f.advance(10_000)
  expect(f.blits).toHaveLength(2)
  expect(f.redraws).toHaveLength(0)
  expect(f.everies).toBe(0)
  // Drawn again (a tab switched back) within the window: the move is not replayed.
  forget('pane')
  drawCritter(f, 'card', 'working', { since: 500 })
  expect(bursting('pane', 'card')).toBe(false)
})

test('motion 2: a card met long after its start, or a still state, does not move', async () => {
  resetPaint()
  const f = fake()
  f.now = 100_000
  // The working critter's own frame for the beat (beat 0 is its blink at phase 0).
  expect(drawCritter(f, 'old', 'working', { since: 1000 })).toBe(box(critterFrames('general', 'working', 'small', { motion: true })[0]!))
  expect(drawCritter(f, 'done', 'done', { since: 99_900 })).toBe(box(critterBox('general', 'done', 'small')))
  await f.advance(1000)
  expect(f.blits).toHaveLength(0)
})

test('motion 2: the lead woken by a prompt after rest (done, then working) squashes and hops', async () => {
  resetPaint()
  const f = fake()
  drawCritter(f, 'lead', 'done', { role: 'lead' })
  const mounted = drawCritter(f, 'lead', 'working', { role: 'lead' })
  await f.advance(1000)
  expectMove(f, 'lead', 'wake', 'lead', 'working', mounted, 0)
})

test('motion 3: a finish nods with eyes shut, fades in two steps (2 x 150 ms), rests 700 ms in grey, then asks one redraw (the fold)', async () => {
  resetPaint()
  const f = fake()
  drawCritter(f, 'card', 'working', { since: -100_000, fold: true })
  const mounted = drawCritter(f, 'card', 'done', { since: -100_000, fold: true })
  expect(tagOf('pane', 'card')).toBe('done@-100000')
  await f.advance(999)
  expect(f.redraws).toHaveLength(0)
  expect(bursting('pane', 'card')).toBe(true)
  await f.advance(1)
  expectMove(f, 'card', 'settle', 'general', 'done', mounted, 0)
  expect(f.redraws).toEqual([1000])
  expect(bursting('pane', 'card')).toBe(false)
  await f.advance(10_000)
  expect(f.redraws).toHaveLength(1)
})

// B-M4: a critter that is not on a folding card (the Crew map, Tasks) nods and fades but asks no redraw.
test('motion 3: a critter off a folding card plays the nod with no fold redraw', async () => {
  resetPaint()
  const f = fake()
  drawCritter(f, 'row', 'working', { since: -100_000 })
  const mounted = drawCritter(f, 'row', 'done', { since: -100_000 })
  await f.advance(2000)
  expectMove(f, 'row', 'settle', 'general', 'done', mounted, 0)
  expect(f.redraws).toHaveLength(0)
})

// B-M5: after a burst the 1 s clock still stops by itself: a burst never makes the paint live, and its timers are `after`, not `every`.
test('the 1 s clock stops when nothing is live, also right after a burst has played', async () => {
  resetPaint()
  const f = fake()
  drawCritter(f, 'card', 'working', { since: -100_000, fold: true })
  drawCritter(f, 'card', 'done', { since: -100_000, fold: true })
  startClock(f.$, () => false)
  expect(clockRunning()).toBe(true)
  await f.advance(2000)
  expect(bursting('pane', 'card')).toBe(false)
  await f.ticks()
  expect(clockRunning()).toBe(false)
  expect(f.everies).toBe(1)
})

// B-M2: a dry draw (the hidden one of a tab switch) mounts the first frame and records nothing.
test('peek draws an instrument without tracking it: no entry, no tag, no burst, no shown', async () => {
  resetPaint()
  const f = fake()
  const c = critterArgs('general', 'working', { motion: true, since: -100_000 })
  drawCritter(f, 'card', 'working', { since: -100_000 })
  drawCritter(f, 'card', 'done', { since: -100_000, fold: true })
  expect(bursting('pane', 'card')).toBe(true)
  const dry = peek(critterArgs('general', 'done', { size: 'small' }).frames)
  expect(dry.columns).toBe(c.columns)
  expect(tagOf('pane', 'card')).toBe('done@-100000')
  expect(bursting('pane', 'card')).toBe(true)
  await f.advance(2000)
  expect(f.blits).toHaveLength(2)
  expect(peek(critterArgs('general', 'done').frames).cells).not.toBe('')
  expect(tagOf('pane', 'never-drawn')).toBeUndefined()
})

test('motion 3: the lead does not nod at a finish (the sweep moves it, motion 10)', async () => {
  resetPaint()
  const f = fake()
  drawCritter(f, 'lead', 'working', { role: 'lead' })
  drawCritter(f, 'lead', 'done', { role: 'lead' })
  await f.advance(2000)
  expect(f.blits).toHaveLength(0)
  expect(f.redraws).toHaveLength(0)
})

test('motion 4: an asker glances toward its badge, then hops once with it (2 x 140 ms), then holds still', async () => {
  resetPaint()
  const f = fake()
  drawCritter(f, 'card', 'working', { since: -100_000 })
  const mounted = drawCritter(f, 'card', 'waiting', { since: -100_000 })
  await f.advance(5000)
  expectMove(f, 'card', 'ask', 'general', 'waiting', mounted, 0)
  // The hop frame carries the badge; the glance does not.
  expect(moveFrames('ask').map(x => x.badge)).toEqual([undefined, 'waiting'])
  // A new asker in the block (a key first drawn within the window of its ask) plays it too, once per ask.
  resetPaint()
  const g = fake()
  g.now = 10_000
  const first = drawCritter(g, 'asker', 'waiting', { since: 9_500 })
  expect(first).toBe(box(critterPoseBox('general', 'small', moveFrames('ask')[0]!)))
  await g.advance(1000)
  drawCritter(g, 'asker', 'waiting', { since: 9_500 })
  expect(bursting('pane', 'asker')).toBe(false)
  // The next ask under the same key, also fresh, plays again.
  drawCritter(g, 'asker', 'waiting', { since: 10_900 })
  expect(bursting('pane', 'asker')).toBe(true)
})

test('motion 8: stalled shuts its eyes, then sinks and dims (2 x 300 ms), then sits up dim with its z, once', async () => {
  resetPaint()
  const f = fake()
  drawCritter(f, 'card', 'working')
  const mounted = drawCritter(f, 'card', 'stalled')
  await f.advance(5000)
  expectMove(f, 'card', 'stall', 'general', 'stalled', mounted, 0)
  expect(f.blits).toHaveLength(2)
})

test('motion 9: failed flinches with eyes shut, then dims without its badge (2 x 130 ms), then the red badge, once', async () => {
  resetPaint()
  const f = fake()
  drawCritter(f, 'card', 'working', { role: 'scout' })
  const mounted = drawCritter(f, 'card', 'failed', { role: 'scout' })
  await f.advance(5000)
  expectMove(f, 'card', 'fail', 'scout', 'failed', mounted, 0)
})

test('motion off: a state change notes the new state and shows only the end state', async () => {
  resetPaint()
  const f = fake()
  const c1 = critterArgs('general', 'working', { motion: true })
  const c2 = critterArgs('general', 'done', { motion: true })
  begin('pane')
  trackBurst(f.$, 'pane', 'card', c1.sig, c1.frames, c1.tag!, undefined, 0)
  begin('pane')
  const got = trackBurst(f.$, 'pane', 'card', c2.sig, c2.frames, c2.tag!, undefined, 0)
  expect(got.cells).toBe(box(critterBox('general', 'done', 'small')))
  await f.advance(5000)
  expect(f.blits).toHaveLength(0)
  expect(f.redraws).toHaveLength(0)
})

test('R24: critters without motion (the band) carry no move at all', () => {
  const c = critterArgs('lead', 'working', { size: 'micro' })
  expect(c.tag).toBeUndefined()
  expect(c.burst).toBeUndefined()
})

test('the move table: which state change plays which move', () => {
  const at = 10_000
  expect(critterMove('general', undefined, 'working', at - 100, at)?.move).toBe('wake')
  expect(critterMove('general', undefined, 'working', at - 5000, at)).toBeUndefined()
  expect(critterMove('general', undefined, 'waiting', at - 100, at)?.move).toBe('ask')
  expect(critterMove('general', undefined, 'done', at - 100, at)).toBeUndefined()
  expect(critterMove('lead', 'done', 'working', undefined, at)?.move).toBe('wake')
  expect(critterMove('general', 'queued', 'working', undefined, at)?.move).toBe('wake')
  expect(critterMove('general', 'working', 'done', undefined, at)?.move).toBe('settle')
  expect(critterMove('lead', 'working', 'done', undefined, at)).toBeUndefined()
  expect(critterMove('general', 'working', 'waiting', undefined, at)?.move).toBe('ask')
  expect(critterMove('general', 'working', 'stalled', undefined, at)?.move).toBe('stall')
  expect(critterMove('general', 'waiting', 'failed', undefined, at)?.move).toBe('fail')
  expect(critterMove('general', 'waiting', 'working', undefined, at)).toBeUndefined()
  expect(critterMove('general', 'stalled', 'working', undefined, at)).toBeUndefined()
})

test('a burst ends early: a new signature stops it, and a denied blit (not mounted) asks one redraw for the end state', async () => {
  resetPaint()
  const f = fake()
  drawCritter(f, 'card', 'working')
  drawCritter(f, 'card', 'stalled')
  // A draw while it runs (same signature) mounts the burst's current frame.
  const again = drawCritter(f, 'card', 'stalled')
  expect(again).toBe(box(critterPoseBox('general', 'small', moveFrames('stall')[0]!)))
  // A new state mid-burst: the burst stops, the new state is drawn at once.
  drawCritter(f, 'card', 'working')
  await f.advance(5000)
  expect(f.blits).toHaveLength(0)

  resetPaint()
  const g = fake()
  drawCritter(g, 'card', 'working')
  drawCritter(g, 'card', 'failed')
  g.deny = 'not mounted'
  await g.advance(5000)
  expect(g.blits).toHaveLength(1)
  expect(g.redraws).toHaveLength(1)
  expect(bursting('pane', 'card')).toBe(false)
})

test('the paint beat leaves a bursting key alone, and a still instrument is not live after its burst', async () => {
  resetPaint()
  const f = fake()
  const frames = () => [ring('A', 10)]
  const b: Burst = { frames: () => [ring('A', 3), ring('A', 6)], ms: [80, 80] }
  begin('pane')
  trackBurst(f.$, 'pane', 'ring', 'r', frames, 'x', undefined, 0)
  begin('pane')
  trackBurst(f.$, 'pane', 'ring', 'r', frames, 'y', () => b, 0)
  expect(await paintTick(f.$)).toBe(0)
  await f.advance(200)
  expect(f.blits.map(x => x.cells)).toEqual([box(ring('A', 6)), box(ring('A', 10))])
  expect(isLive()).toBe(false)
  expect(f.everies).toBe(0)
})

test('a burst whose frames are not the instrument\'s size, or whose times do not match its frames, is not played', async () => {
  resetPaint()
  const f = fake()
  begin('pane')
  track('pane', 'ring', 'r', () => [ring('A', 10)])
  begin('pane')
  const got = trackBurst(f.$, 'pane', 'ring', 'r', () => [ring('A', 10)], 'b', () => ({ frames: () => [critterBox('lead', 'working', 'small')], ms: [80] }), 0)
  expect(got.cells).toBe(box(ring('A', 10)))
  begin('pane')
  trackBurst(f.$, 'pane', 'ring', 'r', () => [ring('A', 10)], 'c', () => ({ frames: () => [ring('A', 3)], ms: [80, 80] }), 0)
  await f.advance(1000)
  expect(f.blits).toHaveLength(0)
})

test('a cue (motions 1 and 4) is on for its time, then one redraw ends it; it never plays twice', async () => {
  resetPaint()
  const f = fake()
  cue(f.$, 'ask:1', 0, 140)
  expect(cueOn('ask:1')).toBe(true)
  await f.advance(139)
  expect(cueOn('ask:1')).toBe(true)
  await f.advance(1)
  expect(cueOn('ask:1')).toBe(false)
  expect(f.redraws).toEqual([140])
  cue(f.$, 'ask:1', 200, 140)
  expect(cueOn('ask:1')).toBe(false)
  await f.advance(1000)
  expect(f.redraws).toHaveLength(1)
  expect(f.everies).toBe(0)
})

test('motion 1: the to-do bar\'s segments are where todoBar draws each task, so the flash lands on the task that was done', () => {
  for (const cells of [10, 28, 58]) {
    for (let total = 1; total <= cells; total++) {
      const segs = todoSegs(cells, total)!
      const text = todoBar(cells, total, 0, 0).map(r => r.text).join('')
      expect(segs).toHaveLength(total)
      const lit = new Set<number>()
      for (const [a, b] of segs) for (let i = a; i < b; i++) lit.add(i)
      for (let i = 0; i < cells; i++) expect(text[i] === '━').toBe(lit.has(i))
    }
    // More tasks than cells: the bar is proportional, and nothing flashes.
    expect(todoSegs(cells, cells + 1)).toBeUndefined()
  }
  expect(TODO_FLASH_MS).toEqual([160, 160, 160])
})
