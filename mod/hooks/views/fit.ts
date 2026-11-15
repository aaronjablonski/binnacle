// Pure text helpers for the views. No claude-code import, so vitest loads it.

import { C, dialOf, GLYPHS, rateColor } from './style'
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

/**
 * A left text and a dim right text for one row of `columns`; `stacked` when the right text gets a row of its own.
 * @deprecated HUD v1. v2 rows put the metric and time on grid columns: `row` in parts.tsx.
 */
export function splitRow(left: string, right: string, columns: number, minLeft = 8): { left: string; right: string; stacked: boolean } {
  if (right === '') return { left: fit(left, columns), right: '', stacked: false }
  const room = columns - right.length - 1
  if (room < minLeft) return { left: fit(left, columns), right: fit(right, columns), stacked: true }
  return { left: fit(left, room), right, stacked: false }
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

/**
 * `text` on one line (whitespace collapsed) cut to at most `cols` at a word
 * boundary, ending with `…` when cut. The one exception: when even the first
 * word does not fit, that word is cut (there is no boundary to cut at).
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
  if (out === '') return fit(t, cols)
  return `${out}…`
}

/**
 * An agent type as a metric cell: `general-purpose` is `general`; any other
 * type is its longest leading part, cut at a hyphen or a space, that fits
 * `room` (a metric cell is 10 wide). When even the first part is too wide it
 * is cut with `…`, as `fit` does.
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
  return best !== '' ? best : fit(type, room)
}

/** One wrapped line's words as text; a lone word wider than the line is cut. */
const joinLine = (words: string[], cols: number): string => (words.length === 1 ? fit(words[0] ?? '', cols) : words.join(' '))

/**
 * `text` wrapped by word into at most `maxLines` lines of at most `cols`.
 * When it needs more, the last line holds what is left cut by `wordFit`, so
 * it ends with `…`. A word wider than a line is cut with `…`.
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
 * Runs (styled pieces of one line) cut to `cols` by `wordFit` over their
 * joined text: the same runs when they fit; otherwise the runs up to the cut,
 * the last one shortened, then a plain `{ text: '…' }` run. Empty runs are dropped.
 */
export function fitRuns<T extends { text: string }>(runs: T[], cols: number): (T | { text: string })[] {
  const joined = runs.map(r => r.text).join('')
  const cut = wordFit(joined, cols)
  if (cut === joined) return runs
  if (cut === '') return []
  const keep = cut.endsWith('…') ? cut.length - 1 : cut.length
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
