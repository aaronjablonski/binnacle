// The desktop app's forms of the Now deck and the band (cockpit spec, R32):
// one Svg each, drawn from the same model as the terminal's deck and band. The
// cockpit palette (raster.ts `PALETTE.night`: one iris accent, amber only for
// a dialog, red for a stop), Critters at small size from the same cell data as
// the Rasters (raster.ts `critterBox`), gauge rings that go ink at 70 % and
// red at 90 % (R9), sentence-case labels, and no animation, glow or gradient.
// `<title>` tooltips where the Svg is interactive. It takes no presses:
// everything pressable stays a Button outside it.
//
// Pure: strings from the Timeline, no claude-code import, so vitest loads it.

import type { AgentRow, Timeline, UiState } from '../../types'
import { cacheLine, pace, taskMeter, turnClock } from '../model/meter'
import { headerState, needs, watch } from '../model/alerts'
import { summary } from '../model/select'
import { agentsWords, bandModel, bandWords, needsPiece } from './bandmodel'
import type { BandModel } from './bandmodel'
import { buckets, elapsed, shortPaths, wordFit } from './fit'
import { critterBox, DOT_BITS, gaugeHue, PALETTE } from './raster'
import type { Hue, Palette } from './raster'
import { crewRole, podStateOf } from './style'
import type { PodState, Role } from './style'

/** The longest `source` an Svg element takes (`SvgProps.source`). */
export const SVG_MAX = 131072

// ---------- the model ----------

/** A ring: its short name (`CTX`, `5H`), its figure, and the pace line under it when the window fills before it resets. */
export type RingFig = { name: string; pct: number; sub?: string }

/** One crew member as a character, with the words its tooltip says. */
export type CrewFig = { role: Role; state: PodState; title: string }

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

/** Who is asking and who is stalled or quiet, from the alert model. */
type Flags = { asking: Set<string>; stalled: Set<string> }

/** The pod state the alert model gives an agent (`?` waiting on a dialog, `z` stalled or quiet), else none. */
function problemState(agentId: string, found: Flags): PodState | undefined {
  if (found.asking.has(agentId)) return 'waiting'
  if (found.stalled.has(agentId)) return 'stalled'
  return undefined
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function crewFig(a: AgentRow, found: Flags, state?: PodState): CrewFig {
  const role = crewRole(a.id, a.type)
  const flagged = problemState(a.id, found)
  const st = state ?? podStateOf({ id: a.id, type: a.type, status: a.status, ...(flagged !== undefined ? { state: flagged } : {}) })
  const used = (a.tokensIn ?? 0) + (a.tokensOut ?? 0)
  const who = a.id === 'main' ? 'the lead' : oneLine(a.description || a.type)
  const parts = [who, st]
  if (a.model !== undefined) parts.push(a.model)
  if (used > 0) parts.push(`${tokens(used)} tokens`)
  return { role, state: st, title: parts.join(', ') }
}

/** Crew order: live first, then failed, then done; newest start first within each. */
function crewRank(a: AgentRow): number {
  if (a.status === 'running') return 0
  if (a.status === 'error') return 1
  return 2
}

/**
 * The deck's model: what both Svgs draw and their alts say. The pill is
 * WAITING (amber) while a dialog needs the person (the alert model's `needs`
 * with no `isPromptCovered`, so R2's 20 s delay in auto mode stands, as
 * `problems()`'s default has it), WORKING (iris) while a turn, agent or step
 * runs, STOPPED (red) after a failed turn (R8), ALL DONE when every task is
 * done, else IDLE. Watch rows colour nothing (R9).
 */
export function deckModel(t: Timeline, u: UiState, now: number): DeckModel {
  const s = summary(t)
  const view = needs(t, now)
  const hs = headerState(t, now, view)
  const flags: Flags = {
    asking: new Set(view.items.map(n => n.agent)),
    stalled: new Set(watch(t, now, u.dismissed).filter(w => w.kind === 'stalled' || w.kind === 'quiet').map(w => w.agent)),
  }
  const subs = Object.values(t.agents).filter(a => a.id !== 'main')
  const running = s.running.length > 0 || t.steps.some(x => x.status === 'running') || t.turns.some(x => x.endedAt === undefined)
  let pill: DeckModel['pill'] = { word: 'IDLE', hue: 'mute' }
  if (view.items.length > 0) pill = { word: 'WAITING', hue: 'amber' }
  else if (hs.state === 'stopped') pill = { word: 'STOPPED', hue: 'red' }
  else if (running) pill = { word: 'WORKING', hue: 'iris' }
  else if (hs.state === 'all-done') pill = { word: 'ALL DONE', hue: 'mint' }

  // The lead's row stays running for the whole session: its critter follows the pill instead.
  const main = t.agents.main
  const leadAsks = flags.asking.has('main')
  const leadState: PodState = pill.word === 'WAITING' ? (leadAsks ? 'waiting' : 'working') : pill.word === 'WORKING' ? 'working' : pill.word === 'STOPPED' ? 'failed' : 'done'
  const lead: CrewFig =
    main !== undefined ? crewFig(main, flags, leadState) : { role: 'lead', state: leadState, title: 'the lead' }

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
  const crew = ranked.slice(0, MAX_CREW).map(a => crewFig(a, flags))

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
      model.cache.warm = `stays warm ${Math.max(1, Math.floor(left / 60))} min`
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
const DIM = ink('dim')
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

/** A section's name: dim, sentence case, no capitals or tracking (the cockpit has no caps). */
const label = (x: number, y: number, s: string): string =>
  `<text x="${num(x)}" y="${num(y)}" font-size="11" fill="${DIM}" ${FONT}>${esc(s)}</text>`

/** The one style: a hover dims a tooltip target a little. Nothing animates. */
const DEFS = '<style>.h:hover{opacity:0.8}</style>'

/**
 * A critter, drawn from the same cells as its Raster (`critterBox`, small:
 * the body and the badge column): each quadrant sub-pixel a rect `u` wide and
 * `2u` tall, the badge a disc with its letter. No glow and no animation: a
 * lit lamp is a white rect like any other.
 */
function character(x: number, y: number, c: CrewFig, u: number): string {
  const g = critterBox(c.role, c.state, 'small')
  const r = num(Math.max(5, u * 1.3))
  let o = `<g><title>${esc(c.title)}</title>`
  for (let row = 0; row < g.rows; row++) {
    for (let col = 0; col < g.columns; col++) {
      const cell = g.cell(col, row)
      cell.q.forEach((v, i) => {
        if (v === undefined) return
        const px = col * 2 + (i & 1)
        const py = row * 2 + (i >> 1)
        o += `<rect x="${num(x + px * u)}" y="${num(y + py * 2 * u)}" width="${num(u + 0.3)}" height="${num(2 * u + 0.3)}" fill="${hex(v)}"></rect>`
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
        o += `<circle cx="${num(cx)}" cy="${num(cy)}" r="${r}" fill="${hex(cell.bg ?? P.mute)}"></circle>`
        o += `<text x="${num(cx)}" y="${num(cy + 3.5)}" text-anchor="middle" font-size="9.5" font-weight="700" fill="${hex(cell.fg ?? P.badge)}" ${FONT}>${esc(cell.ch)}</text>`
      }
    }
  }
  return `${o}</g>`
}

/** What a ring's name reads under it: the cockpit's words (the model keeps `CTX`, `5H`, `7D` for titles and the alt). */
const RING_WORDS: Record<string, string> = { CTX: 'context', '5H': '5 hours', '7D': 'this week' }

function ring(cx: number, cy: number, r: number, f: RingFig): string {
  const c = 2 * Math.PI * r
  // R9: iris below 70 %, ink from 70, red from 90; amber is the dialog colour only.
  const hue = ink(gaugeHue(f.pct))
  const name = f.sub !== undefined ? f.sub : (RING_WORDS[f.name] ?? f.name.toLowerCase())
  const nameFill = f.sub !== undefined ? ink('ink') : DIM
  return (
    `<g class="h"><title>${esc(f.name)}: ${f.pct}% used</title>` +
    `<circle cx="${num(cx)}" cy="${num(cy)}" r="${r}" fill="none" stroke="${ink('rest')}" stroke-width="5"></circle>` +
    `<circle cx="${num(cx)}" cy="${num(cy)}" r="${r}" fill="none" stroke="${hue}" stroke-width="5" stroke-linecap="round" ` +
    `stroke-dasharray="${num((c * f.pct) / 100)} ${num(c)}" transform="rotate(-90 ${num(cx)} ${num(cy)})"></circle>` +
    text(cx, cy + 4.5, `${f.pct}%`, { size: 12.5, bold: true, fill: f.pct >= 90 ? hue : ink('ink'), anchor: 'middle' }) +
    `<text x="${num(cx)}" y="${num(cy + r + 17)}" text-anchor="middle" font-size="10" fill="${nameFill}" ${FONT}>${esc(name)}</text></g>`
  )
}

function pill(x: number, y: number, word: string, hue: Hue | 'mute'): string {
  const w = word.length * 7.4 + 18
  return (
    `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="20" rx="10" fill="${ink(hue)}"></rect>` +
    `<text x="${num(x + w / 2)}" y="${num(y + 14)}" text-anchor="middle" font-size="10.5" font-weight="700" fill="${ink('badge')}" ${FONT}>${esc(word)}</text>`
  )
}

/** The frame's two accents, as the lintel and the sill have them: a short heavy rule at the top left and the bottom right in the tone (iris works, amber asks, mint is done, red stopped), a hairline between. No glow. */
function accents(w: number, h: number, hue: Hue | 'mute'): string {
  const c = ink(hue)
  return (
    `<path d="M 14 1.5 H 54" stroke="${c}" stroke-width="3" stroke-linecap="round"></path>` +
    `<path d="M ${num(w - 54)} ${num(h - 1.5)} H ${num(w - 14)}" stroke="${c}" stroke-width="3" stroke-linecap="round"></path>`
  )
}

/** The plan strip: one rounded column a task, its height its tokens, the one in progress in the accent, a done one in soft iris; a queued task a rest tick. */
function plan(x: number, base: number, width: number, hmax: number, cols: PlanFig[]): string {
  if (cols.length === 0) return ''
  const max = Math.max(1, ...cols.map(c => c.tokens))
  const gap = cols.length > 12 ? 2 : 4
  const bw = Math.max(2, Math.min(11, (width - gap * (cols.length - 1)) / cols.length))
  return cols
    .map((c, i) => {
      const h = c.tokens > 0 ? Math.max(3, (c.tokens / max) * hmax) : 2
      const fill = c.current ? ink('iris') : c.tokens === 0 ? ink('rest') : ink('irisSoft')
      return `<rect class="h" x="${num(x + i * (bw + gap))}" y="${num(base - h)}" width="${num(bw)}" height="${num(h)}" rx="1.5" fill="${fill}"><title>${esc(c.title)}</title></rect>`
    })
    .join('')
}

function badgePill(x: number, y: number, word: string, hue: keyof Palette): string {
  return (
    `<rect x="${num(x)}" y="${num(y)}" width="58" height="18" rx="9" fill="none" stroke="${ink(hue)}"></rect>` +
    text(x + 29, y + 13, word, { size: 10.5, fill: ink(hue), anchor: 'middle' })
  )
}

function open(w: number, h: number): string {
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${num(w)}" height="${num(h)}" viewBox="0 0 ${num(w)} ${num(h)}">`
  const glass = `<rect x="0.5" y="0.5" width="${num(w - 1)}" height="${num(h - 1)}" rx="8" fill="${ink('ground')}" stroke="${ink('rule')}"></rect>`
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
 * Now's deck as one Svg (R32): the frame and pill, the lead's critter, the
 * focus over two lines, the running step, up to three gauge rings; then
 * Agents (critters, and a count of the failed) and To do (the plan strip),
 * each only when it has something to show. No Next, no "n live", no Steps
 * trace with its error count and no Cache row (the cockpit removed them, R26).
 */
export function nowDeckSvg(t: Timeline, u: UiState, now: number, cols: number): string {
  const m = deckModel(t, u, now)
  const W = deckWidth(cols)
  const L = 22
  const C = 84
  const V = W - 106
  const hasRings = m.rings.length > 0
  // The hero's text ends 10 px before the leftmost ring (radius 19, 52 apart, the last at W - 36).
  const heroRight = hasRings ? W - 36 - 52 * (m.rings.length - 1) - 19 - 10 : W - 20
  const rows: string[] = []
  let y = 162
  if (m.crew.length > 0) {
    let o = label(L, y, 'Agents')
    const room = Math.max(1, Math.floor((V - 12 - C) / 42))
    const shown = m.crew.slice(0, room)
    shown.forEach((c, i) => {
      o += character(C + i * 42, y - 18, c, 3.2)
    })
    const more = m.more + m.crew.length - shown.length
    if (more > 0) o += text(C + shown.length * 42, y, `+${more}`, { fill: DIM })
    if (m.failed > 0) o += badgePill(V, y - 8, `${m.failed} failed`, 'red')
    rows.push(o)
    y += 48
  }
  if (m.tasks.total > 0) {
    rows.push(
      label(L, y, 'To do') +
        plan(C, y + 6, V - 20 - C, 26, m.tasks.plan) +
        text(V, y, `${m.tasks.done}/${m.tasks.total}`, { bold: true }),
    )
    y += 44
  }
  const H = rows.length > 0 ? y - 14 : 150
  let s = open(W, H) + accents(W, H, m.pill.hue)
  s += pill(C, 14, m.pill.word, m.pill.hue)
  if (m.right !== undefined) s += text(W - 16, 28, m.right, { size: 11, fill: DIM, anchor: 'end' })
  s += character(16, 46, m.lead, 4.6)
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

/** One piece of a line of mixed styles. */
type Piece = { t: string; fill?: string; bold?: boolean }

/** Pieces as the tspans of one `<text>`; `size` is the line's. */
function tspans(x: number, y: number, pieces: Piece[], o: { size?: number; anchor?: 'end' } = {}): string {
  const anchor = o.anchor !== undefined ? ` text-anchor="${o.anchor}"` : ''
  const inner = pieces
    .filter(p => p.t !== '')
    .map(p => `<tspan fill="${p.fill ?? ink('ink')}" font-weight="${p.bold === true ? 600 : 400}" xml:space="preserve">${esc(p.t)}</tspan>`)
    .join('')
  return `<text x="${num(x)}" y="${num(y)}" font-size="${o.size ?? 12.5}"${anchor} ${FONT}>${inner}</text>`
}

/** The to-do bar: one rounded segment a task with a gap, done in soft iris, the current in the accent, the open ones at rest (the terminal's `todoBar`). */
function todoSegments(x: number, y: number, width: number, total: number, done: number, current: number): string {
  if (total <= 0) return ''
  const gap = total > 30 ? 1 : 3
  const w = Math.max(1.5, (width - gap * (total - 1)) / total)
  let o = ''
  for (let i = 0; i < total; i++) {
    const fill = i < done ? ink(done === total ? 'mint' : 'irisSoft') : i < done + current ? ink('iris') : ink('rest')
    o += `<rect x="${num(x + i * (w + gap))}" y="${num(y)}" width="${num(w)}" height="4" rx="2" fill="${fill}"></rect>`
  }
  return `<g><title>${done} of ${total} done</title>${o}</g>`
}

/** A gauge's figure in a line: ink, bold from 70 %, red from 90 % (R9). */
const figurePiece = (pct: number): Piece => ({ t: `${pct}%`, bold: pct >= 70, fill: pct >= 90 ? ink('red') : ink('ink') })

/**
 * The band as one Svg (spec "CockpitBand", R25, R32): the one critter (the
 * lead, or the asker while an ask is up) at small size, row 1 what is
 * happening (the goal; amber "Needs you" and the ask while a dialog is up;
 * red when stopped) with the gauges or "answer below" at the right, row 2 the
 * to-do bar and its words. At idle one dim line. `/mc` is the Button beside
 * the Svg, not drawn in it. \`model\` is the band's own when it has read one.
 */
export function bandSvg(t: Timeline, u: UiState, now: number, cols: number, model?: BandModel): string {
  const m = model ?? bandModel(t, u, now)
  const W = bandWidth(cols)
  const dm = deckModel(t, u, now)
  const right = W - 16
  if (m.form === 'idle' && m.rest !== undefined) {
    const H = 34
    const head: Piece[] = [...(m.rest.tick ? [{ t: '✓ ', fill: ink('mint') }] : []), { t: m.rest.head, fill: DIM }]
    const facts = m.rest.facts.map(f => ({ t: `   ·   ${f}`, fill: DIM }))
    const pieces = [...head, ...facts]
    const total = pieces.map(p => p.t).join('')
    const fit = total.length <= charsIn(W - 32, 12.5) ? pieces : head
    return bounded(`${open(W, H)}${accents(W, H, 'mute')}${tspans(16, 21, fit)}</svg>`, W, dm)
  }
  const H = 58
  const hue: Hue | 'mute' = m.form === 'asked' ? 'amber' : m.form === 'stopped' ? 'red' : 'iris'
  const lead: CrewFig = { role: m.critter.role, state: m.critter.state, title: m.form === 'asked' ? `${m.ask?.who ?? 'An agent'} is waiting for you` : 'the lead' }
  let s = open(W, H) + accents(W, H, hue)
  s += character(12, 8, lead, 3.6)
  const X = 74
  // Row 1.
  if (m.form === 'asked' && m.ask !== undefined) {
    const a = m.ask
    const answer = 'answer below ↓'
    const room = W - X - 16 - 120
    const said = cutTo(a.command !== '' ? `${a.sentence}  ${a.tool}  ${a.command}` : `${a.sentence}  ${a.tool}`, room, 12.5)
    const lead1 = `${a.sentence}  `
    const pieces: Piece[] = [{ t: 'Needs you', fill: ink('amber'), bold: true }, { t: '   ' }]
    if (said.length <= lead1.length) pieces.push({ t: said })
    else pieces.push({ t: lead1 }, { t: said.slice(lead1.length), bold: true })
    s += tspans(X, 24, pieces)
    s += tspans(right, 24, [{ t: answer, fill: ink('amber') }], { anchor: 'end' })
  } else {
    const stopped = m.form === 'stopped'
    const head: Piece = stopped ? { t: 'Stopped', fill: ink('red'), bold: true } : { t: m.kicker, fill: DIM }
    const gauges: Piece[] = []
    if (m.context !== undefined) gauges.push({ t: 'context ', fill: DIM }, figurePiece(m.context))
    if (m.week !== undefined) gauges.push({ t: `${gauges.length > 0 ? '    ' : ''}week `, fill: DIM }, figurePiece(m.week))
    const gaugeW = gauges.reduce((n, p) => n + p.t.length, 0) * 12.5 * 0.52
    const room = W - X - 16 - (gauges.length > 0 ? gaugeW + 24 : 0) - (head.t.length + 3) * 12.5 * 0.52
    const goal = cutTo(m.focus, room, 14)
    s += tspans(X, 24, [head, { t: '   ' }, { t: goal, bold: !stopped, fill: stopped ? ink('red') : ink('ink') }], { size: 14 })
    if (W >= 600 && gauges.length > 0) s += tspans(right, 24, gauges, { anchor: 'end' })
  }
  // Row 2.
  const bar = Math.min(200, Math.max(80, W * 0.2))
  const hasBar = m.total > 0
  if (hasBar) s += todoSegments(X, 38, bar, m.total, m.done, m.current)
  const wx = hasBar ? X + bar + 14 : X
  const sep = { t: '   ·   ', fill: DIM }
  const words: Piece[] = []
  if (hasBar) words.push({ t: String(m.done), bold: true }, { t: ` of ${m.total} done`, fill: DIM })
  if (m.form === 'asked') {
    if (words.length > 0) words.push(sep)
    if (m.working > 0) words.push({ t: `${m.working} ${m.working === 1 ? 'agent' : 'agents'} working, `, fill: DIM })
    words.push({ t: `${m.waiting} waiting`, fill: ink('amber') })
  } else if (m.form === 'working') {
    if (m.working > 0) words.push(...(words.length > 0 ? [sep] : []), { t: agentsWords(m), fill: DIM })
    words.push(...(words.length > 0 ? [sep] : []), { t: needsPiece(m), fill: DIM })
  }
  s += tspans(wx, 43, words, { size: 12.5 })
  return bounded(`${s}</svg>`, W, dm)
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
  if (m.crew.length > 0) parts.push(`${m.live} agents working, ${m.failed} failed.`)
  if (m.tasks.total > 0) parts.push(`${m.tasks.done} of ${m.tasks.total} tasks done.`)
  return parts.join(' ').slice(0, MAX_ALT)
}

/** The band in words. */
export function bandAlt(t: Timeline, u: UiState, now: number, model?: BandModel): string {
  return bandWords(model ?? bandModel(t, u, now)).slice(0, MAX_ALT)
}
