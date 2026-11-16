import { describe, expect, test } from 'vitest'

import {
  BLINK_BEATS,
  CREW_PALETTE,
  CRITTER,
  CRITTER_BADGE,
  DEFAULT,
  DONE_HUE_TRACE,
  FACE_OF,
  FAILED_TOWARD_MUTE,
  GAUGE_PAIR,
  GAUGE_RING,
  Grid,
  PALETTE,
  QUEUED_TOWARD_GROUND,
  ROLE_HUE,
  CRITTER_ROLES,
  STALLED_TOWARD_MUTE,
  STATES,
  cellsOf,
  critter,
  critterBody,
  critterBox,
  critterFrames,
  critterShape,
  critterTone,
  encode,
  frameFoot,
  frameTop,
  gaugeHue,
  gaugePair,
  gaugeRing,
  mix,
  type CritterSize,
  type Ground,
  type CritterRole,
  type State,
} from '../mod/hooks/views/raster'

const SIZES: CritterSize[] = ['small', 'micro']
const GROUNDS: Ground[] = ['night', 'day']
const FRAMES: (1 | 2)[] = [1, 2]

/** Every combination the generator checks, at the two cockpit sizes. */
const all = function* (): Generator<[CritterRole, State, CritterSize, Ground, 1 | 2]> {
  for (const role of CRITTER_ROLES) for (const state of STATES) for (const size of SIZES) for (const ground of GROUNDS) for (const frame of FRAMES) yield [role, state, size, ground, frame]
}

const glyphs = (g: Grid): string[] => {
  const cells = cellsOf(g)
  const out: string[] = []
  for (let r = 0; r < g.rows; r++) out.push(cells.slice(r * g.columns, (r + 1) * g.columns).map(([c]) => String.fromCodePoint(c)).join(''))
  return out
}

/** The distinct colours one cell's four quadrants need, the empty ground counting as one. */
const coloursIn = (g: Grid, x: number, row: number): number => {
  const q = g.cell(x, row).q
  return new Set(q.map(v => (v === undefined ? 'ground' : v))).size
}

describe('Critters: the mini mascot at small and micro', () => {
  test('every grid is exactly 10 x 6 (small) or 8 x 4 (micro) sub-pixels of known marks', () => {
    for (const [role, state, size, , frame] of all()) {
      const rows = critterShape(role, size, state, frame)
      expect(rows).toHaveLength(CRITTER[size].h)
      for (const r of rows) {
        expect([...r]).toHaveLength(CRITTER[size].w)
        expect(r).toMatch(/^[.#pqedfwk]+$/)
      }
    }
  })

  test('every sprite is exactly 5 x 3 / 4 x 2 cells with at most two colours a cell, for all roles x states x frames x grounds', () => {
    let n = 0
    for (const [role, state, size, ground, frame] of all()) {
      const g = critter(role, state, size, { ground, frame })
      expect([g.columns, g.rows]).toEqual([CRITTER[size].columns, CRITTER[size].rows])
      for (let row = 0; row < g.rows; row++) for (let x = 0; x < g.columns; x++) expect(coloursIn(g, x, row)).toBeLessThanOrEqual(2)
      expect(() => encode(g)).not.toThrow()
      n++
    }
    expect(n).toBe(5 * 6 * 2 * 2 * 2)
  })

  test('the box adds one badge column: 6 x 3 and 5 x 2, the badge only in the top right cell', () => {
    for (const [role, state, size, ground] of all()) {
      const g = critterBox(role, state, size, { ground })
      expect([g.columns, g.rows]).toEqual([CRITTER[size].columns + 1, CRITTER[size].rows])
      const cells = cellsOf(g)
      const b = CRITTER_BADGE[state]
      const corner = cells[CRITTER[size].columns]!
      if (b === undefined) expect(corner).toEqual([0x20, DEFAULT, DEFAULT])
      else expect(corner).toEqual([b.ch.codePointAt(0)!, CREW_PALETTE[ground][b.fg], CREW_PALETTE[ground][b.bg]])
      for (let r = 1; r < g.rows; r++) expect(cells[r * g.columns + CRITTER[size].columns]).toEqual([0x20, DEFAULT, DEFAULT])
    }
  })

  test('role identity: the five roles differ in shape and in glyphs at both sizes', () => {
    for (const size of SIZES) {
      const shapes = CRITTER_ROLES.map(r => critterShape(r, size).join('\n'))
      expect(new Set(shapes).size).toBe(5)
      // Compared as encoded (glyphs and colours): at micro the reviewer's glasses differ from the plain mascot in colour only.
      const drawn = CRITTER_ROLES.map(r => encode(critter(r, 'working', size)))
      expect(new Set(drawn).size).toBe(5)
      // and the hues differ too
      const hues = CRITTER_ROLES.map(r => CREW_PALETTE.night[ROLE_HUE[r]])
      expect(new Set(hues).size).toBe(5)
    }
  })

  test('the state moves only the face, never the silhouette or the accessory: the same cells are lit in every state', () => {
    for (const role of CRITTER_ROLES) {
      for (const size of SIZES) {
        const occupied = (st: State, frame: 1 | 2 = 1) => critterShape(role, size, st, frame).map(r => r.replace(/[^.]/g, '#')).join('/')
        const base = occupied('working')
        for (const st of STATES) expect(occupied(st)).toBe(base)
        expect(occupied('working', 2)).toBe(base)
      }
    }
  })

  test('the face shows the state: open (queued, working), look (waiting), shut (stalled, done), sad (failed); frame 2 of working is the blink', () => {
    expect(FACE_OF).toEqual({ queued: 'open', working: 'open', waiting: 'look', stalled: 'shut', failed: 'sad', done: 'shut' })
    for (const size of SIZES) {
      const face = (st: State, frame: 1 | 2 = 1) => critterShape('general', size, st, frame).join('/')
      expect(face('queued')).toBe(face('working'))
      expect(face('stalled')).toBe(face('done'))
      expect(face('working', 2)).not.toBe(face('working'))
      expect(face('working', 2)).toBe(face('stalled'))
      expect(face('stalled')).not.toBe(face('working'))
      // The micro faces are two pixels wide: only the small size tells all four apart.
      if (size === 'small') expect(new Set([face('working'), face('waiting'), face('stalled'), face('failed')]).size).toBe(4)
    }
  })

  test('state recolour: queued 60 % toward the ground, stalled and failed 55 % toward mute, done grey with a trace of the hue', () => {
    for (const ground of GROUNDS) {
      const pal = CREW_PALETTE[ground]
      for (const role of CRITTER_ROLES) {
        const hue = pal[ROLE_HUE[role]]
        expect(critterTone('#', role, 'working', pal)).toBe(hue)
        expect(critterTone('#', role, 'waiting', pal)).toBe(hue)
        expect(critterTone('#', role, 'queued', pal)).toBe(mix(hue, pal.ground, QUEUED_TOWARD_GROUND))
        expect(critterTone('#', role, 'stalled', pal)).toBe(mix(hue, pal.mute, STALLED_TOWARD_MUTE))
        expect(critterTone('#', role, 'failed', pal)).toBe(mix(hue, pal.mute, FAILED_TOWARD_MUTE))
        expect(critterTone('#', role, 'done', pal)).toBe(mix(pal.mute, hue, DONE_HUE_TRACE))
        expect(critterBody(role, 'failed', pal)).toBe(critterTone('#', role, 'failed', pal))
      }
    }
    expect([QUEUED_TOWARD_GROUND, STALLED_TOWARD_MUTE, FAILED_TOWARD_MUTE, DONE_HUE_TRACE]).toEqual([0.6, 0.55, 0.55, 0.12])
  })

  test('sky is the general hue, in the crew palette only: night 0x6fb6f2, day 0x2f8fd8', () => {
    expect(CREW_PALETTE.night.sky).toBe(0x6fb6f2)
    expect(CREW_PALETTE.day.sky).toBe(0x2f8fd8)
    expect(ROLE_HUE.general).toBe('sky')
    expect(ROLE_HUE).toEqual({ lead: 'ember', scout: 'teal', build: 'iris', check: 'orchid', general: 'sky' })
  })

  test('badges: ? on amber (waiting), z in dim on rule grey (stalled), ! on red (failed); none otherwise', () => {
    expect(CRITTER_BADGE.waiting).toEqual({ ch: '?', fg: 'badge', bg: 'amber' })
    expect(CRITTER_BADGE.stalled).toEqual({ ch: 'z', fg: 'dim', bg: 'rule' })
    expect(CRITTER_BADGE.failed).toEqual({ ch: '!', fg: 'badge', bg: 'red' })
    for (const s of ['queued', 'working', 'done'] as State[]) expect(CRITTER_BADGE[s]).toBeUndefined()
  })

  test('R19: red only in the failed badge, amber only in the waiting badge, no mint in a body: a sprite has no lamp', () => {
    for (const [role, state, size, ground, frame] of all()) {
      const pal = CREW_PALETTE[ground]
      const g = critter(role, state, size, { ground, frame })
      const used = new Set<number>()
      for (let r = 0; r < g.rows; r++) for (let x = 0; x < g.columns; x++) for (const v of g.cell(x, r).q) if (v !== undefined) used.add(v)
      expect(used.has(pal.mint)).toBe(false)
      expect(used.has(pal.amber)).toBe(false)
      expect(used.has(pal.red)).toBe(false)
      expect(critterShape(role, size, state, frame).some(r => r.includes('o'))).toBe(false)
    }
  })

  test('the blink: a working critter with motion has one shut frame in four, staggered by phase; nothing else moves', () => {
    const f = critterFrames('build', 'working', 'small', { motion: true, phase: 1 })
    expect(f).toHaveLength(BLINK_BEATS)
    const enc = f.map(encode)
    expect(enc.filter(e => e !== enc[0]).length).toBe(1)
    expect(enc[1]).not.toBe(enc[0])
    const g = critterFrames('build', 'working', 'small', { motion: true, phase: 2 }).map(encode)
    expect(g[2]).not.toBe(g[0])
    expect(critterFrames('build', 'working', 'small', { motion: false })).toHaveLength(1)
    for (const s of STATES.filter(s => s !== 'working')) expect(critterFrames('scout', s, 'micro', { motion: true })).toHaveLength(1)
  })
})

describe('the gauge ring', () => {
  test('9 x 5 Braille, the figure centred in the middle row, no name inside', () => {
    const g = gaugeRing(62)
    expect([g.columns, g.rows]).toEqual([GAUGE_RING.columns, GAUGE_RING.rows])
    const mid = glyphs(g)[2]!
    expect(mid.indexOf('62%')).toBe(3)
    expect(glyphs(gaugeRing(100))[2]!.indexOf('100%')).toBe(2)
    for (const r of [0, 1, 3, 4]) expect(glyphs(g)[r]).not.toMatch(/[A-Za-z0-9%]/)
  })

  test('colour (R9): iris under 70, ink from 70, red from 90; the figure ink until 70', () => {
    expect([gaugeHue(69), gaugeHue(70), gaugeHue(89), gaugeHue(90)]).toEqual(['iris', 'ink', 'ink', 'red'])
    const fig = (pct: number) => {
      const g = gaugeRing(pct)
      const cells = cellsOf(g).slice(2 * 9, 3 * 9)
      return cells.find(([c]) => c === '%'.codePointAt(0))![1]
    }
    expect(fig(62)).toBe(PALETTE.night.ink)
    expect(fig(85)).toBe(PALETTE.night.ink)
    expect(fig(95)).toBe(PALETTE.night.red)
    const lit = (pct: number) => new Set(cellsOf(gaugeRing(pct)).filter(([c]) => c >= 0x2800 && c <= 0x28ff).map(([, fg]) => fg))
    expect(lit(0)).toEqual(new Set([PALETTE.night.rest]))
    expect(lit(1).has(PALETTE.night.iris)).toBe(true)
    expect(lit(100)).toEqual(new Set([PALETTE.night.red]))
    expect(lit(50)).toEqual(new Set([PALETTE.night.iris, PALETTE.night.rest]))
  })

  test('the pair is 20 x 5, rings at 0 and 11', () => {
    const g = gaugePair([62, 34])
    expect([g.columns, g.rows]).toEqual([GAUGE_PAIR.columns, GAUGE_PAIR.rows])
    expect(glyphs(g)[2]!.indexOf('62%')).toBe(3)
    expect(glyphs(g)[2]!.indexOf('34%')).toBe(14)
  })
})

describe('lintel and sill without pill', () => {
  test('frameTop: the clamp █▀▀ in the hue, then a rule-grey hairline to the edge', () => {
    const g = frameTop(62, { hue: 'amber' })
    expect(glyphs(g)[0]).toBe('█▀▀' + '▔'.repeat(59))
    const cells = cellsOf(g)
    expect(cells[0]![1]).toBe(PALETTE.night.amber)
    expect(cells[3]![1]).toBe(PALETTE.night.rule)
  })

  test('frameFoot: a rule-grey hairline, then ▄▄█ in the hue', () => {
    const g = frameFoot(62)
    expect(glyphs(g)[0]).toBe('▁'.repeat(59) + '▄▄█')
    expect(cellsOf(g)[61]![1]).toBe(PALETTE.night.iris)
  })
})
