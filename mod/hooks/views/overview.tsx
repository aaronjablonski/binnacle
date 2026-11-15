import type { EngineInterface, RenderElement } from 'claude-code'

import type { Step, Tab, Timeline } from '../../types'
import { summary } from '../model/select'
import { leaveDetail, updateUi } from '../state'
import { budgetMeters, budgetView, isBudgetOpen, setBudgetOpen, tokenText } from './budget'
import { buckets, clock, crewRow, elapsed, GAUGE, pips, shortPaths, spark, typeShort, wordFit } from './fit'
import { argOf, headline, laid, runsLine } from './lay'
import type { Placed } from './lay'
import { crewPods, moveNeed, needsSection, needsYou, podFor, waitStates } from './needs'
import { isOnScreen } from './onscreen'
import { openStepInline } from './openstep'
import { blank, deck, deckRows, footer, more, row, section } from './parts'
import type { DeckCell, DeckRow, Hint } from './parts'
import type { ViewCtx } from './shell'
import { C, cellCol, COL, DECK, GRID, statusColor } from './style'
import type { Run } from './style'

// From this width the pane is the inline strip: eight cells, two halves.
export const STRIP = 96
export const MAX_LIST = 6
export const STEP_GLYPH: Record<Step['status'], string> = { running: '▸', done: '✓', error: '✖', denied: '✖', interrupted: '·' }
const KEPT_NOTE = 'kept steps are never trimmed and export in full'

export const subagents = (t: Timeline) => Object.values(t.agents).filter(a => a.id !== 'main')
function openTab($: EngineInterface, tab: Tab): Promise<void> {
  return updateUi($, u => ({ ...leaveDetail(u), tab }))
}

/** An agent's tokens as `72k`, or `…` while it has reported none. */
export const agentTokens = (a: { tokensIn?: number; tokensOut?: number }): string =>
  a.tokensIn !== undefined || a.tokensOut !== undefined ? tokenText((a.tokensIn ?? 0) + (a.tokensOut ?? 0)) : '…'

/**
 * Now's deck (spec "Now"): FOCUS, NEXT, a rail-only row, CREW, TASKS, STEPS
 * and BUDGET, each a label at 2 and cells on 14, 26, 38 and 50. CREW, TASKS,
 * STEPS and BUDGET open their tab (or the budget view). In the strip (`strip`)
 * there is no rail-only row, the aside column is out, and STEPS carries its
 * errors beside the count; `count` things waiting take the NEXT row.
 */
export function nowRows(ctx: ViewCtx, $: EngineInterface, strip: boolean, count: number): (DeckRow | null)[] {
  const { t, now } = ctx
  const s = summary(t)
  const h = headline(t)
  const subs = subagents(t)
  const live = subs.filter(a => a.status === 'running').length
  const failed = subs.filter(a => a.status === 'error').length
  const times = t.steps.map(x => x.startedAt)
  const from = times.length > 0 ? Math.min(...times) : now
  const pods = crewPods(ctx)
  const rows: (DeckRow | null)[] = []

  const focus: DeckCell[] = [{ col: DECK.gauge, runs: [{ text: h.text, ...(h.isIdle ? { dim: true } : { bold: true }) }] }]
  if (h.at !== undefined) focus.push({ col: DECK.aside, runs: [{ text: elapsed(h.at, now), dim: true }] })
  rows.push({ key: 'deck-focus', label: 'FOCUS', cells: focus })

  if (strip && count > 0) {
    rows.push({
      key: 'deck-wait',
      label: [{ text: 'WAITING', color: C.wait, bold: true }],
      cells: [{ col: DECK.gauge, runs: [{ text: `${count} need you`, color: C.wait, bold: true }] }],
    })
  } else if (s.next !== undefined) {
    rows.push({ key: 'deck-next', label: 'NEXT', cells: [{ col: DECK.gauge, runs: s.next }] })
  }
  if (!strip) rows.push(null)

  const crew: DeckCell[] = [
    { col: DECK.gauge, runs: crewRow(pods), narrow: crewRow(pods, 7, { tight: true }), whole: true },
    { col: DECK.value, runs: [{ text: String(live), bold: true }, { text: ' live', dim: true }] },
  ]
  if (failed > 0) crew.push({ col: DECK.aside, runs: [{ text: String(failed), bold: true, color: C.fail }, { text: ' failed', dim: true }] })
  rows.push({ key: 'deck-crew', label: 'CREW', onPress: () => openTab($, 'agents'), cells: crew })

  const active = t.tasks.filter(x => x.status === 'in_progress').length
  const tasks: DeckCell[] =
    s.total > 0
      ? [
          { col: DECK.gauge, runs: pips(s.done, s.total, GAUGE, active), narrow: pips(s.done, s.total, 10, active), whole: true },
          { col: DECK.value, runs: [{ text: String(s.done), bold: true }, { text: `/${s.total}`, dim: true }] },
        ]
      : [{ col: DECK.value, runs: [{ text: '–', dim: true }] }]
  if (s.total > 0 && times.length > 0) tasks.push({ col: DECK.aside, runs: [{ text: elapsed(from, now), dim: true }] })
  rows.push({ key: 'deck-tasks', label: 'TASKS', onPress: () => openTab($, 'tasks'), cells: tasks })

  const errors: Run[] = s.errors > 0 ? [{ text: '✖', color: C.fail }, { text: ` ${s.errors}` }] : []
  const steps: DeckCell[] = [
    { col: DECK.gauge, runs: spark(buckets(times, from, now, GAUGE), GAUGE), narrow: spark(buckets(times, from, now, 10), 10), whole: true },
    { col: DECK.value, runs: [{ text: String(s.steps), bold: true }, ...(strip && errors.length > 0 ? [{ text: ' ' }, ...errors] : [])] },
  ]
  if (!strip && errors.length > 0) steps.push({ col: DECK.aside, runs: errors })
  rows.push({ key: 'deck-steps', label: 'STEPS', onPress: () => openTab($, 'timeline'), cells: steps })

  const meters = budgetMeters(t)
  if (meters.length > 0) {
    const cols = [DECK.gauge, cellCol(2), DECK.value]
    rows.push({
      key: 'deck-budget',
      label: 'BUDGET',
      onPress: () => setBudgetOpen($, true),
      cells: meters.map((m, i) => ({ col: cols[i] ?? DECK.value, runs: m, whole: true })),
    })
  }
  return rows
}

function agentsBlock(ctx: ViewCtx, $: EngineInterface): RenderElement[] {
  const live = subagents(ctx.t)
    .filter(a => a.status === 'running')
    .sort((a, b) => a.startedAt - b.startedAt)
  if (live.length === 0) return []
  const waits = waitStates(ctx.t, ctx.u, ctx.now)
  const rows = live.slice(0, MAX_LIST).map(a => {
    const hull = podFor(a, waits, ctx.now).hull
    return row(ctx, $, {
      key: `agent-${a.id}`,
      glyph: hull.text,
      ...(hull.color !== undefined ? { glyphColor: hull.color } : {}),
      name: shortPaths(a.description || a.type),
      metric: agentTokens(a),
      time: elapsed(a.startedAt, ctx.now),
      onPress: () => updateUi($, u => ({ ...leaveDetail(u), tab: 'agents', agentOpen: a.id })),
    })
  })
  return [section(ctx, $, 'AGENTS', 'tokens', 'time'), ...rows, ...(live.length > MAX_LIST ? [more(ctx, $, live.length - MAX_LIST)] : [])]
}

/** The steps LATEST shows: the one running (else the newest) and the newest error. */
function latestSteps(t: Timeline): Step[] {
  const bySeq = [...t.steps].sort((a, b) => b.seq - a.seq)
  const first = bySeq.find(x => x.status === 'running') ?? bySeq[0]
  if (first === undefined) return []
  const error = bySeq.find(x => x.status === 'error')
  return error !== undefined && error.id !== first.id ? [first, error] : [first]
}

// The agent as a metric cell: its type in a short form (`general-purpose` is `general`).
export const who = (t: Timeline, agent: string): string => (agent === 'main' ? 'main' : typeShort(t.agents[agent]?.type ?? agent))

function latestBlock(ctx: ViewCtx, $: EngineInterface): RenderElement[] {
  const { t, now, e } = ctx
  const steps = latestSteps(t)
  if (steps.length === 0) return []
  const rows = steps.map(x =>
    row(ctx, $, {
      key: `step-${x.id}`,
      ...(isOnScreen(e.surface, x.id) ? { flag: 'inView' as const } : {}),
      glyph: STEP_GLYPH[x.status],
      glyphColor: statusColor(x.status),
      tool: x.tool,
      name: argOf(x.tool, x.label),
      metric: who(t, x.agent),
      time: x.status === 'running' ? 'now' : elapsed(x.endedAt ?? x.startedAt, now),
      onPress: () => openStepInline($, x.id),
    }),
  )
  return [section(ctx, $, 'LATEST', 'agent', 'time'), ...rows]
}

function keptBlock(ctx: ViewCtx, $: EngineInterface): RenderElement[] {
  const { t, e } = ctx
  const kept = t.steps.filter(x => x.pin !== undefined).sort((a, b) => b.seq - a.seq)
  if (kept.length === 0) return []
  const rows = kept.slice(0, MAX_LIST).map(x =>
    row(ctx, $, {
      key: `kept-${x.id}`,
      glyph: '★',
      glyphColor: C.spark,
      name: x.pin !== undefined && x.pin !== '' ? x.pin : argOf(x.tool, x.label),
      metric: x.tool,
      time: clock(x.startedAt),
      onPress: () => openStepInline($, x.id),
    }),
  )
  const note =
    kept.length < 3
      ? [runsLine(e, $, [{ col: COL.name, text: wordFit(KEPT_NOTE, ctx.cols - COL.name), dim: true }], 'kept-note')]
      : []
  return [section(ctx, $, 'KEPT', 'step', 'at'), ...rows, ...(kept.length > MAX_LIST ? [more(ctx, $, kept.length - MAX_LIST)] : []), ...note]
}

function notesBlock(ctx: ViewCtx, $: EngineInterface): RenderElement[] {
  const notes = summary(ctx.t).notes.slice(0, 2)
  if (notes.length === 0) return []
  return [
    section(ctx, $, 'NOTES'),
    ...notes.map((n, i) =>
      runsLine(
        ctx.e,
        $,
        [
          { col: GRID.margin, text: '·', dim: true },
          { col: COL.name, text: wordFit(n.text.replace(/\s+/g, ' ').trim(), ctx.cols - COL.name) },
        ],
        `note-${i}`,
      ),
    ),
  ]
}

/** The footer's hints: `n`/`p` when more than one thing waits, `b` for the budget view; engine keys as text. */
function hints($: EngineInterface, count: number, strip: boolean): Hint[] {
  const budget: Hint = { hotkey: 'b', label: 'budget', key: 'hint-budget', onPress: () => setBudgetOpen($, true) }
  const next: Hint = { hotkey: 'n', label: 'next error', key: 'hint-next', onPress: () => moveNeed($, 1, count) }
  const prev: Hint = { hotkey: 'p', label: 'prev', key: 'hint-prev', onPress: () => moveNeed($, -1, count) }
  if (strip) return count > 0 ? [next, prev, budget] : [budget, { text: '↵ open' }, { text: 'esc prompt' }]
  if (count > 1) return [prev, budget, { text: 'esc prompt' }]
  return [budget, { text: '↵ open' }, { text: 'esc prompt' }]
}

/** The blocks, one blank row between each and never two. */
function stack(ctx: ViewCtx, $: EngineInterface, blocks: (RenderElement[] | RenderElement | null)[]): RenderElement[] {
  const out: RenderElement[] = []
  let n = 0
  for (const b of blocks) {
    const els = b === null ? [] : Array.isArray(b) ? b : [b]
    if (els.length === 0) continue
    if (out.length > 0) out.push(blank(ctx, $, `gap-${n}`))
    out.push(...els)
    n += 1
  }
  return out
}

// ---------- the inline strip: the same cells, eight across ----------

export const HALF = 50
// The right half's own columns: glyph 2, name 4, metric 24, time 36.
export const RIGHT = { glyph: 2, name: 4, nameEnd: 22, arg: 10, metric: 24, time: 36 }

function stripHead($: EngineInterface, ctx: ViewCtx, label: string, metric: string, time: string, key: string): RenderElement {
  return runsLine(ctx.e, $, [
    { col: 0, text: '┌', color: C.accent },
    { col: 2, text: label, bold: true },
    { col: RIGHT.metric, text: metric, dim: true },
    { col: RIGHT.time, text: time, dim: true },
  ], key)
}

type StripRow = { key: string; glyph: string; color?: string; tool?: string; name: string; metric: string; time: string; onPress: () => void | Promise<void> }

function stripRow($: EngineInterface, ctx: ViewCtx, r: StripRow): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const nameCol = r.tool !== undefined ? RIGHT.arg : RIGHT.name
  const segs: Placed[] = [
    { col: RIGHT.glyph, text: r.glyph, ...(r.color !== undefined ? { color: r.color } : { dim: true }) },
    ...(r.tool !== undefined ? [{ col: RIGHT.name, text: r.tool.slice(0, 5), dim: true }] : []),
    { col: nameCol, text: wordFit(r.name, RIGHT.nameEnd - nameCol) },
    { col: RIGHT.metric, text: wordFit(r.metric, GRID.content), dim: true },
    { col: RIGHT.time, text: wordFit(r.time, GRID.content), dim: true },
  ]
  return (
    <Box key={`strip-${r.key}`} flexDirection="row">
      <Text>{'  '}</Text>
      <Button key={r.key} plain onPress={r.onPress}>
        {laid(segs, 2, ctx.e, $, `${r.key}-`)}
      </Button>
    </Box>
  )
}

/**
 * A press, then `after` once it is done: the band's strip opens the pane
 * after a row's own write. Without `after` the press is unchanged.
 */
export function andThen(press: () => void | Promise<void>, after?: () => Promise<void>): () => void | Promise<void> {
  if (after === undefined) return press
  return async () => {
    await press()
    await after()
  }
}

/**
 * The right half's two blocks: AGENTS (its head and up to two rows, or one
 * and `+ n more`) and LATEST (its head and one row); `agentsShort` is AGENTS
 * cut to its head and first row. Each is empty when it has nothing to show.
 */
type RightBlocks = { agents: RenderElement[]; agentsShort: RenderElement[]; latest: RenderElement[] }

function stripBlocks(ctx: ViewCtx, $: EngineInterface, after?: () => Promise<void>): RightBlocks {
  const { t, now } = ctx
  const agents: RenderElement[] = []
  const latest: RenderElement[] = []
  const live = subagents(t)
    .filter(a => a.status === 'running')
    .sort((a, b) => a.startedAt - b.startedAt)
  const waits = waitStates(t, ctx.u, now)
  const agentRow = (a: (typeof live)[number]): RenderElement => {
    const hull = podFor(a, waits, now).hull
    return stripRow($, ctx, {
      key: `agent-${a.id}`,
      glyph: hull.text,
      ...(hull.color !== undefined ? { color: hull.color } : {}),
      name: shortPaths(a.description || a.type),
      metric: agentTokens(a),
      time: elapsed(a.startedAt, now),
      onPress: andThen(() => updateUi($, u => ({ ...leaveDetail(u), tab: 'agents', agentOpen: a.id })), after),
    })
  }
  if (live.length > 0) {
    agents.push(stripHead($, ctx, 'AGENTS', 'tokens', 'time', 'strip-agents'))
    if (live.length <= 2) agents.push(...live.map(agentRow))
    else agents.push(agentRow(live[0]!), runsLine(ctx.e, $, [{ col: RIGHT.glyph, text: '+', dim: true }, { col: RIGHT.name, text: `${live.length - 1} more`, dim: true }], 'strip-more'))
  }
  const steps = latestSteps(t)
  // One LATEST row: the newest error when there is one, else the step in flight.
  const x = steps.find(s => s.status === 'error') ?? steps[0]
  if (x !== undefined) {
    latest.push(
      stripHead($, ctx, 'LATEST', 'agent', 'time', 'strip-latest'),
      stripRow($, ctx, {
        key: `step-${x.id}`,
        glyph: STEP_GLYPH[x.status],
        ...(statusColor(x.status) !== undefined ? { color: statusColor(x.status)! } : {}),
        tool: x.tool,
        name: argOf(x.tool, x.label),
        metric: who(t, x.agent),
        time: x.status === 'running' ? 'now' : elapsed(x.endedAt ?? x.startedAt, now),
        onPress: andThen(() => openStepInline($, x.id), after),
      }),
    )
  }
  return { agents, agentsShort: agents.slice(0, 2), latest }
}

/**
 * The right half in at most `room` rows: AGENTS, a blank and LATEST when
 * they fit; then without the blank; then AGENTS cut to one agent; then one
 * block alone, AGENTS first. Six rows at most.
 */
export function stripRight(ctx: ViewCtx, $: EngineInterface, room = Infinity, after?: () => Promise<void>): RenderElement[] {
  const { agents, agentsShort, latest } = stripBlocks(ctx, $, after)
  const gap = (): RenderElement[] => (agents.length > 0 && latest.length > 0 ? [blank(ctx, $, 'strip-gap')] : [])
  const ways: (() => RenderElement[])[] = [
    () => [...agents, ...gap(), ...latest],
    () => [...agents, ...latest],
    () => [...agentsShort, ...gap(), ...latest],
    () => [...agentsShort, ...latest],
    () => agents,
    () => agentsShort,
    () => latest,
  ]
  for (const way of ways) {
    const out = way()
    if (out.length <= room) return out
  }
  return []
}

function stripView(ctx: ViewCtx, $: EngineInterface, count: number): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const leftRows = deckRows(ctx, $, nowRows(ctx, $, true, count), { key: 'strip-deck', side: 'left', cols: HALF })
  const bar = footer(ctx, $, hints($, count, true))
  return (
    <Box flexDirection="column">
      <Box key="strip" flexDirection="row">
        <Box key="strip-left" flexDirection="column" width={HALF}>
          {leftRows}
        </Box>
        <Box key="strip-right" flexDirection="column">
          {stripRight(ctx, $)}
        </Box>
      </Box>
      {bar !== null ? <Text key="strip-footer-gap">{' '}</Text> : null}
      {bar}
    </Box>
  )
}

/**
 * The Now tab (spec "Now"): the NEEDS YOU bracket first when anything
 * waits; the deck (FOCUS, NEXT, CREW, TASKS, STEPS, BUDGET); AGENTS live only;
 * LATEST; KEPT; NOTES; the footer while the pane has the focus. From 96
 * columns the inline strip: the deck's rows left (the left bracket only),
 * AGENTS and LATEST right. The budget view replaces both while it is open.
 */
export function overviewView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box } = $.ui.resolve(ctx.e)
  if (isBudgetOpen()) {
    const bar = footer(ctx, $, [{ hotkey: 'b', label: 'back', key: 'hint-back', onPress: () => setBudgetOpen($, false) }, { text: 'esc prompt' }])
    return <Box flexDirection="column">{stack(ctx, $, [budgetView(ctx, $), bar])}</Box>
  }
  const count = Math.min(needsYou(ctx.t, ctx.u, ctx.now).length, MAX_LIST)
  if (ctx.cols >= STRIP) return stripView(ctx, $, count)
  const blocks = [
    needsSection(ctx, $),
    deck(ctx, $, nowRows(ctx, $, false, count), { key: 'now' }),
    agentsBlock(ctx, $),
    latestBlock(ctx, $),
    keptBlock(ctx, $),
    notesBlock(ctx, $),
  ]
  const bar = footer(ctx, $, hints($, count, false))
  return <Box flexDirection="column">{stack(ctx, $, [...blocks, bar])}</Box>
}
