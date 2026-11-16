import { describe, expect, test } from 'vitest'

import {
  CRITTER,
  CRITTER_ROLES,
  critterBox,
  critterPoseBox,
  encode,
  GAUGE_FILL,
  GAUGE_FILL_MS,
  gaugeFill,
  gaugePair,
  Grid,
  MOVE_MS,
  moveFrames,
  pairsOk,
  poseShape,
  sweepPose,
  type CritterSize,
  type FaceName,
  type Ground,
  type Pose,
} from '../mod/hooks/views/raster'

// The one-shot moves (motion sketches 2, 3, 4, 8, 9, 10) drawn on the mini
// mascot, and the gauge fill (6). The moves themselves, their timers and the
// views are tested against the engine in mod/hooks/views/motion*.test.ts*.

const SIZES: CritterSize[] = ['small', 'micro']
const GROUNDS: Ground[] = ['night', 'day']
const FACES: FaceName[] = ['open', 'blink', 'shut', 'look', 'sad']
const POSES: Pose[] = ['still', 'squash', 'hop']

const coloursIn = (g: Grid, x: number, row: number): number => new Set(g.cell(x, row).q.map(v => (v === undefined ? 'ground' : v))).size

describe('the poses of the moves', () => {
  test('every pose x face x role x size x ground keeps two colours to a cell and the box of the still critter', () => {
    let n = 0
    for (const role of CRITTER_ROLES) for (const size of SIZES) for (const face of FACES) for (const pose of POSES) {
      expect(pairsOk(poseShape(role, size, face, pose))).toBe(true)
      for (const ground of GROUNDS) {
        for (const state of ['working', 'waiting', 'queued'] as const) {
          const g = critterPoseBox(role, size, { pose, face, state, toward: 'done', t: 0.5, badge: 'waiting' }, ground)
          expect([g.columns, g.rows]).toEqual([CRITTER[size].columns + 1, CRITTER[size].rows])
          for (let row = 0; row < g.rows; row++) for (let x = 0; x < CRITTER[size].columns; x++) expect(coloursIn(g, x, row)).toBeLessThanOrEqual(2)
          expect(() => encode(g)).not.toThrow()
          n++
        }
      }
    }
    expect(n).toBe(5 * 2 * 5 * 3 * 2 * 3)
  })

  test('the frames of every move and of the sweep keep two colours to a cell, at both sizes and grounds', () => {
    const frames = [...(Object.keys(MOVE_MS) as (keyof typeof MOVE_MS)[]).flatMap(m => moveFrames(m)), ...[0, 1, 2, 3, 4].map(sweepPose)]
    for (const role of CRITTER_ROLES) for (const size of SIZES) for (const ground of GROUNDS) for (const f of frames) {
      const g = critterPoseBox(role, size, f, ground)
      for (let row = 0; row < g.rows; row++) for (let x = 0; x < g.columns; x++) expect(coloursIn(g, x, row)).toBeLessThanOrEqual(2)
    }
  })

  test('a squash and a hop really move: neither is the still shape', () => {
    for (const role of CRITTER_ROLES) for (const size of SIZES) for (const pose of ['squash', 'hop'] as const) {
      expect(poseShape(role, size, 'open', pose)).not.toEqual(poseShape(role, size, 'open', 'still'))
    }
  })

  test('the crown, the hard hat and the antenna stay legible in every pose: the accessory marks are still drawn', () => {
    const marks = (rows: string[], re: RegExp): number => rows.join('').split('').filter(c => re.test(c)).length
    for (const size of SIZES) for (const face of FACES) for (const pose of POSES) {
      // The lead's crown and the builder's hat are the trim marks (p, q).
      for (const role of ['lead', 'build'] as const) expect(marks(poseShape(role, size, face, pose), /[pq]/)).toBeGreaterThanOrEqual(4)
      // The reviewer's glasses (w) are its face: they stay at small, where they are drawn.
      if (size === 'small') expect(marks(poseShape('check', size, face, pose), /w/)).toBeGreaterThanOrEqual(2)
    }
    // The scout's antenna tip is the body mark on the empty top row of the still shape; a squash and a legs-tucked hop keep it.
    for (const size of SIZES) for (const pose of POSES) {
      const rows = poseShape('scout', size, 'open', pose)
      expect(rows.slice(0, 2).join('')).toContain('#')
    }
  })

  test('the moves follow the sketches: wake squash then hop, settle nod then half grey then grey, ask glance then hop with the badge, stall shut then sunk, fail flinch then dim', () => {
    expect(MOVE_MS).toEqual({ wake: [120, 120], settle: [150, 150, 700], ask: [140, 140], stall: [300, 300], fail: [130, 130] })
    expect(moveFrames('wake').map(f => [f.pose, f.state])).toEqual([['squash', 'queued'], ['hop', 'working']])
    expect(moveFrames('settle').map(f => [f.pose, f.face, f.state, f.toward, f.t])).toEqual([
      ['squash', 'shut', 'working', undefined, undefined],
      ['still', 'shut', 'working', 'done', 0.5],
      ['still', 'shut', 'done', undefined, undefined],
    ])
    expect(moveFrames('ask').map(f => [f.pose, f.face, f.badge])).toEqual([['still', 'look', undefined], ['hop', 'look', 'waiting']])
    expect(moveFrames('stall').map(f => [f.pose, f.face, f.toward])).toEqual([['still', 'shut', undefined], ['squash', 'shut', 'stalled']])
    expect(moveFrames('fail').map(f => [f.pose, f.face, f.state, f.badge])).toEqual([['squash', 'shut', 'working', undefined], ['still', 'sad', 'failed', undefined]])
    // Only the hop of the ask carries a badge: stalled and failed get theirs with the end state.
    for (const m of ['wake', 'settle', 'stall', 'fail'] as const) expect(moveFrames(m).every(f => f.badge === undefined)).toBe(true)
  })

  test('the lead on the sweep: squash, hop, still, half grey with eyes shut, grey (the end state)', () => {
    expect([0, 1, 2, 3, 4].map(i => sweepPose(i).pose)).toEqual(['squash', 'hop', 'still', 'still', 'still'])
    expect(encode(critterPoseBox('lead', 'small', sweepPose(4)))).toBe(encode(critterBox('lead', 'done', 'small')))
    expect(encode(critterPoseBox('lead', 'small', sweepPose(2)))).toBe(encode(critterBox('lead', 'working', 'small')))
  })

  test('a still frame of a state is that state\'s critter', () => {
    for (const role of CRITTER_ROLES) for (const size of SIZES) for (const ground of GROUNDS) {
      expect(encode(critterPoseBox(role, size, { pose: 'still', face: 'look', state: 'waiting', badge: 'waiting' }, ground))).toBe(encode(critterBox(role, 'waiting', size, { ground })))
      expect(encode(critterPoseBox(role, size, { pose: 'still', face: 'shut', state: 'done' }, ground))).toBe(encode(critterBox(role, 'done', size, { ground })))
    }
  })
})

describe('the gauge fill (motion 6)', () => {
  test('5 frames of 80 ms, easing in, each arc short of its value, every figure true', () => {
    expect(GAUGE_FILL).toEqual([0.3, 0.55, 0.75, 0.88, 0.96])
    expect(GAUGE_FILL_MS).toBe(80)
    const frames = gaugeFill([62, 34], [0, 0])
    expect(frames).toHaveLength(5)
    const end = encode(gaugePair([62, 34]))
    // The figures are the end state's on every frame: only the arcs differ.
    const words = (g: Grid): string => {
      let s = ''
      for (let x = 0; x < g.columns; x++) s += g.cell(x, 2).ch ?? ' '
      return s
    }
    for (const f of frames) expect(words(f)).toBe(words(gaugePair([62, 34])))
    expect(encode(frames[0]!)).not.toBe(end)
    // The arc grows: each frame lights at least as many dots as the one before.
    const lit = (g: Grid): number => {
      let n = 0
      for (let r = 0; r < g.rows; r++) for (let x = 0; x < g.columns; x++) if (g.cell(x, r).dots !== undefined && g.cell(x, r).fg !== g.pal.rest) n++
      return n
    }
    for (let i = 1; i < frames.length; i++) expect(lit(frames[i]!)).toBeGreaterThanOrEqual(lit(frames[i - 1]!))
  })
})
