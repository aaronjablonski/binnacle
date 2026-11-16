import { describe, expect, test } from 'vitest'

import {
  BLINK_BEATS,
  CREW_PALETTE,
  CRITTER,
  CRITTER_BADGE,
  DEFAULT,
  DONE_HUE_TRACE,
  FAILED_TOWARD_GROUND,
  GAUGE_PAIR,
  GAUGE_RING,
  Grid,
  PALETTE,
  QUEUED_TOWARD_GROUND,
  ROLE_HUE,
  ROLES,
  STALLED_TOWARD_GROUND,
  STATES,
  cellsOf,
  critter,
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
  type Role,
  type State,
} from '../mod/hooks/views/raster'

const SIZES: CritterSize[] = ['small', 'micro']
const GROUNDS: Ground[] = ['night', 'day']
const FRAMES: (1 | 2)[] = [1, 2]

/** Every combination the generator checks, at the two cockpit sizes. */
const all = function* (): Generator<[Role, State, CritterSize, Ground, 1 | 2]> {
  for (const role of ROLES) for (const state of STATES) for (const size of SIZES) for (const ground of GROUNDS) for (const frame of FRAMES) yield [role, state, size, ground, frame]
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

describe('Critters: family A at small and micro', () => {
  test('every grid is exactly 10 x 6 (small) or 8 x 4 (micro) sub-pixels of known marks', () => {
    for (const role of ROLES) {
      for (const size of SIZES) {
        const rows = critterShape(role, size)
        expect(rows).toHaveLength(CRITTER[size].h)
        for (const r of rows) {
          expect([...r]).toHaveLength(CRITTER[size].w)
          expect(r).toMatch(/^[.#eopw]+$/)
        }
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
    expect(n).toBe(4 * 6 * 2 * 2 * 2)
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

  test('role identity: the four roles differ in shape and in glyphs at both sizes', () => {
    for (const size of SIZES) {
      const shapes = ROLES.map(r => critterShape(r, size).join('\n'))
      expect(new Set(shapes).size).toBe(4)
      const drawn = ROLES.map(r => glyphs(critter(r, 'working', size)).join('\n'))
      expect(new Set(drawn).size).toBe(4)
      // and the hues differ too
      const hues = ROLES.map(r => CREW_PALETTE.night[ROLE_HUE[r]])
      expect(new Set(hues).size).toBe(4)
    }
  })

  test('the shape is one grid per role and size: a state only recolours it', () => {
    for (const role of ROLES) {
      for (const size of SIZES) {
        const occupied = (s: State) => {
          const g = critter(role, s, size)
          const out: boolean[] = []
          for (let r = 0; r < g.rows; r++) for (let x = 0; x < g.columns; x++) for (const v of g.cell(x, r).q) out.push(v !== undefined)
          return out.join('')
        }
        const base = occupied('working')
        for (const s of STATES) expect(occupied(s)).toBe(base)
      }
    }
  })

  test('state recolour: queued 62 %, stalled 42 %, failed 50 % toward the ground, done grey with a trace of the hue', () => {
    for (const ground of GROUNDS) {
      const pal = CREW_PALETTE[ground]
      for (const role of ROLES) {
        const hue = pal[ROLE_HUE[role]]
        expect(critterTone('#', role, 'working', pal)).toBe(hue)
        expect(critterTone('#', role, 'waiting', pal)).toBe(hue)
        expect(critterTone('#', role, 'queued', pal)).toBe(mix(hue, pal.ground, QUEUED_TOWARD_GROUND))
        expect(critterTone('#', role, 'stalled', pal)).toBe(mix(hue, pal.ground, STALLED_TOWARD_GROUND))
        expect(critterTone('#', role, 'failed', pal)).toBe(mix(hue, pal.ground, FAILED_TOWARD_GROUND))
        expect(critterTone('#', role, 'done', pal)).toBe(mix(pal.mute, hue, DONE_HUE_TRACE))
      }
    }
    expect([QUEUED_TOWARD_GROUND, STALLED_TOWARD_GROUND, FAILED_TOWARD_GROUND, DONE_HUE_TRACE]).toEqual([0.62, 0.42, 0.5, 0.12])
  })

  test('badges: ? on amber (waiting), z in mute on rule grey (stalled), ! on red (failed); none otherwise', () => {
    expect(CRITTER_BADGE.waiting).toEqual({ ch: '?', fg: 'badge', bg: 'amber' })
    expect(CRITTER_BADGE.stalled).toEqual({ ch: 'z', fg: 'mute', bg: 'rule' })
    expect(CRITTER_BADGE.failed).toEqual({ ch: '!', fg: 'badge', bg: 'red' })
    for (const s of ['queued', 'working', 'done'] as State[]) expect(CRITTER_BADGE[s]).toBeUndefined()
  })

  test('R19: amber only as the waiting lamp, red only as the failed lamp, no mint anywhere in a body', () => {
    for (const [role, state, size, ground, frame] of all()) {
      const pal = CREW_PALETTE[ground]
      const g = critter(role, state, size, { ground, frame })
      const used = new Set<number>()
      for (let r = 0; r < g.rows; r++) for (let x = 0; x < g.columns; x++) for (const v of g.cell(x, r).q) if (v !== undefined) used.add(v)
      expect(used.has(pal.mint)).toBe(false)
      // The micro grid has no lamp: there the badge alone carries the state.
      const lamp0 = critterShape(role, size).some(r => r.includes('o'))
      expect(used.has(pal.amber)).toBe(state === 'waiting' && lamp0)
      expect(used.has(pal.red)).toBe(state === 'failed' && lamp0)
      const lamp = critterTone('o', role, state, pal, frame)
      if (state === 'waiting') expect(lamp).toBe(pal.amber)
      if (state === 'failed') expect(lamp).toBe(pal.red)
      if (state === 'failed') expect(critterTone('e', role, state, pal, frame)).not.toBe(pal.red)
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
