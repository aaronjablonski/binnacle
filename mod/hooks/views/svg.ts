// The desktop app's forms of the Now deck and the band (rich spec "Desktop"):
// one Svg each, drawn from the same model as the terminal's deck. The same
// pixel characters (raster.ts sprites, cell by cell), real rings, rounded
// pills, a glow and a proportional font; `<title>` tooltips and a pulsing
// lamp where the Svg is interactive. It takes no presses: everything
// pressable stays a Button outside it.
//
// Pure: strings from the Timeline, no claude-code import, so vitest loads it.

import type { AgentRow, Timeline, UiState } from '../../types'
import { cacheLine, pace, taskMeter, turnClock } from '../model/meter'
import { problems, summary } from '../model/select'
import type { Problem } from '../model/select'
import { buckets, elapsed, shortPaths, wordFit } from './fit'
import { DOT_BITS, PALETTE, rate, sprite, SPRITE } from './raster'
import type { Hue, Palette, Role, Size, State } from './raster'
import { spriteOf } from './style'
import type { PodState } from './style'

/** The longest `source` an Svg element takes (`SvgProps.source`). */
export const SVG_MAX = 131072

// ---------- the model ----------

/** A ring: its short name (`CTX`, `5H`), its figure, and the pace line under it when the window fills before it resets. */
export type RingFig = { name: string; pct: number; sub?: string }

/** One crew member as a character, with the words its tooltip says. */
export type CrewFig = { role: Role; state: State; title: string }

/** One column of the plan strip: a task's tokens, and whether it is the one in progress. */
export type PlanFig = { tokens: number; current: boolean; title: string }

/** What the deck and the band show, read once from the Timeline. */
export type DeckModel = {
  pill: { word: string; hue: Hue | 'mute' }
  right?: string
  lead: CrewFig
  focus: string
  isIdle: boolean
  step?: { label: string; age: string }
  rings: RingFig[]
  next?: string
  crew: CrewFig[]
  more: number
  live: number
  failed: number
  tasks: { done: number; total: number; plan: PlanFig[] }
  steps: { count: number; errors: number; trace: number[]; errorAt: number[] }
  cache?: { readPct: number; read: number; write: number; fresh: number; warm?: string }
}

const MAX_CREW = 6
const MAX_PLAN = 24
const MAX_TEXT = 300

/** One line of plain text, at most MAX_TEXT characters. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
}

/** A window's short name for its ring: `5H`, `7D`, else its first three letters. */
export function ringName(name: string): string {
  const n = name.toLowerCase()
  if (/five|5.?h/.test(n)) return '5H'
  if (/seven|7.?d|week/.test(n)) return '7D'
  const short = name.replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase()
  return short === '' ? 'WIN' : short
}

/** The pod state problems give an agent (`?` waiting, `z` stalled), else none. */
function problemState(agentId: string, found: Problem[]): PodState | undefined {
  if (found.some(p => p.agent === agentId && p.kind === 'asking')) return 'waiting'
  if (found.some(p => p.agent === agentId && p.kind === 'stalled')) return 'stalled'
  return undefined
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function crewFig(a: AgentRow, now: number, found: Problem[], size: Size, state?: PodState): CrewFig {
  const s = spriteOf(a, now, state ?? problemState(a.id, found), size)
  const used = (a.tokensIn ?? 0) + (a.tokensOut ?? 0)
  const who = a.id === 'main' ? 'the lead' : oneLine(a.description || a.type)
  const parts = [who, s.state]
  if (a.model !== undefined) parts.push(a.model)
  if (used > 0) parts.push(`${tokens(used)} tokens`)
  return { role: s.role, state: s.state, title: parts.join(', ') }
}

/** Crew order: live first, then failed, then done; newest start first within each. */
function crewRank(a: AgentRow): number {
  if (a.status === 'running') return 0
  if (a.status === 'error') return 1
  return 2
}

/**
 * The deck's model: what both Svgs draw and their alts say. The pill is
 * WAITING (amber) while something needs the person, WORKING (iris) while a
 * turn, agent or step runs, ALL DONE when every task is done, else IDLE.
 */
export function deckModel(t: Timeline, u: UiState, now: number): DeckModel {
  const s = summary(t)
  const found = problems(t, now, u.dismissed)
  const subs = Object.values(t.agents).filter(a => a.id !== 'main')
  const running = s.running.length > 0 || t.steps.some(x => x.status === 'running') || t.turns.some(x => x.endedAt === undefined)
  let pill: DeckModel['pill'] = { word: 'IDLE', hue: 'mute' }
  if (found.length > 0) pill = { word: 'WAITING', hue: 'amber' }
  else if (running) pill = { word: 'WORKING', hue: 'iris' }
  else if (s.total > 0 && s.done === s.total) pill = { word: 'ALL DONE', hue: 'mute' }

  // The lead's row stays running for the whole session: its character follows the pill instead.
  const main = t.agents.main
  const leadState: PodState = pill.word === 'WAITING' ? 'waiting' : pill.word === 'WORKING' ? 'working' : 'done'
  const lead: CrewFig =
    main !== undefined ? crewFig(main, now, found, 'L', leadState) : { role: 'lead', state: leadState, title: 'the lead' }

  const bySeq = [...t.steps].sort((a, b) => b.seq - a.seq)
  const runningStep = bySeq.find(x => x.status === 'running')
  let focus = s.focus !== undefined ? oneLine(s.focus) : ''
  const isIdle = focus === '' && bySeq.length === 0
  if (focus === '') focus = bySeq[0] !== undefined ? oneLine(shortPaths(bySeq[0].label)) : 'Idle. Nothing running yet.'

  const rings: RingFig[] = []
  if (t.budget?.contextPct !== undefined) rings.push({ name: 'CTX', pct: clampPct(t.budget.contextPct) })
  const paced = pace(t, now).windows
  for (const w of (t.budget?.windows ?? []).slice(0, 2)) {
    const ring: RingFig = { name: ringName(w.name), pct: clampPct(w.pct) }
    const p = paced.find(x => x.name === w.name)
    if (p?.beforeReset === true) ring.sub = `▲ ${elapsed(0, p.fullIn)}`
    rings.push(ring)
  }

  const ranked = [...subs].sort((a, b) => crewRank(a) - crewRank(b) || b.startedAt - a.startedAt)
  const crew = ranked.slice(0, MAX_CREW).map(a => crewFig(a, now, found, 'S'))

  const meter = taskMeter(t)
  const plan = meter.rows.slice(0, MAX_PLAN).map(r => ({
    tokens: r.tokens,
    current: r.task.status === 'in_progress',
    title: `${wordFit(oneLine(r.task.subject), 80)}: ${r.tokens > 0 ? `${tokens(r.tokens)} tokens` : r.task.status}`,
  }))

  const first = t.steps.reduce((m, x) => Math.min(m, x.startedAt), now)
  const trace = buckets(t.steps.map(x => x.startedAt), first, now, 22)
  const errs = buckets(t.steps.filter(x => x.status === 'error').map(x => x.startedAt), first, now, 22)
  const errorAt = errs.flatMap((n, i) => (n > 0 ? [i] : []))

  const model: DeckModel = {
    pill,
    lead,
    focus,
    isIdle,
    rings,
    crew,
    more: Math.max(0, ranked.length - crew.length),
    live: s.running.length,
    failed: subs.filter(a => a.status === 'error').length,
    tasks: { done: s.done, total: s.total, plan },
    steps: { count: s.steps, errors: s.errors, trace, errorAt },
  }
  const clockNow = turnClock(t, now)
  if (clockNow !== undefined) {
    const n = t.turns.filter(x => x.agent === 'main').length
    model.right = `turn ${n} · ${elapsed(0, clockNow.ms)}`
  }
  if (runningStep !== undefined) {
    model.step = { label: oneLine(shortPaths(runningStep.label)), age: elapsed(runningStep.startedAt, now) }
  }
  if (s.next !== undefined && s.next.trim() !== '') model.next = oneLine(s.next)
  const c = cacheLine(t)
  if (c.total > 0) {
    model.cache = { readPct: Math.round(c.readShare * 100), read: c.read, write: c.write, fresh: c.fresh }
    if (c.warmUntil !== undefined && c.warmUntil > now) {
      const left = Math.floor((c.warmUntil - now) / 1000)
      model.cache.warm = `warm for about ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
    }
  }
  return model
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

// ---------- drawing ----------

const P: Palette = PALETTE.night
const FONT = `font-family="system-ui,-apple-system,'Segoe UI',sans-serif"`
const LABEL = '#7c8698'
const DIM = '#8b93a6'

/** Text for a document: no control characters, the five XML characters escaped. */
export function esc(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`
const ink = (k: keyof Palette): string => hex(P[k])
const num = (v: number): string => String(Math.round(v * 10) / 10)

/** About how many characters of a proportional font at `size` fit in `px`. */
const charsIn = (px: number, size: number): number => Math.max(0, Math.floor(px / (size * 0.52)))

/** `s` cut to `px` at a word, with `…`; whole when it fits. */
function cutTo(s: string, px: number, size: number): string {
  const room = charsIn(px, size)
  if (s.length <= room) return s
  if (room <= 1) return ''
  const head = s.slice(0, room - 1)
  const space = head.lastIndexOf(' ')
  return `${(space > room / 2 ? head.slice(0, space) : head).trimEnd()}…`
}

/** `s` wrapped by word into at most `lines` lines of `px`; the last one cut. */
function wrapTo(s: string, px: number, size: number, lines: number): string[] {
  const room = charsIn(px, size)
  const out: string[] = []
  let rest = s
  while (rest !== '' && out.length < lines - 1) {
    if (rest.length <= room) break
    const head = rest.slice(0, room + 1)
    const space = head.lastIndexOf(' ')
    if (space <= 0) break
    out.push(rest.slice(0, space))
    rest = rest.slice(space + 1)
  }
  if (rest !== '') out.push(cutTo(rest, px, size))
  return out
}

type TextOpts = { size?: number; bold?: boolean; fill?: string; anchor?: 'end' | 'middle' }

function text(x: number, y: number, s: string, o: TextOpts = {}): string {
  const anchor = o.anchor !== undefined ? ` text-anchor="${o.anchor}"` : ''
  const weight = o.bold === true ? 600 : 400
  const fill = o.fill ?? ink('ink')
  return `<text x="${num(x)}" y="${num(y)}" font-size="${o.size ?? 12.5}" font-weight="${weight}" fill="${fill}"${anchor} ${FONT}>${esc(s)}</text>`
}

const label = (x: number, y: number, s: string): string =>
  `<text x="${num(x)}" y="${num(y)}" font-size="9.5" letter-spacing="1.4" fill="${LABEL}" ${FONT}>${esc(s)}</text>`

const DEFS =
  '<defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2" result="b"></feGaussianBlur>' +
  '<feMerge><feMergeNode in="b"></feMergeNode><feMergeNode in="SourceGraphic"></feMergeNode></feMerge></filter>' +
  '<linearGradient id="glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b1f29"></stop><stop offset="1" stop-color="#14171e"></stop></linearGradient></defs>' +
  '<style>.h:hover{opacity:0.75}</style>'

const PULSE = '<animate attributeName="opacity" values="1;0.45;1" dur="2s" repeatCount="indefinite"></animate>'

/**
 * A character, drawn from the same cells as its Raster: each quadrant
 * sub-pixel a rect `u` wide and `2u` tall, each Braille dot a circle, the
 * badge a disc with its letter. A lit lamp glows and pulses.
 */
function character(x: number, y: number, c: CrewFig, size: Size, u: number): string {
  const g = sprite(c.role, c.state, size)
  let o = `<g><title>${esc(c.title)}</title>`
  for (let row = 0; row < g.rows; row++) {
    for (let col = 0; col < g.columns; col++) {
      const cell = g.cell(col, row)
      cell.q.forEach((v, i) => {
        if (v === undefined) return
        const px = col * 2 + (i & 1)
        const py = row * 2 + (i >> 1)
        const at = `x="${num(x + px * u)}" y="${num(y + py * 2 * u)}"`
        if (v === P.lamp) {
          o += `<rect ${at} width="${num(u)}" height="${num(2 * u)}" fill="${hex(v)}" filter="url(#glow)">${PULSE}</rect>`
        } else {
          o += `<rect ${at} width="${num(u + 0.3)}" height="${num(2 * u + 0.3)}" fill="${hex(v)}"></rect>`
        }
      })
      if (cell.dots !== undefined && cell.fg !== undefined) {
        for (let dc = 0; dc < 2; dc++) {
          for (let dr = 0; dr < 4; dr++) {
            if ((cell.dots & DOT_BITS[dc]![dr]!) === 0) continue
            o += `<circle cx="${num(x + (col * 2 + dc + 0.5) * u)}" cy="${num(y + (row * 4 + dr + 0.5) * u)}" r="${num(u * 0.36)}" fill="${hex(cell.fg)}"></circle>`
          }
        }
      }
      if (cell.ch !== undefined && cell.ch !== ' ') {
        const cx = x + (col * 2 + 1) * u
        const cy = y + (row * 4 + 1.5) * u
        o += `<circle cx="${num(cx)}" cy="${num(cy)}" r="6.5" fill="${hex(cell.bg ?? P.mute)}"></circle>`
        o += `<text x="${num(cx)}" y="${num(cy + 3.5)}" text-anchor="middle" font-size="9.5" font-weight="700" fill="${hex(cell.fg ?? P.badge)}" ${FONT}>${esc(cell.ch)}</text>`
      }
    }
  }
  return `${o}</g>`
}

/** The width of a character of `size` drawn at `u`. */
const charWidth = (size: Size, u: number): number => SPRITE[size].columns * 2 * u

function ring(cx: number, cy: number, r: number, f: RingFig): string {
  const c = 2 * Math.PI * r
  const hue = ink(rate(f.pct))
  const name = f.sub !== undefined ? f.sub : f.name
  const nameFill = f.sub !== undefined ? ink('amber') : DIM
  return (
    `<g class="h"><title>${esc(f.name)}: ${f.pct}% used</title>` +
    `<circle cx="${num(cx)}" cy="${num(cy)}" r="${r}" fill="none" stroke="${ink('rest')}" stroke-width="5"></circle>` +
    `<circle cx="${num(cx)}" cy="${num(cy)}" r="${r}" fill="none" stroke="${hue}" stroke-width="5" stroke-linecap="round" ` +
    `stroke-dasharray="${num((c * f.pct) / 100)} ${num(c)}" transform="rotate(-90 ${num(cx)} ${num(cy)})" filter="url(#glow)"></circle>` +
    text(cx, cy + 4.5, `${f.pct}%`, { size: 12.5, bold: true, fill: f.pct >= 70 ? hue : ink('ink'), anchor: 'middle' }) +
    `<text x="${num(cx)}" y="${num(cy + r + 17)}" text-anchor="middle" font-size="9.5" letter-spacing="1.2" fill="${nameFill}" ${FONT}>${esc(name)}</text></g>`
  )
}

function pill(x: number, y: number, word: string, hue: Hue | 'mute'): string {
  const w = word.length * 7.4 + 18
  return (
    `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="20" rx="10" fill="${ink(hue)}"></rect>` +
    `<text x="${num(x + w / 2)}" y="${num(y + 14)}" text-anchor="middle" font-size="10.5" font-weight="700" letter-spacing="1" fill="${ink('badge')}" ${FONT}>${esc(word)}</text>`
  )
}

/** The clamps: a top-left and a bottom-right corner in the frame's hue with a glow, hairlines between. */
function clamps(w: number, h: number, hue: Hue | 'mute'): string {
  const c = ink(hue)
  return (
    `<path d="M 1.5 26 V 9 Q 1.5 1.5 9 1.5 H 46" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round" filter="url(#glow)"></path>` +
    `<path d="M ${num(w - 1.5)} ${num(h - 26)} V ${num(h - 9)} Q ${num(w - 1.5)} ${num(h - 1.5)} ${num(w - 9)} ${num(h - 1.5)} H ${num(w - 46)}" ` +
    `fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round" filter="url(#glow)"></path>` +
    `<path d="M 54 1.5 H ${num(w - 10)}" stroke="${ink('rest')}" stroke-width="1"></path>` +
    `<path d="M 10 ${num(h - 1.5)} H ${num(w - 54)}" stroke="${ink('rest')}" stroke-width="1"></path>`
  )
}

/** The plan strip: one rounded column a task, its height its tokens, the one in progress in ember; a queued task a rest tick. */
function plan(x: number, base: number, width: number, hmax: number, cols: PlanFig[]): string {
  if (cols.length === 0) return ''
  const max = Math.max(1, ...cols.map(c => c.tokens))
  const gap = cols.length > 12 ? 2 : 4
  const bw = Math.max(2, Math.min(11, (width - gap * (cols.length - 1)) / cols.length))
  return cols
    .map((c, i) => {
      const h = c.tokens > 0 ? Math.max(3, (c.tokens / max) * hmax) : 2
      const fill = c.tokens === 0 ? ink('rest') : c.current ? ink('ember') : ink('iris')
      return `<rect class="h" x="${num(x + i * (bw + gap))}" y="${num(base - h)}" width="${num(bw)}" height="${num(h)}" rx="1.5" fill="${fill}"><title>${esc(c.title)}</title></rect>`
    })
    .join('')
}

/** The step trace: a filled line over the buckets, errors as red dots. */
function trace(x: number, base: number, w: number, h: number, vals: number[], errorAt: number[]): string {
  if (vals.length < 2) return ''
  const max = Math.max(1, ...vals)
  const pts = vals.map((v, i) => [x + (i * w) / (vals.length - 1), base - (v / max) * h] as const)
  const line = pts.map((p, i) => `${i > 0 ? 'L' : 'M'}${num(p[0])} ${num(p[1])}`).join(' ')
  let o = `<path d="${line} L ${num(x + w)} ${num(base)} L ${num(x)} ${num(base)} Z" fill="${ink('iris')}" opacity="0.16"></path>`
  o += `<path d="${line}" fill="none" stroke="${ink('iris')}" stroke-width="1.6"></path>`
  for (const i of errorAt) {
    const p = pts[i]
    if (p === undefined) continue
    o += `<circle cx="${num(p[0])}" cy="${num(p[1])}" r="3" fill="${ink('red')}"><title>an error</title></circle>`
  }
  return o
}

/** The cache stack: read, written and fresh input as three rounded runs. */
function cacheStack(x: number, y: number, w: number, c: NonNullable<DeckModel['cache']>): string {
  const total = Math.max(1, c.read + c.write + c.fresh)
  let o = ''
  let at = x
  const parts: [number, keyof Palette, string][] = [
    [c.read, 'mint', 'read from the cache'],
    [c.write, 'orchid', 'written to the cache'],
    [c.fresh, 'mute', 'sent fresh'],
  ]
  for (const [n, hue, what] of parts) {
    if (n <= 0) continue
    const pw = Math.max(4, (n / total) * w - 2)
    o += `<rect class="h" x="${num(at)}" y="${num(y)}" width="${num(pw)}" height="8" rx="4" fill="${ink(hue)}"><title>${tokens(n)} tokens ${what}</title></rect>`
    at += pw + 2
  }
  return o
}

function badgePill(x: number, y: number, word: string, hue: keyof Palette): string {
  return (
    `<rect x="${num(x)}" y="${num(y)}" width="58" height="18" rx="9" fill="none" stroke="${ink(hue)}"></rect>` +
    text(x + 29, y + 13, word, { size: 10.5, fill: ink(hue), anchor: 'middle' })
  )
}

function open(w: number, h: number): string {
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${num(w)}" height="${num(h)}" viewBox="0 0 ${num(w)} ${num(h)}">`
  const glass = `<rect x="0.5" y="0.5" width="${num(w - 1)}" height="${num(h - 1)}" rx="10" fill="url(#glass)"></rect>`
  return head + DEFS + glass
}

/** A document past the limit (it should never be: every text is cut) is replaced by the pill and the focus alone. */
function bounded(source: string, w: number, m: DeckModel): string {
  if (source.length < SVG_MAX) return source
  return `${open(w, 60)}${pill(16, 14, m.pill.word, m.pill.hue)}${text(110, 28, cutTo(m.focus, w - 130, 14), { size: 14, bold: true })}</svg>`
}

/** The deck's width in px for a pane of `cols` columns. */
const deckWidth = (cols: number): number => Math.max(340, Math.min(640, Math.round(cols * 7.3)))

/**
 * Now's deck as one Svg (spec "Desktop"): the frame and pill, the lead's
 * character, the focus over two lines, the running step, three rings; then
 * NEXT, CREW (characters, live and failed), TASKS (the plan strip), STEPS
 * (the trace, errors) and CACHE, each only when it has something to show.
 */
export function nowDeckSvg(t: Timeline, u: UiState, now: number, cols: number): string {
  const m = deckModel(t, u, now)
  const W = deckWidth(cols)
  const L = 22
  const C = 84
  const V = W - 106
  const A = W - 60
  const hasRings = m.rings.length > 0
  // The hero's text ends 10 px before the leftmost ring (radius 19, 52 apart, the last at W - 36).
  const heroRight = hasRings ? W - 36 - 52 * (m.rings.length - 1) - 19 - 10 : W - 20
  const rows: string[] = []
  let y = 162
  if (m.next !== undefined) {
    rows.push(label(L, y, 'NEXT') + text(C, y, cutTo(m.next, W - C - 20, 12.5)))
    y += 42
  }
  if (m.crew.length > 0) {
    let o = label(L, y, 'CREW')
    const room = Math.max(1, Math.floor((V - 12 - C) / 42))
    const shown = m.crew.slice(0, room)
    shown.forEach((c, i) => {
      o += character(C + i * 42, y - 18, c, 'S', 3.5)
    })
    const more = m.more + m.crew.length - shown.length
    if (more > 0) o += text(C + shown.length * 42, y, `+${more}`, { fill: DIM })
    o += badgePill(V, y - 16, `${m.live} live`, 'iris')
    if (m.failed > 0) o += badgePill(V, y + 6, `${m.failed} failed`, 'red')
    rows.push(o)
    y += 48
  }
  if (m.tasks.total > 0) {
    rows.push(
      label(L, y, 'TASKS') +
        plan(C, y + 6, V - 20 - C, 26, m.tasks.plan) +
        text(V, y, `${m.tasks.done}/${m.tasks.total}`, { bold: true }),
    )
    y += 44
  }
  if (m.steps.count > 0) {
    let o = label(L, y, 'STEPS') + trace(C, y + 6, V - 20 - C, 24, m.steps.trace, m.steps.errorAt)
    o += text(V, y, String(m.steps.count), { bold: true })
    if (m.steps.errors > 0) o += text(A, y, `${m.steps.errors} error${m.steps.errors === 1 ? '' : 's'}`, { fill: ink('red') })
    rows.push(o)
    y += 42
  }
  if (m.cache !== undefined) {
    let o = label(L, y, 'CACHE') + cacheStack(C, y - 9, V - 20 - C, m.cache) + text(V, y, `${m.cache.readPct}% read`, { bold: true })
    if (m.cache.warm !== undefined) {
      o += text(C, y + 20, m.cache.warm, { size: 11, fill: ink('mint') })
      y += 20
    }
    rows.push(o)
    y += 42
  }
  const H = rows.length > 0 ? y - 14 : 150
  let s = open(W, H) + clamps(W, H, m.pill.hue)
  s += pill(C, 14, m.pill.word, m.pill.hue)
  if (m.right !== undefined) s += text(W - 16, 28, m.right, { size: 11, fill: DIM, anchor: 'end' })
  s += character(18, 54, m.lead, 'L', 3.7 * (60 / charWidth('L', 3.7)))
  const focus = wrapTo(m.focus, heroRight - C, 15, 2)
  focus.forEach((line, i) => {
    s += text(C, 68 + i * 20, line, { size: 15, bold: !m.isIdle, fill: m.isIdle ? DIM : ink('ink') })
  })
  if (m.step !== undefined) {
    const room = heroRight - C - 40
    const said = esc(cutTo(m.step.label, room, 12))
    s += `<text x="${C}" y="114" font-size="12" ${FONT}>`
    s += `<tspan fill="${ink('iris')}">▸</tspan><tspan fill="${ink('ink')}"> ${said}</tspan><tspan fill="${DIM}">   ${esc(m.step.age)}</tspan></text>`
  }
  m.rings.forEach((r, i) => {
    s += ring(W - 36 - 52 * (m.rings.length - 1 - i), 78, 19, r)
  })
  if (rows.length > 0) s += `<path d="M 16 136 H ${num(W - 16)}" stroke="${ink('rest')}" stroke-width="1" stroke-dasharray="1 5"></path>`
  s += rows.join('')
  s += '</svg>'
  return bounded(s, W, m)
}

/** The band's width in px for `cols` columns of the band. */
const bandWidth = (cols: number): number => Math.max(480, Math.min(1400, Math.round(cols * 8)))

/**
 * The band as one Svg (spec "Band" and "Desktop"): the lead's character,
 * the pill, the focus and its age; the small crew beside NEXT; the TASKS
 * strip; three rings at the right when there is room; `/mc`.
 */
export function bandSvg(t: Timeline, u: UiState, now: number, cols: number): string {
  const m = deckModel(t, u, now)
  const W = bandWidth(cols)
  const H = 92
  const hasRings = m.rings.length > 0 && W >= 720
  const end = hasRings ? W - 78 * m.rings.length - 40 : W - 60
  const age = t.now !== undefined ? elapsed(t.now.at, now) : ''
  let s = open(W, H) + clamps(W, H, m.pill.hue)
  s += character(16, 17, m.lead, 'L', 3.7 * (60 / charWidth('L', 3.7)))
  s += pill(82, 12, m.pill.word, m.pill.hue)
  const focusX = 82 + m.pill.word.length * 7.4 + 30
  s += text(focusX, 27, cutTo(m.focus, end - focusX - 50, 14.5), { size: 14.5, bold: !m.isIdle, fill: m.isIdle ? DIM : ink('ink') })
  if (age !== '') s += text(end - 10, 27, age, { size: 11.5, fill: DIM, anchor: 'end' })
  const crewEnd = 330
  const room = Math.max(0, Math.floor((crewEnd - 84) / 40))
  m.crew.slice(0, room).forEach((c, i) => {
    s += character(84 + i * 40, 50, c, 'S', 3.5)
  })
  if (m.next !== undefined) s += label(340, 58, 'NEXT') + text(384, 58, cutTo(m.next, end - 384, 12), { size: 12 })
  if (m.tasks.total > 0) {
    const stripW = Math.min(150, end - 384 - 60)
    s += label(340, 78, 'TASKS') + plan(384, 80, stripW, 18, m.tasks.plan)
    s += text(384 + stripW + 12, 78, `${m.tasks.done}/${m.tasks.total}`, { size: 12, bold: true })
  }
  if (hasRings) {
    m.rings.forEach((r, i) => {
      s += ring(W - 78 * (m.rings.length - i) - 18, 40, 20, r)
    })
  }
  s += text(W - 18, 84, '/mc', { size: 11, fill: DIM, anchor: 'end' })
  s += '</svg>'
  return bounded(s, W, m)
}

// ---------- the alts ----------

const MAX_ALT = 600

function ringsSaid(m: DeckModel): string {
  return m.rings.map(r => `${r.name} ${r.pct}%`).join(', ')
}

/** Now's deck in words, for a reader that cannot see the Svg. */
export function nowDeckAlt(t: Timeline, u: UiState, now: number): string {
  const m = deckModel(t, u, now)
  const parts = [`Now: ${m.pill.word}. ${m.focus}.`]
  if (m.step !== undefined) parts.push(`Running: ${m.step.label}, ${m.step.age}.`)
  if (m.rings.length > 0) parts.push(`${ringsSaid(m)}.`)
  if (m.next !== undefined) parts.push(`Next: ${m.next}.`)
  if (m.crew.length > 0) parts.push(`${m.live} agents live, ${m.failed} failed.`)
  if (m.tasks.total > 0) parts.push(`${m.tasks.done} of ${m.tasks.total} tasks done.`)
  if (m.steps.count > 0) parts.push(`${m.steps.count} steps, ${m.steps.errors} errors.`)
  if (m.cache !== undefined) parts.push(`Cache ${m.cache.readPct}% read.`)
  return parts.join(' ').slice(0, MAX_ALT)
}

/** The band in words. */
export function bandAlt(t: Timeline, u: UiState, now: number): string {
  const m = deckModel(t, u, now)
  const parts = [`${m.pill.word}: ${m.focus}.`]
  if (m.next !== undefined) parts.push(`Next: ${m.next}.`)
  if (m.tasks.total > 0) parts.push(`${m.tasks.done} of ${m.tasks.total} tasks done.`)
  if (m.rings.length > 0) parts.push(`${ringsSaid(m)}.`)
  return parts.join(' ').slice(0, MAX_ALT)
}
