// A test helper, not part of the mod: it lays a drawn tree out as the
// terminal's rows of characters, so a test can assert the column a piece of
// text starts at. Imported by *.test.tsx files only.
//
// The model is the terminal's, simplified to what the HUD uses:
// - a string, a Text and its nested Texts are one row, concatenated;
// - a plain Button is `hotkey: ` (when it has one) and then its children or
//   its label; any other Button is `[ label ]`;
// - a column Box stacks its children's rows; a row Box (the default, as in
//   Ink) puts its children side by side, each as wide as its own `width` or its widest row, with
//   `columnGap` between them;
// - `paddingLeft` (or `paddingX`) indents, `width` pads a Box's rows, and
//   `display: 'none'` draws nothing.
// Rows are not cut: a row longer than the body is what a test should catch.

type El = { type?: unknown; props?: Record<string, unknown>; children?: unknown }
type Node = El | string | number | null | undefined | boolean | Node[]

/** An element's children: the drawn tree keeps them beside `props`; JSX before drawing, inside. */
function kidsOf(el: El): Node[] {
  const c = el.children ?? el.props?.children
  if (c === undefined) return []
  return Array.isArray(c) ? (c as Node[]) : [c as Node]
}

function inline(node: Node): string {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(inline).join('')
  const props = node.props ?? {}
  const kids = kidsOf(node)
  if (node.type === 'Button') {
    const body = kids.length > 0 ? kids.map(inline).join('') : String(props.label ?? '')
    if (props.plain === true) return typeof props.hotkey === 'string' ? `${props.hotkey}: ${body}` : body
    return `[ ${body} ]`
  }
  return kids.map(inline).join('')
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0)

function rowsOf(node: Node): string[] {
  if (node === null || node === undefined || node === false || node === true) return []
  if (typeof node === 'string' || typeof node === 'number') return String(node).split('\n')
  if (Array.isArray(node)) return node.flatMap(rowsOf)
  const props = node.props ?? {}
  if (node.type !== 'Box') return [inline(node)]
  if (props.display === 'none') return []
  const pad = ' '.repeat(num(props.paddingLeft) || num(props.paddingX))
  const width = typeof props.width === 'number' ? props.width : undefined
  let rows: string[]
  // Ink's default direction is a row; the HUD always writes it out.
  if (props.flexDirection !== 'column' && props.flexDirection !== 'column-reverse') {
    const gap = ' '.repeat(num(props.columnGap) || num(props.gap))
    const blocks = kidsOf(node)
      .filter(k => !(k === null || k === undefined || k === false || k === true))
      .map(k => {
        const r = rowsOf(k)
        const w = typeof k === 'object' && !Array.isArray(k) && k !== null && typeof k.props?.width === 'number'
          ? (k.props.width as number)
          : Math.max(0, ...r.map(x => x.length))
        return { r, w }
      })
    const height = Math.max(0, ...blocks.map(b => b.r.length))
    rows = []
    for (let i = 0; i < height; i++) {
      rows.push(blocks.map(b => (b.r[i] ?? '').padEnd(b.w)).join(gap).trimEnd())
    }
  } else {
    rows = kidsOf(node).flatMap(rowsOf)
  }
  rows = rows.map(r => pad + r)
  if (width !== undefined) rows = rows.map(r => r.padEnd(width))
  return rows
}

/** The drawn tree as rows of characters, each with its trailing spaces cut. */
export function screen(drawn: unknown): string[] {
  return rowsOf(drawn as Node).map(r => r.trimEnd())
}

/** The column `text` starts at in `row`, or -1. */
export function colOf(row: string | undefined, text: string): number {
  return (row ?? '').indexOf(text)
}

// ---------- where the focusable elements sit ----------

const FOCUSABLE = new Set(['Button', 'Input', 'Select'])

/** A laid-out row with the focusable elements that start on it, by column. */
type Line = { s: string; at: { key: string; col: number }[] }

function keyOf(node: El): string {
  const k = node.props?.key
  return typeof k === 'string' ? k : '?'
}

function inlineAt(node: Node): Line {
  if (node === null || node === undefined || node === false || node === true) return { s: '', at: [] }
  if (typeof node === 'string' || typeof node === 'number') return { s: String(node), at: [] }
  if (Array.isArray(node)) return joinLines(node.map(inlineAt))
  const at = FOCUSABLE.has(String(node.type)) ? [{ key: keyOf(node), col: 0 }] : []
  return { s: inline(node), at }
}

function joinLines(parts: Line[]): Line {
  let s = ''
  const at: Line['at'] = []
  for (const p of parts) {
    for (const a of p.at) at.push({ key: a.key, col: a.col + s.length })
    s += p.s
  }
  return { s, at }
}

function linesOf(node: Node): Line[] {
  if (node === null || node === undefined || node === false || node === true) return []
  if (typeof node === 'string' || typeof node === 'number') return String(node).split('\n').map(s => ({ s, at: [] }))
  if (Array.isArray(node)) return node.flatMap(linesOf)
  const props = node.props ?? {}
  if (node.type !== 'Box') return [inlineAt(node)]
  if (props.display === 'none') return []
  const pad = num(props.paddingLeft) || num(props.paddingX)
  const width = typeof props.width === 'number' ? props.width : undefined
  let lines: Line[]
  if (props.flexDirection !== 'column' && props.flexDirection !== 'column-reverse') {
    const gap = num(props.columnGap) || num(props.gap)
    const blocks = kidsOf(node)
      .filter(k => !(k === null || k === undefined || k === false || k === true))
      .map(k => {
        const r = linesOf(k)
        const w = typeof k === 'object' && !Array.isArray(k) && k !== null && typeof k.props?.width === 'number'
          ? (k.props.width as number)
          : Math.max(0, ...r.map(x => x.s.length))
        return { r, w }
      })
    const height = Math.max(0, ...blocks.map(b => b.r.length))
    lines = []
    for (let i = 0; i < height; i++) {
      let s = ''
      const at: Line['at'] = []
      blocks.forEach((b, j) => {
        if (j > 0) s += ' '.repeat(gap)
        const cell = b.r[i] ?? { s: '', at: [] }
        for (const a of cell.at) at.push({ key: a.key, col: a.col + s.length })
        s += cell.s.padEnd(b.w)
      })
      lines.push({ s, at })
    }
  } else {
    lines = kidsOf(node).flatMap(linesOf)
  }
  return lines.map(l => ({ s: ' '.repeat(pad) + l.s, at: l.at.map(a => ({ key: a.key, col: a.col + pad })) }))
}

/**
 * Every Button, Input and Select of the drawn tree with the row and column
 * it starts at on the terminal, in reading order: row by row, left to right.
 */
export function stops(drawn: unknown): { key: string; row: number; col: number }[] {
  return linesOf(drawn as Node).flatMap((l, row) => l.at.map(a => ({ key: a.key, row, col: a.col })))
}
