// The Raster engine: pure cell grids for the rich instruments, no `$`.
//
// A Raster is a fixed box of terminal cells; each cell is one width-1 BMP
// glyph with a foreground and a background (RasterProps in the type file).
// A Grid holds what was drawn into each cell, in one of five kinds:
//
//   q      quadrant sub-pixels, 2 x 2 to a cell (`sp`, and `px` for a half
//          block): two colours to a cell, the terminal default counting as one
//   dots   Braille dots, 2 x 4 to a cell, one colour on the default ground
//   lv     an eighth-block level, 1 to 8, from the bottom
//   ht     the upper hairline `▔`
//   ch     a letter on a colour (badges, pill words, ring figures)
//
// `encode` checks the cell rules (one kind per cell, at most two colours,
// at most 1024 colour pairs) and packs the cells as the engine reads them.
// Ported from the mock generator `gen-rich.js` (its SHAPES, DOTS, palettes,
// ring, beads and frame), which every board was checked against.

/** The terminal's own colour (bit 24 alone), as RasterProps spells it. */
export const DEFAULT = 0x01000000

/** Bytes per cell in a Raster's `cells`: three little-endian u32s. */
export const CELL_BYTES = 12

export type Hue = 'iris' | 'irisSoft' | 'irisDeep' | 'ember' | 'teal' | 'amber' | 'red' | 'mint' | 'orchid'
export type Neutral = 'mute' | 'rest' | 'rule' | 'ink' | 'dim' | 'lamp' | 'badge' | 'ground'
export type Palette = Record<Hue | Neutral, number>
/** A colour: a palette key, or `0x00RRGGBB`. */
export type Ink = keyof Palette | number

/**
 * The cockpit palette for Rasters (cockpit spec "Palette"): one accent in
 * three strengths (`iris`, `irisSoft`, `irisDeep`), three status hues, the
 * neutrals of each ground. `ember`, `teal` and `orchid` are crew art only
 * (owner ruling 1, R20): role hues inside a critter, never in text; ember
 * means the lead. A Raster's background is always the terminal default, so
 * `ground` is only what tones are mixed toward.
 */
export const PALETTE: { night: Palette; day: Palette } = {
  night: {
    iris: 0x8f9eff, irisSoft: 0x5a659f, irisDeep: 0x2c3254,
    ember: 0xe07b53, teal: 0x3fbdb4, orchid: 0xb48cf2,
    amber: 0xe3b04b, red: 0xef6b7e, mint: 0x4fbf93,
    ink: 0xd7dbe5, dim: 0x8a92a6, mute: 0x5b6478, rule: 0x333a4c, rest: 0x272c3a,
    lamp: 0xffffff, badge: 0x16181d, ground: 0x15171c,
  },
  day: {
    iris: 0x5364e8, irisSoft: 0x9aa5ee, irisDeep: 0xdfe3fb,
    ember: 0xe07b53, teal: 0x2aa69d, orchid: 0xa078e6,
    amber: 0xb9790f, red: 0xcf3550, mint: 0x1e8f66,
    ink: 0x262a35, dim: 0x687083, mute: 0xa4aab9, rule: 0xd3d7df, rest: 0xe3e5ea,
    lamp: 0xffffff, badge: 0x16181d, ground: 0xf7f6f2,
  },
}

/** The ground a Raster is mixed for: `style.ts` `groundOf` resolves the `ground` option. */
export type Ground = 'night' | 'day'

/** The three strengths of the structural accent (`iris`, `irisSoft`, `irisDeep`); the Accent option swaps them. */
export type AccentHues = Pick<Palette, 'iris' | 'irisSoft' | 'irisDeep'>

/**
 * The Accent option in Rasters (R35): iris is the palette's own; sky reads like the theme's `ide` blue and
 * slate like `promptBorder`'s grey-blue, each in the three strengths on both grounds. Only the structural
 * accent changes (lintel, sill, gauges, bars): role hues inside a critter come from `CREW_PALETTE` and never do.
 */
export const ACCENT_HUES: Record<'iris' | 'sky' | 'slate', Record<Ground, AccentHues>> = {
  iris: {
    night: { iris: PALETTE.night.iris, irisSoft: PALETTE.night.irisSoft, irisDeep: PALETTE.night.irisDeep },
    day: { iris: PALETTE.day.iris, irisSoft: PALETTE.day.irisSoft, irisDeep: PALETTE.day.irisDeep },
  },
  sky: {
    night: { iris: 0x7ab8f5, irisSoft: 0x4a7399, irisDeep: 0x24394d },
    day: { iris: 0x2f7fc7, irisSoft: 0x93bde3, irisDeep: 0xdcebf8 },
  },
  slate: {
    night: { iris: 0xa0acbf, irisSoft: 0x666f7e, irisDeep: 0x30353e },
    day: { iris: 0x5f6d83, irisSoft: 0xa6b0bf, irisDeep: 0xe3e7ed },
  },
}

/** The Raster palette of a ground with the structural accent of `accent` (iris when unknown). */
export function accentPalette(ground: Ground, accent: string): Palette {
  const hues = Object.hasOwn(ACCENT_HUES, accent) ? ACCENT_HUES[accent as keyof typeof ACCENT_HUES] : ACCENT_HUES.iris
  return { ...PALETTE[ground], ...hues[ground] }
}

/** A meter's hue by how full it is: red from 90 %, amber from 70 %, else iris. */
export function rate(pct: number): Hue {
  if (pct >= 90) return 'red'
  if (pct >= 70) return 'amber'
  return 'iris'
}

/** `a` moved toward `b` by `t` (0 to 1), channel by channel. */
export function mix(a: number, b: number, t: number): number {
  let out = 0
  for (const shift of [16, 8, 0]) {
    const x = (a >> shift) & 255
    const y = (b >> shift) & 255
    out |= Math.round(x + (y - x) * t) << shift
  }
  return out
}

// ---------- glyph pickers ----------

/** Quadrant glyphs by bits: top-left 1, top-right 2, bottom-left 4, bottom-right 8. */
export const QUAD = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█'

export const BRAILLE_BASE = 0x2800

/** Braille dot bits by [column][row] in a cell of 2 x 4 dots. */
export const DOT_BITS: readonly (readonly number[])[] = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]

const EIGHTHS = '▁▂▃▄▅▆▇█'
const HAIRLINE = '▔'

function assertInt(n: number, lo: number, hi: number, what: string): void {
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${what} ${n} is not an integer in ${lo}..${hi}`)
}

export function quadGlyph(bits: number): string {
  assertInt(bits, 0, 15, 'quadrant bits')
  return QUAD[bits]!
}

export function brailleGlyph(bits: number): string {
  assertInt(bits, 0, 255, 'Braille bits')
  return String.fromCharCode(BRAILLE_BASE + bits)
}

// East Asian Wide and emoji-presentation ranges of the BMP: two cells wide.
const WIDE: readonly [number, number][] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
]

// Zero-width: combining marks, joiners, variation selectors.
const ZERO: readonly [number, number][] = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a], [0x064b, 0x065f], [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0x20d0, 0x20ff], [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f], [0xfeff, 0xfeff],
]

const within = (cp: number, ranges: readonly [number, number][]) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi)

/** Throws unless `ch` is one printable width-1 BMP character. */
export function assertGlyph(ch: string): number {
  const units = [...ch]
  if (units.length !== 1) throw new Error(`a cell holds one character, not ${JSON.stringify(ch)}`)
  const cp = ch.codePointAt(0)!
  if (cp > 0xffff) throw new Error(`U+${cp.toString(16)} is outside the BMP`)
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) throw new Error(`U+${cp.toString(16)} is a control character`)
  if (cp >= 0xd800 && cp <= 0xdfff) throw new Error(`U+${cp.toString(16)} is a surrogate`)
  if (within(cp, ZERO)) throw new Error(`U+${cp.toString(16)} has no width`)
  if (within(cp, WIDE)) throw new Error(`U+${cp.toString(16)} is two cells wide`)
  return cp
}

// ---------- the grid ----------

/** What has been drawn into one cell; at most one kind may be set. */
export type Cell = {
  /** Quadrant sub-pixels: top-left, top-right, bottom-left, bottom-right. */
  q: (number | undefined)[]
  /** Braille dot bits, with `fg` their one colour. */
  dots?: number
  /** An eighth-block level, 0 to 8, with `fg` and an optional `bg`. */
  lv?: number
  /** The hairline `▔`, in `fg`. */
  ht?: boolean
  /** A letter, in `fg` on `bg` (the default when absent). */
  ch?: string
  fg?: number
  bg?: number
}

/** A resolved cell: what the engine reads, `[codePoint, foreground, background]`. */
export type Triple = [codePoint: number, fg: number, bg: number]

export class Grid {
  readonly columns: number
  readonly rows: number
  readonly pal: Palette
  private readonly grid: Cell[]

  constructor(columns: number, rows: number, pal: Palette = PALETTE.night) {
    assertInt(columns, 1, 512, 'columns')
    assertInt(rows, 1, 256, 'rows')
    this.columns = columns
    this.rows = rows
    this.pal = pal
    this.grid = Array.from({ length: columns * rows }, () => ({ q: [undefined, undefined, undefined, undefined] }))
  }

  /** The colour an ink names on this grid's palette. */
  col(k: Ink): number {
    if (typeof k === 'number') {
      if (!Number.isInteger(k) || k < 0 || k > 0xffffff) throw new Error(`colour ${k} is not 0x00RRGGBB`)
      return k
    }
    return this.pal[k]
  }

  /** The cell at column `x`, row `row`; throws outside the grid. */
  cell(x: number, row: number): Cell {
    if (!Number.isInteger(x) || !Number.isInteger(row) || x < 0 || x >= this.columns || row < 0 || row >= this.rows) {
      throw new Error(`cell ${x},${row} is outside ${this.columns}x${this.rows}`)
    }
    return this.grid[row * this.columns + x]!
  }

  /** A quadrant sub-pixel: `x` in half cells, `y` in half rows. */
  sp(x: number, y: number, k: Ink): void {
    this.cell(x >> 1, y >> 1).q[(y & 1) * 2 + (x & 1)] = this.col(k)
  }

  /** A half-block pixel: cell column `x`, `y` in half rows (both quadrants of that half). */
  px(x: number, y: number, k: Ink): void {
    const q = this.cell(x, y >> 1).q
    const c = this.col(k)
    if (y & 1) {
      q[2] = c
      q[3] = c
    } else {
      q[0] = c
      q[1] = c
    }
  }

  /** The left quadrant of a half-block pixel. */
  pxL(x: number, y: number, k: Ink): void {
    this.cell(x, y >> 1).q[y & 1 ? 2 : 0] = this.col(k)
  }

  /** The right quadrant of a half-block pixel. */
  pxR(x: number, y: number, k: Ink): void {
    this.cell(x, y >> 1).q[y & 1 ? 3 : 1] = this.col(k)
  }

  /** A whole cell in one colour. */
  full(x: number, row: number, k: Ink): void {
    this.px(x, row * 2, k)
    this.px(x, row * 2 + 1, k)
  }

  /** A Braille dot: `x` in dot columns (2 a cell), `y` in dot rows (4 a cell); one colour a cell. */
  dot(x: number, y: number, k: Ink): void {
    const c = this.cell(x >> 1, y >> 2)
    const fg = this.col(k)
    if (c.dots !== undefined && c.fg !== fg) throw new Error(`Braille cell ${x >> 1},${y >> 2} needs two colours`)
    c.dots = (c.dots ?? 0) | DOT_BITS[x & 1]![y & 3]!
    c.fg = fg
  }

  /** An eighth-block level from the bottom, 0 to 8. */
  lv(x: number, row: number, n: number, k: Ink, bg?: Ink): void {
    const c = this.cell(x, row)
    c.lv = Math.max(0, Math.min(8, Math.round(n)))
    c.fg = this.col(k)
    if (bg !== undefined) c.bg = this.col(bg)
  }

  /** The upper hairline. */
  ht(x: number, row: number, k: Ink): void {
    const c = this.cell(x, row)
    c.ht = true
    c.fg = this.col(k)
  }

  /** One letter on a colour. */
  glyph(x: number, row: number, ch: string, fg: Ink, bg?: Ink): void {
    assertGlyph(ch)
    const c = this.cell(x, row)
    c.ch = ch
    c.fg = this.col(fg)
    if (bg !== undefined) c.bg = this.col(bg)
  }

  /** Letters from `x`; returns the column after the last. */
  word(x: number, row: number, s: string, fg: Ink, bg?: Ink): number {
    const chars = [...s]
    chars.forEach((ch, i) => this.glyph(x + i, row, ch, fg, bg))
    return x + chars.length
  }
}

const QUAD_KIND = (c: Cell) => c.q.some(v => v !== undefined)

function kindsOf(c: Cell): number {
  return [QUAD_KIND(c), c.dots !== undefined, c.lv !== undefined, c.ht === true, c.ch !== undefined].filter(Boolean).length
}

/** One quadrant cell: the commonest colour as the glyph, the other (or the default) behind. */
function quadTriple(c: Cell, where: string): Triple {
  const counts = new Map<number, number>()
  let empties = 0
  for (const v of c.q) {
    if (v === undefined) empties++
    else counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  const colours = counts.size + (empties > 0 ? 1 : 0)
  if (colours > 2) throw new Error(`cell ${where} needs ${colours} colours`)
  // Map keeps first-seen order, so a tie goes to the colour met first.
  let fg = -1
  let best = 0
  for (const [col, n] of counts) {
    if (n > best) {
      fg = col
      best = n
    }
  }
  let bits = 0
  c.q.forEach((v, i) => {
    if (v === fg) bits |= 1 << i
  })
  let bg = DEFAULT
  for (const col of counts.keys()) if (col !== fg) bg = col
  return [QUAD.codePointAt(bits)!, fg, bg]
}

function tripleOf(c: Cell, where: string): Triple {
  if (kindsOf(c) > 1) throw new Error(`cell ${where} mixes two kinds of glyph`)
  if (QUAD_KIND(c)) return quadTriple(c, where)
  if (c.dots !== undefined) return [BRAILLE_BASE + c.dots, c.fg!, DEFAULT]
  if (c.lv !== undefined) return [c.lv === 0 ? 0x20 : EIGHTHS.codePointAt(c.lv - 1)!, c.fg!, c.bg ?? DEFAULT]
  if (c.ht === true) return [HAIRLINE.codePointAt(0)!, c.fg!, DEFAULT]
  if (c.ch !== undefined) return [c.ch.codePointAt(0)!, c.fg!, c.bg ?? DEFAULT]
  return [0x20, DEFAULT, DEFAULT]
}

/** Every cell resolved, row-major; throws where a cell breaks a rule. */
export function cellsOf(g: Grid): Triple[] {
  const out: Triple[] = []
  const pairs = new Set<string>()
  for (let row = 0; row < g.rows; row++) {
    for (let x = 0; x < g.columns; x++) {
      const t = tripleOf(g.cell(x, row), `${x},${row}`)
      if (t[0] !== 0x20 || t[2] !== DEFAULT) pairs.add(`${t[1]}/${t[2]}`)
      out.push(t)
    }
  }
  if (pairs.size > 1024) throw new Error(`${pairs.size} colour pairs > 1024`)
  return out
}

// ---------- encoding ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard padded base64, written out so it needs nothing from the runtime. */
export function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? B64[n & 63]! : '='
  }
  return out
}

/** A Raster's `cells`: `columns * rows` little-endian u32 triplets, base64. */
export function encode(g: Grid): string {
  const cells = cellsOf(g)
  const bytes = new Uint8Array(cells.length * CELL_BYTES)
  const view = new DataView(bytes.buffer)
  cells.forEach(([cp, fg, bg], i) => {
    view.setUint32(i * CELL_BYTES, cp, true)
    view.setUint32(i * CELL_BYTES + 4, fg, true)
    view.setUint32(i * CELL_BYTES + 8, bg, true)
  })
  return base64(bytes)
}

/** `encode` read back: the triplets of a `cells` string. */
export function decode(cells: string): Triple[] {
  const clean = cells.replace(/=+$/, '')
  const bytes: number[] = []
  let acc = 0
  let bits = 0
  for (const ch of clean) {
    const v = B64.indexOf(ch)
    if (v < 0) throw new Error(`not base64: ${ch}`)
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((acc >> bits) & 255)
    }
  }
  if (bytes.length % CELL_BYTES !== 0) throw new Error(`${bytes.length} bytes is not a whole number of cells`)
  const view = new DataView(Uint8Array.from(bytes).buffer)
  const out: Triple[] = []
  for (let i = 0; i < bytes.length; i += CELL_BYTES) {
    out.push([view.getUint32(i, true), view.getUint32(i + 4, true), view.getUint32(i + 8, true)])
  }
  return out
}

// ---------- the crew ----------

export type Role = 'lead' | 'scout' | 'build' | 'check'
export type State = 'queued' | 'working' | 'done' | 'waiting' | 'stalled' | 'failed'
/** @deprecated Neo Rich sizes. The cockpit draws Critters (`critter`): `CritterSize` small and micro. */
export type Size = 'L' | 'S'

export const ROLES: readonly Role[] = ['lead', 'scout', 'build', 'check']
export const STATES: readonly State[] = ['queued', 'working', 'done', 'waiting', 'stalled', 'failed']

/**
 * @deprecated Neo Rich sprites (large and small). The cockpit draws Critters:
 * `critter`, `critterBox`, `CRITTER`. Kept until wave 2 replaces the callers.
 *
 * A sprite's box: the body (8 x 4 cells large, 4 x 2 small) and one column
 * beside its top right corner for the badge. The box is the same in every
 * state, so a state change is a blit, never a resize.
 */
export const SPRITE: Record<Size, { columns: number; rows: number; body: number }> = {
  L: { columns: 9, rows: 4, body: 8 },
  S: { columns: 5, rows: 2, body: 4 },
}

// '#' body, 'd' a dark feature (visor, eye band, belt), 'o' the lamp. Each
// shape is laid out so no cell needs a third colour.
//   lead:  a commander: helmet, dark visor, a cape that flares to the ground, the lamp on the chest
//   scout: an explorer: a round head that is one big scanning eye (the lamp), an antenna, two feet
//   build: a builder bot: flat head with an eye band, a wide body, one arm raised with a claw
//   check: an inspector: slim and tall, the lamp is its lens, a belt, a tick beside it
const SHAPES: Record<Size, Record<Role, readonly string[]>> = {
  L: {
    lead: ['......####......', '.....######.....', '.....#dddd#.....', '......####......', '....########....', '....###oo###....', '..############..', '.####..##..####.'],
    scout: ['................', '................', '.....######.....', '...##########...', '..####oooo####..', '..####oooo####..', '...##########...', '....##....##....'],
    build: ['....########....', '....##dddd##....', '..############.#', '..#####oo#####.#', '..##############', '..############..', '..####....####..', '.#####....#####.'],
    check: ['......####......', '.....##oo##.....', '......####......', '.....######.....', '.....######.....', '.....##dd##.....', '......####......', '.....##..##.....'],
  },
  S: {
    lead: ['..####..', '..#oo#..', '.######.', '##.##.##'],
    scout: ['..####..', '.#oooo#.', '.#oooo#.', '..####..'],
    build: ['.####..#', '.#oo#..#', '########', '.##..##.'],
    check: ['..####..', '..#oo#..', '...##...', '..#..#..'],
  },
}

// Braille details in dot coordinates (2 x 4 dots a cell), in cells the body leaves empty.
const DOTS: Record<Size, Partial<Record<Role, readonly [number, number][]>>> = {
  L: {
    scout: [[8, 3], [8, 2], [9, 1], [10, 0], [11, 0], [11, 1], [10, 1]],
    build: [[15, 0], [14, 1], [14, 2], [15, 3]],
    check: [[12, 8], [13, 9], [13, 10], [14, 8], [14, 7], [15, 6], [15, 5]],
  },
  S: {},
}

type Look = { fill: 'outline' | 'solid'; hue: keyof Palette; lamp?: 'lamp' | 'off' | 'red'; badge?: string; dull?: boolean }

/** What a state does to a sprite: fill, hue, lamp, badge. The body never changes. */
function lookOf(role: Role, state: State): Look {
  const live: Hue = role === 'lead' ? 'ember' : 'iris'
  switch (state) {
    case 'queued':
      return { fill: 'outline', hue: 'mute' }
    case 'working':
      return { fill: 'solid', hue: live, lamp: 'lamp' }
    case 'done':
      return { fill: 'solid', hue: 'mute', lamp: 'off' }
    case 'waiting':
      return { fill: 'solid', hue: 'amber', lamp: 'lamp', badge: '?' }
    case 'stalled':
      return { fill: 'solid', hue: 'amber', lamp: 'off', badge: 'z', dull: true }
    case 'failed':
      return { fill: 'outline', hue: 'red', lamp: 'red', badge: '!' }
  }
}

export type SpriteOptions = {
  pal?: Palette
  /** The working pulse: `dim` is the lamp half-way to the body, the 1 s clock's off beat. */
  lamp?: 'on' | 'dim'
}

/** @deprecated Neo Rich. Use `drawCritter`. Draws a sprite into `g` with its body's top left at cell `x`, `row`; the badge goes at `x + body`. */
export function drawSprite(g: Grid, x: number, row: number, role: Role, state: State, size: Size, lamp: 'on' | 'dim' = 'on'): void {
  const pal = g.pal
  const shape = SHAPES[size][role]
  const k = lookOf(role, state)
  const body = k.dull === true ? mix(pal[k.hue], pal.ground, 0.35) : pal[k.hue]
  // One tone to a cell row, so a cell never holds two body tones.
  const tones = size === 'L' ? [mix(body, 0xffffff, 0.14), body, body, mix(body, pal.ground, 0.3)] : [body, mix(body, pal.ground, 0.3)]
  const dark = mix(body, pal.ground, 0.58)
  const at = (px: number, py: number): string | undefined => {
    const ch = shape[py]?.[px]
    return ch !== undefined && ch !== '.' ? ch : undefined
  }
  for (let py = 0; py < shape.length; py++) {
    const line = shape[py]!
    for (let px = 0; px < line.length; px++) {
      const ch = at(px, py)
      if (ch === undefined) continue
      const sx = x * 2 + px
      const sy = row * 2 + py
      const tone = k.fill === 'outline' ? body : tones[py >> 1]!
      if (ch === 'o') {
        if (k.lamp === 'lamp') g.sp(sx, sy, lamp === 'dim' ? mix(pal.lamp, body, 0.5) : pal.lamp)
        else if (k.lamp === 'red') g.sp(sx, sy, pal.red)
        else if (k.lamp === 'off') g.sp(sx, sy, mix(body, pal.ground, 0.62))
        continue
      }
      const edge = at(px - 1, py) === undefined || at(px + 1, py) === undefined || at(px, py - 1) === undefined || at(px, py + 1) === undefined
      if (k.fill === 'solid') g.sp(sx, sy, ch === 'd' ? dark : tone)
      else if (edge) g.sp(sx, sy, tone)
    }
  }
  for (const [dx, dy] of DOTS[size][role] ?? []) g.dot(x * 2 + dx, row * 4 + dy, body)
  if (k.badge !== undefined) g.glyph(x + SPRITE[size].body, row, k.badge, 'badge', k.hue)
}

/** @deprecated Neo Rich. Use `critterBox`. One crew member in a box of its own: SPRITE[size] cells. */
export function sprite(role: Role, state: State, size: Size, options: SpriteOptions = {}): Grid {
  const g = new Grid(SPRITE[size].columns, SPRITE[size].rows, options.pal)
  drawSprite(g, 0, 0, role, state, size, options.lamp)
  return g
}

// ---------- meters ----------

/** Beads: a segment is two cells, `▄` then `▖`; any non-zero lights one, only 100 lights all. */
export function drawBeads(g: Grid, x: number, row: number, cells: number, pct: number, hue?: Ink): void {
  const n = cells >> 1
  const lit = pct >= 100 ? n : pct > 0 ? Math.max(1, Math.min(n - 1, Math.floor((pct * n) / 100))) : 0
  for (let i = 0; i < n; i++) {
    const k = i < lit ? (hue ?? rate(pct)) : 'rest'
    g.px(x + i * 2, row * 2 + 1, k)
    g.pxL(x + i * 2 + 1, row * 2 + 1, k)
  }
}

export function beads(cells: number, pct: number, hue?: Ink, pal?: Palette): Grid {
  const g = new Grid(cells, 1, pal)
  drawBeads(g, 0, 0, cells, pct, hue)
  return g
}

/** A solid stacked bar on the lower half: shares by largest remainder. */
export function drawStack(g: Grid, x: number, row: number, cells: number, parts: readonly (readonly [number, Ink])[]): void {
  const total = parts.reduce((a, p) => a + p[0], 0) || 1
  const raw = parts.map(p => (p[0] * cells) / total)
  const n = raw.map(Math.floor)
  let left = cells - n.reduce((a, b) => a + b, 0)
  raw
    .map((v, i) => [v - n[i]!, i] as const)
    .sort((a, b) => b[0] - a[0])
    .forEach(([, i]) => {
      if (left > 0 && parts[i]![0] > 0) {
        n[i]!++
        left--
      }
    })
  let c = x
  parts.forEach((p, i) => {
    for (let j = 0; j < n[i]!; j++) g.px(c++, row * 2 + 1, p[1])
  })
}

export function stack(cells: number, parts: readonly (readonly [number, Ink])[], pal?: Palette): Grid {
  const g = new Grid(cells, 1, pal)
  drawStack(g, 0, 0, cells, parts)
  return g
}

export type BarsOptions = {
  /** Cells from one column to the next (1: adjacent). */
  pitch?: number
  /** A column's colour; iris when absent. */
  hueOf?: (i: number, v: number) => Ink
  pal?: Palette
}

/** A histogram on eighth blocks, 1 to 3 rows tall (8, 16 or 24 levels); a zero is a rest tick. */
export function drawBars(g: Grid, x: number, row: number, rows: number, vals: readonly number[], hueOf: (i: number, v: number) => Ink = () => 'iris', pitch = 1): void {
  assertInt(rows, 1, 3, 'bar rows')
  const max = Math.max(...vals, 1)
  vals.forEach((v, i) => {
    const lv = v <= 0 ? 0 : Math.max(1, Math.round((v / max) * rows * 8))
    for (let k = 0; k < rows; k++) {
      const part = Math.max(0, Math.min(8, lv - k * 8))
      const rr = row + rows - 1 - k
      if (part > 0) g.lv(x + i * pitch, rr, part, hueOf(i, v))
      else if (k === 0) g.lv(x + i * pitch, rr, 1, 'rest')
    }
  })
}

/** Bars in a box `vals.length * pitch` wide and `rows` tall. */
export function bars(rows: number, vals: readonly number[], options: BarsOptions = {}): Grid {
  assertInt(rows, 1, 3, 'bar rows')
  const pitch = options.pitch ?? 1
  const g = new Grid(Math.max(1, vals.length * pitch), rows, options.pal)
  drawBars(g, 0, 0, rows, vals, options.hueOf, pitch)
  return g
}

// ---------- the ring ----------

/** @deprecated Neo Rich: the cockpit's gauge is `GAUGE_RING` (9 x 5, no name inside). A ring's box: 7 x 4 cells of Braille. */
export const RING = { columns: 7, rows: 4 } as const

export type RingOptions = {
  /** The lit arc's colour; `rate(pct)` when absent. */
  hue?: Ink
  /** The name's colour; mute when absent (amber marks the hot window). */
  nameHue?: Ink
}

type RingDot = [dx: number, dy: number, turn: number]

// The ring's dots by cell for an aspect, worked out once each: a 14-dot circle two dots thick, round in pixel space.
const RING_TABLES = new Map<number, RingDot[][]>()
function ringCells(a: number): RingDot[][] {
  const hit = RING_TABLES.get(a)
  if (hit !== undefined) return hit
  const cells = new Map<string, RingDot[]>()
  for (let dy = 0; dy < 16; dy++) {
    for (let dx = 0; dx < 14; dx++) {
      const vx = dx - 6.5
      const vy = (dy - 7.5) * (a / 2)
      const d = Math.hypot(vx, vy)
      if (d < 4.7 || d > 6.95) continue
      const turn = (Math.atan2(vx, -vy) / (2 * Math.PI) + 1) % 1
      const key = `${dx >> 1},${dy >> 2}`
      const list = cells.get(key) ?? []
      list.push([dx, dy, turn])
      cells.set(key, list)
    }
  }
  const table = [...cells.values()]
  RING_TABLES.set(a, table)
  return table
}

/**
 * Draws a ring lit clockwise from the top, with its name and figure in the
 * three middle cells of rows 1 and 2. A cell where lit meets unlit takes the
 * colour of most of its dots; any non-zero value lights at least one cell.
 */
export function drawRing(g: Grid, x: number, row: number, name: string, pct: number, options: RingOptions = {}): void {
  if ([...name].length > 3) throw new Error(`a ring's name is at most 3 letters, not ${name}`)
  const k = options.hue ?? rate(pct)
  const paint = ringCells(cellAspect).map(dots => {
    const lit = pct >= 100 || dots.filter(p => p[2] < pct / 100).length * 2 > dots.length
    return { dots, lit }
  })
  if (pct > 0 && !paint.some(p => p.lit)) {
    const first = Math.min(...paint.map(p => Math.min(...p.dots.map(d => d[2]))))
    const cell = paint.find(p => Math.min(...p.dots.map(d => d[2])) === first)
    if (cell !== undefined) cell.lit = true
  }
  for (const { dots, lit } of paint) for (const [dx, dy] of dots) g.dot(x * 2 + dx, row * 4 + dy, lit ? k : 'rest')
  const mid = (s: string, r: number, fg: Ink) => g.word(x + 2 + Math.floor((3 - [...s].length) / 2), r, s, fg)
  if (name !== '') mid(name, row + 1, options.nameHue ?? 'mute')
  const figure = pct >= 100 ? '100' : `${Math.max(0, Math.round(pct))}%`
  mid(figure, row + 2, pct >= 70 ? k : 'ink')
}

export function ring(name: string, pct: number, options: RingOptions & { pal?: Palette } = {}): Grid {
  const g = new Grid(RING.columns, RING.rows, options.pal)
  drawRing(g, 0, 0, name, pct, options)
  return g
}

// ---------- pill and frame ----------

/** A pill inside a Raster: half-cell caps, letters on the colour. Returns the column after it. */
export function drawPill(g: Grid, x: number, row: number, word: string, hue: Ink): number {
  g.pxR(x, row * 2, hue)
  g.pxR(x, row * 2 + 1, hue)
  const e = g.word(x + 1, row, word, 'badge', hue)
  g.pxL(e, row * 2, hue)
  g.pxL(e, row * 2 + 1, hue)
  return e + 1
}

/** A pill in a box of its own: the word's length plus two cells. */
export function rpill(word: string, hue: Ink, pal?: Palette): Grid {
  const g = new Grid([...word].length + 2, 1, pal)
  drawPill(g, 0, 0, word, hue)
  return g
}

export type FrameOptions = {
  /** The clamps' colour (iris; amber while waiting). */
  hue?: Ink
  /** Cells of the clamp after its corner; 3 when absent. */
  clamp?: number
  pal?: Palette
}

export type LintelOptions = FrameOptions & {
  /** The state pill hanging from the line. */
  pill?: string
  pillHue?: Ink
  /** The pill's first column; 13 (the gauge column) when absent. */
  pillCol?: number
  /** One dim readout at the right. */
  right?: string
  rightHue?: Ink
}

/**
 * What a lintel of `width` has room for (the one collision rule; `lintel`
 * and the text form in parts.tsx both obey it):
 * - `pill`: whether the pill fits, past the clamp and with its last cap at
 *   most at `width - 2`;
 * - `right`: the longest readout that ends at `width - 3` and leaves one
 *   hairline cell after the pill (with no pill, after the clamp); 0 for none.
 */
export function lintelRoom(width: number, o: { pill?: string; pillCol?: number; clamp?: number }): { pill: boolean; right: number } {
  const clamp = o.clamp ?? 3
  const pc = o.pillCol ?? 13
  const pill = o.pill !== undefined && pc > clamp && pc + [...o.pill].length + 2 <= width - 1
  const after = pill ? pc + [...(o.pill ?? '')].length + 2 : clamp + 1
  return { pill, right: Math.max(0, width - 3 - after) }
}

/**
 * @deprecated Neo Rich (pill and readout on the line). The cockpit's lintel is `frameTop`.
 *
 * The deck's top: a clamp top left (`█▀▀▀`), a hairline, the pill, a readout
 * at the right. A pill or readout without room (`lintelRoom`) is left out,
 * so no width can make a cell hold both.
 */
export function lintel(width: number, o: LintelOptions = {}): Grid {
  const g = new Grid(width, 1, o.pal)
  const hue = o.hue ?? 'iris'
  const clamp = Math.max(0, Math.min(o.clamp ?? 3, width - 1))
  g.full(0, 0, hue)
  for (let i = 1; i <= clamp && i < width; i++) g.px(i, 0, hue)
  const pc = o.pillCol ?? 13
  const room = lintelRoom(width, { ...o, clamp })
  let e = pc
  const withPill = o.pill !== undefined && room.pill
  if (withPill) e = drawPill(g, pc, 0, o.pill ?? '', o.pillHue ?? hue)
  const right = o.right !== undefined && [...o.right].length <= room.right ? o.right : ''
  const rs = width - 2 - [...right].length
  for (let i = clamp + 1; i < width; i++) {
    if (withPill && i >= pc - 1 && i <= e) continue
    if (right !== '' && i >= rs - 1 && i <= width - 2) continue
    g.ht(i, 0, 'rest')
  }
  if (right !== '') g.word(rs, 0, right, o.rightHue ?? 'mute')
  return g
}

export type SillOptions = FrameOptions & {
  /** The clean-run sweep: the cells within 2 of this column are bright. */
  sweep?: number
}

/** @deprecated Neo Rich. The cockpit's sill is `frameFoot`. The deck's foot: a hairline (`▁`) ending in the mirrored clamp bottom right (`▄▄▄█`). */
export function sill(width: number, o: SillOptions = {}): Grid {
  const g = new Grid(width, 1, o.pal)
  const hue = o.hue ?? 'iris'
  const clamp = o.clamp ?? 3
  for (let i = 0; i < width - 1 - clamp; i++) {
    g.lv(i, 0, 1, o.sweep !== undefined && Math.abs(i - o.sweep) < 3 ? 'ink' : 'rest')
  }
  for (let i = Math.max(0, width - 1 - clamp); i < width - 1; i++) g.px(i, 1, hue)
  g.full(width - 1, 0, hue)
  return g
}

// ---------- the cockpit: Critters (crew spec family A) ----------
//
// Ported from the mock generator `gen-crew.js` (`FAM.A`, `shape`, `tone`,
// `cellsOf`) for the two cockpit sizes: small, 3 rows x 5 columns (10 x 6
// quadrant sub-pixels), and micro, 2 x 4 (8 x 4). The hero size is not built
// (controller ruling: no large character). One grid per role and size; a
// state only recolours it. The tones differ from the generator only where the
// rulings sheet says so (R19): the done lamp is off (no mint), failed eyes
// are shut (red is only the lamp and the badge), and the stalled badge is a
// mute `z` on rule grey (no amber).

/** A critter's size: `small` (cards, the header, map nodes) or `micro` (tethers, slim, the band). */
export type CritterSize = 'small' | 'micro'

/**
 * A critter's body box in cells and sub-pixels. The state badge is one more
 * column to the right of the top row (`critterBox`), reserved in every state
 * so a state change is a blit, never a resize.
 */
export const CRITTER: Record<CritterSize, { columns: number; rows: number; w: number; h: number }> = {
  small: { columns: 5, rows: 3, w: 10, h: 6 },
  micro: { columns: 4, rows: 2, w: 8, h: 4 },
}

/** The crew art's own palette (`gen-crew.js` NIGHT and DAY), plus the cockpit's rule grey behind the stalled badge (R19). */
export type CrewPalette = {
  name: Ground
  ember: number
  teal: number
  iris: number
  orchid: number
  amber: number
  red: number
  mint: number
  mute: number
  rest: number
  ink: number
  dim: number
  eye: number
  ground: number
  line: number
  rule: number
  badge: number
}

const CREW_HUES = { ember: 0xe07b53, teal: 0x3fbdb4, iris: 0x8a9bff, orchid: 0xb48cf2, amber: 0xe0a93f, red: 0xee5f74, mint: 0x43b888 }

/** Exactly `gen-crew.js` NIGHT and DAY: the hex every critter cell is mixed from. */
export const CREW_PALETTE: Record<Ground, CrewPalette> = {
  night: {
    ...CREW_HUES, name: 'night',
    mute: 0x5d6679, rest: 0x333b4d, ink: 0xc9cfdb, dim: 0x8b93a6, eye: 0x16181d, ground: 0x16181d, line: 0x3d4459,
    rule: PALETTE.night.rule, badge: 0x16181d,
  },
  day: {
    ...CREW_HUES, name: 'day', iris: 0x6f82f2, teal: 0x2aa69d, orchid: 0xa078e6,
    mute: 0xa3a9b8, rest: 0xd6dae2, ink: 0x2b2f3a, dim: 0x6f7686, eye: 0x22252e, ground: 0xf6f5f1, line: 0xc3c7d0,
    rule: PALETTE.day.rule, badge: 0x16181d,
  },
}

/** A role's hue in the crew palette (owner ruling 1): lead ember, scout teal, build iris, check orchid. */
export const ROLE_HUE: Record<Role, 'ember' | 'teal' | 'iris' | 'orchid'> = { lead: 'ember', scout: 'teal', build: 'iris', check: 'orchid' }

/** Queued: the body is the role hue moved this far toward the ground (crew spec "States", R20). */
export const QUEUED_TOWARD_GROUND = 0.62
/** Stalled: the body moved this far toward the ground. */
export const STALLED_TOWARD_GROUND = 0.42
/** Failed: the body moved this far toward the ground. */
export const FAILED_TOWARD_GROUND = 0.5
/** Done: grey (`mute`) with this much of the role hue left in it. */
export const DONE_HUE_TRACE = 0.12
/** An unlit lamp: the body moved this far toward the ground. */
export const LAMP_OFF_TOWARD_GROUND = 0.4
/** Shut eyes: the body moved this far toward the eye colour. */
export const EYES_SHUT_TOWARD_EYE = 0.38

// '.' ground  '#' body  'e' eye  'o' lamp (the state)  'p' prop (a tint of the role hue)  'w' glass
const FAM_A_BASE: Record<CritterSize, readonly string[]> = {
  small: ['..........', '..........', '.########.', '##ee##ee##', '.###oo###.', '.#.#..#.#.'],
  micro: ['........', '.######.', '##e##e##', '#.####.#'],
}

const FAM_A_ROLES: Record<Role, Record<CritterSize, Record<number, string>>> = {
  lead: { small: { 0: '.p..pp..p.', 1: '.pppppppp.' }, micro: { 0: '.p.pp.p.', 1: '.pppppp.' } },
  scout: { small: { 0: '......p..p', 1: '.......pp.', 3: '##ww##ww##' }, micro: { 0: '.....#.#', 2: '##w##w##' } },
  build: { small: { 0: '...pppp...', 1: 'pppppppppp' }, micro: { 0: '..pppp..', 1: 'pppppppp' } },
  check: { small: { 0: '.........p', 1: '........p.', 2: '.#####ww#.', 3: '##ee##ww##' }, micro: { 0: '.......#', 2: '##e#ww##' } },
}

/** A role's grid at a size: the family's base with the role's prop rows laid over it (`gen-crew.js` `shape`). */
export function critterShape(role: Role, size: CritterSize): string[] {
  const rows = FAM_A_BASE[size].slice()
  const over = FAM_A_ROLES[role][size]
  for (const k of Object.keys(over)) rows[Number(k)] = over[Number(k)]!
  return rows
}

const WHITE = 0xffffff
const PROP_SHADE_DAY = 0x20222a

/**
 * The colour of one mark for a role in a state on a ground (`gen-crew.js`
 * `tone`, with R19's changes). `frame` 2 is the working blink: eyes shut and
 * the lamp tinted. Undefined is the ground (a quadrant left empty).
 */
export function critterTone(mark: string, role: Role, state: State, pal: CrewPalette, frame: 1 | 2 = 1): number | undefined {
  const hue = pal[ROLE_HUE[role]]
  const night = pal.name === 'night'
  const body =
    state === 'queued'
      ? mix(hue, pal.ground, QUEUED_TOWARD_GROUND)
      : state === 'stalled'
        ? mix(hue, pal.ground, STALLED_TOWARD_GROUND)
        : state === 'failed'
          ? mix(hue, pal.ground, FAILED_TOWARD_GROUND)
          : state === 'done'
            ? mix(pal.mute, hue, DONE_HUE_TRACE)
            : hue
  const live = state === 'working' || state === 'waiting'
  const shut = mix(body, pal.eye, EYES_SHUT_TOWARD_EYE)
  const off = mix(body, pal.ground, LAMP_OFF_TOWARD_GROUND)
  const lamp = state === 'working' ? WHITE : state === 'waiting' ? pal.amber : state === 'failed' ? pal.red : off
  switch (mark) {
    case '#':
      return body
    case 'p':
      return night ? mix(body, WHITE, 0.45) : mix(body, PROP_SHADE_DAY, 0.32)
    case 'w':
      return live ? (night ? mix(hue, WHITE, 0.85) : mix(hue, WHITE, 0.62)) : mix(body, WHITE, 0.4)
    case 'e':
      // R19: no red inside a sprite but the failed lamp and badge, so failed eyes are shut.
      return live && frame !== 2 ? pal.eye : shut
    case 'o':
      return frame === 2 && state === 'working' ? mix(hue, WHITE, 0.5) : lamp
    default:
      return undefined
  }
}

/** The badge a state wears in the cell right of the top row (R19): `?` on amber, `z` mute on rule grey, `!` on red. */
export const CRITTER_BADGE: Partial<Record<State, { ch: string; fg: 'badge' | 'mute'; bg: 'amber' | 'rule' | 'red' }>> = {
  waiting: { ch: '?', fg: 'badge', bg: 'amber' },
  stalled: { ch: 'z', fg: 'mute', bg: 'rule' },
  failed: { ch: '!', fg: 'badge', bg: 'red' },
}

/** Options of the critter draws. */
export type CritterOptions = {
  /** The ground the tones are mixed for; night when absent. */
  ground?: Ground
  /** 2 is the working blink (eyes shut, lamp tinted). */
  frame?: 1 | 2
}

/** Draws a critter's body with its top left at cell `x`, `row`. The badge is not drawn (`drawCritterBadge`). */
export function drawCritter(g: Grid, x: number, row: number, role: Role, state: State, size: CritterSize, o: CritterOptions = {}): void {
  const pal = CREW_PALETTE[o.ground ?? 'night']
  const rows = critterShape(role, size)
  rows.forEach((line, py) => {
    ;[...line].forEach((mark, px) => {
      const c = critterTone(mark, role, state, pal, o.frame ?? 1)
      if (c !== undefined) g.sp(x * 2 + px, row * 2 + py, c)
    })
  })
}

/** Draws a state's badge (if it has one) into the cell at `x`, `row`. */
export function drawCritterBadge(g: Grid, x: number, row: number, state: State, ground: Ground = 'night'): void {
  const b = CRITTER_BADGE[state]
  if (b === undefined) return
  const pal = CREW_PALETTE[ground]
  g.glyph(x, row, b.ch, pal[b.fg], pal[b.bg])
}

/** A critter's body alone: exactly 5 x 3 cells (small) or 4 x 2 (micro). */
export function critter(role: Role, state: State, size: CritterSize, o: CritterOptions = {}): Grid {
  const box = CRITTER[size]
  const g = new Grid(box.columns, box.rows, PALETTE[o.ground ?? 'night'])
  drawCritter(g, 0, 0, role, state, size, o)
  return g
}

/** A critter in its box: the body and the badge column (6 x 3 small, 5 x 2 micro); the badge drawn when the state has one. */
export function critterBox(role: Role, state: State, size: CritterSize, o: CritterOptions = {}): Grid {
  const box = CRITTER[size]
  const g = new Grid(box.columns + 1, box.rows, PALETTE[o.ground ?? 'night'])
  drawCritter(g, 0, 0, role, state, size, o)
  drawCritterBadge(g, box.columns, 0, state, o.ground ?? 'night')
  return g
}

/** How many paint beats one blink cycle lasts: the 1 s clock shuts the eyes for one beat in four (R24). */
export const BLINK_BEATS = 4

/**
 * A critter's frames for the paint clock: a working critter with `motion`
 * blinks once every `BLINK_BEATS` beats (frame 2 on one of them), shifted by
 * `phase` so agents blink apart; every other state, or motion off, is one
 * still frame. Never pass motion for the band or at idle (R24).
 */
export function critterFrames(role: Role, state: State, size: CritterSize, o: { ground?: Ground; motion?: boolean; phase?: number } = {}): Grid[] {
  const ground = o.ground ?? 'night'
  if (state !== 'working' || o.motion !== true) return [critterBox(role, state, size, { ground })]
  const open = critterBox(role, state, size, { ground })
  const shut = critterBox(role, state, size, { ground, frame: 2 })
  const at = (((Math.trunc(o.phase ?? 0)) % BLINK_BEATS) + BLINK_BEATS) % BLINK_BEATS
  return Array.from({ length: BLINK_BEATS }, (_, i) => (i === at ? shut : open))
}

// ---------- the cockpit: the gauge ring ----------

/** A gauge's box (cockpit spec "Spacing and type"): 9 x 5 cells of Braille, the figure in the middle row. */
export const GAUGE_RING = { columns: 9, rows: 5 } as const

/** A gauge's hue (R9: amber is the dialog colour only): iris, ink from 70 %, red from 90 %. */
export function gaugeHue(pct: number): 'iris' | 'ink' | 'red' {
  if (pct >= 90) return 'red'
  if (pct >= 70) return 'ink'
  return 'iris'
}

/** The aspect the mocks and the fidelity tests draw at: a cell twice as tall as wide, so a Braille dot is square. */
export const MOCK_ASPECT = 2

let cellAspect = 2.2
const GAUGE_TABLES = new Map<number, RingDot[][]>()

/** The cell height / width the gauge ring is drawn for. Called from a start path or a test; never from render. */
export function setCellAspect(a: number): void {
  cellAspect = Number.isFinite(a) && a >= 1.5 && a <= 3 ? a : 2.2
}

/** The aspect now in force. */
export function getCellAspect(): number {
  return cellAspect
}

/**
 * The cell aspect a terminal is known to have, from its environment (FX4):
 * Windows Terminal 2.35, VS Code 2.4, the Mac and GPU terminals 2.1, else 2.2.
 */
export function aspectFromEnv(env: { WT_SESSION?: string; TERM_PROGRAM?: string; TERM?: string }): number {
  if (env.WT_SESSION !== undefined && env.WT_SESSION !== '') return 2.35
  const tp = env.TERM_PROGRAM
  if (tp === 'vscode') return 2.4
  if (tp === 'iTerm.app' || tp === 'Apple_Terminal' || tp === 'WezTerm' || tp === 'ghostty' || env.TERM === 'xterm-kitty') return 2.1
  return 2.2
}

/**
 * The gauge's dots by cell for aspect `a`, worked out once each
 * (`gen-cockpit.js` `ring` at a = 2): an 18 x 20 dot field, two thick, a true
 * circle in pixel space. A dot is half a cell wide and a quarter of one tall,
 * so a vertical step is a / 2 horizontal ones.
 */
export function gaugeCells(a: number): RingDot[][] {
  const hit = GAUGE_TABLES.get(a)
  if (hit !== undefined) return hit
  // The ring's height is a whole number of dots, so the centre row may sit half a dot off
  // the middle (9 or 10 for 9.5) where that makes the pixel box rounder; at a = 2 it never does.
  let best: { table: RingDot[][]; miss: number } | undefined
  for (const cy of [9.5, 9, 10]) {
    const built = gaugeTable(a, cy)
    if (best === undefined || built.miss < best.miss - 1e-9) best = built
  }
  GAUGE_TABLES.set(a, best!.table)
  return best!.table
}

function gaugeTable(a: number, cy: number): { table: RingDot[][]; miss: number } {
  const cells = new Map<string, RingDot[]>()
  const k = a / 2
  let lo = 20
  let hi = -1
  let left = 18
  let right = -1
  for (let dy = 0; dy < 20; dy++) {
    for (let dx = 0; dx < 18; dx++) {
      const vx = dx - 8.5
      const vy = (dy - cy) * k
      const d = Math.hypot(vx, vy)
      if (d < 6.7 || d > 8.95) continue
      const turn = (Math.atan2(vx, -vy) / (2 * Math.PI) + 1) % 1
      const key = `${dx >> 1},${dy >> 2}`
      const list = cells.get(key) ?? []
      list.push([dx, dy, turn])
      cells.set(key, list)
      lo = Math.min(lo, dy)
      hi = Math.max(hi, dy)
      left = Math.min(left, dx)
      right = Math.max(right, dx)
    }
  }
  // Width over height in pixels: a dot is half a cell wide and a quarter of one tall, a cell `a` times taller than wide.
  const ratio = ((right - left + 1) * 0.5) / ((hi - lo + 1) * 0.25 * a)
  return { table: [...cells.values()], miss: Math.abs(ratio - 1) }
}

/** A gauge's figure: `62%`, `100%`. */
export function gaugeFigure(pct: number): string {
  return `${Math.round(Math.max(0, Number.isFinite(pct) ? pct : 0))}%`
}

/**
 * Draws a gauge lit clockwise from the top, the figure centred in its middle
 * row (no name inside: the word goes under it as Text). A cell where lit
 * meets unlit takes the colour of most of its dots; any non-zero value
 * lights at least one cell. The figure is ink, or the gauge's hue from 70 %.
 */
export function drawGaugeRing(g: Grid, x: number, row: number, pct: number, o: { hue?: Ink } = {}): void {
  const p = Number.isFinite(pct) ? Math.max(0, pct) : 0
  const k = o.hue ?? gaugeHue(p)
  const paint = gaugeCells(cellAspect).map(dots => ({ dots, lit: p >= 100 || dots.filter(d => d[2] < p / 100).length * 2 > dots.length }))
  if (p > 0 && !paint.some(c => c.lit)) {
    const first = Math.min(...paint.map(c => Math.min(...c.dots.map(d => d[2]))))
    const cell = paint.find(c => Math.min(...c.dots.map(d => d[2])) === first)
    if (cell !== undefined) cell.lit = true
  }
  for (const { dots, lit } of paint) for (const [dx, dy] of dots) g.dot(x * 2 + dx, row * 4 + dy, lit ? k : 'rest')
  const s = gaugeFigure(p)
  g.word(x + Math.floor((GAUGE_RING.columns - s.length) / 2), row + 2, s, p >= 70 ? k : 'ink')
}

/** One gauge in a box of its own. */
export function gaugeRing(pct: number, o: { hue?: Ink; pal?: Palette } = {}): Grid {
  const g = new Grid(GAUGE_RING.columns, GAUGE_RING.rows, o.pal)
  drawGaugeRing(g, 0, 0, pct, o.hue !== undefined ? { hue: o.hue } : {})
  return g
}

/** The header's two gauges: 9 x 5 each, 2 columns apart (columns 40 and 51 at 62), 20 x 5 in all. */
export const GAUGE_PAIR = { columns: 2 * GAUGE_RING.columns + 2, rows: GAUGE_RING.rows, pitch: GAUGE_RING.columns + 2 } as const

/** Up to two gauges side by side in a `GAUGE_PAIR` box. */
export function gaugePair(pcts: readonly number[], pal?: Palette): Grid {
  const g = new Grid(GAUGE_PAIR.columns, GAUGE_PAIR.rows, pal)
  pcts.slice(0, 2).forEach((p, i) => drawGaugeRing(g, i * GAUGE_PAIR.pitch, 0, p))
  return g
}

// ---------- the cockpit: lintel and sill ----------

/** The frame's hues: iris (working), amber (a dialog waits), mint (all done), red (stopped by an error). */
export type FrameHue = 'iris' | 'amber' | 'mint' | 'red'

/**
 * The header's top (cockpit spec: "lintel without pill or readout"): a clamp
 * top left (`█▀▀`: the corner and two upper halves) in `hue`, then a
 * rule-grey hairline (`▔`) to the right edge.
 */
export function frameTop(width: number, o: { hue?: FrameHue; pal?: Palette } = {}): Grid {
  const g = new Grid(width, 1, o.pal)
  const hue = o.hue ?? 'iris'
  g.full(0, 0, hue)
  for (let i = 1; i < Math.min(3, width); i++) g.px(i, 0, hue)
  for (let i = 3; i < width; i++) g.ht(i, 0, 'rule')
  return g
}

/** The header's foot: a rule-grey hairline (`▁`), then the mirrored clamp bottom right (`▄▄█`). */
export function frameFoot(width: number, o: { hue?: FrameHue; pal?: Palette } = {}): Grid {
  const g = new Grid(width, 1, o.pal)
  const hue = o.hue ?? 'iris'
  for (let i = 0; i < width - 3; i++) g.lv(i, 0, 1, 'rule')
  for (let i = Math.max(0, width - 3); i < width - 1; i++) g.px(i, 1, hue)
  g.full(width - 1, 0, hue)
  return g
}
