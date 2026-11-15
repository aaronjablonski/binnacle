import type { EngineInterface, RenderElement } from 'claude-code'

import type { Step, Tab, Timeline } from '../../types'
import { cacheLine, pace, taskKey, taskMeter, thisTurn, turnClock } from '../model/meter'
import { summary } from '../model/select'
import { leaveDetail, updateUi } from '../state'
import { budgetMeters, budgetView, exportLedger, isBudgetOpen, setBudgetOpen, tokenText } from './budget'
import { buckets, clock, crewRow, elapsed, GAUGE, pips, sectionRows, shortPaths, spark, toolCell, typeShort, wordFit, NOW_SECTIONS } from './fit'
import { argOf, headline, laid, runsLine } from './lay'
import type { Placed } from './lay'
import { crewPods, moveNeed, needsCap, needsFrameRows, needsLimits, needsSection, needsYou, paneState, podFor, waitStates } from './needs'
import { isOnScreen } from './onscreen'
import { openStep } from './openstep'
import { clearCountdown, setCountdown } from './countdown'
import { openAgentPage } from './agentmeta'
import { openPage } from './pagenav'
import { blank, deck, deckRows, footer, heightOf, hero, inst, more, row, section } from './parts'
import type { DeckCell, DeckRow, Hint, InstSpec } from './parts'
import { barsSpec, deckRowEl, lintelSpec, ringsSpec, sillSpec, toneOf } from './richkit'
import type { DeckRowSpec, Ring } from './richkit'
import { Grid, drawBeads, drawSprite } from './raster'
import type { Ink } from './raster'
import type { ViewCtx } from './shell'
import { deckSvg } from './svgview'
import { C, cellCol, COL, DECK, GRID, spriteOf, statusColor } from './style'
import type { Pod, Run } from './style'
import { richStrip } from './stripband'

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
      onPress: () => openAgentPage($, a.id, `agent-${a.id}`),
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
      onPress: () => openStep($, x.id, `step-${x.id}`),
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
      onPress: () => openStep($, x.id, `kept-${x.id}`),
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
    ...(r.tool !== undefined ? [{ col: RIGHT.name, text: toolCell(r.tool, 5), dim: true }] : []),
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
      onPress: andThen(() => openAgentPage($, a.id, `agent-${a.id}`), after),
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
        onPress: andThen(() => openStep($, x.id, `step-${x.id}`), after),
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
    const bar = footer(ctx, $, [
      { hotkey: 'b', label: 'back', key: 'hint-back', onPress: () => setBudgetOpen($, false) },
      { hotkey: 'e', label: 'csv', key: 'hint-csv', onPress: () => exportLedger($, ctx.showCost === true) },
      { text: 'esc prompt' },
    ])
    return <Box flexDirection="column">{stack(ctx, $, [budgetView(ctx, $), bar])}</Box>
  }
  const count = Math.min(needsYou(ctx.t, ctx.u, ctx.now).length, MAX_LIST)
  if (ctx.look === 'rich') {
    if (ctx.cols < STRIP) return richNow(ctx, $, count)
    const bar = footer(ctx, $, hints($, count, true))
    const comp = richStrip(ctx, $, { maxRows: Math.max(0, (ctx.bodyRows ?? 14) - (bar !== null ? 2 : 0)) })
    if (comp !== undefined) return <Box flexDirection="column">{stack(ctx, $, [comp, bar])}</Box>
  }
  const svgDeck = deckSvg(ctx, $)
  if (svgDeck === null && ctx.cols >= STRIP) return stripView(ctx, $, count)
  const deckEl = svgDeck ?? deck(ctx, $, nowRows(ctx, $, false, count), { key: 'now' })
  // NEEDS YOU lists what waits in the rows the deck leaves (binding rule 2): its head and opened item take 4, the gaps 2.
  const needsRoom = (ctx.bodyRows ?? 40) - heightOf(deckEl) - 6
  const blocks = [
    needsSection(ctx, $, needsCap(ctx, needsRoom)),
    deckEl,
    agentsBlock(ctx, $),
    latestBlock(ctx, $),
    keptBlock(ctx, $),
    notesBlock(ctx, $),
  ]
  const bar = footer(ctx, $, hints($, count, false))
  return <Box flexDirection="column">{stack(ctx, $, [...blocks, bar])}</Box>
}

// ---------- Neo Rich: the Now frame, the height rule, THIS TURN ----------

/** A focus older than this, with steps run since, is stale: the latest activity leads. */
export const STALE_MS = 10 * 60_000
/** The Now list sections take rows from here: TASKS joins at 40 rows. */
const TASKS_FROM_ROWS = 40
/** Under this many rows the deck drops STEPS; under the second, NEXT too. */
const DROP_STEPS_UNDER = 24
const DROP_NEXT_UNDER = 20

/**
 * A focus that is more than 10 minutes old while steps have started since:
 * the text, when it was set and how many steps have run since. Undefined for
 * a fresh focus, or one the guide never set (a task's name has no age).
 */
export function staleFocus(t: Timeline, now: number): { text: string; at: number; since: number } | undefined {
  const s = summary(t)
  const at = s.focusAt
  if (s.focus === undefined || at === undefined || now - at <= STALE_MS) return undefined
  const since = t.steps.filter(x => x.startedAt > at).length
  if (since === 0) return undefined
  return { text: s.focus.replace(/\s+/g, ' ').trim(), at, since }
}

/** The warm countdown as `CACHE ~3:48` while the session is idle (no main turn running) and the cache is still warm. */
export function cacheReadout(t: Timeline, now: number): string | undefined {
  if (turnClock(t, now) !== undefined) return undefined
  const warm = cacheLine(t).warmUntil
  if (warm === undefined || warm <= now) return undefined
  const s = Math.floor((warm - now) / 1000)
  return `CACHE ~${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The lintel's one readout: the turn clock while a main turn runs (amber from 80 % of its limit), else the warm countdown while idle. */
export function lintelReadout(ctx: ViewCtx): { right?: string; amber: boolean } {
  const { t, now } = ctx
  const tc = turnClock(t, now, needsLimits())
  if (tc !== undefined) {
    const n = t.turns.filter(x => x.agent === 'main').length
    return { right: `turn ${n} ${elapsed(tc.turn.startedAt, now)}`, amber: tc.level !== 'ok' }
  }
  const cache = cacheReadout(t, now)
  return cache !== undefined ? { right: cache, amber: false } : { amber: false }
}

/** The three rings Now shows (CTX, 5H, 7D) from the budget reading; a window that will not last to its reset has its name in amber. */
export function ringsOf(t: Timeline, now: number): Ring[] {
  const b = t.budget
  if (b === undefined) return []
  const p = pace(t, now)
  const out: Ring[] = []
  if (b.contextPct !== undefined) out.push({ name: 'CTX', pct: b.contextPct })
  for (const [name, label] of [['five_hour', '5H'], ['seven_day', '7D']] as const) {
    const w = b.windows.find(x => x.name === name)
    if (w !== undefined) out.push({ name: label, pct: w.pct, ...(p.windows.find(x => x.name === name)?.beforeReset === true ? { hot: true } : {}) })
  }
  return out
}

/** The BUDGET line of the hero: `▲ 5h full 37m` when a window will not last, else the context's tokens, else the figures. */
function budgetMeta(t: Timeline, now: number): Run {
  const hot = pace(t, now).windows.find(w => w.beforeReset === true)
  if (hot !== undefined) return { text: `▲ ${hot.name === 'five_hour' ? '5h' : hot.name === 'seven_day' ? '7d' : hot.name.replace(/_/g, ' ')} full ${elapsed(0, hot.fullIn)}`, color: C.wait }
  const b = t.budget
  if (b?.contextTokens !== undefined) return { text: `${tokenText(b.contextTokens)} of context`, dim: true }
  return { text: b?.contextPct !== undefined ? `context ${Math.round(b.contextPct)}%` : 'no reading yet', dim: true }
}

/** The lead's large character: working while the session works or waits, done when all is done, an outline when idle; waiting when the lead itself asks. */
export function leadSpec(ctx: ViewCtx): InstSpec {
  const { t, u, now } = ctx
  const asks = waitStates(t, u, now).get('main')
  const word = paneState(ctx).word
  const state = asks ?? (word === 'ALL DONE' ? 'done' : word === 'IDLE' ? 'queued' : 'working')
  return { key: 'lead', ...spriteOf({ id: 'main', type: 'main', status: t.agents.main?.status ?? 'running' }, now, state) }
}

/** The small crew in one Raster: `slots` places at a pitch of 6; more agents than places fold to a `+n` beside it. Unused places stay blank. */
export function crewSpec(pods: Pod[], slots: number): InstSpec {
  const over = pods.length > slots
  const shown = over ? pods.slice(0, Math.max(0, slots - 1)) : pods
  const columns = slots * 6 - 1
  const make = (lamp: 'on' | 'dim'): Grid => {
    const g = new Grid(columns, 2)
    shown.forEach((p, i) => drawSprite(g, i * 6, 0, p.role, p.state, 'S', lamp))
    return g
  }
  const working = shown.some(p => p.state === 'working')
  return {
    key: 'crew',
    columns,
    rows: 2,
    sig: `crew:${slots}:${shown.map(p => `${p.role}:${p.state}`).join(',')}`,
    frames: () => (working ? [make('on'), make('dim')] : [make('on')]),
    fallback: [crewRow(pods, Math.max(1, slots)), [{ text: '' }]],
  }
}

/** The plan strip: one column per task, its height the tokens it took, its colour its state; more tasks than cells are bucketed. */
export function planSpec(t: Timeline, cells: number): InstSpec {
  const rows = taskMeter(t).rows
  const per = Math.max(1, Math.ceil(rows.length / cells))
  const vals: number[] = []
  const hues: Ink[] = []
  for (let i = 0; i < rows.length; i += per) {
    const group = rows.slice(i, i + per)
    vals.push(group.reduce((n, r) => n + r.tokens, 0))
    const live = group.some(r => r.task.status === 'in_progress')
    hues.push(live ? 'iris' : group.every(r => r.task.status === 'completed') ? 'mute' : 'rest')
  }
  if (vals.length === 0) {
    vals.push(0)
    hues.push('rest')
  }
  return barsSpec('plan', 1, vals, hues)
}

/** The step trace: `cells` buckets of step starts over the session, a bucket with an error red. */
function traceSpec(t: Timeline, now: number, cells: 10 | 22): InstSpec {
  const times = t.steps.map(x => x.startedAt)
  const from = times.length > 0 ? Math.min(...times) : now
  const vals = buckets(times, from, now, cells)
  const bad = buckets(t.steps.filter(x => x.status === 'error').map(x => x.startedAt), from, now, cells)
  return barsSpec('trace', 1, vals, vals.map((_, i) => (bad[i]! > 0 ? 'red' : 'iris')))
}

export type FrameParts = {
  /** The width the frame is drawn for: the pane, or a strip compartment. */
  cols: number
  /** Waiting things (the strip's `NEXT` row says so). */
  count: number
  /** A strip compartment: the hero's third line is `next`, there is no BUDGET line or rings, and presses take `press`. */
  strip?: boolean
  /** A narrow strip compartment (96 to 116): three bead meters take the rings' place. */
  beads?: boolean
  /** The deck rows this height keeps. */
  keep?: { next: boolean; steps: boolean; tasks?: boolean }
  /** What a press does after its own write (the strip leaves for the pane). */
  press?: (f: () => void | Promise<void>) => () => void | Promise<void>
  /** The frame's key prefix: `now` in the pane, `strip-now` in a compartment. */
  key?: string
  /** The pane's ring starts on the CREW row (nothing waits, so no NEEDS YOU item takes it). */
  focus?: boolean
}

const keepAll = { next: true, steps: true, tasks: true }

/** The rows of the rich Now frame: lintel (1), hero (4), the deck rows, sill (1). */
export function frameRows(t: Timeline, now: number, p: FrameParts): number {
  const k = p.keep ?? keepAll
  const stale = staleFocus(t, now) !== undefined
  const next = k.next && (p.strip === true ? p.count > 0 : summary(t).next !== undefined)
  return 2 + 4 + (stale ? 1 : 0) + (next ? 1 : 0) + 2 + (k.tasks !== false ? 1 : 0) + (k.steps ? 1 : 0) + (p.beads === true && t.budget !== undefined ? 2 : 0)
}

/**
 * Now's frame in the rich look (spec "Screens: Now"): the lintel with the
 * state pill and the turn clock (the warm countdown while idle); the hero (the
 * lead's character, the focus on two lines, the running step, the BUDGET
 * line, three rings); NEXT, CREW, TASKS and STEPS as label-Button rows with
 * their instruments beside them; the sill. A stale focus gives the hero to the
 * latest activity and keeps the focus in a dim row of its own.
 */
export function nowFrame(ctx: ViewCtx, $: EngineInterface, p: FrameParts): RenderElement {
  const { Box } = $.ui.resolve(ctx.e)
  const { t, now } = ctx
  const cols = p.cols
  const sub = { ...ctx, cols }
  const k = p.keep ?? keepAll
  const key = p.key ?? 'now'
  const press = p.press ?? ((f: () => void | Promise<void>) => f)
  const s = summary(t)
  const hl = headline(t)
  const state = paneState(ctx)
  const ro = lintelReadout(ctx)
  const stale = staleFocus(t, now)
  const bySeq = [...t.steps].sort((a, b) => b.seq - a.seq)
  const running = bySeq.find(x => x.status === 'running') ?? bySeq[0]
  const stepRuns = (x: Step, bold: boolean): Run[] => {
    const color = statusColor(x.status)
    return [
      { text: STEP_GLYPH[x.status], ...(color !== undefined ? { color } : { dim: true }), ...(bold ? { bold: true } : {}) },
      { text: ` ${x.tool} ${argOf(x.tool, x.label)}`.trimEnd(), ...(bold ? { bold: true } : {}) },
      { text: `  ${x.status === 'running' ? 'now' : elapsed(x.endedAt ?? x.startedAt, now)}`, dim: true },
    ]
  }
  const openHero = (x: Step) => press(() => openStep($, x.id, 'hero-step'))
  const lines: { key?: string; runs: string | Run[]; onPress?: () => void | Promise<void>; lines?: 1 | 2 }[] = []
  if (stale !== undefined && running !== undefined) {
    // The latest activity leads; who and how long, and how far the focus is behind.
    lines.push({ key: 'hero-step', runs: stepRuns(running, true), onPress: openHero(running) })
    lines.push({ key: 'hero-who', runs: [{ text: `${who(t, running.agent)} · ${running.status === 'running' ? 'running' : elapsed(running.endedAt ?? running.startedAt, now)}`, dim: true }] })
    lines.push({ key: 'hero-since', runs: [{ text: `${stale.since} ${stale.since === 1 ? 'step' : 'steps'} since the focus`, dim: true }] })
  } else {
    if (hl.isIdle) lines.push({ key: 'hero-focus', runs: [{ text: hl.text, dim: true }] })
    else lines.push({ key: 'hero-focus', runs: hl.text, lines: 2 })
    if (running !== undefined) lines.push({ key: 'hero-step', runs: stepRuns(running, false), onPress: openHero(running) })
    if (p.strip === true && s.next !== undefined) lines.push({ key: 'hero-next', runs: [{ text: 'next  ', dim: true }, { text: s.next, dim: true }] })
  }
  const rings = p.strip === true ? [] : ringsOf(t, now)
  if (p.strip !== true && t.budget !== undefined) {
    lines.push({ key: 'deck-budget', runs: [{ text: 'BUDGET ', dim: true }, budgetMeta(t, now)], onPress: press(() => setBudgetOpen($, true)) })
  }
  const heroEl = hero(sub, $, {
    key: `${key}-hero`,
    who: leadSpec(ctx),
    lines,
    ...(rings.length > 0 ? { right: ringsSpec('dials', rings) } : {}),
  })

  const rows: DeckRowSpec[] = []
  const at = DECK.gauge
  const cell = (col: number, text: string, extra: Omit<Run, 'text'> = {}): Placed => ({ col, text, ...extra })
  if (stale !== undefined) {
    rows.push({ key: 'deck-focus', label: [{ text: `FOCUS ${elapsed(stale.at, now)}`, color: C.wait }], cells: [cell(at, stale.text, { dim: true })] })
  }
  if (k.next) {
    if (p.strip === true && p.count > 0) {
      rows.push({ key: 'deck-wait', label: [{ text: 'WAITING', color: C.wait, bold: true }], cells: [cell(at, `${p.count} need you`, { color: C.wait, bold: true })] })
    } else if (p.strip !== true && s.next !== undefined) {
      rows.push({ key: 'deck-next', label: 'NEXT', cells: [cell(at, s.next)] })
    }
  }
  const pods = crewPods(ctx)
  const subs = subagents(t)
  const live = subs.filter(a => a.status === 'running').length
  const failed = subs.filter(a => a.status === 'error').length
  const slots = Math.max(1, Math.min(6, Math.floor((cols - at - 10 + 1) / 6)))
  const crew = crewSpec(pods, slots)
  const crewAfter = at + crew.columns + 1
  const over = pods.length > slots ? pods.length - (slots - 1) : 0
  const crewCells: Placed[] = []
  if (over > 0) crewCells.push(cell(crewAfter, `+${over}`, { dim: true }))
  if (failed > 0) crewCells.push(cell(crewAfter + (over > 0 ? `+${over}`.length + 1 : 0), `${failed} failed`, { color: C.fail, bold: true }))
  rows.push({
    key: 'deck-crew',
    label: 'CREW',
    onPress: press(() => openTab($, 'agents')),
    ...(p.focus === true ? { autoFocus: true } : {}),
    sub: [{ text: `${live} live`, ...(live > 0 ? { bold: true } : { dim: true }) }],
    inst: crew,
    cells: crewCells,
  })
  const barCells: 10 | 22 = cols >= 62 || p.strip === true ? 22 : 10
  const valueAt = DECK.value
  const asideAt = cols >= 62 ? DECK.aside : valueAt + 6
  const times = t.steps.map(x => x.startedAt)
  const from = times.length > 0 ? Math.min(...times) : now
  if (k.tasks !== false) {
    rows.push({
      key: 'deck-tasks',
      label: 'TASKS',
      onPress: press(() => openTab($, 'tasks')),
      ...(s.total > 0 ? { inst: planSpec(t, barCells) } : {}),
      cells:
        s.total > 0
          ? [cell(valueAt, `${s.done}/${s.total}`, { bold: true }), ...(times.length > 0 ? [cell(asideAt, elapsed(from, now), { dim: true })] : [])]
          : [cell(at, '–', { dim: true })],
    })
  }
  if (k.steps) {
    rows.push({
      key: 'deck-steps',
      label: 'STEPS',
      onPress: press(() => openTab($, 'timeline')),
      inst: traceSpec(t, now, barCells),
      cells: [cell(valueAt, String(s.steps), { bold: true }), ...(s.errors > 0 ? [cell(asideAt, `${s.errors} ${s.errors === 1 ? 'error' : 'errors'}`, { color: C.fail })] : [])],
    })
  }
  if (p.beads === true) {
    const b = t.budget
    const meters: { name: string; pct: number }[] = []
    if (b?.contextPct !== undefined) meters.push({ name: 'CTX', pct: b.contextPct })
    for (const [name, label] of [['five_hour', '5H'], ['seven_day', '7D']] as const) {
      const w = b?.windows.find(x => x.name === name)
      if (w !== undefined) meters.push({ name: label, pct: w.pct })
    }
    if (meters.length > 0) {
      rows.push({ key: 'deck-budget', label: 'BUDGET', onPress: press(() => setBudgetOpen($, true)), inst: beadsRow(meters) })
      rows.push({ key: 'deck-budget-figures', cells: meters.map((m, i) => cell(at + i * 12, `${m.name} ${Math.round(m.pct)}%`, { dim: true })) })
    }
  }
  const tone = state.word === 'WAITING' ? ('warning' as const) : ('accent' as const)
  const lintelAt = (right: string | undefined, amber: boolean): InstSpec =>
    lintelSpec(`${key}-lintel`, cols, { tone, pill: state.word, pillTone: toneOf(state.color), ...(right !== undefined ? { right, rightAmber: amber } : {}) })
  // While idle and warm the readout is the countdown: the clock blits this lintel alone (countdown.ts), not the pane.
  const site = ctx.site ?? 'mission-control'
  if (cacheReadout(t, now) !== undefined && ro.right !== undefined) setCountdown(site, `${key}-lintel`, at => lintelAt(cacheReadout(t, at), false))
  else clearCountdown(site, `${key}-lintel`)
  return (
    <Box key={key} flexDirection="column">
      {inst(sub, $, lintelAt(ro.right, ro.amber))}
      {heroEl}
      {rows.map(r => deckRowEl(sub, $, cols, r, p.strip !== true))}
      {inst(sub, $, sillSpec(`${key}-sill`, cols, { tone }))}
    </Box>
  )
}

/** Three bead meters side by side in one Raster, at the figures' pitch of 12. */
function beadsRow(meters: { name: string; pct: number }[]): InstSpec {
  const columns = meters.length * 12 - 2
  return {
    key: 'budget-beads',
    columns,
    rows: 1,
    sig: `beads3:${meters.map(m => `${m.name}${Math.round(m.pct)}`).join(',')}`,
    frames: () => {
      const g = new Grid(columns, 1)
      meters.forEach((m, i) => drawBeads(g, i * 12, 0, 10, m.pct))
      return [g]
    },
    fallback: [
      meters.flatMap((m, i): Run[] => {
        const lit = m.pct >= 100 ? 10 : m.pct > 0 ? Math.max(1, Math.min(9, Math.floor(m.pct / 10))) : 0
        return [{ text: '▮'.repeat(lit), color: C.live }, { text: '▯'.repeat(10 - lit), color: C.subtle }, ...(i < meters.length - 1 ? [{ text: '  ' }] : [])]
      }),
    ],
  }
}

/** The height rule's rows for one section: its `n` rows, the last `+ k more` when the list is longer than the room. */
function listRows<T>(ctx: ViewCtx, $: EngineInterface, items: T[], n: number, make: (x: T, i: number) => RenderElement): RenderElement[] {
  if (items.length <= n) return items.map(make)
  if (n < 2) return items.slice(0, n).map(make)
  return [...items.slice(0, n - 1).map(make), more(ctx, $, items.length - (n - 1))]
}

function agentsBlockN(ctx: ViewCtx, $: EngineInterface, n: number): RenderElement[] {
  const waits = waitStates(ctx.t, ctx.u, ctx.now)
  const subs = subagents(ctx.t)
  const live = subs.filter(a => a.status === 'running').sort((a, b) => a.startedAt - b.startedAt)
  const failed = subs.filter(a => a.status === 'error').sort((a, b) => b.startedAt - a.startedAt)
  const items = [...live, ...failed]
  if (items.length === 0 || n <= 0) return []
  const rows = listRows(ctx, $, items, n, a => {
    const hull = podFor(a, waits, ctx.now).hull
    return row(ctx, $, {
      key: `agent-${a.id}`,
      glyph: hull.text,
      ...(hull.color !== undefined ? { glyphColor: hull.color } : {}),
      name: shortPaths(a.description || a.type),
      metric: agentTokens(a),
      time: a.status === 'error' ? { text: 'failed', color: C.fail } : elapsed(a.startedAt, ctx.now),
      onPress: () => openAgentPage($, a.id, `agent-${a.id}`),
    })
  })
  return [section(ctx, $, 'AGENTS', 'tokens', 'time'), ...rows]
}

/** LATEST in rich Now: the step running (else the newest) and the newest error first, then the rest newest first. */
function latestBlockN(ctx: ViewCtx, $: EngineInterface, n: number): RenderElement[] {
  const { t, now, e } = ctx
  const lead = latestSteps(t)
  const rest = [...t.steps].sort((a, b) => b.seq - a.seq).filter(x => !lead.some(l => l.id === x.id))
  const steps = [...lead, ...rest]
  if (steps.length === 0 || n <= 0) return []
  const rows = listRows(ctx, $, steps, n, x =>
    row(ctx, $, {
      key: `step-${x.id}`,
      ...(isOnScreen(e.surface, x.id) ? { flag: 'inView' as const } : {}),
      glyph: STEP_GLYPH[x.status],
      glyphColor: statusColor(x.status),
      tool: x.tool,
      name: argOf(x.tool, x.label),
      metric: who(t, x.agent),
      time: x.status === 'running' ? 'now' : elapsed(x.endedAt ?? x.startedAt, now),
      onPress: () => openStep($, x.id, `step-${x.id}`),
    }),
  )
  return [section(ctx, $, 'LATEST', 'agent', 'time'), ...rows]
}

/** THIS TURN (spec "Done signal"): what the turn that just ended did, in LATEST's place. */
export function turnLines(t: Timeline): { glyph: string; color?: string; text: string }[] {
  const x = thisTurn(t)
  if (x === undefined || x.ms === undefined) return []
  const out: { glyph: string; color?: string; text: string }[] = []
  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`
  if (x.tasksClosed.length > 0) out.push({ glyph: '✓', color: C.result, text: `${plural(x.tasksClosed.length, 'task')} closed` })
  if (x.agentsFinished.length > 0) out.push({ glyph: '✓', color: C.result, text: `${plural(x.agentsFinished.length, 'agent')} finished` })
  if (x.files > 0) out.push({ glyph: '·', text: `${plural(x.files, 'file')} changed` })
  if (x.errors > 0) out.push({ glyph: '✖', color: C.fail, text: plural(x.errors, 'error') })
  if (out.length > 0) out.unshift({ glyph: '·', text: `ran ${elapsed(0, x.ms)}` })
  return out
}

function turnBlockN(ctx: ViewCtx, $: EngineInterface, n: number): RenderElement[] {
  const lines = turnLines(ctx.t)
  if (lines.length === 0 || n <= 0) return []
  const rows = lines.slice(0, n).map((l, i) =>
    runsLine(ctx.e, $, [{ col: COL.glyph, text: l.glyph, ...(l.color !== undefined ? { color: l.color } : { dim: true }) }, { col: COL.name, text: l.text }], `turn-${i}`),
  )
  return [section(ctx, $, 'THIS TURN', undefined, undefined, { key: 'sec-this-turn' }), ...rows]
}

const taskGlyph = { in_progress: '▸', pending: '▫', completed: '▪' } as const

function tasksBlockN(ctx: ViewCtx, $: EngineInterface, n: number): RenderElement[] {
  const { t } = ctx
  if (t.tasks.length === 0 || n <= 0) return []
  const meter = new Map(taskMeter(t).rows.map(r => [taskKey(r.task), r]))
  const of = (status: 'in_progress' | 'pending' | 'completed') => t.tasks.filter(x => x.status === status)
  const items = [...of('in_progress'), ...of('pending'), ...of('completed').sort((a, b) => b.updatedAt - a.updatedAt)]
  const rows = listRows(ctx, $, items, n, x => {
    const m = meter.get(taskKey(x))
    const isActive = x.status === 'in_progress'
    return row(ctx, $, {
      key: `task-${x.owner}-${x.id}`,
      glyph: taskGlyph[x.status],
      ...(isActive ? { glyphColor: C.live } : {}),
      name: isActive ? x.activeForm ?? x.subject : x.subject,
      ...(isActive ? { bold: true } : {}),
      ...(x.status === 'completed' ? { dim: true } : {}),
      ...(m !== undefined && m.tokens > 0 ? { metric: tokenText(m.tokens) } : {}),
      ...(m !== undefined && m.ms + m.agentMs > 0 ? { time: elapsed(0, m.ms + m.agentMs) } : {}),
      onPress: () => openPage($, 'task', `${x.owner}:${x.id}`, `task-${x.owner}-${x.id}`),
    })
  })
  return [section(ctx, $, 'TASKS', 'tokens', 'time'), ...rows]
}

function keptBlockN(ctx: ViewCtx, $: EngineInterface, n: number): RenderElement[] {
  const { t, e } = ctx
  const kept = t.steps.filter(x => x.pin !== undefined).sort((a, b) => b.seq - a.seq)
  if (kept.length === 0 || n <= 0) return []
  const note = kept.length < 3
  const shown = kept.slice(0, Math.min(kept.length, n))
  const rows = shown.map(x =>
    row(ctx, $, {
      key: `kept-${x.id}`,
      glyph: '★',
      glyphColor: C.spark,
      name: x.pin !== undefined && x.pin !== '' ? x.pin : argOf(x.tool, x.label),
      metric: x.tool,
      time: clock(x.startedAt),
      onPress: () => openStep($, x.id, `kept-${x.id}`),
    }),
  )
  const extra: RenderElement[] = []
  if (note && n > shown.length) extra.push(runsLine(e, $, [{ col: COL.name, text: wordFit(KEPT_NOTE, ctx.cols - COL.name), dim: true }], 'kept-note'))
  else if (kept.length > shown.length) extra.push(more(ctx, $, kept.length - shown.length))
  return [section(ctx, $, 'KEPT', 'step', 'at'), ...rows, ...extra]
}

function notesBlockN(ctx: ViewCtx, $: EngineInterface, n: number): RenderElement[] {
  const notes = [...ctx.t.notes].reverse().slice(0, n)
  if (notes.length === 0 || n <= 0) return []
  return [
    section(ctx, $, 'NOTES'),
    ...notes.map((x, i) =>
      runsLine(
        ctx.e,
        $,
        [
          { col: GRID.margin, text: '·', dim: true },
          { col: COL.name, text: wordFit(x.text.replace(/\s+/g, ' ').trim(), ctx.cols - COL.name) },
        ],
        `note-${i}`,
      ),
    ),
  ]
}

/** Which deck rows a pane of `bodyRows` keeps: under 24 rows STEPS goes, under 20 NEXT too. */
export function deckKeep(bodyRows: number): { next: boolean; steps: boolean } {
  return { steps: bodyRows >= DROP_STEPS_UNDER, next: bodyRows >= DROP_NEXT_UNDER }
}

/** How many rows each Now section gets with `spare` rows to deal (the height rule, `sectionRows`): the shown sections in display order. */
export function nowSections(ctx: ViewCtx, spare: number): { key: string; rows: number }[] {
  const { t } = ctx
  const bodyRows = ctx.bodyRows ?? 40
  const agentCount = subagents(t).filter(a => a.status === 'running' || a.status === 'error').length
  const kept = t.steps.filter(x => x.pin !== undefined).length
  const turn = turnLines(t).length
  const word = paneState(ctx).word
  const useTurn = word !== 'WORKING' && word !== 'WAITING' && turn > 0
  const got = sectionRows(spare, [
    { key: useTurn ? 'turn' : 'latest', count: useTurn ? turn : t.steps.length, ...NOW_SECTIONS.latest, ...(useTurn ? { cap: 5 } : {}) },
    { key: 'agents', count: agentCount, ...NOW_SECTIONS.agents },
    { key: 'tasks', count: bodyRows >= TASKS_FROM_ROWS ? t.tasks.length : 0, ...NOW_SECTIONS.tasks },
    { key: 'kept', count: kept > 0 ? kept + (kept < 3 ? 1 : 0) : 0, ...NOW_SECTIONS.kept },
    { key: 'notes', count: t.notes.length, ...NOW_SECTIONS.notes },
  ])
  const order = ['tasks', 'agents', 'latest', 'turn', 'kept', 'notes']
  return got.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
}

/** Now in the rich look: the amber frame when anything waits, the frame, the sections the height rule gives rows to, the footer. */
function richNow(ctx: ViewCtx, $: EngineInterface, count: number): RenderElement {
  const { Box } = $.ui.resolve(ctx.e)
  const bodyRows = ctx.bodyRows ?? 40
  const waiting = needsYou(ctx.t, ctx.u, ctx.now).length
  const parts: FrameParts = { cols: ctx.cols, count, focus: waiting === 0, keep: { ...deckKeep(bodyRows), tasks: true } }
  const bar = footer(ctx, $, hints($, count, false))
  // NEEDS YOU first (binding rule 2): it lists what waits in the rows the frame and footer leave; the sections share the rest.
  const frameH = frameRows(ctx.t, ctx.now, parts)
  const cap = needsCap(ctx, bodyRows - frameH - 1 - (bar !== null ? 2 : 0) - 6)
  const used = needsFrameRows(waiting, cap) + (waiting > 0 ? 1 : 0) + frameH + 1 + (bar !== null ? 2 : 0)
  const give = nowSections(ctx, Math.max(0, bodyRows - used))
  const rowsOf = (key: string): number => give.find(g => g.key === key)?.rows ?? 0
  const blocks = [
    needsSection(ctx, $, cap),
    nowFrame(ctx, $, parts),
    tasksBlockN(ctx, $, rowsOf('tasks')),
    agentsBlockN(ctx, $, rowsOf('agents')),
    latestBlockN(ctx, $, rowsOf('latest')),
    turnBlockN(ctx, $, rowsOf('turn')),
    keptBlockN(ctx, $, rowsOf('kept')),
    notesBlockN(ctx, $, rowsOf('notes')),
  ]
  return <Box flexDirection="column">{stack(ctx, $, [...blocks, bar])}</Box>
}
