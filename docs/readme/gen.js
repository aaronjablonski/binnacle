// Generates the README renderings in this folder (docs/readme/*.svg).
// Run: node docs/readme/gen.js   (Node 18+, no dependencies)
//
// The layout data is the HUD v2 design's (docs/superpowers/specs/
// 2026-11-15-mission-control-hud2-design.md): every piece of text is placed at
// an absolute column with Line.at(col, ...parts), and the script exits 1 when a
// row is too wide, starts off the grid, overruns its cell or breaks the rhythm
// rules. The SVG keeps that grid: one column is CH px, every word is placed at
// its own x with a fixed textLength, and bars, sparklines and symbols are drawn
// as shapes, so alignment does not depend on the viewer's monospace font.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = path.dirname(fileURLToPath(import.meta.url))

// ---------- the grid ----------
const W = 62 // pane columns
const M = 2 // left margin: col 0 is the gutter (▍ ┌ ◂ !), col 1 blank
const CELL = 12 // a cell: 10 columns of content + 2 of gap
const CW = 10
const cellCol = i => M + i * CELL // 2 14 26 38 50
const CELLS = [0, 1, 2, 3, 4].map(cellCol)
const C4 = cellCol(3) // metric column
const C5 = cellCol(4) // time column
const NAME_END = C4 - 2 // a name must end by col 36
// Allowed start columns per row kind, at 62 columns.
const STOPS = {
  tabs: CELLS,
  cells: CELLS,
  chips: CELLS,
  head: [0, 2, C5],
  next: [2, 8],
  sec: [0, 2, C4, C5],
  find: [2, 4, C4, C5],
  row: [0, 2, 4, 6, 8, 10, 12, C4, C5],
  open: [0, 2, 4, 10, C4, C5],
  detail: [6, 14],
  action: [6],
  more: [2, 4, 6, 8],
  note: [2, 4],
  hint: [2],
  track: [2],
  blank: [],
}

const len = s => [...s].length
const sp = n => ' '.repeat(Math.max(0, n))
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const fit = (s, n) => (len(s) <= n ? s : [...s].slice(0, n - 1).join('') + '…')
const txt = p => (typeof p === 'string' ? p : p[1])
const widthOf = parts => parts.reduce((n, p) => n + len(txt(p)), 0)

const problems = []
let current = ''
const bad = msg => problems.push(`${current}: ${msg}`)

class Line {
  constructor(k, cls = '') { this.k = k; this.cls = cls; this.parts = []; this.w = 0; this.starts = []; this.segs = [] }
  at(col, ...parts) {
    if (this.w > col) bad(`[${this.k}] overlap at col ${col} (already at ${this.w}): ${this.text()}|${parts.map(txt).join('')}`)
    else if (this.w > 0 && col - this.w < 1) bad(`[${this.k}] no gap before col ${col}: ${this.text()}`)
    if (col > this.w) { this.parts.push(sp(col - this.w)); this.w = col }
    const n = widthOf(parts)
    this.parts.push(...parts)
    this.starts.push(col)
    this.segs.push([col, n])
    this.w += n
    return this
  }
  text() { return this.parts.map(txt).join('') }
}
const L = (k, cls) => new Line(k, cls)
const BLANK = () => L('blank')

// ---------- validation ----------
function validate(lines, o = {}) {
  const w = o.w || W
  const stops = o.stops || STOPS
  const maxRows = o.maxRows || 36
  if (lines.length > maxRows) bad(`${lines.length} rows > ${maxRows}`)
  let rowsInSection = 0
  lines.forEach((l, i) => {
    const prev = lines[i - 1]
    if (l.w > w) bad(`row ${i} [${l.k}] is ${l.w} > ${w}: ${l.text()}`)
    const allowed = stops[l.k]
    if (allowed === undefined) bad(`row ${i}: unknown kind ${l.k}`)
    if (allowed) l.starts.forEach(c => { if (!allowed.includes(c)) bad(`row ${i} [${l.k}] starts a segment at col ${c}, off grid (${allowed.join(' ')}): ${l.text()}`) })
    if (o.loose) return
    // a segment in a cell column never runs into the next cell's first column
    l.segs.forEach(([c, n]) => {
      if (['row', 'open', 'sec', 'find', 'cells', 'chips', 'head'].includes(l.k)) {
        if ((c === C4 || (l.k === 'cells' && c !== C5)) && n > CW) bad(`row ${i} [${l.k}] cell at ${c} is ${n} wide > ${CW}: ${l.text()}`)
        if (c === C5 && n > CW) bad(`row ${i} [${l.k}] time cell is ${n} wide > ${CW}: ${l.text()}`)
        if (c < C4 && c + n > NAME_END && l.starts.includes(C4)) bad(`row ${i} [${l.k}] name ends at ${c + n} > ${NAME_END}: ${l.text()}`)
      }
    })
    if (l.k === 'blank' && prev && prev.k === 'blank') bad(`row ${i}: two blank rows`)
    if (l.k === 'sec') { rowsInSection = 0; if (!prev || prev.k !== 'blank') bad(`row ${i}: section label without a blank row above: ${l.text()}`) }
    if (l.k === 'row' || l.k === 'open') { rowsInSection++; if (rowsInSection > 6) bad(`row ${i}: more than 6 rows in a section: ${l.text()}`) }
    if (l.k === 'open') {
      if (prev && prev.k !== 'blank' && prev.k !== 'sec') bad(`row ${i}: opened row needs a blank row above: ${l.text()}`)
      let j = i + 1, d = 0
      while (lines[j] && lines[j].k === 'detail') { d++; j++ }
      if (d < 1 || d > 3) bad(`row ${i}: opened row has ${d} detail lines (1 to 3)`)
      if (!lines[j] || lines[j].k !== 'action') bad(`row ${i}: opened row has no action line`)
      else if (lines[j + 1] && lines[j + 1].k !== 'blank') bad(`row ${i}: opened row needs a blank row below`)
    }
    if (l.k === 'detail' && !['open', 'detail'].includes(prev && prev.k)) bad(`row ${i}: stray detail line`)
    if (l.k === 'action') { const n = (l.text().match(/\S: /g) || []).length; if (n < 1 || n > 3) bad(`row ${i}: ${n} actions (1 to 3)`) }
    if (l.k === 'hint') { const n = l.text().trim().split(/ {3,}/).length; if (n > 3) bad(`hint has ${n} entries > 3`) }
  })
  return lines
}

// ---------- svg ----------
const CH = 8.4 // one column
const LH = 22 // one row
const FS = 14
const BASE = 15.5 // baseline inside a row
const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
const BG = '#16181d', FG = '#c9cfdb', EDGE = '#2a2f3d', BAR = '#1b1e25', TINT = '#222735'
const COL = { d: '#8b93a6', a: '#7aa2f7', g: '#9ece6a', y: '#e0af68', r: '#f7768e', p: '#bb9af7', s: '#343a4d' }
const f = v => String(+v.toFixed(2))
const rect = (x, y, w, h, fill, extra = '') => `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${fill}"${extra}/>`
const stroke = (d, c, sw = 1.4) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`
const poly = (pts, c) => `<path d="M${pts.map(p => `${f(p[0])},${f(p[1])}`).join(' L')} Z" fill="${c}"/>`
const P = (...v) => v.map(f).join(' ')

// Symbols are drawn, not typed: a fallback font's are rarely one column wide.
// Each gets the centre of its cell (x, y) and its colour.
const GLYPH = {
  '▍': (x, y, c) => rect(x - CH / 2, y - 9, 3.2, 18, c),
  '┌': (x, y, c) => stroke(`M${P(x, y + 11)} V${f(y)} H${f(x + CH / 2)}`, c, 1.3),
  '├': (x, y, c) => stroke(`M${P(x, y - 11)} V${f(y + 11)} M${P(x, y)} H${f(x + CH / 2)}`, c, 1.2),
  '│': (x, y, c) => stroke(`M${P(x, y - 11)} V${f(y + 11)}`, c, 1.2),
  '└': (x, y, c) => stroke(`M${P(x, y - 11)} V${f(y)} H${f(x + CH / 2)}`, c, 1.2),
  '▸': (x, y, c) => poly([[x - 2.6, y - 4.2], [x + 3.4, y], [x - 2.6, y + 4.2]], c),
  '◂': (x, y, c) => poly([[x + 2.6, y - 4.2], [x - 3.4, y], [x + 2.6, y + 4.2]], c),
  '▲': (x, y, c) => poly([[x - 4, y + 3.6], [x + 4, y + 3.6], [x, y - 4]], c),
  '✓': (x, y, c) => stroke(`M${P(x - 3.4, y + 0.4)} L${P(x - 1, y + 3)} L${P(x + 3.6, y - 3.2)}`, c, 1.5),
  '✖': (x, y, c) => stroke(`M${P(x - 3, y - 3)} L${P(x + 3, y + 3)} M${P(x + 3, y - 3)} L${P(x - 3, y + 3)}`, c, 1.9),
  '✕': (x, y, c) => stroke(`M${P(x - 2.6, y - 2.6)} L${P(x + 2.6, y + 2.6)} M${P(x + 2.6, y - 2.6)} L${P(x - 2.6, y + 2.6)}`, c, 1.3),
  '●': (x, y, c) => `<circle cx="${f(x)}" cy="${f(y)}" r="3.4" fill="${c}"/>`,
  '○': (x, y, c) => `<circle cx="${f(x)}" cy="${f(y)}" r="3.1" fill="none" stroke="${c}" stroke-width="1.2"/>`,
  '◆': (x, y, c) => poly([[x, y - 4.6], [x + 3.9, y], [x, y + 4.6], [x - 3.9, y]], c),
  '★': (x, y, c) => poly(Array.from({ length: 10 }, (_, k) => { const r = k % 2 ? 1.9 : 4.6, a = ((-90 + k * 36) * Math.PI) / 180; return [x + r * Math.cos(a), y + 0.4 + r * Math.sin(a)] }), c),
  '›': (x, y, c) => stroke(`M${P(x - 1.6, y - 3.4)} L${P(x + 1.8, y)} L${P(x - 1.6, y + 3.4)}`, c, 1.3),
  '↗': (x, y, c) => stroke(`M${P(x - 3, y + 3)} L${P(x + 3, y - 3)} M${P(x - 0.8, y - 3)} H${f(x + 3)} V${f(y + 0.8)}`, c, 1.4),
  '↥': (x, y, c) => stroke(`M${P(x, y + 1.6)} V${f(y - 4.2)} M${P(x - 2.8, y - 1.6)} L${P(x, y - 4.4)} L${P(x + 2.8, y - 1.6)} M${P(x - 3, y + 4)} H${f(x + 3)}`, c, 1.3),
  '↵': (x, y, c) => stroke(`M${P(x + 3, y - 4)} V${f(y + 1)} H${f(x - 3)} M${P(x - 1, y - 1.4)} L${P(x - 3.2, y + 1)} L${P(x - 1, y + 3.4)}`, c, 1.2),
  '▤': (x, y, c) => stroke(`M${P(x - 3.3, y - 4.2)} H${f(x + 3.3)} V${f(y + 4.2)} H${f(x - 3.3)} Z M${P(x - 3.3, y - 1.4)} H${f(x + 3.3)} M${P(x - 3.3, y + 1.4)} H${f(x + 3.3)}`, c, 1),
  '≡': (x, y, c) => stroke(`M${P(x - 3.2, y - 3)} H${f(x + 3.2)} M${P(x - 3.2, y)} H${f(x + 3.2)} M${P(x - 3.2, y + 3)} H${f(x + 3.2)}`, c, 1.3),
  '⎿': (x, y, c) => stroke(`M${P(x - 1.5, y - 6)} V${f(y + 2)} H${f(x + 3.5)}`, c, 1.2),
  '✳': (x, y, c) => stroke(`M${P(x, y - 3.8)} V${f(y + 3.8)} M${P(x - 3.3, y - 1.9)} L${P(x + 3.3, y + 1.9)} M${P(x + 3.3, y - 1.9)} L${P(x - 3.3, y + 1.9)}`, c, 1.4),
}
const SPARKS = '▁▂▃▄▅▆▇█'
const TYPED = '…“”·×' // non-ASCII that every monospace stack has; typed inside a word
const special = ch => ch === ' ' || ch === '━' || ch === '─' || SPARKS.includes(ch) || ch in GLYPH

function styleOf(cls) {
  const t = cls.split(' ').filter(Boolean)
  const key = t.find(k => k in COL)
  return { fill: key ? COL[key] : FG, bold: t.includes('b'), u: t.includes('u'), inv: t.includes('inv') }
}

// One styled run of text, its first character's cell starting at x, in the row whose top is y.
function drawText(text, cls, x, y) {
  const st = styleOf(cls)
  const chars = [...text]
  let out = ''
  if (st.inv) { out += rect(x, y + 3, chars.length * CH, 17, FG); st.fill = BG }
  for (let i = 0; i < chars.length; ) {
    const ch = chars[i], cx = x + i * CH
    if (ch === ' ') { i++; continue }
    if (ch === '━' || ch === '─') {
      let j = i
      while (chars[j] === ch) j++
      out += ch === '━' ? rect(cx, y + 9.5, (j - i) * CH, 3, st.fill) : rect(cx, y + 10.5, (j - i) * CH, 1, st.fill)
      i = j
      continue
    }
    const lv = SPARKS.indexOf(ch)
    if (lv >= 0) { const h = 2 + lv * 2; out += rect(cx + 0.7, y + 18 - h, CH - 1.4, h, st.fill); i++; continue }
    if (ch in GLYPH) { out += GLYPH[ch](cx + CH / 2, y + LH / 2, st.fill); i++; continue }
    let j = i
    while (j < chars.length && !special(chars[j])) j++
    const word = chars.slice(i, j)
    word.forEach(c => { if (c.codePointAt(0) > 0x7e && !TYPED.includes(c)) bad(`no drawing for "${c}" in: ${text}`) })
    const attrs = (st.fill !== FG ? ` fill="${st.fill}"` : '') + (st.bold ? ' font-weight="700"' : '') + (word.length > 1 ? ` textLength="${f(word.length * CH)}"` : '')
    out += `<text x="${f(cx)}" y="${f(y + BASE)}"${attrs}>${esc(word.join(''))}</text>`
    if (st.u) out += rect(cx, y + 18, word.length * CH, 1, st.fill)
    i = j
  }
  return out
}
function drawLine(line, x, y, cols) {
  let out = ''
  if (line.cls === 'hv') out += rect(x, y, cols * CH, LH, TINT, ' rx="3"')
  let col = 0
  for (const p of line.parts) {
    const [cls, text] = typeof p === 'string' ? ['', p] : p
    out += drawText(text, cls, x + col * CH, y)
    col += len(text)
  }
  return out
}
const drawLines = (lines, x, y, cols) => lines.map((l, i) => drawLine(l, x, y + i * LH, cols)).filter(Boolean).join('\n')

const TB = 34 // title bar
// A terminal window at (0, y): frame, title bar, three dots, a title.
function frame(y, w, h, title) {
  const r = 10
  return [
    `<rect x="0.5" y="${f(y + 0.5)}" width="${f(w - 1)}" height="${f(h - 1)}" rx="${r}" fill="${BG}" stroke="${EDGE}"/>`,
    `<path d="M0.5,${f(y + TB)} V${f(y + r + 0.5)} a${r},${r} 0 0 1 ${r},-${r} H${f(w - r - 0.5)} a${r},${r} 0 0 1 ${r},${r} V${f(y + TB)} Z" fill="${BAR}" stroke="${EDGE}"/>`,
    ...[COL.r, COL.y, COL.g].map((c, i) => `<circle cx="${20 + i * 18}" cy="${f(y + TB / 2 + 0.5)}" r="5" fill="${c}" opacity="0.75"/>`),
    `<text x="${f(w / 2)}" y="${f(y + TB / 2 + 4.5)}" text-anchor="middle" font-size="12" fill="${COL.d}">${esc(title)}</text>`,
  ].join('\n')
}
// The prompt box with a blinking block cursor (it stays solid where SMIL is off).
function promptBox(x, y, w) {
  return [
    `<rect x="${f(x + 0.5)}" y="${f(y + 0.5)}" width="${f(w - 1)}" height="33" rx="6" fill="none" stroke="#3b4261"/>`,
    `<text x="${f(x + 12)}" y="${f(y + 6 + BASE)}" fill="${COL.d}">&gt;</text>`,
    `<rect x="${f(x + 12 + 2 * CH)}" y="${f(y + 9)}" width="${CH}" height="17" fill="${FG}"><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.5;0.5;1" dur="1.2s" repeatCount="indefinite"/></rect>`,
  ].join('\n')
}
function emit(file, label, w, h, body) {
  const W_ = Math.ceil(w), H_ = Math.ceil(h)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W_}" height="${H_}" viewBox="0 0 ${W_} ${H_}" role="img" aria-label="${esc(label)}">
<title>${esc(label)}</title>
<g font-family="${FONT}" font-size="${FS}" fill="${FG}">
${body}
</g>
</svg>
`
  fs.writeFileSync(path.join(OUT, file), svg)
  written.push(`${file}  ${W_}×${H_}  ${label}`)
}
const written = []

// a free-flow line (band, chat): left parts, right parts, padded to w
function lr(left, right, w) {
  const gap = w - widthOf(left) - widthOf(right)
  if (gap < 2) bad(`lr gap ${gap}: ${[...left, ...right].map(txt).join('')}`)
  const l = L('free'); l.parts = [...left, sp(Math.max(1, gap)), ...right]; l.w = widthOf(l.parts)
  return l
}
const free = (...parts) => { const l = L('free'); l.parts = parts; l.w = widthOf(parts); return l }

// The chat beside the pane: the same turn at two widths.
const CHAT_WIDE = [
  [['d', '> '], 'group timeline steps by agent'],
  [],
  [['g', '●'], ' ', ['b', 'Read'], '(mod/hooks/views/timeline.tsx)'],
  [['d', '  ⎿ Read 347 lines']],
  [['g', '●'], ' ', ['b', 'Agent'], '(Explore · find every caller…)'],
  [['d', '  ⎿ Running in background']],
  [['g', '●'], ' ', ['b', 'Agent'], '(general-purpose · write tests)'],
  [['d', '  ⎿ Running in background']],
  [['d', '◆ Mission Control updated: Grouping…']],
  [['g', '●'], ' ', ['b', 'Edit'], '(mod/hooks/views/timeline.tsx)'],
  [['d', '  ⎿ Added 21 lines']],
  [['g', '●'], ' ', ['b', 'Bash'], '(npm test -- timeline)'],
  [['r', '  ⎿ Error: 1 failed, 22 passed']],
  [],
  [['y', '✳ Grouping timeline steps by agent…'], ['d', ' 2m 14s']],
].map(p => free(...p))
const CHAT_NARROW = [
  [['d', '> '], 'group timeline steps by agent'],
  [],
  [['g', '●'], ' ', ['b', 'Read'], '(…/views/timeline.tsx)'],
  [['d', '  ⎿ Read 347 lines']],
  [['g', '●'], ' ', ['b', 'Agent'], '(Explore · find callers…)'],
  [['d', '  ⎿ Running in background']],
  [['g', '●'], ' ', ['b', 'Agent'], '(general · write tests)'],
  [['d', '  ⎿ Running in background']],
  [['d', '◆ Mission Control updated: Group…']],
  [['g', '●'], ' ', ['b', 'Edit'], '(…/views/timeline.tsx)'],
  [['d', '  ⎿ Added 21 lines']],
  [['g', '●'], ' ', ['b', 'Bash'], '(npm test -- timeline)'],
  [['r', '  ⎿ Error: 1 failed, 22 passed']],
  [],
  [['y', '✳ Grouping timeline steps…'], ['d', ' 2m 14s']],
].map(p => free(...p))
const CHAT_COLS = 48 // the hero and the mocks
const SIDE_COLS = 34 // the feature renderings: a narrower chat, the same pane

// A terminal window: the chat on the left with the band and prompt, the pane on the right.
function paneBoard(file, label, o) {
  current = file
  const pw = o.w || W
  const chatCols = o.chatCols || SIDE_COLS
  const chat = o.chat || (chatCols >= CHAT_COLS ? CHAT_WIDE : CHAT_NARROW)
  validate(o.lines, o)
  validate([o.hint], { w: pw })
  ;[...chat, o.band].forEach(l => { if (l.w > chatCols) bad(`chat row is ${l.w} > ${chatCols}: ${l.text()}`) })
  const PY = 14, CPX = 18, PPX = 16
  const divX = CPX + chatCols * CH + CPX
  const paneX = divX + PPX
  const w = paneX + pw * CH + PPX
  const rows = Math.max(o.lines.length + 2, chat.length + 4)
  const top = TB + PY
  const h = top + rows * LH + PY
  const bottom = top + rows * LH
  const body = [
    frame(0, w, h, 'claude'),
    drawLines(chat, CPX, top, chatCols),
    drawLine(o.band, CPX, bottom - 34 - 4 - LH, chatCols),
    promptBox(CPX, bottom - 34, chatCols * CH),
    rect(divX, TB + 0.5, 1, h - TB - 1, EDGE),
    drawLines(o.lines, paneX, top, pw),
    drawLine(o.hint, paneX, bottom - LH, pw),
  ].join('\n')
  emit(file, label, w, h, body)
}

// ---------- parts ----------
const TABS = ['Now', 'Tasks', 'Agents', 'Steps', 'Artifacts']
function tabBar(open) {
  // the engine draws `1: Label`; each tab is one grid cell wide
  const line = L('tabs'), track = L('track')
  let s = 0, e = 0
  TABS.forEach((name, i) => {
    const col = M + i * CELL
    if (i === open) { line.at(col, ['a', `${i + 1}:`], ' ', ['a b', name]); s = col; e = line.w }
    else line.at(col, ['a', `${i + 1}:`], ['d', ' ' + name])
  })
  if (line.w > W) bad(`tab bar ${line.w} > ${W}`)
  const end = Math.min(W, M + TABS.length * CELL)
  track.at(M, ['s', '─'.repeat(s - M)], ['a', '━'.repeat(e - s)], ['s', '─'.repeat(end - e)])
  return [line, track]
}
const top = open => [...tabBar(open), BLANK()]

function bar(v, total, cls = 'a') {
  let n = Math.round((v / total) * CW)
  if (v > 0 && n === 0) n = 1
  if (v < total && n === CW) n = CW - 1
  return [[cls, '━'.repeat(n)], ['s', '─'.repeat(CW - n)]]
}
function stack(segs) { // [[n, cls]] -> exactly CW columns, largest remainder, 1 at least
  const total = segs.reduce((n, s) => n + s[0], 0)
  const raw = segs.map(s => (s[0] / total) * CW)
  const out = raw.map((x, i) => (segs[i][0] > 0 ? Math.max(1, Math.floor(x)) : 0))
  let left = CW - out.reduce((a, b) => a + b, 0)
  const order = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0])
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length][1]]++
  for (; left < 0; left++) out[out.indexOf(Math.max(...out))]--
  return segs.map((s, i) => [s[1], '━'.repeat(out[i])])
}
function spark(vals, cls = 'a') {
  if (vals.length !== CW) bad(`spark has ${vals.length} buckets, not ${CW}`)
  const max = Math.max(...vals)
  return [[cls, vals.map(v => SPARKS[Math.min(7, Math.round((v / max) * 7))]).join('')]]
}
// label / value / diagram, each starting at the cell's first column
function readout(cells, cols = CELLS) {
  if (cells.length > cols.length) bad(`readout has ${cells.length} cells`)
  const a = L('cells'), b = L('cells'), c = L('cells')
  cells.forEach((cell, i) => {
    const col = cols[i]
    if (len(cell.label) > CW) bad(`readout label too wide: ${cell.label}`)
    if (widthOf(cell.value) > CW) bad(`readout value too wide: ${cell.label}`)
    if (widthOf(cell.gfx) !== CW) bad(`readout diagram of ${cell.label} is ${widthOf(cell.gfx)} wide, not ${CW}`)
    a.at(col, ['d', cell.label]); b.at(col, ...cell.value); c.at(col, ...cell.gfx)
  })
  return [a, b, c]
}
const sec = (label, metric, time, cls = 'a') => {
  const l = L('sec').at(0, [cls, '┌']).at(2, [cls === 'a' ? 'b' : cls + ' b', label])
  if (metric) l.at(C4, ['d', metric])
  if (time) l.at(C5, ['d', time])
  return l
}
// a table row: gutter flag, glyph, name, one metric, time
function row(o) {
  const l = L(o.open ? 'open' : 'row', o.cls)
  if (o.flag) l.at(0, o.flag)
  const g = o.indent || 0
  if (o.guide) l.at(2, ['s', o.guide])
  l.at(2 + g, o.glyph)
  const nameCol = 4 + g
  const name = Array.isArray(o.name) ? o.name : [[o.nameCls || '', o.name]]
  if (o.tool) { l.at(nameCol, ['d', fit(o.tool, 5)]); l.at(nameCol + 6, ...name) }
  else l.at(nameCol, ...name)
  if (o.metric) l.at(C4, ...(Array.isArray(o.metric) ? o.metric : [['d', o.metric]]))
  if (o.time) l.at(C5, ...(Array.isArray(o.time) ? o.time : [['d', o.time]]))
  return l
}
const detail = (key, ...value) => L('detail').at(6, ['d', key]).at(14, ...value)
const action = (...pairs) => { // engine format for hotkeyed plain Buttons: `g: chat`, 3 columns apart
  const parts = []
  pairs.forEach(([k, word], i) => { if (i) parts.push('   '); parts.push(['a', k + ':'], ' ' + word) })
  return L('action').at(6, ...parts)
}
const more = (text, indent = 0, guide) => { const l = L('more'); if (guide) l.at(2, ['s', guide]); return l.at(2 + indent, ['d', '+']).at(4 + indent, ['d', text]) }
const hint = (...items) => {
  const parts = []
  items.forEach((it, i) => { if (i) parts.push('   '); if (Array.isArray(it)) parts.push(['a', it[0] + ':'], ['d', ' ' + it[1]]); else parts.push(['d', it]) })
  return L('hint').at(2, ...parts)
}
// cut at a word boundary, never inside a word
const wordFit = (s, n) => { if (len(s) <= n) return s; let out = ''; for (const w of s.split(' ')) { if (len(out) + len(w) + (out ? 1 : 0) + 1 > n) break; out += (out ? ' ' : '') + w } return out + '…' }
function wrapWords(s, n, maxLines) {
  const lines = ['']
  for (const w of s.split(' ')) {
    const cur = lines[lines.length - 1]
    if (len(cur) + len(w) + (cur ? 1 : 0) <= n) lines[lines.length - 1] = cur + (cur ? ' ' : '') + w
    else lines.push(w)
  }
  if (lines.some(l => len(l) > n)) bad('a word is wider than the line: ' + s)
  if (lines.length > maxLines) { const keep = lines.slice(0, maxLines); keep[maxLines - 1] = wordFit(keep[maxLines - 1] + ' ' + lines[maxLines], n); return keep }
  return lines
}
const headline = (text, age) => L('head').at(0, ['a', '▍']).at(2, ['b', text]).at(C5, ['d', age])
const nextLine = text => L('next').at(2, ['d', 'next']).at(8, text)
const HL = s => ['a u', s]
const LIVE = ['a', '▸'], DONE = ['d', '✓'], FAIL = ['r', '✖'], ASK = ['y', '?']
const ONSCREEN = ['a', '◂'], PROBLEM = ['r', '!']

// The band in the chat column. It drops `/mc` before it cuts the focus.
const BUSY_LEFT = [['a', '▍'], ' 9', ['d', '/14'], '  Grouping timeline…', '   ', ['a', '▸'], ' 2', '   ', ['r', '✖'], ' 1']
const BAND_BUSY_WIDE = lr(BUSY_LEFT, [['d', '/mc']], CHAT_COLS)
const BAND_BUSY = lr([['a', '▍'], ' 9', ['d', '/14'], '  Grouping…', '   ', ['a', '▸'], ' 2', '   ', ['r', '✖'], ' 1'], [['d', '/mc']], SIDE_COLS)
const BAND_WAIT = free(['y b', '▲ 2 need you'], '   ', ['a', '▍'], ' 9', ['d', '/14'], '  Grouping…')

const STEPS_SPARK = [2, 2, 3, 5, 3, 7, 5, 2, 3, 5]
const NOW_READOUT = hot => readout([
  { label: 'TASKS', value: [['b', '9'], ['d', '/14']], gfx: bar(9, 14) },
  { label: 'AGENTS', value: [['b', '2'], ['d', ' live']], gfx: stack([[2, 'a'], [3, 'd'], [1, 'r']]) },
  { label: 'STEPS', value: [['b', '52'], ' ', ['r', '✖'], hot ? ' 3' : ' 1'], gfx: spark(STEPS_SPARK) },
  { label: 'CTX', value: [['b', '9%']], gfx: bar(9, 100) },
  hot ? { label: '5H', value: [['y b', '78%']], gfx: bar(78, 100, 'y') } : { label: '7D', value: [['b', '22%']], gfx: bar(22, 100) },
])
const AGENT_ROWS = () => [
  row({ glyph: LIVE, name: 'find every caller of stepRow', metric: '72k', time: '1m' }),
  row({ glyph: LIVE, name: 'write timeline tests', metric: '88k', time: '40s' }),
]

// ---------- Now, busy (the hero) ----------
paneBoard('hero.svg', 'Mission Control beside the chat: the Now tab while Claude works', {
  chatCols: CHAT_COLS,
  band: BAND_BUSY_WIDE,
  lines: [
    ...top(0),
    headline('Grouping timeline steps by agent', '20s'),
    nextLine('Humanise step labels'),
    BLANK(),
    ...NOW_READOUT(false),
    BLANK(),
    sec('AGENTS', 'tokens', 'time'),
    ...AGENT_ROWS(),
    BLANK(),
    sec('LATEST', 'agent', 'time'),
    row({ flag: ONSCREEN, glyph: LIVE, tool: 'Edit', name: '…/views/timeline.tsx', metric: 'main', time: 'now' }),
    row({ glyph: FAIL, tool: 'Bash', name: 'npm test -- timeline', metric: 'general', time: '4s' }),
    BLANK(),
    sec('KEPT', 'step', 'at'),
    row({ glyph: ['', '★'], name: 'the label helper', metric: 'Edit', time: '13:21' }),
    L('note').at(4, ['d', 'kept steps are never trimmed and export in full']),
    BLANK(),
    sec('NOTES'),
    L('note').at(2, ['d', '·']).at(4, 'stepRow is called from timeline and overview only'),
    L('note').at(2, ['d', '·']).at(4, 'Handback steps carry raw JSON; label them by agent'),
  ],
  hint: hint(['n', 'next error'], ['p', 'prev'], ['f', 'find']),
})

// ---------- Now, waiting on you ----------
paneBoard('now.svg', 'Now tab with a NEEDS YOU section: a permission request and a repeated failure', {
  band: BAND_WAIT,
  lines: [
    ...top(0),
    headline('Grouping timeline steps by agent', '20s'),
    nextLine('Humanise step labels'),
    BLANK(),
    sec('NEEDS YOU', 'why', 'waiting', 'y'),
    row({ open: true, cls: 'hv', glyph: ASK, tool: 'Bash', name: [['b', 'npm publish --dry-run']], metric: [['y', 'permission']], time: [['y', '40s']] }),
    detail('asks', 'to run this command in mod/'),
    action(['g', 'chat'], ['x', 'dismiss'], ['n', 'next']),
    BLANK(),
    row({ glyph: FAIL, tool: 'Bash', name: 'npm test -- timeline', metric: 'failed 3×', time: '2m' }),
    BLANK(),
    ...NOW_READOUT(true),
    BLANK(),
    sec('AGENTS', 'tokens', 'time'),
    ...AGENT_ROWS(),
  ],
  hint: hint(['p', 'prev'], ['f', 'find'], 'esc prompt'),
})

// ---------- Tasks ----------
paneBoard('tasks.svg', 'Tasks tab: readouts, the active task with two live agents, queued and done tasks', {
  band: BAND_BUSY,
  lines: [
    ...top(1),
    ...readout([
      { label: 'DONE', value: [['b', '9'], ['d', '/14']], gfx: bar(9, 14) },
      { label: 'ACTIVE', value: [['b', '1']], gfx: bar(1, 14) },
      { label: 'QUEUED', value: [['b', '4']], gfx: bar(4, 14, 'd') },
      { label: 'ELAPSED', value: [['b', '1h23']], gfx: spark([1, 0, 2, 1, 0, 3, 1, 0, 1, 0], 'd') },
    ]),
    BLANK(),
    sec('ACTIVE', 'agents', 'time'),
    row({ glyph: LIVE, name: [['b', 'Grouping timeline steps by agent']], metric: '2 live', time: '3m' }),
    BLANK(),
    sec('QUEUED'),
    row({ glyph: ['d', '○'], name: 'Humanise step labels' }),
    row({ glyph: ['d', '○'], name: 'Turn titles without raw paths' }),
    row({ glyph: ['d', '○'], name: 'Run plugin tests on four surfaces' }),
    row({ glyph: ['d', '○'], name: 'Update README and HANDOVER.md' }),
    BLANK(),
    sec('DONE', undefined, 'took'),
    row({ glyph: DONE, name: 'Count .ts files in mod/', nameCls: 'd', time: '7s' }),
    row({ glyph: DONE, name: 'List HANDOVER.md headings', nameCls: 'd', time: '5s' }),
    row({ glyph: DONE, name: 'Read HANDOVER.md', nameCls: 'd', time: '4s' }),
    more('6 more'),
  ],
  hint: hint('↵ open', ['d', 'all done'], ['e', 'export']),
})

// ---------- Agents ----------
const AGENT_READOUT = () => readout([
  { label: 'LIVE', value: [['b', '2']], gfx: bar(2, 6) },
  { label: 'DONE', value: [['b', '3']], gfx: bar(3, 6, 'd') },
  { label: 'FAILED', value: [['r b', '1']], gfx: bar(1, 6, 'r') },
  { label: 'OPUS', value: [['b', '993k']], gfx: bar(993, 1512, 'p') },
  { label: 'HAIKU', value: [['b', '519k']], gfx: bar(519, 1512, 'p') },
])
const toggles = on => {
  const l = L('chips')
  ;[['l', 'List'], ['t', 'Tree'], ['r', 'Running']].forEach(([k, name], i) => {
    if (i === on) l.at(CELLS[i], ['a', k + ':'], ' ', ['a b', name]); else l.at(CELLS[i], ['a', k + ':'], ['d', ' ' + name])
  })
  return l
}
paneBoard('agents.svg', 'Agents tab as a list: one finished agent opened to its result, and a workflow run', {
  band: BAND_BUSY,
  lines: [
    ...top(2),
    ...AGENT_READOUT(),
    BLANK(),
    toggles(0),
    BLANK(),
    sec('AGENTS', 'tokens', 'time'),
    row({ glyph: ['d', '◆'], name: 'main', metric: '993k', time: '1h23' }),
    ...AGENT_ROWS(),
    row({ glyph: FAIL, name: 'run plugin tests', metric: '81k', time: '31s' }),
    BLANK(),
    row({ open: true, cls: 'hv', glyph: DONE, name: [['b', 'count .ts files in mod/']], metric: '106k', time: '7s' }),
    detail('result', '17 TypeScript files under mod/, 9 tests'),
    detail('agent', ['d', 'Explore · haiku · 2 steps · 13:25']),
    action(['s', 'steps'], ['v', 'transcript'], ['g', 'chat']),
    BLANK(),
    more('2 more done'),
    BLANK(),
    sec('RUNS', 'agents', 'time'),
    row({ flag: PROBLEM, glyph: ['d', '≡'], name: 'review-branch', metric: [['d', '6 · '], ['r', '✖'], ' 1'], time: '6m' }),
  ],
  hint: hint('↵ open', ['n', 'next failed'], ['p', 'prev']),
})

paneBoard('agents-tree.svg', 'Agents tab as a tree: a workflow run as a branch, with a failed agent flagged in the gutter', {
  band: BAND_BUSY,
  lines: [
    ...top(2),
    ...AGENT_READOUT(),
    BLANK(),
    toggles(1),
    BLANK(),
    sec('AGENTS', 'tokens', 'time'),
    row({ glyph: ['d', '◆'], name: 'main', metric: '993k', time: '1h23' }),
    row({ guide: '├', indent: 2, glyph: LIVE, name: 'find every caller of stepRow', metric: '72k', time: '1m' }),
    row({ guide: '├', indent: 2, glyph: LIVE, name: 'write timeline tests', metric: '88k', time: '40s' }),
    row({ flag: PROBLEM, guide: '├', indent: 2, glyph: ['d', '≡'], name: 'review-branch', metric: '412k', time: '6m' }),
    row({ guide: '│ ├', indent: 4, glyph: LIVE, name: 'review the hooks', metric: '64k', time: '1m' }),
    row({ flag: PROBLEM, guide: '│ ├', indent: 4, glyph: FAIL, name: 'review the views', metric: '81k', time: '31s' }),
    more('4 done', 4, '│ └'),
    more('3 done', 2, '└'),
  ],
  hint: hint('↵ open', ['n', 'next !'], ['p', 'prev']),
})

// ---------- Steps ----------
const chips = (on, items) => {
  const l = L('chips')
  items.forEach(([name, n, cls], i) => {
    if (i === on) l.at(CELLS[i], ['a b', name + ' ' + n]); else l.at(CELLS[i], ['d', name + ' '], [cls || '', String(n)])
  })
  return l
}
paneBoard('steps.svg', 'Steps tab with find: seven hits for "timeline" underlined, earlier turns with hit counts', {
  band: BAND_BUSY,
  lines: [
    ...top(3),
    L('find').at(2, ['a', '/']).at(4, 'timeline', ['inv', ' ']).at(C4, ['b', '7'], ['d', ' hits']).at(C5, ['d', 'of 52']),
    BLANK(),
    chips(0, [['All', 7], ['Kept', 1], ['Errors', 1, 'r'], ['In view', 2]]),
    BLANK(),
    sec('“group timeline steps by agent”', 'agent', 'time'),
    row({ flag: ONSCREEN, glyph: LIVE, tool: 'Edit', name: ['…/views/', HL('timeline'), '.tsx'], metric: 'main', time: 'now' }),
    row({ glyph: FAIL, tool: 'Bash', name: ['npm test -- ', HL('timeline')], metric: 'general', time: '4s' }),
    row({ glyph: DONE, tool: 'Edit', name: ['…/', HL('timeline'), '.test.tsx'], metric: 'general', time: '2s' }),
    row({ flag: ONSCREEN, glyph: DONE, tool: 'Grep', name: ['"stepRow(" …/', HL('timeline'), '.tsx'], metric: 'Explore', time: '1s' }),
    row({ glyph: ['', '★'], tool: 'Read', name: ['…/views/', HL('timeline'), '.tsx'], metric: 'main', time: '1s' }),
    more('13 more in this turn · 2 hits'),
    BLANK(),
    sec('EARLIER TURNS', 'hits', 'at'),
    row({ glyph: ['d', '›'], name: '“count .ts files in mod/”', metric: '1', time: '13:02' }),
    row({ glyph: ['d', '›'], name: '“list HANDOVER.md headings”', metric: '1', time: '12:41' }),
  ],
  hint: hint(['n', 'next hit'], ['p', 'prev'], 'esc clear'),
})

paneBoard('step-open.svg', 'Steps tab with a failed step opened in place: status, result and actions', {
  band: BAND_BUSY,
  lines: [
    ...top(3),
    L('find').at(2, ['a', 'f:'], ['d', ' Find']).at(C4, ['b', '52'], ['d', ' steps']).at(C5, ['r', '✖'], ['d', ' 1 error']),
    BLANK(),
    chips(0, [['All', 52], ['Kept', 1], ['Errors', 1, 'r'], ['In view', 2]]),
    BLANK(),
    sec('“group timeline steps by agent”', 'agent', 'time'),
    row({ flag: ONSCREEN, glyph: LIVE, tool: 'Edit', name: '…/views/timeline.tsx', metric: 'main', time: 'now' }),
    BLANK(),
    row({ open: true, cls: 'hv', glyph: FAIL, tool: 'Bash', name: [['b', 'npm test -- timeline']], metric: 'general', time: '4s' }),
    detail('status', ['r', 'exit 1'], ['d', ' · 13:27:41 · general-purpose']),
    detail('result', ['r', 'FAIL'], ' mod/hooks/views/timeline.test.tsx'),
    L('detail').at(14, ['r', '✕'], ' groups consecutive steps by agent'),
    action(['g', 'chat'], ['k', 'keep'], ['c', 'copy']),
    BLANK(),
    row({ glyph: DONE, tool: 'Edit', name: '…/timeline.test.tsx', metric: 'general', time: '2s' }),
    row({ flag: ONSCREEN, glyph: DONE, tool: 'Grep', name: '"stepRow(" …/timeline.tsx', metric: 'Explore', time: '1s' }),
    row({ glyph: ['', '★'], tool: 'Edit', name: '…/views/fit.ts', metric: 'main', time: '3s' }),
    more('13 more in this turn'),
    BLANK(),
    sec('EARLIER TURNS', 'steps', 'at'),
    row({ glyph: ['d', '›'], name: '“count .ts files in mod/”', metric: '12', time: '13:02' }),
    row({ glyph: ['d', '›'], name: '“list HANDOVER.md headings”', metric: '22', time: '12:41' }),
  ],
  hint: hint('↵ full step', ['q', 'quote'], 'esc close'),
})

// ---------- Artifacts ----------
paneBoard('artifacts.svg', 'Artifacts tab: a published page opened to its link, files changed, and the handoff export', {
  band: BAND_BUSY,
  lines: [
    ...top(4),
    sec('ARTIFACTS', 'kind', 'age'),
    row({ open: true, cls: 'hv', glyph: ['a', '↗'], name: [['b', 'Rate limit design']], metric: 'page', time: '9m' }),
    detail('link', 'claude.ai/artifact/R4JHk79nyTdV…'),
    detail('from', ['d', 'main · step 31 · 13:19']),
    action(['o', 'step'], ['c', 'copy link'], ['g', 'chat']),
    BLANK(),
    row({ glyph: ['p', '▤'], name: 'calm-design.md', metric: 'doc ×3', time: '12m' }),
    row({ glyph: ['g', '◆'], name: '17 .ts files in mod/', metric: 'result', time: '31m' }),
    BLANK(),
    sec('FILES CHANGED', 'edits', 'last'),
    row({ glyph: ['d', 'M'], name: '…/views/timeline.tsx', metric: '3', time: 'now' }),
    row({ glyph: ['d', 'M'], name: '…/views/fit.ts', metric: '1', time: '3m' }),
    row({ glyph: ['d', 'A'], name: '…/views/timeline.test.tsx', metric: '2', time: '4m' }),
    more('1 more'),
    BLANK(),
    sec('HANDOFF', 'to', 'last'),
    row({ glyph: ['a', '↥'], name: 'Export digest', metric: 'journal', time: '13:30' }),
    L('note').at(4, ['d', 'kept ★ steps go in with full input and result']),
  ],
  hint: hint('↵ open', ['e', 'export'], 'esc prompt'),
})

// ---------- Slim (bodyColumns < 32; 24 shown) ----------
{
  const SW = 24, V = 14, GO = 23 // value column = the second cell; col 23 = the open mark
  const slimStops = { head: [0, 2], sec: [0, 2, V, GO], row: [2, 4], open: [2, 4], detail: [4], action: [4], bud: [2, 8, V], hint: [2], blank: [] }
  const focus = text => wrapWords(text, SW - 2, 2).map((t, i) => (i ? L('head').at(2, ['b', t]) : L('head').at(0, ['a', '▍']).at(2, ['b', t])))
  const ssec = (label, value, cls = 'a') => { const l = L('sec').at(0, [cls, '┌']).at(2, [cls === 'a' ? 'b' : cls + ' b', label]); if (value) l.at(V, ...value); return l.at(GO, ['d', '›']) }
  const srow = (glyph, name, cls = '') => L('row').at(2, glyph).at(4, [cls, wordFit(name, SW - 4)])
  const bud = (label, value, v, cls = 'a') => L('bud').at(2, ['d', label]).at(8, [cls === 'a' ? 'b' : cls + ' b', value]).at(V, ...bar(v, 100, cls))
  const SLIM_CHAT = 62
  const o = { w: SW, stops: slimStops, chatCols: SLIM_CHAT }
  const wideBand = left => lr(left, [['d', '/mc']], SLIM_CHAT)
  paneBoard('slim.svg', 'Slim mode: a 24-column pane with focus, tasks, agents, budget and latest stacked', {
    ...o,
    band: wideBand([['a', '▍'], ' 9', ['d', '/14'], '   Grouping timeline steps by agent', '   ', ['a', '▸'], ' 2', '   ', ['r', '✖'], ' 1']),
    lines: [
      ...focus('Grouping timeline steps by agent'),
      BLANK(),
      ssec('TASKS', [['b', '9'], ['d', '/14']]),
      srow(['d', '○'], 'Humanise step labels'),
      BLANK(),
      ssec('AGENTS', [['b', '2'], ['d', ' live']]),
      srow(LIVE, 'find every caller of stepRow'),
      srow(LIVE, 'write timeline tests'),
      BLANK(),
      ssec('BUDGET'),
      bud('CTX', '9%', 9),
      bud('5H', '18%', 18),
      bud('7D', '22%', 22),
      BLANK(),
      ssec('LATEST', [['r', '✖'], ' 1']),
      srow(FAIL, 'npm test -- timeline'),
      srow(['', '★'], 'the label helper'),
    ],
    hint: hint('↵ open', 'esc prompt'),
  })
  paneBoard('budget.svg', 'Slim mode while Claude waits on you: NEEDS YOU on top, and the 5-hour window at 78% in the budget rows', {
    ...o,
    band: wideBand([['y b', '▲ 2 need you'], '   ', ['a', '▍'], ' 9', ['d', '/14'], '   Grouping timeline steps by agent']),
    lines: [
      ...focus('Grouping timeline steps by agent'),
      BLANK(),
      ssec('NEEDS YOU', [['y b', '2']], 'y'),
      L('open', 'hv').at(2, ASK).at(4, ['b', 'npm publish']),
      L('detail').at(4, ['b', '--dry-run']),
      L('action').at(4, ['a', 'g:'], ' chat', '   ', ['a', 'x:'], ' dismiss'),
      BLANK(),
      srow(FAIL, 'npm test -- timeline'),
      BLANK(),
      ssec('TASKS', [['b', '9'], ['d', '/14']]),
      srow(['d', '○'], 'Humanise step labels'),
      BLANK(),
      ssec('AGENTS', [['b', '2'], ['d', ' live']]),
      srow(LIVE, 'find every caller of stepRow'),
      srow(LIVE, 'write timeline tests'),
      BLANK(),
      ssec('BUDGET'),
      bud('CTX', '9%', 9),
      bud('5H', '78%', 78, 'y'),
      bud('7D', '22%', 22),
    ],
    hint: hint('↵ open', 'esc prompt'),
  })
}

// ---------- the band: three states, pane closed ----------
{
  current = 'band.svg'
  const B = 110
  const states = [
    ['claude: working', [
      free(['g', '●'], ' ', ['b', 'Bash'], '(npm test -- timeline)'),
      free(['r', '  ⎿ Error: 1 failed, 22 passed']),
    ], lr([['a', '▍'], ' 9', ['d', '/14'], '   Grouping timeline steps by agent', '   ', ['a', '▸'], ' 2 live', '   ', ['r', '✖'], ' 1 error', '   ', ['d', 'ctx 9%   7d 22%']], [['d', '/mc']], B)],
    ['claude: waiting on you', [
      free(['g', '●'], ' ', ['b', 'Bash'], '(npm publish --dry-run)'),
      free(['y', '  ⎿ Waiting for permission']),
    ], lr([['y b', '▲ 2 need you'], '   ', ['a', '▍'], ' 9', ['d', '/14'], '   Grouping timeline steps by agent', '   ', ['a', '▸'], ' 2 live'], [['d', '/mc']], B)],
    ['claude: all done', [
      free(['g', '●'], ' All 14 tasks are done.'),
      free(),
    ], lr([['d', '▍ 14/14 done   3 artifacts']], [['d', '/mc']], B)],
  ]
  const PX = 18, PY = 12, GAP = 14
  const w = PX * 2 + B * CH
  const each = TB + PY + 2 * LH + 6 + LH + 4 + 34 + PY
  const body = states.map(([title, chat, band], i) => {
    const y = i * (each + GAP), t = y + TB + PY
    return [frame(y, w, each, title), drawLines(chat, PX, t, B), drawLine(band, PX, t + 2 * LH + 6, B), promptBox(PX, t + 3 * LH + 10, B * CH)].join('\n')
  }).join('\n')
  emit('band.svg', 'The band above the prompt in three states: working, waiting on you, and all done', w, states.length * each + (states.length - 1) * GAP, body)
}

// ---------- the inline strip: a terminal under 110 columns ----------
{
  current = 'strip.svg'
  const SW = 96
  const SC = [0, 1, 2, 3, 4, 5, 6, 7].map(cellCol) // 8 cells: 2 .. 86, the last ends at 96
  const stripStops = { strip: [0, 2, 8, ...SC.slice(1), 52, 54, 60], blank: [], hint: [2], track: [2], tabs: CELLS.concat(SC[7]) }
  const [tabs, track] = tabBar(0)
  tabs.at(SC[7], ['d', '7d 22%'])
  const trackWide = L('track').at(2, ...track.parts.slice(1), ['s', '─'.repeat(SW - W)])
  const S = () => L('strip')
  const ro = readout([
    { label: 'TASKS', value: [['b', '9'], ['d', '/14']], gfx: bar(9, 14) },
    { label: 'AGENTS', value: [['b', '2'], ['d', ' live']], gfx: stack([[2, 'a'], [3, 'd'], [1, 'r']]) },
    { label: 'STEPS', value: [['b', '52'], ' ', ['r', '✖'], ' 1'], gfx: spark(STEPS_SPARK) },
    { label: 'CTX', value: [['b', '9%']], gfx: bar(9, 100) },
  ])
  ro.forEach(l => { l.k = 'strip' })
  const strip = [
    tabs, trackWide, BLANK(),
    S().at(0, ['a', '▍']).at(2, ['b', 'Grouping timeline steps by agent']).at(38, ['d', '20s']).at(50, ['a', '┌']).at(52, ['b', 'AGENTS']).at(74, ['d', 'tokens']).at(86, ['d', 'time']),
    S().at(2, ['d', 'next']).at(8, 'Humanise step labels').at(52, LIVE).at(54, wordFit('find every caller of stepRow', 18)).at(74, ['d', '72k']).at(86, ['d', '1m']),
    S().at(52, LIVE).at(54, wordFit('write timeline tests', 18)).at(74, ['d', '88k']).at(86, ['d', '40s']),
    ro[0],
    ro[1].at(50, ['a', '┌']).at(52, ['b', 'LATEST']).at(74, ['d', 'agent']).at(86, ['d', 'time']),
    ro[2].at(52, FAIL).at(54, ['d', 'Bash']).at(60, fit('npm test -- timeline', 12)).at(74, ['d', 'general']).at(86, ['d', '4s']),
    BLANK(),
    hint(['n', 'next error'], ['p', 'prev'], ['f', 'find']),
  ]
  validate(strip, { w: SW, stops: stripStops, maxRows: 14, loose: true })
  strip.forEach((l, i) => l.segs.forEach(([c, n]) => { if (c + n > SW) bad(`strip row ${i} overflows`) }))
  const chat = [0, 1, 9, 10, 11, 12, 13, 14].map(i => CHAT_WIDE[i])
  const PX = 18, PY = 14
  const w = PX * 2 + SW * CH
  const t = TB + PY
  const ruleY = t + chat.length * LH + 8
  const stripY = ruleY + 7
  const promptY = stripY + strip.length * LH + 6
  const h = promptY + 34 + PY
  const body = [
    frame(0, w, h, 'claude'),
    drawLines(chat, PX, t, SW),
    rect(PX, ruleY, SW * CH, 1, EDGE),
    drawLines(strip, PX, stripY, SW),
    promptBox(PX, promptY, SW * CH),
  ].join('\n')
  emit('strip.svg', 'A 96-column terminal: Mission Control as an inline strip above the prompt, Now on the left and lists on the right', w, h, body)
}

if (problems.length) {
  console.log(problems.join('\n'))
  console.log(`\n${problems.length} problem(s)`)
  process.exitCode = 1
} else {
  console.log(written.join('\n'))
  console.log('ok: every row is on the grid')
}
