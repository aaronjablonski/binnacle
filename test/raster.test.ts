import { describe, expect, test } from 'vitest'

import {
  BRAILLE_BASE,
  DEFAULT,
  Grid,
  PALETTE,
  QUAD,
  ROLES,
  SPRITE,
  STATES,
  bars,
  beads,
  brailleGlyph,
  cellsOf,
  decode,
  encode,
  lintel,
  lintelRoom,
  quadGlyph,
  ring,
  RING,
  rpill,
  sill,
  sprite,
  stack,
  type Size,
} from '../mod/hooks/views/raster'

const N = PALETTE.night
const cp = (s: string) => s.codePointAt(0)!

/** The resolved cells of one row, as text. */
const rowText = (g: Grid, row: number) =>
  cellsOf(g)
    .slice(row * g.columns, (row + 1) * g.columns)
    .map(([c]) => String.fromCodePoint(c))
    .join('')

describe('glyph pickers', () => {
  test('all 16 quadrant glyphs, bit 1 top-left, 2 top-right, 4 bottom-left, 8 bottom-right', () => {
    const want = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█'
    for (let bits = 0; bits < 16; bits++) expect(quadGlyph(bits)).toBe(want[bits])
    expect(new Set([...want]).size).toBe(16)
    expect(QUAD).toBe(want)
  })

  test('all 256 Braille glyphs sit at U+2800 plus the bits', () => {
    const seen = new Set<string>()
    for (let bits = 0; bits < 256; bits++) {
      const g = brailleGlyph(bits)
      expect(g.codePointAt(0)).toBe(BRAILLE_BASE + bits)
      expect([...g]).toHaveLength(1)
      seen.add(g)
    }
    expect(seen.size).toBe(256)
  })

  test('pickers refuse values out of range', () => {
    expect(() => quadGlyph(16)).toThrow()
    expect(() => quadGlyph(-1)).toThrow()
    expect(() => brailleGlyph(256)).toThrow()
    expect(() => brailleGlyph(1.5)).toThrow()
  })
})

describe('cell rules', () => {
  test('a quadrant cell with three colours is refused', () => {
    const g = new Grid(1, 1, N)
    g.sp(0, 0, 'iris')
    g.sp(1, 0, 'ember')
    g.sp(0, 1, 'mint')
    expect(() => encode(g)).toThrow(/colours/)
  })

  test('a quadrant cell with two colours and a gap is refused (the default counts)', () => {
    const g = new Grid(1, 1, N)
    g.sp(0, 0, 'iris')
    g.sp(1, 0, 'ember')
    expect(() => encode(g)).toThrow(/colours/)
  })

  test('a Braille cell in two colours is refused', () => {
    const g = new Grid(1, 1, N)
    g.dot(0, 0, 'iris')
    expect(() => g.dot(1, 3, 'ember')).toThrow(/Braille/)
  })

  test('a cell mixing two kinds of glyph is refused', () => {
    const g = new Grid(1, 1, N)
    g.sp(0, 0, 'iris')
    g.dot(1, 1, 'iris')
    expect(() => encode(g)).toThrow(/kinds/)
  })

  test('a glyph must be one width-1 BMP character', () => {
    const g = new Grid(4, 1, N)
    expect(() => g.glyph(0, 0, 'ab', 'ink')).toThrow()
    expect(() => g.glyph(0, 0, '😀', 'ink')).toThrow()
    expect(() => g.glyph(0, 0, '中', 'ink')).toThrow()
    expect(() => g.glyph(0, 0, '\t', 'ink')).toThrow()
    expect(() => g.glyph(0, 0, '́', 'ink')).toThrow()
    g.glyph(0, 0, '?', 'badge', 'amber')
    expect(cellsOf(g)[0]).toEqual([cp('?'), N.badge, N.amber])
  })

  test('drawing outside the grid is refused', () => {
    const g = new Grid(2, 1, N)
    expect(() => g.sp(4, 0, 'iris')).toThrow(/outside/)
    expect(() => g.glyph(2, 0, 'x', 'ink')).toThrow(/outside/)
  })

  test('a grid is 1 to 512 columns and 1 to 256 rows', () => {
    expect(() => new Grid(0, 1, N)).toThrow()
    expect(() => new Grid(513, 1, N)).toThrow()
    expect(() => new Grid(1, 257, N)).toThrow()
    expect(new Grid(512, 256, N).columns).toBe(512)
  })

  test('more than 1024 colour pairs is refused', () => {
    const g = new Grid(512, 3, N)
    for (let i = 0; i < 1025; i++) g.glyph(i % 512, Math.floor(i / 512), 'x', i + 1)
    expect(() => encode(g)).toThrow(/1024/)
  })

  test('a quadrant cell picks the glyph from the bits of its colour, the other colour behind', () => {
    const g = new Grid(3, 1, N)
    g.sp(0, 1, 'iris') // bottom-left
    g.sp(1, 1, 'iris') // bottom-right: ▄
    g.sp(2, 0, 'iris')
    g.sp(3, 0, 'iris')
    g.sp(2, 1, 'ember')
    g.sp(3, 1, 'ember') // two colours, no gap
    g.sp(4, 0, 'mint') // top-left of cell 2
    const cells = cellsOf(g)
    expect(cells[0]).toEqual([cp('▄'), N.iris, DEFAULT])
    expect(cells[1]![1]).not.toBe(DEFAULT)
    expect(cells[1]![2]).not.toBe(DEFAULT)
    expect([cp('▀'), cp('▄')]).toContain(cells[1]![0])
    expect(cells[2]).toEqual([cp('▘'), N.mint, DEFAULT])
  })

  test('levels, hairlines and blanks', () => {
    const g = new Grid(10, 1, N)
    for (let n = 1; n <= 8; n++) g.lv(n - 1, 0, n, 'iris')
    g.ht(8, 0, 'rest')
    expect(rowText(g, 0)).toBe('▁▂▃▄▅▆▇█▔ ')
    expect(cellsOf(g)[9]).toEqual([0x20, DEFAULT, DEFAULT])
  })
})

describe('encode', () => {
  test('length is columns x rows x 12 bytes, base64 with no padding', () => {
    for (const [c, r] of [[1, 1], [7, 4], [22, 1], [62, 1], [9, 4]] as const) {
      const g = new Grid(c, r, N)
      const s = encode(g)
      expect(s.length).toBe((c * r * 12 * 4) / 3)
      expect(s).toMatch(/^[A-Za-z0-9+/]*$/)
      expect(decode(s)).toHaveLength(c * r)
    }
  })

  test('round trip: decode(encode(g)) is cellsOf(g)', () => {
    const g = ring('5H', 78)
    expect(decode(encode(g))).toEqual(cellsOf(g))
    const s = sprite('lead', 'waiting', 'L')
    expect(decode(encode(s))).toEqual(cellsOf(s))
  })

  test('little-endian u32 triplets: one orange cell is the type file example', () => {
    const g = new Grid(1, 1, N)
    g.glyph(0, 0, '█', 0xff8800)
    const bytes = Uint8Array.of(0x88, 0x25, 0, 0, 0x00, 0x88, 0xff, 0, 0, 0, 0, 0x01)
    expect(encode(g)).toBe(Buffer.from(bytes).toString('base64'))
  })
})

describe('sprites', () => {
  const sizes: Size[] = ['L', 'S']

  test('every role x state x size passes the cell rules and has its stated size', () => {
    expect(SPRITE.L).toEqual({ columns: 9, rows: 4, body: 8 })
    expect(SPRITE.S).toEqual({ columns: 5, rows: 2, body: 4 })
    let n = 0
    for (const pal of [PALETTE.night, PALETTE.day])
      for (const role of ROLES)
        for (const state of STATES)
          for (const size of sizes)
            for (const lamp of ['on', 'dim'] as const) {
              const g = sprite(role, state, size, { pal, lamp })
              expect([g.columns, g.rows]).toEqual([SPRITE[size].columns, SPRITE[size].rows])
              expect(encode(g).length).toBe((g.columns * g.rows * 12 * 4) / 3)
              n++
            }
    expect(n).toBe(2 * 4 * 6 * 2 * 2)
  })

  // The body's outline: every painted sub-pixel and dot, filled in from the
  // outside (an outline sprite has the same outer edge as a solid one), the
  // badge column left out.
  function silhouette(g: Grid, body: number): string {
    const W = body * 2
    const H = g.rows * 2
    const painted = (x: number, y: number) => g.cell(x >> 1, y >> 1).q[(y & 1) * 2 + (x & 1)] !== undefined
    const outside = new Set<string>()
    const todo: [number, number][] = []
    for (let x = -1; x <= W; x++) todo.push([x, -1], [x, H])
    for (let y = 0; y < H; y++) todo.push([-1, y], [W, y])
    while (todo.length > 0) {
      const [x, y] = todo.pop()!
      const k = `${x},${y}`
      if (outside.has(k)) continue
      if (x >= 0 && x < W && y >= 0 && y < H && painted(x, y)) continue
      if (x < -1 || x > W || y < -1 || y > H) continue
      outside.add(k)
      todo.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1])
    }
    let mask = ''
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) mask += outside.has(`${x},${y}`) ? '.' : '#'
      mask += '\n'
    }
    let dots = ''
    for (let row = 0; row < g.rows; row++)
      for (let col = 0; col < body; col++) dots += (g.cell(col, row).dots ?? 0).toString(16).padStart(2, '0')
    return mask + dots
  }

  test('state changes lamp, colour and badge, never the body silhouette', () => {
    for (const role of ROLES)
      for (const size of sizes) {
        const body = SPRITE[size].body
        const base = silhouette(sprite(role, 'working', size), body)
        expect(base).toContain('#')
        for (const state of STATES) expect(silhouette(sprite(role, state, size), body), `${role} ${state} ${size}`).toBe(base)
        const working = cellsOf(sprite(role, 'working', size))
        const done = cellsOf(sprite(role, 'done', size))
        expect(working).not.toEqual(done)
      }
  })

  test('the badge is one letter cell beside the top right corner', () => {
    const want = { queued: ' ', working: ' ', done: ' ', waiting: '?', stalled: 'z', failed: '!' }
    for (const role of ROLES)
      for (const size of sizes)
        for (const state of STATES) {
          const g = sprite(role, state, size)
          const badgeCol = SPRITE[size].body
          expect(rowText(g, 0)[badgeCol], `${role} ${state} ${size}`).toBe(want[state])
          for (let row = 1; row < g.rows; row++) expect(rowText(g, row)[badgeCol]).toBe(' ')
        }
  })

  test('working is the accent (lead in ember) with a white lamp; dim lamp differs only in the lamp', () => {
    const lead = cellsOf(sprite('lead', 'working', 'L'))
    const fgs = new Set(lead.map(c => c[1]))
    expect(fgs.has(N.lamp) || new Set(lead.map(c => c[2])).has(N.lamp)).toBe(true)
    const scout = cellsOf(sprite('scout', 'working', 'L'))
    expect(scout.some(c => c[1] === N.iris || c[2] === N.iris)).toBe(true)
    const on = cellsOf(sprite('build', 'working', 'L', { lamp: 'on' }))
    const dim = cellsOf(sprite('build', 'working', 'L', { lamp: 'dim' }))
    const changed = on.filter((c, i) => JSON.stringify(c) !== JSON.stringify(dim[i]))
    expect(changed.length).toBeGreaterThan(0)
    expect(changed.every(c => c[1] === N.lamp || c[2] === N.lamp)).toBe(true)
  })

  test('failed has a red lamp, queued and done have none lit', () => {
    const has = (g: Grid, c: number) => cellsOf(g).some(x => x[1] === c || x[2] === c)
    expect(has(sprite('scout', 'failed', 'L'), N.red)).toBe(true)
    for (const s of ['queued', 'done', 'stalled'] as const) expect(has(sprite('scout', s, 'L'), N.lamp)).toBe(false)
  })
})

describe('ring', () => {
  // Lit cells of the 18 ring cells, from gen-rich.js's own ring() run at these values.
  const LIT = {
    0: [],
    42: ['4,0', '5,0', '5,1', '5,2', '5,3', '6,1', '6,2'],
    78: ['0,2', '1,2', '1,3', '2,3', '3,3', '4,0', '4,3', '5,0', '5,1', '5,2', '5,3', '6,1', '6,2'],
    96: ['0,1', '0,2', '1,0', '1,1', '1,2', '1,3', '2,0', '2,3', '3,3', '4,0', '4,3', '5,0', '5,1', '5,2', '5,3', '6,1', '6,2'],
    100: ['0,1', '0,2', '1,0', '1,1', '1,2', '1,3', '2,0', '2,3', '3,0', '3,3', '4,0', '4,3', '5,0', '5,1', '5,2', '5,3', '6,1', '6,2'],
  } as const

  test('is 7 x 4 cells of Braille with 18 ring cells', () => {
    expect(RING).toEqual({ columns: 7, rows: 4 })
    const g = ring('5H', 42)
    expect([g.columns, g.rows]).toEqual([7, 4])
    let n = 0
    for (let row = 0; row < 4; row++) for (let col = 0; col < 7; col++) if (g.cell(col, row).dots) n++
    expect(n).toBe(18)
  })

  test.each([0, 42, 78, 96, 100] as const)('quantises %i %% to the generator\'s lit cells', pct => {
    const g = ring('CTX', pct)
    const hue = N[pct >= 90 ? 'red' : pct >= 70 ? 'amber' : 'iris']
    const lit: string[] = []
    for (let row = 0; row < 4; row++)
      for (let col = 0; col < 7; col++) {
        const c = g.cell(col, row)
        if (!c.dots) continue
        if (c.fg === hue) lit.push(`${col},${row}`)
        else expect(c.fg).toBe(N.rest)
      }
    expect(lit.sort()).toEqual([...LIT[pct]])
  })

  test('the name and the figure sit in the three middle cells of rows 1 and 2', () => {
    expect(rowText(ring('CTX', 42), 1).slice(2, 5)).toBe('CTX')
    expect(rowText(ring('CTX', 42), 2).slice(2, 5)).toBe('42%')
    expect(rowText(ring('5H', 0), 1).slice(2, 5)).toBe('5H ')
    expect(rowText(ring('5H', 0), 2).slice(2, 5)).toBe('0% ')
    expect(rowText(ring('7D', 100), 2).slice(2, 5)).toBe('100')
    expect(rowText(ring('7D', 96), 2).slice(2, 5)).toBe('96%')
  })

  test('the figure takes the hue from 70 %, ink below; the name is mute unless asked', () => {
    const fig = (g: Grid) => cellsOf(g)[2 * 7 + 3]![1]
    expect(fig(ring('5H', 42))).toBe(N.ink)
    expect(fig(ring('5H', 78))).toBe(N.amber)
    expect(fig(ring('5H', 96))).toBe(N.red)
    expect(cellsOf(ring('5H', 42))[7 + 2]![1]).toBe(N.mute)
    expect(cellsOf(ring('5H', 42, { nameHue: 'amber' }))[7 + 2]![1]).toBe(N.amber)
  })

  test('any non-zero value lights a cell; a long name is refused', () => {
    const lit = (g: Grid) => cellsOf(g).filter(c => c[0] > BRAILLE_BASE && c[1] !== N.rest).length
    expect(lit(ring('', 1))).toBe(1)
    expect(() => ring('CTXX', 10)).toThrow()
  })
})

describe('meters', () => {
  const litBeads = (g: Grid, hue: number) => {
    let n = 0
    for (let i = 0; i < g.columns; i += 2) if (cellsOf(g)[i]![1] === hue) n++
    return n
  }

  test('beads: 22 cells is 11 beads of ▄▖; non-zero lights one, only 100 lights all', () => {
    const g = beads(22, 37)
    expect([g.columns, g.rows]).toEqual([22, 1])
    expect(rowText(g, 0)).toBe('▄▖'.repeat(11))
    expect(litBeads(beads(22, 0), N.iris)).toBe(0)
    expect(litBeads(beads(22, 1), N.iris)).toBe(1)
    expect(litBeads(beads(22, 37), N.iris)).toBe(4)
    expect(litBeads(beads(22, 50), N.iris)).toBe(5)
    expect(litBeads(beads(22, 78), N.amber)).toBe(8)
    expect(litBeads(beads(22, 99), N.red)).toBe(10)
    expect(litBeads(beads(22, 100), N.red)).toBe(11)
    expect(litBeads(beads(10, 50, 'mint'), N.mint)).toBe(2)
    const unlit = cellsOf(beads(22, 37)).slice(8)
    expect(unlit.every(c => c[1] === N.rest)).toBe(true)
  })

  test('stack: parts share the cells by largest remainder', () => {
    const g = stack(22, [[412, 'mint'], [61, 'orchid'], [55, 'mute']])
    const fgs = cellsOf(g).map(c => c[1])
    expect(fgs.filter(c => c === N.mint)).toHaveLength(17)
    expect(fgs.filter(c => c === N.orchid)).toHaveLength(3)
    expect(fgs.filter(c => c === N.mute)).toHaveLength(2)
    expect(rowText(g, 0)).toBe('▄'.repeat(22))
    expect(rowText(stack(5, []), 0)).toBe('     ')
  })

  test('bars: one column a value, eighth blocks, a rest tick for zero', () => {
    const g = bars(1, [2, 4, 8, 0])
    expect([g.columns, g.rows]).toEqual([4, 1])
    expect(rowText(g, 0)).toBe('▂▄█▁')
    expect(cellsOf(g)[3]![1]).toBe(N.rest)
    expect(cellsOf(g)[2]![1]).toBe(N.iris)
  })

  test('bars: rows stack the levels, pitch spreads the columns, hueOf colours them', () => {
    const g = bars(2, [1, 8, 0], { pitch: 2, hueOf: i => (i === 1 ? 'red' : 'iris') })
    expect([g.columns, g.rows]).toEqual([6, 2])
    expect(rowText(g, 0)).toBe('  █   ')
    expect(rowText(g, 1)).toBe('▂ █ ▁ ')
    expect(cellsOf(g)[2]![1]).toBe(N.red)
    expect(cellsOf(g)[6 + 4]![1]).toBe(N.rest)
    expect(cellsOf(g)[6]![1]).toBe(N.iris)
    expect(bars(3, [5, 0]).rows).toBe(3)
    expect(() => bars(4, [1])).toThrow()
  })
})

describe('pill and frame', () => {
  test('rpill: half-cell caps around letters on the colour', () => {
    const g = rpill('WORKING', 'iris')
    expect([g.columns, g.rows]).toEqual([9, 1])
    expect(rowText(g, 0)).toBe('▐WORKING▌')
    expect(cellsOf(g)[1]).toEqual([cp('W'), N.badge, N.iris])
    expect(cellsOf(g)[0]).toEqual([cp('▐'), N.iris, DEFAULT])
  })

  test('lintel: a clamp, a hairline, the pill at its column, the readout at the right', () => {
    const g = lintel(62, { pill: 'WORKING', right: 'turn 6 41m' })
    expect([g.columns, g.rows]).toEqual([62, 1])
    const s = rowText(g, 0)
    expect(s.slice(0, 4)).toBe('█▀▀▀')
    expect(s.slice(12, 22)).toBe(' ▐WORKING▌')
    expect(s[22]).toBe(' ')
    expect(s.slice(49, 61)).toBe(' turn 6 41m ')
    expect(s.slice(23, 49)).toBe('▔'.repeat(26))
    expect(cellsOf(g)[0]![1]).toBe(N.iris)
    expect(cellsOf(lintel(30, { hue: 'amber' }))[0]![1]).toBe(N.amber)
    expect(rowText(lintel(10, {}), 0)).toBe('█▀▀▀▔▔▔▔▔▔')
  })

  test('lintel never collides: any width, pill, pill column and readout resolve to cells', () => {
    for (let width = 4; width <= 80; width++) {
      for (const pill of [undefined, 'WORKING', 'NEEDS YOU 12', 'ALL DONE']) {
        for (const right of ['', 'turn 6 41m', 'artifact 12 of 30']) {
          for (const pillCol of [2, 13]) {
            for (const clamp of [1, 3]) {
              const o = { pillCol, clamp, right, ...(pill !== undefined ? { pill } : {}) }
              expect(() => cellsOf(lintel(width, o)), `width ${width} ${JSON.stringify(o)}`).not.toThrow()
            }
          }
        }
      }
    }
  })

  test('lintelRoom: the pill only where it fits, the readout only where it clears the pill', () => {
    // Pill WORKING at 13 ends at 22: it needs 23 columns; the readout needs 3 more than its length past 22.
    expect(lintelRoom(22, { pill: 'WORKING' }).pill).toBe(false)
    expect(lintelRoom(23, { pill: 'WORKING' }).pill).toBe(true)
    expect(lintelRoom(35, { pill: 'WORKING' }).right).toBe(35 - 3 - 22)
    // Without a pill the readout clears the clamp.
    expect(lintelRoom(20, {}).right).toBe(20 - 4 - 3)
    expect(lintelRoom(20, { clamp: 1 }).right).toBe(20 - 4 - 1)
    // A readout too long for the room is left out of the drawing, the pill kept.
    const s = rowText(lintel(30, { pill: 'WORKING', right: 'artifact 12 of 30' }), 0)
    expect(s.slice(12, 22)).toBe(' ▐WORKING▌')
    expect(s).not.toContain('artifact')
  })

  test('sill: a hairline that ends in the mirrored clamp; sweep brightens the cells near it', () => {
    const g = sill(20)
    expect(rowText(g, 0)).toBe('▁'.repeat(16) + '▄▄▄█')
    const swept = cellsOf(sill(20, { sweep: 5 }))
    expect(swept.filter(c => c[1] === N.ink)).toHaveLength(5)
    expect(swept[5]![1]).toBe(N.ink)
  })
})

describe('palette', () => {
  test('six hues on both grounds, three neutrals per ground, all 0x00RRGGBB', () => {
    expect(PALETTE.night.ember).toBe(0xe07b53)
    expect(PALETTE.night.mute).toBe(0x5d6679)
    expect(PALETTE.day.mute).toBe(0xa3a9b8)
    expect(PALETTE.day.iris).toBe(0x6f82f2)
    for (const p of [PALETTE.night, PALETTE.day]) for (const v of Object.values(p)) expect(v >>> 24).toBe(0)
  })
})
