// The test card's cells: pure builders, no `$`. Each returns a Raster's
// `cells` string (row-major little-endian u32 triplets, base64) and its size.

export const DEFAULT = 0x01000000 // the terminal's own colour
const DIM = 0x3a3a3a

export type Grid = { columns: number; rows: number; cells: string }

type Cell = [codePoint: number, fg: number, bg: number]

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard padded base64; written out so it needs no `toBase64` in the runtime. */
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

function pack(columns: number, rows: number, cells: Cell[]): Grid {
  if (cells.length !== columns * rows) {
    throw new Error(`grid ${columns}x${rows} got ${cells.length} cells`)
  }
  const bytes = new Uint8Array(cells.length * 12)
  const view = new DataView(bytes.buffer)
  cells.forEach(([cp, fg, bg], i) => {
    view.setUint32(i * 12, cp, true)
    view.setUint32(i * 12 + 4, fg, true)
    view.setUint32(i * 12 + 8, bg, true)
  })
  return { columns, rows, cells: base64(bytes) }
}

const blank = (): Cell => [0x20, DEFAULT, DEFAULT]
const glyph = (ch: string, fg: number, bg = DEFAULT): Cell => [ch.codePointAt(0)!, fg, bg]

function lerp(a: number, b: number, t: number): number {
  const ch = (shift: number) => {
    const x = (a >> shift) & 255
    const y = (b >> shift) & 255
    return Math.round(x + (y - x) * t) << shift
  }
  return ch(16) | ch(8) | ch(0)
}

// --- 1. Pixel sprites -------------------------------------------------------

// Each sprite is 5 pixels wide and 6 tall: 5 columns by 3 rows of half-blocks.
// '.' is empty; every other letter names a colour in its palette.
type Sprite = { px: string[]; palette: Record<string, number> }

export const SPRITES: Sprite[] = [
  {
    // diamond head
    px: ['..h..', '.hhh.', '..h..', 'bbbbb', '.bbb.', '.l.l.'],
    palette: { h: 0x2dd4bf, b: 0xf59e0b, l: 0x78350f },
  },
  {
    // round head
    px: ['.ppp.', 'ppppp', '.ppp.', '.ggg.', 'ggggg', '.l.l.'],
    palette: { p: 0xf9a8d4, g: 0x22c55e, l: 0x14532d },
  },
  {
    // square head, with eyes
    px: ['yyyyy', 'yeyey', 'yyyyy', '.bbb.', 'bbbbb', '.l.l.'],
    palette: { y: 0xfde047, e: 0x1e293b, b: 0x3b82f6, l: 0x1e3a8a },
  },
  {
    // triangle head
    px: ['..t..', '.ttt.', 'ttttt', '.bbb.', 'bbbbb', 'l...l'],
    palette: { t: 0xa78bfa, b: 0xef4444, l: 0x7f1d1d },
  },
]

function spriteCell(s: Sprite, x: number, row: number): Cell {
  const at = (y: number) => {
    const k = s.px[y]?.[x] ?? '.'
    return k === '.' ? undefined : s.palette[k]
  }
  const top = at(row * 2)
  const bottom = at(row * 2 + 1)
  if (top === undefined && bottom === undefined) return blank()
  if (bottom === undefined) return glyph('▀', top!)
  if (top === undefined) return glyph('▄', bottom)
  return glyph('▀', top, bottom)
}

export function sprites(): Grid {
  const W = 5
  const GAP = 3
  const columns = SPRITES.length * W + (SPRITES.length - 1) * GAP
  const cells: Cell[] = []
  for (let row = 0; row < 3; row++) {
    SPRITES.forEach((s, i) => {
      if (i > 0) for (let g = 0; g < GAP; g++) cells.push(blank())
      for (let x = 0; x < W; x++) cells.push(spriteCell(s, x, row))
    })
  }
  return pack(columns, 3, cells)
}

// --- 2. Segmented progress bar ---------------------------------------------

export const SEGMENTS = 40
const GROUP = 4
const AMBER = 0xf59e0b
const YELLOW = 0xfde047

/** 40 segments, a blank cell after every 4: 49 columns. */
export const BAR_COLUMNS = SEGMENTS + SEGMENTS / GROUP - 1

export function bar(filled: number): Grid {
  const cells: Cell[] = []
  for (let i = 0; i < SEGMENTS; i++) {
    if (i > 0 && i % GROUP === 0) cells.push(blank())
    const bg = i < filled ? lerp(AMBER, YELLOW, filled > 1 ? i / (filled - 1) : 0) : DIM
    cells.push([0x20, DEFAULT, bg])
  }
  return pack(BAR_COLUMNS, 1, cells)
}

export function barText(filled: number): string {
  return `[${'#'.repeat(filled)}${'.'.repeat(SEGMENTS - filled)}] ${filled}/${SEGMENTS}`
}

// --- 3. Ring gauge -----------------------------------------------------------

// Quadrant glyph by bits: top-left 1, top-right 2, bottom-left 4, bottom-right 8.
const QUAD = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█'
const RING_ON = 0x22d3ee

/** A 5x3-cell ring of quadrant blocks (10x6 sub-pixels), then the percentage. */
export function ring(percent: number): Grid {
  const W = 5
  const H = 3
  const label = ` ${percent}%`
  // A sub-pixel is half a cell wide and half a cell tall; a cell is about
  // twice as tall as wide, so a sub-pixel is 0.5 x 1 in width units.
  const cx = W / 2
  const cy = H // 3 cells tall = 6 width units
  const outer = 2.5
  const inner = 1.4
  const cells: Cell[] = []
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      let bits = 0
      let on = 0
      let off = 0
      for (let q = 0; q < 4; q++) {
        const sx = col + (q & 1 ? 0.75 : 0.25)
        const sy = (row + (q & 2 ? 0.75 : 0.25)) * 2
        const dx = sx - cx
        const dy = sy - cy
        const r = Math.hypot(dx, dy)
        if (r < inner || r > outer) continue
        bits |= 1 << q
        // Clockwise from twelve o'clock, 0..1.
        const turn = (Math.atan2(dx, -dy) / (2 * Math.PI) + 1) % 1
        if (turn <= percent / 100) on++
        else off++
      }
      cells.push(bits === 0 ? blank() : glyph(QUAD[bits]!, on >= off ? RING_ON : DIM))
    }
    for (let i = 0; i < label.length; i++) {
      cells.push(row === 1 ? glyph(label[i]!, RING_ON) : blank())
    }
  }
  return pack(W + label.length, H, cells)
}

// --- 4. Pill -----------------------------------------------------------------

const PILL = 0x16a34a

export function pill(text: string): Grid {
  const cells: Cell[] = [glyph('▐', PILL)]
  for (const ch of text) cells.push(glyph(ch, 0x000000, PILL))
  cells.push(glyph('▌', PILL))
  return pack(text.length + 2, 1, cells)
}

// --- 5. Thin usage meter -----------------------------------------------------

export function meter(used: number, of = 40): Grid {
  const cells: Cell[] = []
  for (let i = 0; i < of; i++) cells.push(glyph('▄', i < used ? RING_ON : DIM))
  return pack(of, 1, cells)
}

// --- 6. Image bytes ------------------------------------------------------------

/** 32x16 RGBA: a horizontal amber-to-violet gradient with a white circle. */
export function imageRgba(): { rgba: string; width: number; height: number } {
  const width = 32
  const height = 16
  const px = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = lerp(AMBER, 0x7c3aed, x / (width - 1))
      // Pixels show square once 32x16 px fill 16x4 cells (2 px per column,
      // 4 px per row, rows twice as tall), so a plain circle is round on screen.
      const inCircle = Math.hypot(x - 15.5, y - 7.5) < 5.5
      const i = (y * width + x) * 4
      px[i] = inCircle ? 255 : (c >> 16) & 255
      px[i + 1] = inCircle ? 255 : (c >> 8) & 255
      px[i + 2] = inCircle ? 255 : c & 255
      px[i + 3] = 255
    }
  }
  return { rgba: base64(px), width, height }
}
