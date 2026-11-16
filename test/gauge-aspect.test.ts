import { describe, expect, test } from 'vitest'

import { aspectFromEnv, cellsOf, DOT_BITS, gaugeCells, gaugeRing, getCellAspect, MOCK_ASPECT, setCellAspect, GAUGE_RING } from '../mod/hooks/views/raster'
import type { Grid } from '../mod/hooks/views/raster'

// FX4: the gauge ring is a circle in pixel space for the terminal's cell aspect
// a (cell height / width), and at the mocks' a = 2 it is the old table exactly.

/** The pre-FX4 table, written out again here: square dots, 18 x 20, two thick. */
function legacy(): string[] {
  const cells = new Map<string, string[]>()
  for (let dy = 0; dy < 20; dy++) {
    for (let dx = 0; dx < 18; dx++) {
      const vx = dx - 8.5
      const vy = dy - 9.5
      const d = Math.hypot(vx, vy)
      if (d < 6.7 || d > 8.95) continue
      const turn = (Math.atan2(vx, -vy) / (2 * Math.PI) + 1) % 1
      const key = `${dx >> 1},${dy >> 2}`
      cells.set(key, [...(cells.get(key) ?? []), `${dx},${dy},${turn}`])
    }
  }
  return [...cells.values()].map(c => c.join(';'))
}

/** The lit-or-rest dots of a drawn gauge as [x, y] dot positions, read back from the Braille cells. */
function dotsOf(g: Grid): [number, number][] {
  const out: [number, number][] = []
  cellsOf(g).forEach(([cp], i) => {
    if (cp < 0x2800 || cp > 0x28ff) return
    const bits = cp - 0x2800
    const cx = i % g.columns
    const cy = Math.floor(i / g.columns)
    for (let c = 0; c < 2; c++) for (let r = 0; r < 4; r++) if (bits & DOT_BITS[c]![r]!) out.push([cx * 2 + c, cy * 4 + r])
  })
  return out
}

/** Width / height of the ring's dots in pixels: a dot is half a cell wide and a quarter of one tall, a cell `a` times taller than wide. */
function ratio(g: Grid, a: number): number {
  const d = dotsOf(g)
  const xs = d.map(p => p[0])
  const ys = d.map(p => p[1])
  const w = (Math.max(...xs) - Math.min(...xs) + 1) * 0.5
  const h = (Math.max(...ys) - Math.min(...ys) + 1) * 0.25 * a
  return w / h
}

/** The ring as Braille text. */
function braille(g: Grid): string[] {
  const cells = cellsOf(g)
  return Array.from({ length: g.rows }, (_, r) =>
    cells.slice(r * g.columns, (r + 1) * g.columns).map(([cp]) => String.fromCodePoint(cp)).join(''))
}

describe('the gauge ring is round at every aspect (FX4)', () => {
  test('at a = 2 the dot table is the pre-FX4 one, dot for dot (the mocks stay cell for cell)', () => {
    const now = gaugeCells(MOCK_ASPECT).map(c => c.map(([x, y, t]) => `${x},${y},${t}`).join(';'))
    expect(now).toEqual(legacy())
  })

  test('at a = 2.35 the ring is round within 5 % in pixels, and at 2.0 and the other four aspects too', () => {
    for (const a of [2, 2.1, 2.2, 2.35, 2.4]) {
      setCellAspect(a)
      const r = ratio(gaugeRing(100), a)
      expect(Math.abs(r - 1)).toBeLessThan(0.05)
    }
    setCellAspect(2.2)
  })

  test('the box stays 9 x 5 and no cell takes more than two colours, at every aspect and fill', () => {
    for (const a of [2, 2.1, 2.2, 2.35, 2.4]) {
      setCellAspect(a)
      for (const p of [0, 1, 25, 50, 62, 69, 90, 100]) {
        const g = gaugeRing(p)
        expect([g.columns, g.rows]).toEqual([GAUGE_RING.columns, GAUGE_RING.rows])
        for (const [, fg, bg] of cellsOf(g)) expect(new Set([fg, bg]).size).toBeLessThanOrEqual(2)
      }
    }
    setCellAspect(2.2)
  })

  test('the ring is still clockwise from the top: a quarter lights the upper right and no left dot', () => {
    setCellAspect(2.35)
    const g = gaugeRing(25, { hue: 'red' })
    const lit = cellsOf(g).flatMap(([cp, fg], i) => (cp >= 0x2801 && fg === g.col('red') ? [i % g.columns] : []))
    expect(lit.length).toBeGreaterThan(0)
    expect(Math.min(...lit)).toBeGreaterThanOrEqual(4)
    setCellAspect(2.2)
  })

  test('the dot pictures at 2.0 and 2.35 (full ring)', () => {
    for (const a of [2, 2.35]) {
      setCellAspect(a)
      const g = gaugeRing(100)
      // eslint-disable-next-line no-console
      if (process.env.FX4_PICTURE) console.log(`a=${a} ratio=${ratio(g, a).toFixed(3)}\n${braille(g).join('\n')}`)
      expect(braille(g)).toHaveLength(5)
    }
    setCellAspect(2.2)
  })

  test('the aspect is cached: 2.2 until set, and a bad value falls back to 2.2', () => {
    setCellAspect(2.35)
    expect(getCellAspect()).toBe(2.35)
    setCellAspect(Number.NaN)
    expect(getCellAspect()).toBe(2.2)
    expect(gaugeCells(2.35)).toBe(gaugeCells(2.35))
  })
})

describe('the cell aspect from the terminal (FX4)', () => {
  test('Windows Terminal 2.35, VS Code 2.4, the Mac and GPU terminals 2.1, else 2.2', () => {
    expect(aspectFromEnv({ WT_SESSION: 'abc' })).toBe(2.35)
    expect(aspectFromEnv({ TERM_PROGRAM: 'vscode' })).toBe(2.4)
    for (const tp of ['iTerm.app', 'Apple_Terminal', 'WezTerm', 'ghostty']) expect(aspectFromEnv({ TERM_PROGRAM: tp })).toBe(2.1)
    expect(aspectFromEnv({ TERM: 'xterm-kitty' })).toBe(2.1)
    expect(aspectFromEnv({ TERM: 'xterm-256color' })).toBe(2.2)
    expect(aspectFromEnv({})).toBe(2.2)
    expect(aspectFromEnv({ WT_SESSION: '', TERM_PROGRAM: 'vscode' })).toBe(2.4)
  })
})
