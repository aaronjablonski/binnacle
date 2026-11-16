// The desktop app's forms of the Now deck and the band (cockpit spec, R32):
// one Svg each, drawn from the same model as the terminal's deck and band. The
// Now deck's header says what the pane's header says (`headWords`: the pill,
// its meta, the kicker, the goal, the budget line and two gauges). The
// cockpit palette of the ground the pane draws on (raster.ts `PALETTE`: night,
// or day on a light theme; one accent, amber only for a dialog, red for a
// stop), Critters at small size from the same cell data as
// the Rasters (raster.ts `critterBox`), gauge rings that go ink at 70 % and
// red at 90 % (R9), sentence-case labels, and no animation, glow or gradient.
// `<title>` tooltips where the Svg is interactive. It takes no presses:
// everything pressable stays a Button outside it.
//
// Pure: strings from the Timeline and a `DeckHead`, no claude-code import (and
// none of the views that have one), so vitest loads it. The header's words
// come from the pane's own functions in `svgview.tsx` (`deckHead`), handed in.

import type { AgentRow, Timeline, UiState } from '../../types'
import { taskMeter } from '../model/meter'
import { needs, watch } from '../model/alerts'
import { summary } from '../model/select'
import { agentsWords, bandModel, bandWords, needsPiece } from './bandmodel'
import type { BandModel } from './bandmodel'
import { wordFit } from './fit'
import { critterBox, DOT_BITS, gaugeHue, PALETTE } from './raster'
import type { Ground, Hue, Palette } from './raster'
import { CK, crewRole, palette, podStateOf } from './style'
import type { PodState, Role, Run } from './style'

/** The longest `source` an Svg element takes (`SvgProps.source`). */
export const SVG_MAX = 131072

// ---------- the model ----------

/** A gauge ring: its word (`context`, `5 hours`, `this week`) and its figure. */
export type RingFig = { name: string; pct: number }

/** One crew member as a character, with the words its tooltip says. */
export type CrewFig = { role: Role; state: PodState; title: string }

/** One column of the plan strip: a task's tokens, and whether it is the one in progress. */
export type PlanFig = { tokens: number; current: boolean; title: string }

/**
 * The header's words, as the pane's header has them: `headWords`' pill, tone,
 * meta, kicker and lead state, `headline`'s goal, `budgetWords`' line and
 * `nowGauges`. Built by `deckHead` (svgview.tsx) and handed in, so this
 * module stays free of the views that import the engine.
 */
export type DeckHead = {
  pill: string
  /** The pill's tone: iris, amber, mint or red; `mute` for the grey IDLE pill. */
  tone: Hue | 'mute'
  meta: Run[]
  kicker: string
  lead: PodState
  goal: { text: string; isIdle: boolean }
  budget: Run[]
  gauges: { pct: number; label: string }[]
}

/** What the deck shows, read once from the Timeline. */
export type DeckModel = {
  pill: { word: string; hue: Hue | 'mute' }
  /** The header's meta runs (R7, R8): the time this turn, the quiet time, the wait, the stop reason. */
  meta: Run[]
  kicker: string
  lead: CrewFig
  /** The request's goal (R14), the same words as the terminal header's. */
  focus: string
  isIdle: boolean
  /** The budget line (R29, R40) the header draws under the goal. */
  budget: Run[]
  rings: RingFig[]
  crew: CrewFig[]
  more: number
  live: number
  failed: number
  tasks: { done: number; total: number; plan: PlanFig[] }
}

const MAX_CREW = 6
const MAX_PLAN = 24
const MAX_TEXT = 300

/** One line of plain text, at most MAX_TEXT characters. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
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
 * The deck's model: what Now's Svg draws and its alt says. The header's words
 * are `head`'s (the terminal header's: WAITING FOR YOU while a dialog needs
 * the person, WORKING with the turn's time and the quiet time, STOPPED with
 * its reason, ALL DONE, IDLE); the crew and the plan strip are read here.
 * Watch rows colour nothing (R9). `covered` is the pane's `isPromptCovered`:
 * with it an auto-mode ask is a need at once (C-1), as the terminal reads it.
 */
export function deckModel(t: Timeline, u: UiState, now: number, head: DeckHead, covered = false): DeckModel {
  const s = summary(t)
  const view = needs(t, now, { covered })
  const flags: Flags = {
    asking: new Set(view.items.map(n => n.agent)),
    stalled: new Set(watch(t, now, u.dismissed).filter(w => w.kind === 'stalled' || w.kind === 'quiet').map(w => w.agent)),
  }
  const subs = Object.values(t.agents).filter(a => a.id !== 'main')

  // The lead's row stays running for the whole session: its critter follows the header.
  const main = t.agents.main
  const lead: CrewFig = main !== undefined ? crewFig(main, flags, head.lead) : { role: 'lead', state: head.lead, title: 'the lead' }

  const ranked = [...subs].sort((x, y) => crewRank(x) - crewRank(y) || y.startedAt - x.startedAt)
  const crew = ranked.slice(0, MAX_CREW).map(x => crewFig(x, flags))

  const meter = taskMeter(t)
  const plan = meter.rows.slice(0, MAX_PLAN).map(r => ({
    tokens: r.tokens,
    current: r.task.status === 'in_progress',
    title: `${wordFit(oneLine(r.task.subject), 80)}: ${r.tokens > 0 ? `${tokens(r.tokens)} tokens` : r.task.status}`,
  }))

  return {
    pill: { word: head.pill, hue: head.tone },
    meta: head.meta,
    kicker: head.kicker,
    lead,
    focus: oneLine(head.goal.text),
    isIdle: head.goal.isIdle,
    budget: head.budget,
    rings: head.gauges.map(g => ({ name: g.label, pct: clampPct(g.pct) })),
    crew,
    more: Math.max(0, ranked.length - crew.length),
    live: s.running.length,
    failed: subs.filter(x => x.status === 'error').length,
    tasks: { done: s.done, total: s.total, plan },
  }
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

// ---------- drawing ----------

/**
 * The ground this document draws on, set by `nowDeckSvg` and `bandSvg` at the
 * top of a draw (a document is built in one synchronous call, so nothing
 * interleaves). The palette of that ground under the Accent option: the
 * structural accent follows it (FX4); state and role colours do not.
 */
let ground: Ground = 'night'
const P = (): Palette => palette(ground)
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
const ink = (k: keyof Palette): string => hex(P()[k])
const DIM = (): string => ink('dim')
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
  `<text x="${num(x)}" y="${num(y)}" font-size="11" fill="${DIM()}" ${FONT}>${esc(s)}</text>`

/** The one style: a hover dims a tooltip target a little. Nothing animates. */
const DEFS = '<style>.h:hover{opacity:0.8}</style>'

/**
 * A critter, drawn from the same cells as its Raster (`critterBox`, small:
 * the body and the badge column): each quadrant sub-pixel a rect `u` wide and
 * `2u` tall, the badge a disc with its letter. No glow and no animation: a
 * lit lamp is a white rect like any other.
 */
function character(x: number, y: number, c: CrewFig, u: number): string {
  const g = critterBox(c.role, c.state, 'small', { ground })
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
        o += `<circle cx="${num(cx)}" cy="${num(cy)}" r="${r}" fill="${hex(cell.bg ?? PALETTE[ground].mute)}"></circle>`
        o += `<text x="${num(cx)}" y="${num(cy + 3.5)}" text-anchor="middle" font-size="9.5" font-weight="700" fill="${hex(cell.fg ?? PALETTE[ground].badge)}" ${FONT}>${esc(cell.ch)}</text>`
      }
    }
  }
  return `${o}</g>`
}

function ring(cx: number, cy: number, r: number, f: RingFig): string {
  const c = 2 * Math.PI * r
  // R9: iris below 70 %, ink from 70, red from 90; amber is the dialog colour only.
  const hue = ink(gaugeHue(f.pct))
  return (
    `<g class="h"><title>${esc(f.name)}: ${f.pct}% used</title>` +
    `<circle cx="${num(cx)}" cy="${num(cy)}" r="${r}" fill="none" stroke="${ink('rest')}" stroke-width="5"></circle>` +
    `<circle cx="${num(cx)}" cy="${num(cy)}" r="${r}" fill="none" stroke="${hue}" stroke-width="5" stroke-linecap="round" ` +
    `stroke-dasharray="${num((c * f.pct) / 100)} ${num(c)}" transform="rotate(-90 ${num(cx)} ${num(cy)})"></circle>` +
    text(cx, cy + 4.5, `${f.pct}%`, { size: 12.5, bold: true, fill: f.pct >= 90 ? hue : ink('ink'), anchor: 'middle' }) +
    `<text x="${num(cx)}" y="${num(cy + r + 17)}" text-anchor="middle" font-size="10" fill="${DIM()}" ${FONT}>${esc(f.name)}</text></g>`
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
function bounded(source: string, w: number, fallback: () => { pill: DeckModel['pill']; focus: string }): string {
  if (source.length < SVG_MAX) return source
  const m = fallback()
  return `${open(w, 60)}${pill(16, 14, m.pill.word, m.pill.hue)}${text(110, 28, cutTo(m.focus, w - 130, 14), { size: 14, bold: true })}</svg>`
}

/** The deck's width in px for a pane of `cols` columns. */
const deckWidth = (cols: number): number => Math.max(340, Math.min(640, Math.round(cols * 7.3)))

/** Runs as the pieces of a styled line: a dim run dim, a bold one bold, the stop colour red. */
function runPieces(runs: Run[]): Piece[] {
  return runs.map(r => ({ t: r.text, bold: r.bold === true, fill: r.color === CK.fail ? ink('red') : r.dim === true ? DIM() : ink('ink') }))
}

/** `pieces` kept to `px` at `size`: the run that overflows is cut with `…`, the rest dropped. */
function fitPieces(pieces: Piece[], px: number, size: number): Piece[] {
  let room = charsIn(px, size)
  const out: Piece[] = []
  for (const p of pieces) {
    if (p.t.length <= room) {
      out.push(p)
      room -= p.t.length
    } else {
      const cut = room > 1 ? `${p.t.slice(0, room - 1).trimEnd()}…` : ''
      if (cut !== '') out.push({ ...p, t: cut })
      break
    }
  }
  return out
}

/**
 * Now's deck as one Svg (R32), the cockpit header drawn in the pane's words:
 * the pill with its meta beside it (WAITING FOR YOU and the wait; WORKING with
 * this turn's time and the quiet time; STOPPED and its reason), the lead's
 * critter, the kicker over the goal on two lines, the budget line, and the
 * two gauge rings (context, and the hotter of the 5 hours and the week); then
 * Agents (critters, and a count of the failed) and To do (the plan strip),
 * each only when it has something to show. No running step, no turn counter,
 * no Next, no Steps trace and no Cache row (the cockpit removed them, R26).
 * Drawn on `g`, the ground the pane draws on (day on a light theme).
 */
export function nowDeckSvg(t: Timeline, u: UiState, now: number, cols: number, head: DeckHead, g: Ground = 'night', covered = false): string {
  ground = g
  const m = deckModel(t, u, now, head, covered)
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
    if (more > 0) o += text(C + shown.length * 42, y, `+${more}`, { fill: DIM() })
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
  const pillW = m.pill.word.length * 7.4 + 18
  const metaX = C + pillW + 10
  s += tspans(metaX, 28, fitPieces(runPieces(m.meta), W - 16 - metaX, 11), { size: 11 })
  s += character(16, 46, m.lead, 4.6)
  s += text(C, 52, cutTo(m.kicker, heroRight - C, 11), { size: 11, fill: DIM() })
  const focus = wrapTo(m.focus, heroRight - C, 15, 2)
  focus.forEach((line, i) => {
    s += text(C, 72 + i * 20, line, { size: 15, bold: !m.isIdle, fill: m.isIdle ? DIM() : ink('ink') })
  })
  s += tspans(C, 116, fitPieces(runPieces(m.budget), heroRight - C, 12), { size: 12 })
  m.rings.forEach((r, i) => {
    s += ring(W - 36 - 52 * (m.rings.length - 1 - i), 78, 19, r)
  })
  if (rows.length > 0) s += `<path d="M 16 136 H ${num(W - 16)}" stroke="${ink('rest')}" stroke-width="1" stroke-dasharray="1 5"></path>`
  s += rows.join('')
  s += '</svg>'
  return bounded(s, W, () => m)
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
export function bandSvg(t: Timeline, u: UiState, now: number, cols: number, model?: BandModel, g: Ground = 'night'): string {
  ground = g
  const m = model ?? bandModel(t, u, now)
  const W = bandWidth(cols)
  const dm = (): { pill: DeckModel['pill']; focus: string } => ({ pill: { word: m.form === 'asked' ? 'NEEDS YOU' : m.form === 'stopped' ? 'STOPPED' : 'WORKING', hue: m.form === 'asked' ? 'amber' : m.form === 'stopped' ? 'red' : 'iris' }, focus: m.focus })
  const right = W - 16
  if (m.form === 'idle' && m.rest !== undefined) {
    const H = 34
    const head: Piece[] = [...(m.rest.tick ? [{ t: '✓ ', fill: ink('mint') }] : []), { t: m.rest.head, fill: DIM() }]
    const facts = m.rest.facts.map(f => ({ t: `   ·   ${f}`, fill: DIM() }))
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
    const head: Piece = stopped ? { t: 'Stopped', fill: ink('red'), bold: true } : { t: m.kicker, fill: DIM() }
    const gauges: Piece[] = []
    if (m.context !== undefined) gauges.push({ t: 'context ', fill: DIM() }, figurePiece(m.context))
    if (m.week !== undefined) gauges.push({ t: `${gauges.length > 0 ? '    ' : ''}week `, fill: DIM() }, figurePiece(m.week))
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
  const sep = { t: '   ·   ', fill: DIM() }
  const words: Piece[] = []
  if (hasBar) words.push({ t: String(m.done), bold: true }, { t: ` of ${m.total} done`, fill: DIM() })
  if (m.form === 'asked') {
    if (words.length > 0) words.push(sep)
    if (m.working > 0) words.push({ t: `${m.working} ${m.working === 1 ? 'agent' : 'agents'} working, `, fill: DIM() })
    words.push({ t: `${m.waiting} waiting`, fill: ink('amber') })
  } else if (m.form === 'working') {
    if (m.working > 0) words.push(...(words.length > 0 ? [sep] : []), { t: agentsWords(m), fill: DIM() })
    words.push(...(words.length > 0 ? [sep] : []), { t: needsPiece(m), fill: DIM() })
  }
  s += tspans(wx, 43, words, { size: 12.5 })
  return bounded(`${s}</svg>`, W, dm)
}

// ---------- the alts ----------

const MAX_ALT = 600

const ringsSaid = (m: DeckModel): string => m.rings.map(r => `${r.name} ${r.pct}%`).join(', ')

/** The header's meta as the pane reads it ("2 min this turn · quiet 3 min"). */
const metaSaid = (m: DeckModel): string => m.meta.map(r => r.text).join('').trim()

/** Now's header in words, for a reader that cannot see the Svg: the pill and its meta, the kicker and the goal, the budget line, the gauges, the agents and the to-dos. */
export function nowDeckAlt(t: Timeline, u: UiState, now: number, head: DeckHead, covered = false): string {
  const m = deckModel(t, u, now, head, covered)
  const meta = metaSaid(m)
  const parts = [`Now: ${m.pill.word}${meta !== '' ? `, ${meta}` : ''}. ${m.kicker}: ${m.focus}.`]
  const budget = m.budget.map(r => r.text).join('').trim()
  if (budget !== '') parts.push(`${budget}.`)
  if (m.rings.length > 0) parts.push(`${ringsSaid(m)}.`)
  if (m.crew.length > 0) parts.push(`${m.live} agents working, ${m.failed} failed.`)
  if (m.tasks.total > 0) parts.push(`${m.tasks.done} of ${m.tasks.total} tasks done.`)
  return parts.join(' ').slice(0, MAX_ALT)
}

/** The band in words. */
export function bandAlt(t: Timeline, u: UiState, now: number, model?: BandModel): string {
  return bandWords(model ?? bandModel(t, u, now)).slice(0, MAX_ALT)
}
