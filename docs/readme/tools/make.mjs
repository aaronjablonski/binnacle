#!/usr/bin/env node
// Draws the README images from the mod's own views.
//
//   node docs/readme/tools/make.mjs            draw everything
//   node docs/readme/tools/make.mjs --reuse    skip the capture, redraw from the last one
//   node docs/readme/tools/make.mjs hero band  draw only the images whose name starts with these
//   node docs/readme/tools/make.mjs --mod=DIR  draw another copy of the mod (a checkout of a commit, say)
//
// 1. Capture: copies mod/ to a scratch folder, adds shots.test.tsx and runs `claude plugin test` there.
//    Each shot mounts a real view with the tests' fixtures and prints the drawn tree (mod/ is never touched).
// 2. Layout: lays each tree out as terminal cells, the way mod/hooks/views/screen.testkit.ts does, keeping
//    the colours. A Raster's cells are decoded as the engine reads them.
// 3. Paint: each cell becomes Svg (block, Braille and line glyphs as shapes, the rest as text), and
//    headless Chrome or Edge turns the Svg into a PNG. Set CHROME to the browser's path if it is not found.
//
// Text colours in the mod are theme keys, so a real terminal shows the theme's own. Here they are painted
// with the cockpit palette (the hex the Rasters use), on the night or the day ground.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const OUT = path.resolve(HERE, '..')
const TMP = path.join(os.tmpdir(), 'mc-readme-shots')
const args = process.argv.slice(2)
const REUSE = args.includes('--reuse')
const ONLY = args.filter(a => !a.startsWith('--'))
const MOD = path.resolve(args.find(a => a.startsWith('--mod='))?.slice(6) ?? path.join(ROOT, 'mod'))

// ---------- 1. capture ----------
function capture() {
  const dump = path.join(TMP, 'shots.txt')
  if (REUSE && fs.existsSync(dump)) return fs.readFileSync(dump, 'utf8')
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(TMP, { recursive: true })
  const mod = path.join(TMP, 'mod')
  fs.cpSync(MOD, mod, { recursive: true, filter: src => !/\.test\.tsx?$/.test(src) })
  fs.copyFileSync(path.join(HERE, 'shots.test.tsx'), path.join(mod, 'hooks', 'views', 'zz_shots.test.tsx'))
  const run = spawnSync('claude', ['plugin', 'test', mod], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: process.platform === 'win32' })
  const text = (run.stdout ?? '') + (run.stderr ?? '')
  if (run.status !== 0) {
    console.error(text.split(/\r?\n/).filter(l => !l.startsWith('SHOT ')).join('\n'))
    throw new Error('claude plugin test failed')
  }
  fs.writeFileSync(dump, text)
  return text
}
const SHOTS = {}
for (const line of capture().split(/\r?\n/)) {
  if (!line.startsWith('SHOT ')) continue
  const at = line.indexOf(' ', 5)
  SHOTS[line.slice(5, at)] = JSON.parse(line.slice(at + 1))
}

// ---------- palette ----------
const PAL = {
  night: {
    ground: '#15171c', ink: '#d7dbe5', dim: '#8a92a6', mute: '#5b6478', rule: '#333a4c', rest: '#272c3a',
    suggestion: '#8f9eff', ide: '#7ab8f5', promptBorder: '#a0acbf', warning: '#e3b04b', error: '#ef6b7e', success: '#4fbf93',
    ember: '#e07b53', frame: '#0f1115', edge: '#2a2f3d',
  },
  day: {
    ground: '#f7f6f2', ink: '#262a35', dim: '#687083', mute: '#a4aab9', rule: '#d3d7df', rest: '#e3e5ea',
    suggestion: '#5364e8', ide: '#2f7fc7', promptBorder: '#5f6d83', warning: '#b9790f', error: '#cf3550', success: '#1e8f66',
    ember: '#d9683c', frame: '#ecebe6', edge: '#d3d7df',
  },
}
const hex = n => '#' + (n & 0xffffff).toString(16).padStart(6, '0')
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
const mix = (a, b, t) => { const [x, y] = [rgb(a), rgb(b)]; return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('') }
const LINES = new Set([...'─━│├╰╌┏┛└'])

// ---------- 2. layout ----------
// A line is an array of cells: { ch, st } for text (st: color, bg, bold, dim), { ch, fg, bg } (numbers) for a Raster cell.
const kidsOf = el => { const c = el.children ?? el.props?.children; return c === undefined ? [] : Array.isArray(c) ? c : [c] }
const nothing = n => n === null || n === undefined || n === false || n === true
const chars = (s, st) => [...String(s)].map(ch => ({ ch, st }))
function styleOf(p, inh) {
  const st = { ...inh }
  if (p.color !== undefined) st.color = p.color
  if (p.backgroundColor !== undefined) st.bg = p.backgroundColor
  if (p.bold === true) st.bold = true
  if (p.dimColor === true) st.dim = true
  if (p.underline === true) st.ul = true
  return st
}
function inline(node, st) {
  if (nothing(node)) return []
  if (typeof node === 'string' || typeof node === 'number') return chars(node, st)
  if (Array.isArray(node)) return node.flatMap(n => inline(n, st))
  const p = node.props ?? {}
  const kids = kidsOf(node)
  if (node.type === 'Button') {
    if (p.plain !== true) return chars(`[ ${p.label ?? ''} ]`, { ...st, color: 'suggestion', bold: true })
    const bst = styleOf({ dimColor: p.dimColor }, st)
    const body = kids.length > 0 ? kids.flatMap(k => inline(k, bst)) : chars(p.label ?? '', bst)
    if (typeof p.hotkey !== 'string') return body
    const first = body[0]?.st ?? bst
    const key = p.dimColor === true ? first : { ...first, color: first.color ?? 'suggestion', dim: false }
    return [...chars(p.hotkey, key), ...chars(': ', first), ...body]
  }
  if (node.type === 'Input') return chars(p.value !== '' && p.value !== undefined ? p.value : p.placeholder ?? '', { ...st, dim: true })
  return kids.flatMap(k => inline(k, styleOf(p, st)))
}
function raster(p) {
  const b = Buffer.from(p.cells, 'base64')
  const out = []
  for (let r = 0; r < p.rows; r++) {
    const line = []
    for (let c = 0; c < p.columns; c++) {
      const i = (r * p.columns + c) * 12
      line.push({ ch: String.fromCodePoint(b.readUInt32LE(i)), fg: b.readUInt32LE(i + 4), bg: b.readUInt32LE(i + 8), raster: true })
    }
    out.push(line)
  }
  return out
}
const SPACE = { ch: ' ', st: {} }
const padTo = (line, w) => (line.length >= w ? line : [...line, ...Array(w - line.length).fill(SPACE)])
const num = v => (typeof v === 'number' ? v : 0)
function splitLines(cells) {
  const out = [[]]
  for (const c of cells) { if (c.ch === '\n') out.push([]); else out[out.length - 1].push(c) }
  return out
}
function rowsOf(node, st = {}) {
  if (nothing(node)) return []
  if (typeof node === 'string' || typeof node === 'number') return splitLines(chars(node, st))
  if (Array.isArray(node)) return node.flatMap(n => rowsOf(n, st))
  const p = node.props ?? {}
  if (node.type === 'Raster') return raster(p)
  if (node.type === 'Svg') return []
  if (node.type !== 'Box') return splitLines(inline(node, st))
  if (p.display === 'none') return []
  const width = typeof p.width === 'number' ? p.width : undefined
  let rows
  if (p.flexDirection !== 'column' && p.flexDirection !== 'column-reverse') {
    const gap = num(p.columnGap) || num(p.gap)
    const blocks = kidsOf(node).filter(k => !nothing(k)).map(k => {
      const r = rowsOf(k, st)
      const w = typeof k === 'object' && !Array.isArray(k) && typeof k.props?.width === 'number' ? k.props.width : Math.max(0, ...r.map(x => x.length))
      return { r, w }
    })
    const height = Math.max(0, ...blocks.map(b => b.r.length))
    rows = []
    for (let i = 0; i < height; i++) {
      let line = []
      blocks.forEach((b, j) => { line = [...line, ...padTo(b.r[i] ?? [], b.w).slice(0, Math.max(b.w, (b.r[i] ?? []).length)), ...(j < blocks.length - 1 ? Array(gap).fill(SPACE) : [])] })
      rows.push(line)
    }
  } else {
    rows = kidsOf(node).flatMap(k => rowsOf(k, st))
  }
  if (p.overflow === 'hidden') {
    if (typeof p.height === 'number') rows = rows.slice(0, p.height)
    if (width !== undefined) rows = rows.map(r => r.slice(0, width))
  }
  const pad = num(p.paddingLeft) || num(p.paddingX)
  if (pad > 0) rows = rows.map(r => [...Array(pad).fill(SPACE), ...r])
  if (width !== undefined) rows = rows.map(r => padTo(r, width))
  return rows
}
const plain = line => line.map(c => (c.raster ? ' ' : c.ch)).join('').trimEnd()
/** A shot as a grid of `cols` columns; `rows` pads or cuts it. The text is checked against the test kit's own layout. */
function grid(name, cols, rows) {
  const shot = SHOTS[name]
  if (shot === undefined) throw new Error(`no shot ${name}`)
  let lines = rowsOf(shot.tree)
  // The kit lays a Raster out as one empty row, so rows are paired by their text, in order; a row with no
  // Raster cell must match the kit's exactly, columns included.
  const mine = lines.filter(l => plain(l).trim() !== '')
  const kit = shot.rows.map(r => r.trimEnd()).filter(r => r.trim() !== '')
  const squeeze = s => s.replace(/\s+/g, ' ').trim()
  const same = (l, k) => (l.some(c => c.raster) ? squeeze(plain(l)) === squeeze(k) : plain(l) === k)
  if (mine.length !== kit.length || mine.some((l, i) => !same(l, kit[i]))) {
    const at = mine.findIndex((l, i) => !same(l, kit[i] ?? ''))
    console.warn(`! ${name}: the layout differs from the test kit's at text row ${at} (${mine.length} rows, the kit ${kit.length}):\n  mine ${JSON.stringify(plain(mine[at] ?? []))}\n  kit  ${JSON.stringify(kit[at])}`)
  }
  lines = lines.map(l => l.slice(0, cols))
  if (rows !== undefined) { lines = lines.slice(0, rows); while (lines.length < rows) lines.push([]) }
  return { cols, lines }
}
/** The grid with the empty rows above its last row (the footer) cut to one: a pane is as tall as its terminal. */
function tight(g) {
  const lines = [...g.lines]
  while (lines.length > 0 && plain(lines[lines.length - 1]) === '') lines.pop()
  let i = lines.length - 2
  while (i > 0 && plain(lines[i]) === '' && plain(lines[i - 1]) === '') lines.splice(i--, 1)
  return { cols: g.cols, lines }
}
const tall = (g, rows) => { const lines = [...g.lines]; while (lines.length < rows) lines.push([]); return { cols: g.cols, lines } }
const crop = (g, from, to) => ({ cols: g.cols, lines: g.lines.slice(from, to) })
const rowAt = (g, text) => g.lines.findIndex(l => plain(l).includes(text))
/** Hand-written rows (the chat in the hero): each row a list of [text, style]. */
const written = (cols, rows) => ({ cols, lines: rows.map(r => r.flatMap(([t, st]) => chars(t, st ?? {}))) })

// ---------- 3. paint ----------
const CW = 9, CH = 18
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const QUAD = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█'
const FONT = `'Cascadia Mono','Cascadia Code',Consolas,'Segoe UI Symbol',monospace`
const SANS = `-apple-system,'Segoe UI',Helvetica,Arial,sans-serif`
function colours(c, pal) {
  if (c.raster) return { fg: c.fg & 0x01000000 ? pal.ink : hex(c.fg), bg: c.bg & 0x01000000 ? undefined : hex(c.bg) }
  const st = c.st ?? {}
  const key = k => (k.startsWith('#') ? k : k === 'inverseText' ? pal.ground : k === 'subtle' ? (LINES.has(c.ch) ? pal.rule : pal.mute) : pal[k] ?? pal.ink)
  let fg = st.color === undefined ? (st.dim ? pal.dim : pal.ink) : key(st.color)
  if (st.color !== undefined && st.dim) fg = mix(fg, pal.ground, 0.35)
  return { fg, bg: st.bg === undefined ? undefined : key(st.bg), bold: st.bold === true, ul: st.ul === true }
}
const rect = (x, y, w, h, fill) => `<rect x="${+x.toFixed(2)}" y="${+y.toFixed(2)}" width="${+w.toFixed(2)}" height="${+h.toFixed(2)}" fill="${fill}"/>`
/** One glyph as shapes, or undefined when the font draws it. */
function shape(ch, x, y, fg) {
  const cp = ch.codePointAt(0)
  const q = QUAD.indexOf(ch)
  if (q > 0) {
    if (q === 15) return rect(x, y, CW, CH, fg)
    let s = ''
    for (let i = 0; i < 4; i++) if (q & (1 << i)) s += rect(x + (i & 1) * (CW / 2), y + (i >> 1) * (CH / 2), CW / 2, CH / 2, fg)
    return s
  }
  if (cp >= 0x2581 && cp <= 0x2587) { const h = Math.round((CH * (cp - 0x2580)) / 8); return rect(x, y + CH - h, CW, h, fg) }
  if (ch === '▔') return rect(x, y, CW, 1, fg)
  if (ch === '▍') return rect(x, y + 1, 3, CH - 2, fg)
  if (cp >= 0x2800 && cp <= 0x28ff) {
    const bits = cp - 0x2800
    const at = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3]]
    let s = ''
    at.forEach(([dx, dy], i) => { if (bits & (1 << i)) s += `<circle cx="${x + 2.25 + dx * 4.5}" cy="${y + 2.25 + dy * 4.5}" r="1.7" fill="${fg}"/>` })
    return s
  }
  const cx = x + 4, cy = y + 9
  if (ch === '━') return rect(x, y + 7.5, CW, 3, fg)
  if (ch === '─') return rect(x, cy, CW, 1, fg)
  if (ch === '╌') return rect(x + 0.5, cy, 3, 1, fg) + rect(x + 5, cy, 3, 1, fg)
  if (ch === '│') return rect(cx, y, 1, CH, fg)
  if (ch === '├') return rect(cx, y, 1, CH, fg) + rect(cx, cy, CW - 4, 1, fg)
  if (ch === '└') return rect(cx, y, 1, 10, fg) + rect(cx, cy, CW - 4, 1, fg)
  if (ch === '╰') return `<path d="M${cx + 0.5} ${y} V${cy - 3.5} Q${cx + 0.5} ${cy + 0.5} ${cx + 4.5} ${cy + 0.5} H${x + CW}" fill="none" stroke="${fg}" stroke-width="1"/>`
  if (ch === '┏') return rect(cx - 0.5, cy - 0.5, 2, CH / 2 + 0.5, fg) + rect(cx - 0.5, cy - 0.5, CW - 3.5, 2, fg)
  if (ch === '┛') return rect(cx - 0.5, y, 2, CH / 2 + 1.5, fg) + rect(x, cy - 0.5, 5.5, 2, fg)
  if (ch === '○') return `<circle cx="${x + 4.5}" cy="${y + 9.5}" r="3.4" fill="none" stroke="${fg}" stroke-width="1.3"/>`
  if (ch === '●') return `<circle cx="${x + 4.5}" cy="${y + 9.5}" r="4" fill="${fg}"/>`
  if (ch === '▸') return `<path d="M${x + 2} ${y + 5.5} L${x + 7.5} ${y + 9.5} L${x + 2} ${y + 13.5} Z" fill="${fg}"/>`
  if (ch === '◂') return `<path d="M${x + 7} ${y + 5.5} L${x + 1.5} ${y + 9.5} L${x + 7} ${y + 13.5} Z" fill="${fg}"/>`
  if (ch === '▾') return `<path d="M${x + 1} ${y + 7} L${x + 8} ${y + 7} L${x + 4.5} ${y + 12.5} Z" fill="${fg}"/>`
  if (ch === '▪') return rect(x + 2.5, y + 7.5, 4, 4, fg)
  if (ch === '■') return rect(x + 1, y + 6, 7, 7, fg)
  if (ch === '▫') return `<rect x="${x + 2.5}" y="${y + 7.5}" width="4" height="4" fill="none" stroke="${fg}" stroke-width="1"/>`
  return undefined
}
/** A grid as Svg, its top-left cell at (ox, oy). */
function paint(g, pal, ox = 0, oy = 0) {
  let boxes = '', shapes = '', text = ''
  g.lines.forEach((line, r) => {
    const y = oy + r * CH
    let run
    const flush = () => { if (run) { text += `<text x="${run.xs.join(' ')}" y="${y + 13.5}" fill="${run.fg}"${run.bold ? ' font-weight="700"' : ''}>${esc(run.s)}</text>`; run = undefined } }
    line.forEach((c, i) => {
      if (i >= g.cols) return
      const x = ox + i * CW
      const { fg, bg, bold, ul } = colours(c, pal)
      if (bg !== undefined) boxes += rect(x, y, CW, CH, bg)
      if (ul && c.ch !== ' ') shapes += rect(x, y + 16, CW, 1, fg)
      if (c.ch === ' ') return flush()
      const s = shape(c.ch, x, y, fg)
      if (s !== undefined) { shapes += s; return flush() }
      if (c.ch.codePointAt(0) > 126) {
        flush()
        text += `<text x="${x + CW / 2}" y="${y + 13.5}" fill="${fg}" text-anchor="middle"${bold ? ' font-weight="700"' : ''}>${esc(c.ch)}</text>`
        return
      }
      if (!run || run.fg !== fg || run.bold !== bold) { flush(); run = { fg, bold, s: '', xs: [] } }
      run.s += c.ch
      run.xs.push(+(x + 0.1).toFixed(1))
    })
    flush()
  })
  return `<g shape-rendering="crispEdges">${boxes}${shapes}</g><g font-family="${FONT}" font-size="15" xml:space="preserve">${text}</g>`
}

// ---------- parts ----------
// A part is { w, h, svg }: Svg drawn from (0, 0). `at` moves one; `row` and `col` set them side by side or stacked.
const at = (p, x, y) => `<g transform="translate(${x} ${y})">${p.svg}</g>`
function row(parts, gap = 20, align = 'top') {
  const h = Math.max(...parts.map(p => p.h))
  let x = 0, svg = ''
  for (const p of parts) { svg += at(p, x, align === 'top' ? 0 : align === 'bottom' ? h - p.h : (h - p.h) / 2); x += p.w + gap }
  return { w: x - gap, h, svg }
}
function col(parts, gap = 14, align = 'left') {
  const w = Math.max(...parts.map(p => p.w))
  let y = 0, svg = ''
  for (const p of parts) { svg += at(p, align === 'left' ? 0 : (w - p.w) / 2, y); y += p.h + gap }
  return { w, h: y - gap, svg }
}
const GREY = '#7d8590' // a caption readable on GitHub's light and dark pages
/** A caption in the page's own voice (sans, mid grey). */
function cap(text, o = {}) {
  const size = o.size ?? 13
  return { w: o.w ?? Math.ceil(text.length * size * 0.56), h: size + 6, svg: `<text x="0" y="${size}" font-family="${SANS}" font-size="${size}" fill="${o.fill ?? GREY}"${o.bold ? ' font-weight="600"' : ''}>${esc(text)}</text>` }
}
/** A grid on its ground: a rounded card with a hairline edge. */
function card(g, ground = 'night', o = {}) {
  const pal = PAL[ground]
  const px = o.px ?? 12, py = o.py ?? 10
  const w = g.cols * CW + px * 2, h = g.lines.length * CH + py * 2
  return { w, h, svg: `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="8" fill="${pal.ground}" stroke="${pal.edge}"/>${paint(g, pal, px, py)}` }
}
const titled = (title, part) => col([cap(title, { bold: true }), part], 6)
/** The prompt box under a band. */
function prompt(cols, ground = 'night', text = '') {
  const pal = PAL[ground]
  const w = cols * CW, h = 34
  const g = written(cols, [[['> ', { dim: true }], [text, {}]]])
  return { w, h, svg: `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="6" fill="none" stroke="${pal.rule}"/>${paint(g, pal, 12, 8)}<rect x="${12 + (2 + text.length) * CW}" y="9" width="${CW}" height="${CH - 2}" fill="${pal.ink}"/>` }
}
/** An Svg the mod drew for the desktop app, as it is. */
function svgOf(name) {
  let found
  const walk = n => { if (n === null || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(walk); if (n.type === 'Svg') found = n.props; walk(n.children) }
  walk(SHOTS[name].tree)
  if (!found) throw new Error(`${name} drew no Svg`)
  const src = found.source
  const w = Number(/<svg[^>]*\swidth="([\d.]+)"/.exec(src)?.[1]), h = Number(/<svg[^>]*\sheight="([\d.]+)"/.exec(src)?.[1])
  const box = /viewBox="([\d.\s-]+)"/.exec(src)?.[1].split(/\s+/).map(Number)
  const W = w || box?.[2], H = h || box?.[3]
  if (!W || !H) throw new Error(`${name}: the Svg has no size: ${src.slice(0, 200)}`)
  return { w: W, h: H, alt: found.alt, svg: `<image width="${W}" height="${H}" href="data:image/svg+xml;base64,${Buffer.from(src).toString('base64')}"/>` }
}

// ---------- 4. PNG ----------
const BROWSERS = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']
const BROWSER = BROWSERS.find(b => b && fs.existsSync(b))
const made = []
function png(name, part, o = {}) {
  if (ONLY.length > 0 && !ONLY.some(p => name.startsWith(p))) return
  if (!BROWSER) throw new Error('no Chrome or Edge found: set CHROME to its path')
  const pad = o.pad ?? 0
  const w = Math.ceil(part.w + pad * 2), h = Math.ceil(part.h + pad * 2)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${o.back ? `<rect width="${w}" height="${h}" rx="${o.rx ?? 0}" fill="${o.back}"/>` : ''}${at(part, pad, pad)}</svg>`
  const html = path.join(TMP, name + '.html')
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block}</style>${svg}`)
  const file = path.join(OUT, name + '.png')
  const scale = o.scale ?? 2
  const run = spawnSync(BROWSER, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--force-device-scale-factor=${scale}`, `--window-size=${w},${h}`, '--default-background-color=00000000', `--user-data-dir=${path.join(TMP, 'profile')}`, `--screenshot=${file}`, pathToFileURL(html).href], { encoding: 'utf8' })
  if (!fs.existsSync(file)) throw new Error(`no screenshot for ${name}: ${run.stderr}`)
  made.push(`${name}.png  ${w}x${h} @${scale}x  ${Math.round(fs.statSync(file).size / 1024)} KB`)
}

// ---------- the images ----------
const D = { dim: true }, B = { bold: true }, OK = { color: 'success' }, EM = { color: '#e07b53' }
/** The hero: a terminal with the chat on the left (written here, an illustration) and the real pane and band. */
function hero(ground) {
  const pal = PAL[ground]
  const day = ground === 'day' ? '-day' : ''
  const paneG = grid('hero-pane' + day, 62, 40)
  const bandG = grid('hero-band' + day, 74)
  const LEFT = 74
  const dot = [['● ', OK]]
  const tool = (name, arg) => [...dot, [name, B], [`(${arg})`, {}]]
  const res = t => [['  └ ', D], [t, D]]
  const chat = written(LEFT, [
    [['> ', D], ['add rate limiting to the upload', {}]],
    [],
    [['● ', {}], ['I’ll put a token bucket in front of the upload route. First the', {}]],
    [['  callers, then the middleware and its tests.', {}]],
    [],
    tool('Agent', 'find every caller of upload()'),
    res('Running in the background'),
    [],
    tool('Read', 'src/server/upload.ts'),
    res('Read 212 lines'),
    [],
    tool('Update', 'middleware/rateLimit.ts'),
    res('Added 48 lines'),
    [['      12 ', D], ['+ export function rateLimit(opts: LimitOptions) {', OK]],
    [['      13 ', D], ['+   const bucket = new TokenBucket(opts.burst, opts.perMinute)', OK]],
    [['      14 ', D], ['+   return (req, res, next) => {', OK]],
    [['      15 ', D], ['+     if (bucket.take(keyOf(req))) return next()', OK]],
    [['      16 ', D], ['+     res.set(\'Retry-After\', bucket.wait(keyOf(req)))', OK]],
    [['      17 ', D], ['+     res.status(429).end()', OK]],
    [['      … 42 more lines', D]],
    [],
    tool('Bash', 'npm test -- rateLimit'),
    res('14 passed'),
    [],
    tool('Agent', 'write the rate limit tests'),
    res('Running in the background'),
    [],
    [['● ', {}], ['The limiter runs after bodyLimit, so an oversized body is turned', {}]],
    [['  away before it costs a token. Wiring it into the chain next.', {}]],
    [],
    [['✳ Wiring the limiter… ', EM], ['(2m 14s)', D]],
  ])
  const bandRows = bandG.lines.length
  const paneH = 40 * CH
  const px = 16, bar = 34
  const leftW = LEFT * CW, paneW = 62 * CW
  const w = px + leftW + px + 1 + px + paneW + px
  const h = bar + 12 + paneH + 14
  const promptP = prompt(LEFT, ground)
  const bandY = bar + 12 + paneH - promptP.h - 8 - bandRows * CH
  let svg = `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="10" fill="${pal.ground}" stroke="${pal.edge}"/>`
  svg += `<path d="M1 ${bar} V10 Q1 1 10 1 H${w - 10} Q${w - 1} 1 ${w - 1} 10 V${bar} Z" fill="${pal.frame}"/><rect x="1" y="${bar}" width="${w - 2}" height="1" fill="${pal.edge}"/>`
  svg += ['#ef6b7e', '#e3b04b', '#4fbf93'].map((c, i) => `<circle cx="${20 + i * 18}" cy="${bar / 2}" r="5.5" fill="${c}" opacity="0.85"/>`).join('')
  svg += `<text x="${w / 2}" y="${bar / 2 + 4.5}" text-anchor="middle" font-family="${SANS}" font-size="12.5" fill="${pal.dim}">claude --plugin-dir ./mod</text>`
  svg += paint(chat, pal, px, bar + 12)
  svg += paint(bandG, pal, px, bandY)
  svg += at(promptP, px, bar + 12 + paneH - promptP.h)
  svg += rect(px + leftW + px, bar + 1, 1, h - bar - 2, pal.edge)
  svg += paint(paneG, pal, px + leftW + px + 1 + px, bar + 12)
  return { w, h, svg }
}
png('hero', hero('night'), { scale: 1.5 })
png('hero-day', hero('day'), { scale: 1.5 })

// The five tabs, whole.
const PANE = [62, 46]
const tab = name => card(tight(grid(name, ...PANE)))
png('now', tab('now-busy'))
png('now-slim', tab('now-busy-slim'))
png('tasks', tab('tasks'))
png('agents', tab('agents-list'))
png('map', tab('agents-map-flagged'))
png('steps', tab('steps'))
png('artifacts', tab('artifacts'))
png('options', card(grid('options', 62)))
png('budget', card(grid('budget', 62)))

// Needs you and Watch: the top of Now in each.
{
  const n = grid('now-needs', ...PANE), w = grid('now-watch', ...PANE)
  // R47: To do follows the header, Needs you and the Pull request block, so the top of Now ends there.
  const rows = Math.max(rowAt(n, 'To do ─'), rowAt(w, 'To do ─')) - 1
  const cut = g => { const c = crop(g, 0, rowAt(g, 'To do ─') - 1); while (c.lines.length < rows) c.lines.push([]); return c }
  // R45: Watch has no rows on Now; the band and slim carry it, so the right card is the band while something is to watch.
  png('needs-watch', row([titled('Needs you: a dialog is waiting on you', card(cut(n))), titled('Watch: the band counts it, nothing turns amber', card(grid('band-watch-64', 64), 'night', { py: 8 }))], 24), { scale: 1.5 })
}

// The header's five states.
{
  const head = name => { const g = grid(name, 62); /* the tab row, its track, the blank (R51: it may read `1:Now`) */ const top = 2; return crop(g, top + 1, top + 10) }
  const states = [['Working', 'now-busy'], ['Waiting for you', 'now-needs'], ['Stopped by an error', 'now-stopped'], ['All done', 'now-idle'], ['Idle: ended with tasks open', 'now-ended-open']]
  const cards = states.map(([t, n]) => titled(t, card(head(n))))
  png('header-states', col([row(cards.slice(0, 2), 24), row(cards.slice(2, 4), 24), row([cards[4]], 24)], 18), { scale: 1.5 })
}

// The band, in each state and width.
{
  const b = (title, name, cols, o = {}) => titled(title, col([card(grid(name, cols), 'night', { py: 8 }), ...(o.prompt ? [prompt(cols + 3)] : [])], 6))
  png('band', col([
    b('Working: the goal, the to-do bar, the gauges as words', 'band-busy', 104),
    b('A dialog is waiting: who asks and what, in amber', 'band-asked', 104),
    b('Something to watch: the band stays calm', 'band-watch', 104),
    b('After a failed turn', 'band-stopped', 104),
    b('All done: one dim row', 'band-idle', 104),
    row([b('64 columns', 'band-64', 64), b('40 columns', 'band-40', 40)], 24),
  ], 16), { scale: 1.5 })
}

// Show as (R53): a small preview of each choice, top to bottom, each with the prompt under it.
{
  const pane = crop(grid('hero-pane', 62, 40), 0, 18)
  png('show-as', col([
    titled('pane (default): the pane beside the chat, every tab; one band row above the prompt', card(pane)),
    titled('band: no pane, two minimal rows above the prompt', col([card(grid('band-busy', 104), 'night', { py: 8 }), prompt(107)], 6)),
    titled('strip: no pane, all of Now on its side above the prompt', col([card(grid('band-strip', 110)), prompt(113)], 6)),
  ], 18), { scale: 1.5 })
}

// Slim, strip, desktop.
{
  const g = ['slim-busy', 'slim-needs', 'slim-idle'].map(n => tight(grid(n, 28, 46)))
  const rows = Math.max(...g.map(x => x.lines.length))
  png('slim', row(['Working', 'A dialog is waiting', 'All done'].map((t, i) => titled(t, card(tall(g[i], rows)))), 24), { scale: 1.5 })
}
png('strip', col([card(grid('band-strip', 110)), prompt(113)], 6), { scale: 1.5 })
{
  const frame = (p, ground) => ({ w: p.w + 24, h: p.h + 24, svg: `<rect x="0.5" y="0.5" width="${p.w + 23}" height="${p.h + 23}" rx="8" fill="${PAL[ground].ground}" stroke="${PAL[ground].edge}"/>${at(p, 12, 12)}` })
  png('desktop', col([
    row([titled('The Now header on the desktop app, night', frame(svgOf('desktop-now'), 'night')), titled('Day, on a light theme', frame(svgOf('desktop-now-day'), 'day'))], 24),
    titled('The band', frame(svgOf('desktop-band'), 'night')),
    titled('The band while a dialog waits', frame(svgOf('desktop-band-asked'), 'night')),
  ], 16), { scale: 1.5 })
}

// Looks: accent, ground and the text look.
{
  const head = (name, rows = 10) => { const g = grid(name, 62); return crop(g, 0, rows + 3) }
  png('looks', col([
    row([titled('accent: iris (default)', card(head('now-busy'))), titled('accent: sky', card(head('now-sky')))], 24),
    row([titled('accent: slate', card(head('now-slate'))), titled('ground: day', card(head('now-busy-day'), 'day'))], 24),
  ], 18), { scale: 1.5 })
  const t = grid('now-busy-text', 62)
  png('text-look', card(crop(t, 0, rowAt(t, 'Notes and decisions'))), { scale: 1.5 })
}

// The crew: every role in every state.
{
  const ROLE = { lead: ['Lead', 'the main conversation', 'crown'], build: ['Builder', 'build and plan agents', 'hard hat'], scout: ['Explorer', 'explore and search agents', 'antenna and raised arm'], check: ['Reviewer', 'review, test, verify agents', 'glasses'], general: ['General', 'general-purpose, other types', 'plain'] }
  const STATE = { queued: 'queued', working: 'working', waiting: 'waiting on you', stalled: 'stalled', failed: 'failed', done: 'done' }
  const ORDER = ['queued', 'working', 'waiting', 'stalled', 'failed', 'done']
  const sheet = (name, ground, Z, full) => {
    const pal = PAL[ground]
    const items = SHOTS[name].sheet
    const roles = [...new Set(items.map(i => i.role))]
    const cw = items[0].columns * CW * Z, ch = items[0].rows * CH * Z
    const colW = full ? cw + 34 : cw + 14, rowH = ch + (full ? 20 : 10), left = full ? 196 : 76, top = full ? 44 : 34
    const w = left + colW * ORDER.length + 6, h = top + rowH * roles.length
    let svg = `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="8" fill="${pal.ground}" stroke="${pal.edge}"/>`
    ORDER.forEach((s, j) => { svg += `<text x="${left + j * colW}" y="${full ? 27 : 22}" font-family="${SANS}" font-size="${full ? 13 : 11}" font-weight="600" fill="${pal.ink}">${full ? STATE[s] : s}</text>` })
    roles.forEach((r, i) => {
      const y = top + i * rowH
      svg += `<text x="18" y="${y + ch / 2 - (full ? 12 : -4)}" font-family="${SANS}" font-size="${full ? 15 : 12}" font-weight="600" fill="${pal.ink}">${ROLE[r][0]}</text>`
      if (full) svg += `<text x="18" y="${y + ch / 2 + 7}" font-family="${SANS}" font-size="12" fill="${pal.dim}">${esc(ROLE[r][1])}</text><text x="18" y="${y + ch / 2 + 24}" font-family="${SANS}" font-size="12" fill="${pal.dim}">${esc(ROLE[r][2])}</text>`
      ORDER.forEach((s, j) => {
        const it = items.find(k => k.role === r && k.state === s)
        svg += `<g transform="translate(${left + j * colW} ${y}) scale(${Z})">${paint({ cols: it.columns, lines: raster(it) }, pal)}</g>`
      })
    })
    return { w, h, svg }
  }
  png('critters', col([
    sheet('critters-small-night', 'night', 2, true),
    row([titled('On the day ground', sheet('critters-small-day', 'day', 1, false)), titled('Micro: the band, the slim pane, tethers', sheet('critters-micro-night', 'night', 1, false))], 24),
  ], 18), { scale: 1.5 })
}

console.log(made.join('\n'))
