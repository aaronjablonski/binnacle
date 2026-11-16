// Pure text helpers for the views. No claude-code import, so vitest loads it.

import { C, dialOf, GLYPHS, rateColor, typeName } from './style'
import type { Pod, Run } from './style'

/** Cuts `text` to `columns` cells with a trailing '…'; '' when there is no room. */
export function fit(text: string, columns: number): string {
  if (columns <= 0) return ''
  if (text.length <= columns) return text
  if (columns === 1) return '…'
  return `${text.slice(0, columns - 1)}…`
}

/** Cuts `text` from the left, with a leading '…'. */
export function fitLeft(text: string, columns: number): string {
  if (columns <= 0) return ''
  if (text.length <= columns) return text
  if (columns === 1) return '…'
  return `…${text.slice(text.length - (columns - 1))}`
}

/** A span as '8s', '2m' or '1h04'. */
export function elapsed(fromMs: number, toMs: number): string {
  const seconds = Math.max(0, Math.floor((toMs - fromMs) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = String(minutes % 60).padStart(2, '0')
  return `${hours}h${rest}`
}

/**
 * How many of `columns` cells a progress bar fills for done of total.
 * Was HUD v1's `bar`; renamed when Neo took the name for its `▮▯` bar.
 * @deprecated HUD v1. Use `bar`.
 */
export function barSplit(done: number, total: number, columns: number): { filled: number; rest: number } {
  if (total <= 0 || columns <= 0) return { filled: 0, rest: Math.max(0, columns) }
  const share = Math.min(1, Math.max(0, done / total))
  const filled = Math.round(share * columns)
  return { filled, rest: columns - filled }
}

/** The time of day as 'hh:mm', or 'hh:mm:ss' with `seconds`; the machine's own clock. */
export function clock(ms: number, seconds = false): string {
  const d = new Date(ms)
  const two = (n: number): string => String(n).padStart(2, '0')
  const base = `${two(d.getHours())}:${two(d.getMinutes())}`
  return seconds ? `${base}:${two(d.getSeconds())}` : base
}

/** `parts` joined by ' · ' and packed into lines of at most `columns`; a part wider than a line is cut. */
export function packParts(parts: string[], columns: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const raw of parts) {
    const part = fit(raw, columns)
    if (part === '') continue
    if (line === '') {
      line = part
    } else if (line.length + 3 + part.length <= columns) {
      line = `${line} · ${part}`
    } else {
      lines.push(line)
      line = part
    }
  }
  if (line !== '') lines.push(line)
  return lines
}

/**
 * A line of '─' as wide as `columns`; '' for no room.
 * @deprecated HUD v1: v2 draws no rules. Kept until wave 2 replaces its callers.
 */
export function rule(columns: number): string {
  return '─'.repeat(Math.max(0, columns))
}

/**
 * The filled and the resting blocks of a progress bar of `columns` cells.
 * @deprecated HUD v1. Use `bar`; the spec removes this once wave 2 lands.
 */
export function blockBar(done: number, total: number, columns: number): { filled: string; rest: string } {
  const cells = barSplit(done, total, columns)
  return { filled: '█'.repeat(cells.filled), rest: '░'.repeat(cells.rest) }
}

/**
 * The three parts of `LABEL ─── meta` for a row of `columns`: the rule part
 * carries its own spaces, so the parts sum to `columns` exactly. The meta
 * gives way first, then the rule.
 * @deprecated HUD v1, for `sectionHeader`. v2 sections are `section` in parts.tsx.
 */
export function headerParts(label: string, meta: string, columns: number): { label: string; rule: string; meta: string } {
  const head = fit(label, columns)
  const room = columns - head.length - meta.length
  // A rule between label and meta needs a space on each side and one dash.
  if (meta !== '' && room >= 3) return { label: head, rule: ` ${rule(room - 2)} `, meta }
  const left = columns - head.length
  if (left >= 2) return { label: head, rule: ` ${rule(left - 1)}`, meta: '' }
  return { label: head, rule: '', meta: '' }
}

/**
 * `text` broken at spaces into lines of at most `columns`; a word wider than a line is cut with '…'.
 * @deprecated Use `wrapWords`, which caps the lines and cuts the last by word.
 */
export function wrap(text: string, columns: number): string[] {
  if (columns <= 0) return []
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (word === '') continue
    if (line === '') {
      line = fit(word, columns)
    } else if (line.length + 1 + word.length <= columns) {
      line = `${line} ${word}`
    } else {
      lines.push(line)
      line = fit(word, columns)
    }
  }
  if (line !== '') lines.push(line)
  return lines
}

// ---------- HUD v2: the character grid ----------
// One column is one character, counted as one UTF-16 unit: every glyph the
// HUD draws (━ ─ ▁…█ ▸ ✖ ◂ ┌ ▍ …) is one unit and one terminal cell.

/** A piece of text that starts at an absolute column. */
export type Seg = { col: number; text: string }

/** `text` placed at column `col`: the padding helper every grid row is built from. */
export function at(col: number, text: string): Seg {
  return { col, text }
}

/**
 * Each segment with the spaces (`gap`) that bring it from the end of the one
 * before to its column, the line starting at column `start`. Segments are in
 * column order; one that would overlap the one before starts right after it
 * (the row then runs long, which the caller's widths must prevent).
 */
export function placed<T extends Seg>(segs: T[], start = 0): { gap: string; seg: T }[] {
  let end = start
  return segs.map(seg => {
    const gap = ' '.repeat(Math.max(0, seg.col - end))
    end = Math.max(end, seg.col) + seg.text.length
    return { gap, seg }
  })
}

/** The segments as one padded string that starts at column `start`. */
export function line(segs: Seg[], start = 0): string {
  return placed(segs, start)
    .map(p => p.gap + p.seg.text)
    .join('')
}

/** Every diagram is exactly this many columns. */
export const DIAGRAM = 10

/**
 * A 10-column bar for `value` of `total`: `fill` of `━`, `rest` of `─`.
 * Any non-zero value gets at least 1; only 100 % (or more) gets 10. A total
 * of 0 or less draws an empty bar.
 * @deprecated HUD v2 (`━ ─`). Neo draws `bar(value, total, 10)` (`▮ ▯`).
 */
export function bar10(value: number, total: number): { fill: string; rest: string } {
  let n = 0
  if (total > 0 && value > 0) {
    n = Math.round((Math.min(value, total) / total) * DIAGRAM)
    if (n === 0) n = 1
    if (value < total && n === DIAGRAM) n = DIAGRAM - 1
  }
  return { fill: '━'.repeat(n), rest: '─'.repeat(DIAGRAM - n) }
}

/**
 * The widths of a 10-column stacked bar (AGENTS: live, done, failed), by
 * largest remainder: every non-zero count gets at least 1 and the widths sum
 * to 10. All counts zero: all widths zero (draw the rest instead). With more
 * than 10 non-zero counts the largest give way, so some may get 0.
 */
export function stack10(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + Math.max(0, b), 0)
  if (total <= 0) return counts.map(() => 0)
  const raw = counts.map(c => (Math.max(0, c) / total) * DIAGRAM)
  const out = raw.map((x, i) => ((counts[i] ?? 0) > 0 ? Math.max(1, Math.floor(x)) : 0))
  let left = DIAGRAM - out.reduce((a, b) => a + b, 0)
  const order = raw
    .map((x, i) => ({ frac: x - Math.floor(x), i }))
    .filter(o => (counts[o.i] ?? 0) > 0)
    .sort((a, b) => b.frac - a.frac)
  for (let k = 0; left > 0 && order.length > 0; k++, left--) {
    const i = order[k % order.length]!.i
    out[i] = (out[i] ?? 0) + 1
  }
  while (left < 0) {
    const i = out.indexOf(Math.max(...out))
    out[i] = (out[i] ?? 0) - 1
    left++
  }
  return out
}

/**
 * Counts `times` into 10 buckets over `from` … `to` (steps per tenth of the
 * session). `to` itself falls in the last bucket; times outside are left out.
 * A span of zero puts every time equal to `to` in the last bucket.
 * @deprecated Use `buckets(times, from, to, 10)` (or 22 in a deck).
 */
export function buckets10(times: number[], from: number, to: number): number[] {
  const out: number[] = new Array<number>(DIAGRAM).fill(0)
  const span = to - from
  for (const t of times) {
    if (t < from || t > to) continue
    const i = span <= 0 ? DIAGRAM - 1 : Math.min(DIAGRAM - 1, Math.floor(((t - from) / span) * DIAGRAM))
    out[i] = (out[i] ?? 0) + 1
  }
  return out
}

const SPARKS = '▁▂▃▄▅▆▇█'

/**
 * A 10-column sparkline: one of 8 levels (`▁` … `█`) per bucket, scaled to
 * the largest. Fewer than 10 buckets are padded with zeros at the start;
 * more keep the newest 10. All zero draws `▁` throughout.
 * @deprecated Use `spark(buckets, 10)` (or 22 in a deck), which returns a styled Run.
 */
export function spark10(buckets: number[]): string {
  const pad = new Array<number>(Math.max(0, DIAGRAM - buckets.length)).fill(0)
  const ten = buckets.length >= DIAGRAM ? buckets.slice(buckets.length - DIAGRAM) : [...pad, ...buckets]
  const max = Math.max(0, ...ten)
  return ten.map(v => SPARKS[max > 0 ? Math.min(7, Math.max(0, Math.round((v / max) * 7))) : 0]).join('')
}

const oneSpaced = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** The characters that part a long token into words: `snake_case`, `kebab-case`, a path, a dotted name. */
const PARTS = new Set(['_', '-', '/', '\\', '.', ':'])

/**
 * The longest head of one long token that ends where a part ends (before a
 * `_`, `-`, `/`, a backslash, `.` or `:`) and is at most `room` long; '' when no part fits.
 *
 * @example partCut('docs/superpowers/specs', 18) // 'docs/superpowers'
 */
export function partCut(token: string, room: number): string {
  let best = ''
  for (let i = 1; i < token.length && i <= room; i++) {
    if (PARTS.has(token[i]!) && !PARTS.has(token[i - 1]!)) best = token.slice(0, i)
  }
  return best
}

/**
 * `text` on one line (whitespace collapsed) cut to at most `cols` at a word
 * boundary, ending with `…` when cut (binding rule 1: cuts land on words).
 * When even the first word does not fit, it is cut where one of its parts
 * ends (`partCut`: a path segment, a `snake_case` word); a first word with no
 * part that fits leaves nothing: '' (the caller drops the cell).
 */
export function wordFit(text: string, cols: number): string {
  if (cols <= 0) return ''
  const t = oneSpaced(text)
  if (t.length <= cols) return t
  if (cols === 1) return '…'
  let out = ''
  for (const w of t.split(' ')) {
    const next = out === '' ? w : `${out} ${w}`
    if (next.length + 1 > cols) break
    out = next
  }
  if (out === '') out = partCut(t.split(' ')[0] ?? '', cols - 1)
  return out === '' ? '' : `${out}…`
}

/**
 * A name cell (a row's name, a need's asker, a node's label): `wordFit`, and
 * where not even a part of its first word fits, a lone `…` so a pressable row
 * keeps a label. No word is cut either way.
 */
export function nameFit(text: string, cols: number): string {
  const got = wordFit(text, cols)
  return got === '' && cols >= 1 && text.trim() !== '' ? '…' : got
}

/** Words a clause never ends on: a cut after one of them leaves the sentence hanging ("Wire limiter into the…"). */
const HANGING = new Set(['the', 'a', 'an', 'of', 'into', 'to', 'for', 'and', 'or', 'in', 'on', 'at', 'with', 'by', 'from', 'as', 'is'])

/**
 * `nameFit` that cuts at a clause (F M4): a name that has to be cut never ends on a word that wants another
 * ("Wire limiter into the…" is "Wire limiter…"), as long as a word is left.
 *
 * @example clauseFit('Wire limiter into the chain', 22) // 'Wire limiter…'
 */
export function clauseFit(text: string, cols: number): string {
  const got = nameFit(text, cols)
  if (!got.endsWith('…') || got === '…') return got
  const words = got.slice(0, -1).split(' ')
  while (words.length > 1 && HANGING.has((words[words.length - 1] ?? '').toLowerCase())) words.pop()
  return `${words.join(' ')}…`
}

/** Short names a table's 5-wide tool column shows for tools whose names are longer. */
const TOOL_SHORT: Record<string, string> = {
  SubagentHandback: 'Hand',
  TodoWrite: 'Todo',
  MultiEdit: 'Edit',
  NotebookEdit: 'Nb',
  WebSearch: 'Web',
  WebFetch: 'Fetch',
  TaskCreate: 'Task',
  TaskUpdate: 'Task',
  StructuredOutput: 'Out',
}

/**
 * @deprecated R31: a tool cell is never empty. Use `toolName` (and `toolRoom`).
 *
 * A tool's name for a column of `room` (5 in a table row): whole when it
 * fits, else its short name (`SubagentHandback` is `Hand`), else '' (the
 * name column after it says what the step is). Never cut.
 */
export function toolCell(tool: string, room = 5): string {
  if (tool.length <= room) return tool
  const short = TOOL_SHORT[tool]
  return short !== undefined && short.length <= room ? short : ''
}

/**
 * An agent type as a metric cell: `general-purpose` is `general`; any other
 * type is its longest leading part, cut at a hyphen or a space, that fits
 * `room` (a metric cell is 10 wide). When even the first part is too wide it
 * is cut as `wordFit` cuts it (at a part, or left out).
 *
 * @example typeShort('general-purpose') // 'general'
 * @example typeShort('code-reviewer')   // 'code'
 */
export function typeShort(type: string, room = 10): string {
  if (room <= 0) return ''
  if (type === 'general-purpose') return fit('general', room)
  if (type.length <= room) return type
  let best = ''
  for (const m of type.matchAll(/[- ]/g)) {
    const head = type.slice(0, m.index)
    if (head.length > room) break
    best = head
  }
  return best !== '' ? best : wordFit(type, room)
}

/** One wrapped line's words as text; a lone word wider than the line is cut at one of its parts (`wordFit`). */
const joinLine = (words: string[], cols: number): string => (words.length === 1 ? wordFit(words[0] ?? '', cols) : words.join(' '))

/**
 * `text` wrapped by word into at most `maxLines` lines of at most `cols`.
 * When it needs more, the last line holds what is left cut by `wordFit`, so
 * it ends with `…`. A word wider than a line is cut at one of its parts, or left out (`wordFit`).
 */
export function wrapWords(text: string, cols: number, maxLines = 2): string[] {
  if (cols <= 0 || maxLines <= 0) return []
  const words = oneSpaced(text)
    .split(' ')
    .filter(w => w !== '')
  const lines: string[][] = []
  let cur: string[] = []
  let width = 0
  for (const w of words) {
    if (cur.length > 0 && width + 1 + w.length <= cols) {
      cur.push(w)
      width += 1 + w.length
      continue
    }
    if (cur.length > 0) lines.push(cur)
    cur = [w]
    width = w.length
  }
  if (cur.length > 0) lines.push(cur)
  if (lines.length <= maxLines) return lines.map(l => joinLine(l, cols))
  const head = lines.slice(0, maxLines - 1).map(l => joinLine(l, cols))
  const rest = lines
    .slice(maxLines - 1)
    .flat()
    .join(' ')
  return [...head, wordFit(rest, cols)]
}

/**
 * Runs (styled pieces of one line) cut to `cols` on a word of their joined
 * text, its own spacing kept: the same runs when they fit; otherwise the runs
 * up to the last word end that leaves room for `…` (or, when even the first
 * word does not fit, a part of it: `partCut`), the last one shortened, then a
 * plain `{ text: '…' }` run. Nothing fits: no runs. Empty runs are dropped.
 */
export function fitRuns<T extends { text: string }>(runs: T[], cols: number): (T | { text: string })[] {
  const joined = runs.map(r => r.text).join('')
  if (joined.length <= cols) return runs
  if (cols <= 0) return []
  let keep = 0
  for (let i = 1; i <= cols - 1 && i < joined.length; i++) {
    if (joined[i] === ' ' && joined[i - 1] !== ' ') keep = i
  }
  if (keep === 0) {
    const first = joined.trimStart()
    const lead = joined.length - first.length
    const head = partCut(first.split(' ')[0] ?? '', cols - 1 - lead)
    keep = head === '' ? 0 : lead + head.length
  }
  if (keep === 0) return []
  const cut = `${joined.slice(0, keep)}…`
  const out: (T | { text: string })[] = []
  let used = 0
  for (const r of runs) {
    if (used >= keep) break
    const room = keep - used
    const text = r.text.length <= room ? r.text : r.text.slice(0, room)
    if (text !== '') out.push(text === r.text ? r : { ...r, text })
    used += text.length
  }
  // A cut that fell on a space leaves the space at the end: drop it.
  const last = out[out.length - 1]
  if (last !== undefined && last.text.endsWith(' ')) {
    const text = last.text.trimEnd()
    if (text === '') out.pop()
    else out[out.length - 1] = { ...last, text }
  }
  if (cut.endsWith('…')) out.push({ text: '…' })
  return out
}

const PATH_LEAD = /^[("'“‘`[]*/
const PATH_TRAIL = /[)"'”’`\],.;:!?]*$/
const ABSOLUTE = /^([A-Za-z]:[\\/]|[\\/]|~[\\/]|\.{1,2}[\\/])/

function shortPath(token: string): string {
  const lead = PATH_LEAD.exec(token)?.[0] ?? ''
  const rest = token.slice(lead.length)
  const trail = PATH_TRAIL.exec(rest)?.[0] ?? ''
  const core = rest.slice(0, rest.length - trail.length)
  if (core.includes('://') || !/[\\/]/.test(core) || !/[A-Za-z]/.test(core)) return token
  const segs = core.split(/[\\/]+/).filter(s => s !== '')
  const last = segs[segs.length - 1]
  if (last === undefined) return token
  const isPath = segs.length >= 3 || (segs.length === 2 && (ABSOLUTE.test(core) || /\.\w+$/.test(last)))
  if (!isPath) return token
  const dir = /[\\/]$/.test(core) ? '/' : ''
  return `${lead}…/${last}${dir}${trail}`
}

/**
 * Every path in `text` shortened to `…/<last segment>`: a token with a `/` or
 * `\` and a letter that has 3 or more segments, or 2 when it is absolute or
 * ends in an extension. Fractions, dates, `and/or`, `mod/` and URLs stay;
 * brackets, quotes and trailing punctuation are kept around the short form.
 */
export function shortPaths(text: string): string {
  return text.replace(/\S+/g, shortPath)
}

const AGENT_MESSAGE = /<\/?agent-message\b[^>]*>/g

/**
 * A turn's title: the prompt on one line, `<agent-message …>` wrappers
 * stripped, paths shortened, in curly quotes (`“…”`). A hand-back whose text
 * opens with a `[Label]` is titled by that label. With `cols`, cut by word to
 * fit with both quotes. Nothing left: '' (the caller names it).
 */
export function promptTitle(text: string, cols?: number): string {
  const stripped = text.replace(AGENT_MESSAGE, ' ')
  let t = oneSpaced(stripped)
  if (stripped !== text) {
    const label = /^\[([^\]]+)\]/.exec(t)?.[1]
    if (label !== undefined) t = label.trim()
  }
  t = shortPaths(t)
  if (t === '') return ''
  if (cols === undefined) return `“${t}”`
  if (cols < 3) return ''
  return `“${wordFit(t, cols - 2)}”`
}

/**
 * The first `n` cells by priority: while there are too many, the cell with
 * the lowest `drop` rank goes first (1 before 2), then unranked cells from
 * the end. The order of what stays is kept.
 */
export function keepCells<T extends { drop?: number }>(cells: T[], n: number): T[] {
  const out = [...cells]
  while (out.length > Math.max(0, n)) {
    let pick = -1
    for (let i = 0; i < out.length; i++) {
      const rank = out[i]?.drop
      if (rank === undefined) continue
      if (pick === -1 || rank < (out[pick]?.drop ?? Infinity)) pick = i
    }
    out.splice(pick === -1 ? out.length - 1 : pick, 1)
  }
  return out
}

// ---------- Neo: gauges and the crew (spec "Gauges", "Crew: pods") ----------
// Each returns Runs (style.ts `Run`): styled pieces a deck cell, a row's
// metric or a band lays at a column. Glyphs come from `GLYPHS`.

/** The two bar widths Neo draws: 10 (one cell) and 22 (cells 2 and 3 of a deck, without the gap). */
export type BarCells = 10 | 22

/** The width of a deck gauge: from column 14 to 35, ending 2 before the value at 38. */
export const GAUGE = 22

/** Runs without the empty ones. */
const solid = (runs: Run[]): Run[] => runs.filter(r => r.text !== '')

/**
 * A bar of exactly `cells` (10 or 22): `▮` lit, `▯` resting in `subtle`.
 * Any non-zero value lights at least one cell; only 100 % (or more) lights
 * all; a total of 0 or less, or a value of 0 or less, lights none. The lit run
 * is in `color`, by default `rateColor` of the share (the accent, `warning`
 * from 70 %, `error` from 90 %); pass `C.model` for a share bar.
 *
 * @example bar(18, 100, 22)            // [{ text: '▮▮▮▮', color: 'suggestion' }, { text: '▯' × 18, color: 'subtle' }]
 * @example bar(993, 1512, 10, C.model) // 7 lit in `merged`, 3 resting
 */
export function bar(value: number, total: number, cells: BarCells, color?: string): Run[] {
  let lit = 0
  if (total > 0 && value > 0) {
    lit = Math.round((Math.min(value, total) / total) * cells)
    if (lit === 0) lit = 1
    if (value < total && lit === cells) lit = cells - 1
  }
  const pct = total > 0 ? (Math.max(0, value) / total) * 100 : 0
  return solid([
    { text: GLYPHS.bar.lit.repeat(lit), color: color ?? rateColor(pct) },
    { text: GLYPHS.bar.rest.repeat(cells - lit), color: C.subtle },
  ])
}

/**
 * One pip per task: `▪` done (dim), `▸` current (bold, accent), `▫` queued
 * (dim). `active` is how many are current (default 1; 0 when nothing is in
 * progress); they follow the done pips. More than `max` tasks (22 in a deck,
 * 10 where a cell is all there is) draw `bar(done, total, max)` in the accent
 * instead. No tasks draw nothing.
 *
 * @example pips(9, 14)     // ▪▪▪▪▪▪▪▪▪▸▫▫▫▫
 * @example pips(30, 40)    // a 22-cell bar
 * @example pips(9, 14, 10) // a 10-cell bar: 14 tasks do not fit one cell
 */
export function pips(done: number, total: number, max: BarCells = GAUGE, active = 1): Run[] {
  const n = Math.max(0, Math.floor(total))
  if (n > max) return bar(done, n, max, C.live)
  const d = Math.min(n, Math.max(0, Math.floor(done)))
  const cur = Math.min(n - d, Math.max(0, Math.floor(active)))
  const [donePip, curPip, queuedPip] = GLYPHS.pip
  return solid([
    { text: donePip.repeat(d), dim: true },
    { text: curPip.repeat(cur), color: C.live, bold: true },
    { text: queuedPip.repeat(n - d - cur), dim: true },
  ])
}

/**
 * Counts `times` into `n` equal buckets over `from` … `to`. `to` itself falls
 * in the last bucket; times outside are left out. A span of zero puts every
 * time equal to `to` in the last bucket.
 *
 * @example buckets(stepStarts, sessionStart, ctx.now, 22)
 */
export function buckets(times: number[], from: number, to: number, n: BarCells): number[] {
  const out: number[] = new Array<number>(n).fill(0)
  const span = to - from
  for (const t of times) {
    if (t < from || t > to) continue
    const i = span <= 0 ? n - 1 : Math.min(n - 1, Math.floor(((t - from) / span) * n))
    out[i] = (out[i] ?? 0) + 1
  }
  return out
}

/**
 * A trace of exactly `n` (10 or 22) levels, `▁` … `█`, scaled to the largest
 * bucket, as one Run in `color` (default the accent). Fewer buckets are
 * padded with zeros at the start; more keep the newest `n`. All zero draws
 * `▁` throughout.
 *
 * @example spark(buckets(stepStarts, start, ctx.now, 22), 22)
 * @example spark(doneBuckets, 22, C.subtle) // PACE: a quieter trace
 */
export function spark(values: number[], n: BarCells, color: string = C.live): Run[] {
  const pad = new Array<number>(Math.max(0, n - values.length)).fill(0)
  const kept = values.length >= n ? values.slice(values.length - n) : [...pad, ...values]
  const max = Math.max(0, ...kept)
  const levels = GLYPHS.sparks
  const text = kept.map(v => levels[max > 0 ? Math.min(7, Math.max(0, Math.round((v / max) * 7))) : 0]).join('')
  return [{ text, color }]
}

/** Options of `crewRow`. */
export type CrewOpts = {
  /** The one-row band: pods with no gaps, a signal cell only where there is a signal. */
  tight?: boolean
}

/**
 * A crew row: each pod at a pitch of 3 columns (hull, signal or blank, gap);
 * the last has no trailing blank. At most `max` pods (7 in the pane, 12 in
 * the band); more draw `max − 1` and a dim `+n`. 7 pods take 19 columns, 6
 * and `+n` at most 22, so a crew at 14 ends by 36. Spaces are plain runs.
 *
 * @example crewRow(agents.map(a => podOf(a, ctx.now)))       // ◈  ◉  ▣  △! ●  ●  ■
 * @example crewRow(pods, 12, { tight: true })                 // ◈◉▣△!●●■
 */
export function crewRow(pods: Pod[], max = 7, opts: CrewOpts = {}): Run[] {
  const over = pods.length > max
  const shown = over ? pods.slice(0, Math.max(0, max - 1)) : pods
  const out: Run[] = []
  const space = (k: number): void => {
    const last = out[out.length - 1]
    if (last !== undefined && last.text.trim() === '' && Object.keys(last).length === 1) out[out.length - 1] = { text: last.text + ' '.repeat(k) }
    else out.push({ text: ' '.repeat(k) })
  }
  shown.forEach((p, i) => {
    out.push(p.hull)
    if (p.signal !== undefined) out.push(p.signal)
    else if (opts.tight !== true) space(1)
    if (opts.tight !== true && (i < shown.length - 1 || over)) space(1)
  })
  if (over) out.push({ text: `+${pods.length - shown.length}`, dim: true })
  const last = out[out.length - 1]
  if (last !== undefined && last.text.trim() === '' && Object.keys(last).length === 1) out.pop()
  return out
}

/**
 * A meter, one cell wide: `CTX ◔ 9%`: the label dim, a dial (`dialOf`), the
 * rounded percentage bold, in the rate colour from 70 %. Labels are 2 or 3
 * characters (CTX, 5H, 7D), so it is at most 10 wide; a value past 999 % is
 * shown as `999%`.
 *
 * @example meter('5H', 78) // 5H ◕ 78%, the dial and value in warning
 */
export function meter(label: string, pct: number): Run[] {
  const p = Number.isFinite(pct) ? pct : 0
  const value = `${Math.min(999, Math.max(0, Math.round(p)))}%`
  return [
    { text: fit(label, 10 - 3 - value.length), dim: true },
    { text: ' ' },
    dialOf(p),
    { text: ' ' },
    { text: value, bold: true, ...(p >= 70 ? { color: rateColor(p) } : {}) },
  ]
}

/**
 * A tree row's tether prefix, `depth × 2` wide (spec "Grid": tethers take
 * columns 2 to 3, or 4 to 5 two deep): `├╌` for a child with siblings below,
 * `╰╌` for the last; at depth 2 the outer guide `┆` comes first when the
 * parent has siblings below (`outer`), else a blank. Depth 0 has none.
 *
 * @example tether(1, false)       // '├╌'
 * @example tether(2, true, true)  // '┆ ╰╌'
 */
export function tether(depth: number, last: boolean, outer = false): string {
  if (depth <= 0) return ''
  const t = last ? GLYPHS.tether.last : GLYPHS.tether.mid
  if (depth === 1) return t
  return `${outer ? GLYPHS.tether.guide : ' '} ${t}`
}

/**
 * A pill as a Run: the word with one space each side, bold, in `inverseText`
 * on `bg` (spec "Pill"): ` WORKING ` on the accent, ` NEEDS YOU ` on
 * `warning`, ` ALL DONE ` / ` IDLE ` on `subtle`, the chosen filter chip on
 * the accent. `pill` in parts.tsx draws it as a Text.
 */
export function pillRun(word: string, bg: string): Run {
  return { text: ` ${word} `, bg, color: C.inverse, bold: true }
}

// ---------- Neo Rich: meters, the height rule, the strip's compartments ----------

/**
 * Bar heights in eighths for `rows` rows (1 to 3): each value scaled to the
 * largest, 0 to `rows * 8`; any value above zero shows at least one eighth.
 * A value that is not a positive number is 0.
 *
 * @example levels([0, 5, 10], 1) // [0, 4, 8]
 */
export function levels(values: number[], rows: number): number[] {
  const top = Math.max(0, Math.floor(rows)) * 8
  const clean = values.map(v => (Number.isFinite(v) && v > 0 ? v : 0))
  const max = Math.max(0, ...clean)
  if (max === 0) return clean.map(() => 0)
  return clean.map(v => (v === 0 ? 0 : Math.max(1, Math.round((v / max) * top))))
}

/**
 * How many of `n` beads a meter at `pct` lights: none at 0, any value above
 * zero lights one, only 100 or more lights all (raster.ts `beads` draws it).
 *
 * @example beadCount(50, 11) // 5
 */
export function beadCount(pct: number, n: number): number {
  if (n <= 0 || !Number.isFinite(pct) || pct <= 0) return 0
  if (pct >= 100) return n
  return Math.max(1, Math.min(n - 1, Math.floor((pct * n) / 100)))
}

/**
 * One section a page or tab stacks under its deck: how many rows its list
 * holds (`count`), the rows it takes before any other grows (`floor`,
 * default 1) and the most it takes (`cap`, default no limit). `per` is the
 * terminal rows one of its items takes (default 1; a rich agent row is 2).
 */
export type SectionCount = { key: string; count: number; floor?: number; cap?: number; per?: number }

/** Now's sections by height (spec "Now by height"), in the order spare rows are dealt. */
export const NOW_SECTIONS = {
  latest: { floor: 2, cap: 8 },
  agents: { floor: 3, cap: 6 },
  tasks: { floor: 1, cap: 8 },
  kept: { floor: 1, cap: 4 },
  notes: { floor: 2, cap: 4 },
} as const

/** The rows sections take: a header and its rows each, one blank between two. */
export function rowsUsed(got: { rows: number }[]): number {
  if (got.length === 0) return 0
  return got.reduce((n, g) => n + 1 + g.rows, 0) + got.length - 1
}

/**
 * The height rule (rich spec "Now by height", binding rule 2): how many list
 * rows each section shows in `bodyRows` rows. A section costs its header and
 * its rows, and one blank row sits between two sections, never two. Rows are
 * dealt one at a time: first each section's floor, in order, then the spare
 * one to each in turn up to its cap or its count. A row that does not fit is
 * not dealt, so with fewer rows the last sections go first (taken back in
 * reverse) and the lists dealt first grow. Empty sections are left out. The
 * answer is in input order, shown sections only.
 *
 * @example sectionRows(bodyRows - deckRows, [{ key: 'latest', count: steps.length, ...NOW_SECTIONS.latest }])
 */
export function sectionRows(bodyRows: number, counts: SectionCount[]): { key: string; rows: number }[] {
  const want = counts.map(c => Math.max(0, Math.min(Math.floor(c.count), c.cap ?? Number.POSITIVE_INFINITY)))
  const floor = counts.map((c, i) => Math.min(Math.max(1, c.floor ?? 1), want[i]!))
  const got = counts.map(() => 0)
  let left = Math.max(0, Math.floor(bodyRows))
  let shown = 0
  const deal = (i: number): boolean => {
    const per = Math.max(1, Math.floor(counts[i]!.per ?? 1))
    const cost = got[i] === 0 ? 1 + per + (shown > 0 ? 1 : 0) : per
    if (cost > left) return false
    if (got[i] === 0) shown += 1
    got[i] = got[i]! + 1
    left -= cost
    return true
  }
  for (let i = 0; i < counts.length; i++) {
    while (got[i]! < floor[i]!) {
      if (!deal(i)) break
    }
  }
  let moved = true
  while (moved && left > 0) {
    moved = false
    for (let i = 0; i < counts.length; i++) {
      if (got[i]! < want[i]! && deal(i)) moved = true
    }
  }
  return counts.map((c, i) => ({ key: c.key, rows: got[i]! })).filter(g => g.rows > 0)
}

/** One list of a tab for `growLists`: its items, and how many it shows however short the pane (its old fixed cap). */
export type GrowList = { key: string; count: number; least: number; per?: number }

/** The rows a list of `count` takes to show `least` items: those, and a more line when there are more. */
const leastRows = (count: number, least: number): number => (count <= least ? count : least + 1)

/**
 * Binding rule 2 on a tab: the rows each list takes in the `spare` rows its
 * deck and fixed parts leave (a list's rows include its more line). Each
 * shows at least `least` items, as it did with a fixed cap; the height rule
 * (`sectionRows`) deals the rest in turn, up to every item. Lists with no
 * items take none.
 *
 * @example growLists(bodyRows - fixed, [{ key: 'queued', count: 12, least: 5 }, { key: 'done', count: 9, least: 3 }])
 */
export function growLists(spare: number, lists: GrowList[]): Map<string, number> {
  const dealt = sectionRows(
    spare,
    lists.map(l => ({ key: l.key, count: l.count, floor: Math.max(1, leastRows(l.count, l.least)), ...(l.per !== undefined ? { per: l.per } : {}) })),
  )
  const out = new Map<string, number>()
  for (const l of lists) {
    if (l.count <= 0) continue
    out.set(l.key, Math.max(dealt.find(d => d.key === l.key)?.rows ?? 0, leastRows(l.count, l.least)))
  }
  return out
}

/**
 * R37: the items each list of a tab shows once the pane is taller than the mocks' 46 rows. Each list keeps its
 * `cap` (the mock's, the floor); `spare` rows are dealt to the lists in order, one item a row, and a list that
 * ends up showing everything frees its "+ n more" row. Lists with no more items than their cap keep it.
 *
 * @example growCaps(10, [{ count: 12, cap: 5 }, { count: 9, cap: 3 }]) // [12, 3 + 4]: the first takes 6 (one row freed), the second the rest
 */
export function growCaps(spare: number, lists: readonly { count: number; cap: number }[]): number[] {
  let left = Math.max(0, Math.floor(spare))
  return lists.map(({ count, cap }) => {
    if (count <= cap) return cap
    const rest = count - cap
    if (left >= rest - 1) {
      left = Math.max(0, left - Math.max(0, rest - 1))
      return count
    }
    const extra = left
    left = 0
    return cap + extra
  })
}

/** What a list of `count` draws in `rows` rows: every item when they fit, else `rows - 1` and a more line for the rest. */
export function listSplit(count: number, rows: number): { shown: number; more: number } {
  if (count <= rows) return { shown: count, more: 0 }
  const shown = Math.max(1, rows - 1)
  return { shown, more: count - shown }
}

/** The gap between strip compartments: three clear columns, or two where three would drop one. */
const STRIP_GAPS = [3, 2] as const

/**
 * Widths across `cols` for blocks of at least `min` each, side by side: the
 * gap is 3, or 2 where 3 would drop one; blocks that still do not fit are
 * dropped from the right. Spare columns go evenly to those that grow, the
 * remainder to the first of them. (Moved here from stripband.tsx.)
 */
export function layOut(mins: { min: number; grows: boolean }[], cols: number): { widths: number[]; gap: number } {
  for (let n = mins.length; n >= 1; n--) {
    const kept = mins.slice(0, n)
    const sum = kept.reduce((a, c) => a + c.min, 0)
    for (const gap of STRIP_GAPS) {
      const used = sum + gap * (n - 1)
      if (used > cols) continue
      const growers = kept.map((c, i) => (c.grows ? i : -1)).filter(i => i >= 0)
      const spare = cols - used
      const each = growers.length > 0 ? Math.floor(spare / growers.length) : 0
      const widths = kept.map((c, i) => c.min + (growers.includes(i) ? each : 0))
      if (growers.length > 0) widths[growers[0]!] = widths[growers[0]!]! + (spare - each * growers.length)
      return { widths, gap }
    }
  }
  return { widths: [Math.max(1, cols)], gap: STRIP_GAPS[0] }
}

/** A strip compartment: `activity` is AGENTS over LATEST in one (96 to 116 columns). */
export type CompKey = 'now' | 'needs' | 'tasks' | 'agents' | 'latest' | 'budget' | 'activity'

/** The strip's compartments (rich spec "Strip"): their table widths, and whether they take spare columns. */
const COMP: Record<CompKey, { min: number; grows: boolean }> = {
  now: { min: 52, grows: false },
  needs: { min: 34, grows: true },
  tasks: { min: 34, grows: true },
  agents: { min: 36, grows: true },
  latest: { min: 28, grows: true },
  budget: { min: 23, grows: false },
  activity: { min: 46, grows: true },
}

/** The compartments a too-narrow strip gives up first, whole. NOW and NEEDS YOU stay. */
const COMP_DROP: readonly CompKey[] = ['tasks', 'latest', 'budget', 'agents']

/** The narrowest strip in compartments; under it the strip stacks. */
export const COMPARTMENTS_FROM = 96

/**
 * The strip's compartments at `cols` (rich spec "Strip"), each dropped whole
 * and never squeezed, with three clear columns between (two where three would
 * drop one):
 * - 185 and up: NOW 52, TASKS 34, AGENTS 36, LATEST 28, BUDGET 23
 * - 148 to 184: NOW, AGENTS, LATEST, BUDGET
 * - 117 to 147: NOW, AGENTS, BUDGET
 * - 96 to 116: NOW 48, then AGENTS over LATEST (`activity`) 46
 * - under 96: none (the strip stacks)
 * Whenever something waits NEEDS YOU takes the second place: it replaces
 * TASKS (or `activity` under 117) or is put second, and compartments go whole
 * in COMP_DROP order until the rest fits. Spare columns go to the lists.
 *
 * @example compartments(150, false) // { comps: [now 52, agents 37, latest 29, budget 23], gap: 3 }
 */
export function compartments(cols: number, waiting: boolean): { comps: { key: CompKey; width: number }[]; gap: number } {
  if (cols < COMPARTMENTS_FROM) return { comps: [], gap: STRIP_GAPS[0] }
  const narrow = cols < 117
  let keys: CompKey[]
  if (cols >= 185) keys = ['now', 'tasks', 'agents', 'latest', 'budget']
  else if (cols >= 148) keys = ['now', 'agents', 'latest', 'budget']
  else if (narrow) keys = ['now', 'activity']
  else keys = ['now', 'agents', 'budget']
  if (waiting) {
    const swap = keys.indexOf(narrow ? 'activity' : 'tasks')
    if (swap >= 0) keys[swap] = 'needs'
    else keys = [keys[0]!, 'needs', ...keys.slice(1)]
  }
  const minOf = (k: CompKey): number => {
    if (narrow && k === 'now') return 48
    if (narrow && k === 'needs') return 46
    return COMP[k].min
  }
  const specs = (ks: CompKey[]) => ks.map(k => ({ min: minOf(k), grows: COMP[k].grows }))
  const fits = (ks: CompKey[]) => layOut(specs(ks), cols).widths.length === ks.length
  for (const drop of COMP_DROP) {
    if (fits(keys)) break
    keys = keys.filter(k => k !== drop)
  }
  const { widths, gap } = layOut(specs(keys), cols)
  return { comps: keys.slice(0, widths.length).map((key, i) => ({ key, width: widths[i]! })), gap }
}

/**
 * `text` wrapped in full into lines of at most `cols`: by word, a word wider
 * than a line broken across lines, each newline kept (an empty line for a
 * blank one). Nothing is cut and no line ends in `…` (detail pages).
 *
 * @example wrapFull('abcdefghij', 4) // ['abcd', 'efgh', 'ij']
 */
export function wrapFull(text: string, cols: number): string[] {
  if (cols <= 0 || text.trim() === '') return []
  const out: string[] = []
  for (const para of text.replace(/\r\n?/g, '\n').split('\n')) {
    const words = para
      .replace(/[\t ]+/g, ' ')
      .trim()
      .split(' ')
      .filter(w => w !== '')
    if (words.length === 0) {
      out.push('')
      continue
    }
    let cur = ''
    for (const word of words) {
      let w = word
      if (cur !== '' && cur.length + 1 + w.length <= cols) {
        cur = `${cur} ${w}`
        continue
      }
      if (cur !== '') {
        out.push(cur)
        cur = ''
      }
      while (w.length > cols) {
        out.push(w.slice(0, cols))
        w = w.slice(cols)
      }
      cur = w
    }
    if (cur !== '') out.push(cur)
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  while (out.length > 0 && out[0] === '') out.shift()
  return out
}

// ---------- the cockpit: words (cockpit spec "Vocabulary", rulings R22, R27, R31) ----------

/** What `doing` reads of a step: a model `Step` fits (`pending` is its input while it runs). */
export type DoingStep = { id?: string; tool: string; label?: string; pending?: Record<string, unknown>; asking?: number }
/** What `doing` reads of the needs view (alerts.ts `needs`): the steps whose ask is shown. */
export type DoingView = { items: readonly { stepId?: string }[] }
/** A step whose auto-mode ask is still being checked (R2; alerts.ts `CHECKING_TEXT`). */
const CHECKING = 'Checking a permission'

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? oneSpaced(v) : undefined)

/** The last two segments of a path, `/` separated: what a card shows of a file. */
function tail2(path: string): string {
  return path
    .split(/[\\/]+/)
    .filter(s => s !== '')
    .slice(-2)
    .join('/')
}

/** A step's label without its leading tool name (`Edit a/b.ts` is `a/b.ts`). */
function labelRest(s: DoingStep): string {
  const l = oneSpaced(s.label ?? '')
  return l.startsWith(`${s.tool} `) ? l.slice(s.tool.length + 1) : l === s.tool ? '' : l
}

const quoted = (s: string): string => `“${s.replace(/^"(.*)"$/, '$1')}”`

const FILE_VERB: Record<string, string> = { Read: 'Reading', Edit: 'Editing', MultiEdit: 'Editing', NotebookEdit: 'Editing', Write: 'Writing' }
const LIST_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate'])
const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

/**
 * What an agent is doing, as a verb phrase for Now (cockpit spec: tool names
 * become verbs; Steps keeps the names): no running step is "Thinking"; a step
 * a dialog waits on (`asking`, or the question and plan tools) is "Waiting
 * for your answer", except that, given the needs `view`, a permission it
 * does not show yet (auto mode's checking gap) is "Checking a permission",
 * as the pane and the band say (F I1); Read is "Reading <file>", Grep and Glob "Searching
 * <where> for “<what>”", Bash "Running <command>", Edit "Editing <file>",
 * Write "Writing <file>", Agent "Delegating: <description>", the task tools
 * "Updating the to-do list", anything else "Using <tool>". Files show their
 * last two segments. The phrase is one line, uncut.
 *
 * With `room` (F I7) the phrase shortens by clause instead, and never ends
 * in `…`: it drops `for “…”`, then the path shrinks (a file to its last
 * segment, a folder to its first: "Searching src/"), then the verb stands
 * alone. When not even that fits, the result is ''.
 *
 * @example doing({ tool: 'Edit', label: 'Edit test/rateLimit.test.ts' })                              // 'Editing test/rateLimit.test.ts'
 * @example doing({ tool: 'Edit', label: 'Edit test/rateLimit.test.ts' }, undefined, 20)                // 'Editing rateLimit.test.ts'
 * @example doing({ tool: 'Grep', label: 'Grep "upload("', pending: { pattern: 'upload(', path: 'src/server' } }) // 'Searching src/server for “upload(”'
 * @example doing(undefined)                                                                             // 'Thinking'
 */
export function doing(step: DoingStep | undefined, view?: DoingView, room?: number): string {
  const options = doingOptions(step, view)
  if (room === undefined) return options[0]!
  return options.find(o => o.length <= room) ?? ''
}

/** The phrases `doing` may say, the fullest first, each a clause shorter. */
function doingOptions(step: DoingStep | undefined, view?: DoingView): string[] {
  if (step === undefined) return ['Thinking']
  const t = step.tool
  const input = step.pending ?? {}
  if (ASK_TOOLS.has(t)) return ['Waiting for your answer', 'Waiting for you']
  if (step.asking !== undefined) {
    const shown = view === undefined || (step.id !== undefined && view.items.some(n => n.stepId === step.id))
    return shown ? ['Waiting for your answer', 'Waiting for you'] : [CHECKING, 'Checking']
  }
  const rest = labelRest(step)
  const verb = FILE_VERB[t]
  if (verb !== undefined) {
    const p = text(input.file_path) ?? text(input.notebook_path)
    const what = p !== undefined ? tail2(p) : rest
    if (what === '') return [verb]
    const last = what.split('/').pop() ?? what
    return unique([`${verb} ${what}`, `${verb} ${last}`, verb])
  }
  if (t === 'Grep' || t === 'Glob') {
    const pattern = text(input.pattern) ?? (rest !== '' ? rest.replace(/^"(.*)"$/, '$1') : undefined)
    const where = text(input.path)
    const what = pattern !== undefined ? (t === 'Grep' ? quoted(pattern) : pattern) : undefined
    const place = where !== undefined ? tail2(where) : undefined
    // A folder shrinks to its first segment ("src/"), the way a path is cut at its slash.
    const head = place !== undefined && place.includes('/') ? `${place.slice(0, place.indexOf('/') + 1)}` : undefined
    const out: string[] = []
    if (what !== undefined) out.push(place !== undefined ? `Searching ${place} for ${what}` : `Searching for ${what}`)
    if (place !== undefined) out.push(`Searching ${place}`)
    if (head !== undefined) out.push(`Searching ${head}`)
    out.push('Searching')
    return unique(out)
  }
  if (t === 'Bash' || t === 'PowerShell') {
    const c = text(input.command) ?? rest
    return c !== '' ? ['Running ' + c, 'Running a command', 'Running'] : ['Running a command', 'Running']
  }
  if (t === 'Agent' || t === 'Task') {
    const d = text(input.description)
    if (d !== undefined) return [`Delegating: ${d}`, 'Delegating']
    const ty = text(input.subagent_type)
    if (ty !== undefined) return [`Delegating to ${typeName(ty)}`, 'Delegating']
    const fromLabel = rest.includes(' · ') ? rest.slice(rest.indexOf(' · ') + 3) : rest
    return fromLabel !== '' ? [`Delegating: ${fromLabel}`, 'Delegating'] : ['Delegating']
  }
  if (t === 'WebFetch') {
    const u = text(input.url) ?? rest
    const host = /^[a-z]+:\/\/([^/\s]+)/i.exec(u)?.[1]
    return host !== undefined ? [`Reading ${host}`, 'Reading a web page', 'Reading'] : ['Reading a web page', 'Reading']
  }
  if (t === 'WebSearch') {
    const q = text(input.query) ?? rest
    return q !== '' ? [`Searching the web for ${quoted(q)}`, 'Searching the web', 'Searching'] : ['Searching the web', 'Searching']
  }
  if (LIST_TOOLS.has(t)) return ['Updating the to-do list', 'Updating the list', 'Updating']
  if (t === 'Skill') {
    const sk = text(input.skill) ?? rest
    return sk !== '' ? [`Using the ${sk} skill`, 'Using a skill', 'Using'] : ['Using a skill', 'Using']
  }
  if (t === 'SubagentHandback') return ['Handing back']
  return [`Using ${mcpPart(t)}`, 'Using']
}

const unique = (xs: string[]): string[] => [...new Set(xs)]

/** An MCP tool's own part (`mcp__server__tool` is `tool`); any other name as it is. */
function mcpPart(tool: string): string {
  if (!tool.startsWith('mcp__')) return tool
  const parts = tool.split('__').filter(p => p !== '')
  return parts[parts.length - 1] ?? tool
}

/**
 * The short tool names (R31, owner: short, then drop below 40): `Edit Read
 * Write Bash Grep Glob Web Fetch Agent Skill Todo Task+ Task✓ Back Cell`,
 * and a few more the session meets so no cell is ever empty.
 */
export const TOOL_NAMES: Readonly<Record<string, string>> = {
  MultiEdit: 'Edit',
  WebSearch: 'Web',
  WebFetch: 'Fetch',
  TodoWrite: 'Todo',
  TaskCreate: 'Task+',
  TaskUpdate: 'Task✓',
  SubagentHandback: 'Back',
  BashOutput: 'Back',
  TaskOutput: 'Back',
  NotebookEdit: 'Cell',
  PowerShell: 'Shell',
  AskUserQuestion: 'Ask',
  ExitPlanMode: 'Plan',
  EnterPlanMode: 'Plan',
  StructuredOutput: 'Out',
  Workflow: 'Flow',
  ToolSearch: 'Tools',
  TaskList: 'Tasks',
  TaskGet: 'Task',
  TaskStop: 'Stop',
  KillShell: 'Stop',
  SendMessage: 'Send',
}

/** Under this many body columns the tool column is dropped (R31). */
export const TOOL_COLUMN_FROM = 40

/** The width of a step's tool column at `cols`: 5 (short names), or 0 under 40 columns: dropped. */
export function toolRoom(cols: number): number {
  return cols < TOOL_COLUMN_FROM ? 0 : 5
}

/**
 * A tool's name for a column of `room` (R31): whole when it fits; else its
 * short name (`TaskUpdate` is `Task✓`); an MCP tool is the last part of
 * `mcp__server__tool`, cut at a word (`_`, `-` or a capital); any other
 * name is cut at a word the same way. Never empty while `room` > 0: a name
 * whose first word is wider than the room keeps `room - 1` letters and `…`
 * (the only cut inside a word, so the column is never blank). Room 0 is ''.
 *
 * @example toolName('TaskUpdate')                     // 'Task✓'
 * @example toolName('mcp__mission-control__update')    // 'updat…' at 5; 'update' at 6
 * @example toolName('mcp__github__get_issue')         // 'get'
 */
export function toolName(tool: string, room = 5): string {
  if (room <= 0) return ''
  if ([...tool].length <= room) return tool
  const short = TOOL_NAMES[tool]
  if (short !== undefined && [...short].length <= room) return short
  const own = mcpPart(tool)
  if ([...own].length <= room) return own
  const words = own
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(w => w !== '')
  let head = ''
  for (const w of words) {
    const next = head === '' ? w : `${head} ${w}`
    if (next.length > room) break
    head = next
  }
  if (head !== '') return head
  return room === 1 ? '…' : `${own.slice(0, room - 1)}…`
}

/**
 * A duration in the cockpit's words (R27): `45s` under a minute; `2m 14s`
 * under 10 min only where `steps` asks for it (the Steps tab); `12 min`;
 * `1 h 12 min` (and `2 h` on the hour).
 *
 * @example span(45_000)                      // '45s'
 * @example span(134_000, { steps: true })    // '2m 14s'
 * @example span(134_000)                     // '2 min'
 * @example span(72 * 60_000)                 // '1 h 12 min'
 */
export function span(ms: number, o: { steps?: boolean } = {}): string {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (o.steps === true && m < 10) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`
}

/** A countdown as `m:ss` (R27: only a countdown reads this way): `4:48`. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil((Number.isFinite(ms) ? ms : 0) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * How long the prompt cache stays warm, in whole minutes and no seconds (the
 * estimate is not that exact): "4 min", and "under 1 min" in the last
 * minute (R40). The one word helper for the header's budget line and the budget
 * view's CACHE row. Minutes round down, so it never promises more than is left.
 *
 * @example `cache warm ${warmWords(warm - now)}`
 */
export function warmWords(ms: number): string {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  const m = Math.floor(s / 60)
  return m < 1 ? 'under 1 min' : `${m} min`
}

// ---------- the cockpit: bars in `━` (R22: Text, so no Raster on any surface) ----------

/** One part of a `ruleBar`: a count and its style (a theme key, or dim). */
export type BarPart = { count: number; color?: string; dim?: boolean }

/** Adjacent runs of the same style joined. */
function joinRuns(runs: Run[]): Run[] {
  const out: Run[] = []
  for (const r of runs) {
    if (r.text === '') continue
    const last = out[out.length - 1]
    if (last !== undefined && last.color === r.color && last.dim === r.dim && last.bold === r.bold) out[out.length - 1] = { ...last, text: last.text + r.text }
    else out.push(r)
  }
  return out
}

const styleOf = (p: BarPart): Omit<Run, 'text'> => ({ ...(p.color !== undefined ? { color: p.color } : {}), ...(p.dim === true ? { dim: true } : {}) })

/**
 * A stacked bar of `cells` `━` (the spec's `bar(cells, parts)`): each part's
 * share by largest remainder, a non-zero part never under one cell while
 * cells remain; all zero is the rest. Exactly `cells` wide. With `gaps`, the
 * last cell of every part but the last lit one is a blank (the mock's Models
 * bar: a part, a gap, the next part); a part of one cell keeps it.
 *
 * @example ruleBar(28, [{ count: 71, color: 'suggestion' }, { count: 29, dim: true }])
 */
export function ruleBar(cells: number, parts: readonly BarPart[], rest: Omit<Run, 'text'> = { color: C.subtle }, gaps = false): Run[] {
  const n = Math.max(0, Math.floor(cells))
  const counts = parts.map(p => Math.max(0, Number.isFinite(p.count) ? p.count : 0))
  const total = counts.reduce((a, b) => a + b, 0)
  if (n === 0) return []
  if (total <= 0) return [{ text: '━'.repeat(n), ...rest }]
  const raw = counts.map(c => (c * n) / total)
  const got = raw.map(Math.floor)
  let left = n - got.reduce((a, b) => a + b, 0)
  // A part with a count but no cell takes one first, from the largest part, while that keeps a cell.
  counts.forEach((c, i) => {
    if (c > 0 && got[i] === 0) {
      if (left > 0) {
        got[i] = 1
        left--
        return
      }
      const big = got.indexOf(Math.max(...got))
      if (got[big]! > 1) {
        got[big]!--
        got[i] = 1
      }
    }
  })
  raw
    .map((v, i) => [v - Math.floor(v), i] as const)
    .sort((a, b) => b[0] - a[0])
    .forEach(([, i]) => {
      if (left > 0 && counts[i]! > 0) {
        got[i]!++
        left--
      }
    })
  const lastLit = got.reduce((at, g, i) => (g > 0 ? i : at), -1)
  const runs: Run[] = parts.flatMap((p, i): Run[] => {
    const g = got[i]!
    if (!gaps || i >= lastLit || g < 2) return [{ text: '━'.repeat(g), ...styleOf(p) }]
    return [{ text: '━'.repeat(g - 1), ...styleOf(p) }, { text: ' ' }]
  })
  if (left > 0) runs.push({ text: '━'.repeat(left), ...rest })
  return joinRuns(runs)
}

/** A share bar of `cells` `━`: the lit part (any non-zero lights one cell) in `color`, the rest in `subtle`. */
export function pctBar(cells: number, pct: number, color: string = C.live): Run[] {
  const n = Math.max(0, Math.floor(cells))
  const p = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0
  const lit = p > 0 ? Math.max(1, Math.round((n * p) / 100)) : 0
  return joinRuns([
    { text: '━'.repeat(Math.min(n, lit)), color },
    { text: '━'.repeat(Math.max(0, n - lit)), color: C.subtle },
  ])
}

/** Options of `todoBar`. */
export type TodoBarOpts = {
  /** The done part's style: the accent dimmed (iris soft) when absent; `success` when every task is done. */
  done?: Omit<Run, 'text'>
  /** The current part's style: the accent when absent; `warning` while it is paused on a dialog. */
  current?: Omit<Run, 'text'>
}

/**
 * The to-do bar of `cells` (the spec's `todoBar(total, done, current)`): one
 * `━` segment a task with a one-cell gap (`gen-cockpit.js` `todoBar`), done
 * segments dim in the accent, the current in the accent, the open ones in
 * `subtle`. When a segment would be under one cell (more tasks than half the
 * cells) a task is one cell, at floor(i * cells / total), as the mock's slim
 * bar. With more tasks than cells (R13) the bar is proportional instead: one
 * done run, one current run (at least a cell), the open rest, with no gaps. All done, the
 * done part is `success` (mint) unless `o.done` says otherwise. Exactly
 * `cells` wide; no tasks is the rest alone.
 *
 * @example todoBar(58, 14, 9, 1) // 14 segments of 3 or 4 cells, the 10th lit
 */
export function todoBar(cells: number, total: number, done: number, current: number, o: TodoBarOpts = {}): Run[] {
  const n = Math.max(0, Math.floor(cells))
  const t = Math.max(0, Math.floor(total))
  const d = Math.max(0, Math.min(t, Math.floor(done)))
  const c = Math.max(0, Math.min(t - d, Math.floor(current)))
  if (n === 0) return []
  if (t === 0) return [{ text: '━'.repeat(n), color: C.subtle }]
  const doneStyle = o.done ?? (d === t ? { color: C.result } : { color: C.live, dim: true })
  const curStyle = o.current ?? { color: C.live }
  const openStyle = { color: C.subtle }
  const at = (i: number) => Math.floor((i * (n + 1)) / t)
  const segments = Array.from({ length: t }, (_, i) => at(i + 1) - at(i) - 1)
  const styleAt = (i: number) => (i < d ? doneStyle : i < d + c ? curStyle : openStyle)
  if (Math.min(...segments) >= 1) {
    const runs: Run[] = []
    for (let i = 0; i < t; i++) {
      runs.push({ text: '━'.repeat(segments[i]!), ...styleAt(i) })
      if (i < t - 1) runs.push({ text: ' ' })
    }
    return joinRuns(runs)
  }
  if (t <= n) {
    // Between half the cells and all of them (the slim bar, gen-cockpit.js todoS): a task is the one cell at
    // floor(i * n / t); a cell no task lands on is a gap.
    const cells: Run[] = Array.from({ length: n }, () => ({ text: ' ' }))
    for (let i = 0; i < t; i++) cells[Math.floor((i * n) / t)] = { text: '━', ...styleAt(i) }
    return joinRuns(cells)
  }
  let nd = d > 0 ? Math.max(1, Math.round((n * d) / t)) : 0
  let nc = c > 0 ? Math.max(1, Math.round((n * c) / t)) : 0
  if (d < t && nd + nc >= n) nd = Math.max(d > 0 ? 1 : 0, n - nc - 1)
  if (nd + nc > n) nc = Math.max(0, n - nd)
  return joinRuns([
    { text: '━'.repeat(nd), ...doneStyle },
    { text: '━'.repeat(nc), ...curStyle },
    { text: '━'.repeat(Math.max(0, n - nd - nc)), ...openStyle },
  ])
}
