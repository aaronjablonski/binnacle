import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow, Timeline, UiState } from '../../types'
import { dismissKey, problems, summary } from '../model/select'
import type { Problem } from '../model/select'
import { debug, errText, readTimeline, readUi, updateUi } from '../state'
import { elapsed, fit, pillRun, promptTitle, shortPaths, wordFit } from './fit'
import { showInChat } from './find'
import { argOf, laid } from './lay'
import type { Placed } from './lay'
import { openStepInline } from './openstep'
import { viewAgent } from './parts'
import type { ViewCtx } from './shell'
import { C, COL, podOf, RAIL, tableCols } from './style'
import type { Pod, PodState } from './style'

/** An ask counts as "waiting on you" only once it has run this long: in auto mode the classifier settles most within seconds. */
export const ASK_MS = 20_000
/**
 * An ask on any tool but Agent and Workflow notifies only once it has run this
 * long: a real permission dialog raises Claude Code's own notification, and a
 * call let through that runs long (a test run, a build) is no wait at all.
 */
export const NOTIFY_ASK_MS = 60_000
/** Asks that notify from ASK_MS: their mark clears as soon as the agent they spawn shows. */
const SPAWNING_TOOLS = new Set(['Agent', 'Workflow'])
/** A subagent's finish and a failed turn are raised only while this fresh, so a restore does not replay old ones. */
const FRESH_MS = 15_000

export type NotifyMode = 'off' | 'waits' | 'all'

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** What needs the person: the problems not dismissed, with an ask shown only after ASK_MS. */
export function needsYou(t: Timeline, u: UiState, now: number): Problem[] {
  return problems(t, now, u.dismissed).filter(p => p.kind !== 'asking' || now - p.since >= ASK_MS)
}

/** One line for a problem: the kind's wording around its label. */
export function problemText(p: Problem): string {
  const label = oneLine(p.label)
  switch (p.kind) {
    case 'asking':
      return label
    case 'repeat':
      return `${label} failed ×${p.count ?? 2}`
    case 'loop':
      return `${label} looped ×${p.count ?? 3}`
    case 'stalled':
      return `${label} stalled`
    default:
      return `turn failed: ${label}`
  }
}

function ageText(p: Problem, now: number): string {
  const age = elapsed(p.since, now)
  return p.kind === 'asking' ? `asked ${age} ago` : `${age} ago`
}

// Pressing a row: the step's detail, else the Timeline filtered to the agent.
export async function openProblem($: EngineInterface, p: Problem): Promise<void> {
  if (p.stepId !== undefined) {
    await openStepInline($, p.stepId)
    return
  }
  await updateUi($, u => {
    const { detail: _detail, ...rest } = u
    return { ...rest, tab: 'timeline', filter: p.agent === 'main' ? { kind: 'all' } : { kind: 'agent', id: p.agent } }
  })
}

// Which item of NEEDS YOU is opened. Ephemeral pane state like onscreen.ts's:
// a render hook may not write `$.state`, and a reload starting at the first
// item loses nothing.
let openedAt = 0

/** The opened item's index in a list of `count`. */
export function openedNeed(count: number): number {
  return count <= 0 ? 0 : Math.max(0, Math.min(openedAt, count - 1))
}

/** `n` and `p`: opens the next or previous item (wrapping), and redraws. Press handlers only. */
export function moveNeed($: EngineInterface, delta: 1 | -1, count: number): void {
  if (count <= 0) return
  openedAt = (openedNeed(count) + delta + count) % count
  try {
    $.ui.invalidate('ui.render')
  } catch (err) {
    debug($, `invalidate failed: ${errText(err)}`)
  }
}

/** The glyph and its colour for a kind: `?` and `▲` wait on the person, a failure is `✖`. */
export function needGlyph(p: Problem): { glyph: string; color: string } {
  if (p.kind === 'asking') return { glyph: '?', color: C.wait }
  if (p.kind === 'stalled') return { glyph: '▲', color: C.wait }
  return { glyph: '✖', color: C.fail }
}

/** The `why` column: what is wrong, in a word or two. */
export function needWhy(p: Problem): string {
  switch (p.kind) {
    case 'asking':
      return 'asking'
    case 'repeat':
      return `failed ${p.count ?? 2}×`
    case 'loop':
      return `looped ${p.count ?? 3}×`
    case 'stalled':
      return 'stalled'
    default:
      return 'failed'
  }
}

/** Dismisses a problem: its key goes to `ui.dismissed`. */
export function dismissNeed($: EngineInterface, p: Problem): Promise<void> {
  return updateUi($, cur => ({ ...cur, dismissed: [...cur.dismissed, dismissKey(p)] }))
}

/** `g: chat`: the step's own row, or the agent's transcript; undefined when the problem has neither. */
export function chatFor($: EngineInterface, p: Problem): (() => Promise<void>) | undefined {
  if (p.stepId !== undefined) {
    const id = p.stepId
    return () => showInChat($, id)
  }
  if (p.agent !== 'main') {
    const id = p.agent
    return () => viewAgent($, id)
  }
  return undefined
}

/** The tool of a problem's step, when it has one. */
function stepOf(t: Timeline, p: Problem): { tool: string; label: string } | undefined {
  const s = p.stepId !== undefined ? t.steps.find(x => x.id === p.stepId) : undefined
  return s !== undefined ? { tool: s.tool, label: s.label } : undefined
}

/** What the name column of a problem's row says. */
export function needName(t: Timeline, p: Problem): string {
  const s = stepOf(t, p)
  if (s !== undefined) return argOf(s.tool, s.label) || s.tool
  if (p.kind === 'failed-turn') return promptTitle(p.label) || problemText(p)
  return shortPaths(oneLine(p.label))
}

// Rows the section draws; the rest become one dim line.
const MAX_LIST = 6

// ---------- the crew: who asks, who stalled ----------

/** The agents the problems point at: an ask is `waiting` (the hull's `?`), a stall `stalled` (`z`). Waiting wins. */
export function waitStates(t: Timeline, u: UiState, now: number): Map<string, PodState> {
  const out = new Map<string, PodState>()
  for (const p of needsYou(t, u, now)) {
    if (p.kind === 'asking') out.set(p.agent, 'waiting')
    else if (p.kind === 'stalled' && !out.has(p.agent)) out.set(p.agent, 'stalled')
  }
  return out
}

/** An agent as a pod, with its state taken from `waits` (else from its status). */
export function podFor(a: AgentRow, waits: Map<string, PodState>, now: number): Pod {
  const state = waits.get(a.id)
  return podOf({ id: a.id, type: a.type, status: a.status, ...(state !== undefined ? { state } : {}) }, now)
}

const LEAD: AgentRow = { id: 'main', parent: 'main', type: 'main', description: '', status: 'running', startedAt: 0, doing: '', stepCount: 0 }

/**
 * The crew of a session: the lead first, then the live agents (oldest
 * first), the failed ones, and the finished ones. Their states come from
 * `needsYou`, so an ask or a stall shows on the hull.
 */
export function crewPods(ctx: ViewCtx): Pod[] {
  const { t, u, now } = ctx
  const waits = waitStates(t, u, now)
  const subs = Object.values(t.agents).filter(a => a.id !== 'main')
  const rank = { running: 0, error: 1, done: 2 } as const
  subs.sort((a, b) => rank[a.status] - rank[b.status] || a.startedAt - b.startedAt)
  return [podFor(t.agents.main ?? LEAD, waits, now), ...subs.map(a => podFor(a, waits, now))]
}

/** The state pill's word and colour: waiting on the person, working, all done, or idle. */
export function paneState(ctx: ViewCtx): { word: string; color: string } {
  const { t, u, now } = ctx
  if (needsYou(t, u, now).length > 0) return { word: 'WAITING', color: C.wait }
  const working =
    t.steps.some(x => x.status === 'running') ||
    t.tasks.some(x => x.status === 'in_progress') ||
    Object.values(t.agents).some(a => a.id !== 'main' && a.status === 'running')
  if (working) return { word: 'WORKING', color: C.live }
  const s = summary(t)
  if (s.total > 0 && s.done === s.total) return { word: 'ALL DONE', color: C.subtle }
  return { word: 'IDLE', color: C.subtle }
}

// ---------- the warning bracket ----------
//
// `deck` lays out label-and-cell rows only, and the opened item and its action
// line are free rows, so NEEDS YOU keeps its own small wrapper: each piece is
// the children of one row drawn from column 2 (`end` is its last column + 1);
// the bracket puts a rail before it and one on the last column after it.

type Piece = { key: string; els: (RenderElement | string)[]; end: number }

const endOf = (segs: Placed[]): number => segs.reduce((n, s) => Math.max(n, s.col + s.text.length), 2)

/** The room a cell at `col` has before the right rail: 10, or less at the edge. */
const roomAt = (cols: number, col: number): number => Math.min(10, cols - 2 - col)

function textPiece(ctx: ViewCtx, $: EngineInterface, key: string, segs: Placed[]): Piece {
  const { Text } = $.ui.resolve(ctx.e)
  const live = segs.filter(s => s.text !== '')
  return {
    key,
    end: endOf(live),
    els: [
      <Text key={key} wrap="truncate-end">
        {laid(live, 2, ctx.e, $, `${key}-`)}
      </Text>,
    ],
  }
}

function blankPiece(ctx: ViewCtx, $: EngineInterface, key: string): Piece {
  const { Text } = $.ui.resolve(ctx.e)
  return { key, end: 3, els: [<Text key={key}>{' '}</Text>] }
}

/** The pieces in twin warning rails: `┏ … ┓`, `┃ … ┃`, `┗ … ┛`, the right rail on the last column. */
function bracket(ctx: ViewCtx, $: EngineInterface, pieces: Piece[]): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const n = pieces.length
  return (
    <Box key="needs" flexDirection="column">
      {pieces.map((p, i) => {
        const first = i === 0
        const last = i === n - 1
        const left = first ? RAIL.top : last ? RAIL.bottom : RAIL.mid
        const right = first ? RAIL.topRight : last ? RAIL.bottomRight : RAIL.mid
        const pad = ' '.repeat(Math.max(0, ctx.cols - 1 - p.end))
        return (
          <Box key={`needs-${p.key}`} flexDirection="row">
            <Text color={C.wait}>{`${left} `}</Text>
            {p.els}
            {pad !== '' ? <Text>{pad}</Text> : null}
            <Text color={C.wait}>{right}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * NEEDS YOU (spec "Now, waiting"): a `warning` bracket of its own, first on
 * Now. Its head row is the ` NEEDS YOU ` pill, the count, and dim `why` and
 * `waiting` heads on the table columns; then one row per problem. The opened
 * item (the first until `n` or `p` moves it) is bold with an `asks` or `why`
 * line, an `agent` line and `g: chat  x: dismiss  n: next`; the first row
 * takes the pane's focus. Null when nothing waits.
 */
export function needsSection(ctx: ViewCtx, $: EngineInterface): RenderElement | null {
  const { Button, Box } = $.ui.resolve(ctx.e)
  const { t, u, now, cols } = ctx
  const list = needsYou(t, u, now)
  if (list.length === 0) return null
  const shown = list.slice(0, MAX_LIST)
  const at = openedNeed(shown.length)
  const tc = tableCols(cols)
  const nameEnd = Math.min(tc.nameEnd, cols - 2)
  const pieces: Piece[] = []

  const heads: Placed[] = [
    { col: 2, ...pillRun('NEEDS YOU', C.wait) },
    { col: 14, text: String(list.length), color: C.wait, bold: true },
  ]
  if (tc.metric !== undefined && roomAt(cols, tc.metric) > 0) heads.push({ col: tc.metric, text: fit('why', roomAt(cols, tc.metric)), dim: true })
  if (tc.time !== undefined && roomAt(cols, tc.time) > 0) heads.push({ col: tc.time, text: fit('waiting', roomAt(cols, tc.time)), dim: true })
  pieces.push(textPiece(ctx, $, 'needs-head', heads))

  shown.forEach((p, i) => {
    const s = stepOf(t, p)
    const mark = needGlyph(p)
    const isOpen = i === at
    if (isOpen && i > 0) pieces.push(blankPiece(ctx, $, `need-gap-${i}`))
    const toolCol = COL.name
    const nameCol = s !== undefined ? toolCol + 6 : toolCol
    const tint = isOpen && p.kind !== 'failed-turn' && p.kind !== 'repeat' && p.kind !== 'loop' ? { color: C.wait } : { dim: true }
    const segs: Placed[] = [{ col: COL.glyph, text: mark.glyph, color: mark.color }]
    if (s !== undefined) segs.push({ col: toolCol, text: fit(s.tool, 5), dim: true })
    segs.push({ col: nameCol, text: wordFit(needName(t, p), Math.max(0, nameEnd - nameCol)), ...(isOpen ? { bold: true } : {}) })
    if (tc.metric !== undefined && roomAt(cols, tc.metric) > 0) segs.push({ col: tc.metric, text: wordFit(needWhy(p), roomAt(cols, tc.metric)), ...tint })
    if (tc.time !== undefined && roomAt(cols, tc.time) > 0) segs.push({ col: tc.time, text: wordFit(elapsed(p.since, now), roomAt(cols, tc.time)), ...tint })
    const live = segs.filter(x => x.text !== '')
    const key = `open-${p.key}`
    pieces.push({
      key,
      end: endOf(live),
      els: [
        <Button key={key} plain onPress={() => openProblem($, p)} autoFocus={i === 0 ? true : undefined}>
          {laid(live, 2, ctx.e, $, `${key}-`)}
        </Button>,
      ],
    })
    if (!isOpen) return
    const who = p.agent !== 'main' ? t.agents[p.agent]?.type ?? p.agent : 'main'
    const details: { key: string; value: string }[] =
      p.kind === 'asking'
        ? [{ key: 'asks', value: `to run ${shortPaths(oneLine(p.label))}` }]
        : [{ key: 'why', value: shortPaths(problemText(p)) }]
    details.push({ key: 'agent', value: who })
    details.forEach((d, j) => {
      pieces.push(
        textPiece(ctx, $, `need-detail-${j}`, [
          { col: COL.detailKey, text: fit(d.key, COL.detailValue - COL.detailKey - 1), dim: true },
          { col: COL.detailValue, text: wordFit(d.value, Math.max(0, cols - 2 - COL.detailValue)) },
        ]),
      )
    })
    const chat = chatFor($, p)
    const actions: { hotkey: string; label: string; key: string; onPress: () => void | Promise<void> }[] = []
    if (chat !== undefined) actions.push({ hotkey: 'g', label: 'chat', key: `chat-${p.key}`, onPress: chat })
    actions.push({ hotkey: 'x', label: 'dismiss', key: `dismiss-${p.key}`, onPress: () => dismissNeed($, p) })
    if (shown.length > 1) actions.push({ hotkey: 'n', label: 'next', key: 'need-next', onPress: () => moveNeed($, 1, shown.length) })
    const kept: typeof actions = []
    let used = COL.action
    for (const a of actions) {
      const w = (kept.length > 0 ? 3 : 0) + a.hotkey.length + 2 + a.label.length
      if (used + w > cols - 2) break
      kept.push(a)
      used += w
    }
    pieces.push({
      key: 'need-actions',
      end: used,
      els: [
        <Box key="need-actions" flexDirection="row" paddingLeft={COL.action - 2} columnGap={3}>
          {kept.map(a => (
            <Button key={a.key} hotkey={a.hotkey} plain onPress={a.onPress}>
              {a.label}
            </Button>
          ))}
        </Box>,
      ],
    })
    if (i < shown.length - 1) pieces.push(blankPiece(ctx, $, `need-after-${i}`))
  })
  if (list.length > shown.length) {
    pieces.push(
      textPiece(ctx, $, 'need-more', [
        { col: COL.glyph, text: '+', dim: true },
        { col: COL.name, text: wordFit(`${list.length - shown.length} more`, cols - 2 - COL.name), dim: true },
      ]),
    )
  }
  return bracket(ctx, $, pieces)
}

/**
 * The clock's one call: raises a native notification once per step id for an
 * ask that has waited ASK_MS on Agent or Workflow and NOTIFY_ASK_MS on any
 * other tool (and, with `all`, once per failed turn that ended within
 * FRESH_MS), and a toast when a subagent has just finished. What was raised is recorded in
 * `ui` before it is sent. Runs from the clock callback, not a render hook, so
 * it may write state. Never throws.
 */
export async function needsTick($: EngineInterface, notify: NotifyMode | undefined): Promise<void> {
  try {
    const t = await readTimeline($)
    const u = await readUi($)
    const now = await $.clock.now()
    const mode = notify ?? 'waits'

    const notes: { id: string; text: string }[] = []
    if (mode !== 'off') {
      for (const p of needsYou(t, u, now)) {
        const id = p.stepId ?? p.key
        if (u.notified.includes(id)) continue
        if (p.kind === 'asking') {
          const tool = t.steps.find(s => s.id === p.stepId)?.tool
          const wait = tool !== undefined && SPAWNING_TOOLS.has(tool) ? ASK_MS : NOTIFY_ASK_MS
          if (now - p.since >= wait) notes.push({ id, text: `Waiting on you: ${oneLine(p.label)}` })
        } else if (p.kind === 'failed-turn' && mode === 'all' && now - p.since <= FRESH_MS) {
          notes.push({ id, text: `Turn failed: ${oneLine(p.label)}` })
        }
      }
    }
    const toasts: { id: string; text: string }[] = []
    for (const a of Object.values(t.agents)) {
      if (a.id === 'main' || a.status === 'running' || a.endedAt === undefined) continue
      const id = `agent-done:${a.id}`
      if (now - a.endedAt > FRESH_MS || u.toasted.includes(id)) continue
      // A workflow agent's answer is empty and its doing is its last step: its result says more.
      const result = a.result !== undefined ? oneLine(a.result) : ''
      const first = result !== '' ? result : oneLine(a.doing.split('\n')[0] ?? '')
      toasts.push({ id, text: `${a.type} finished${first !== '' ? `: ${first}` : ''}` })
    }
    if (notes.length === 0 && toasts.length === 0) return

    await updateUi($, cur => ({
      ...cur,
      notified: [...cur.notified, ...notes.map(n => n.id).filter(id => !cur.notified.includes(id))],
      toasted: [...cur.toasted, ...toasts.map(x => x.id).filter(id => !cur.toasted.includes(id))],
    }))
    for (const n of notes) {
      try {
        await $.ui.notify(n.text)
      } catch (err) {
        debug($, `notify failed: ${errText(err)}`)
      }
    }
    for (const x of toasts) $.ui.toast(x.text)
  } catch (err) {
    debug($, `needs tick failed: ${errText(err)}`)
  }
}
