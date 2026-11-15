import type { EngineInterface, RenderElement } from 'claude-code'

import type { Step, Tab, Timeline } from '../../types'
import { summary } from '../model/select'
import { leaveDetail, updateUi } from '../state'
import { budgetCells, budgetView, isBudgetOpen, setBudgetOpen, tokenText } from './budget'
import { buckets10, clock, elapsed, shortPaths, wordFit } from './fit'
import { argOf, headline, laid, runsLine } from './lay'
import type { Placed } from './lay'
import { moveNeed, needsSection, needsYou } from './needs'
import { isOnScreen } from './onscreen'
import { openStep } from './openstep'
import { barCell, blank, footer, more, readout, row, section, sparkCell, stackCell } from './parts'
import type { Hint, ReadoutCell } from './parts'
import type { ViewCtx } from './shell'
import { C, COL, GRID, statusColor, tableCols } from './style'

// From this width the pane is the inline strip: eight cells, two halves.
const STRIP = 96
const MAX_LIST = 6
const STEP_GLYPH: Record<Step['status'], string> = { running: '▸', done: '✓', error: '✖', denied: '✖', interrupted: '·' }
const KEPT_NOTE = 'kept steps are never trimmed and export in full'

const subagents = (t: Timeline) => Object.values(t.agents).filter(a => a.id !== 'main')
function openTab($: EngineInterface, tab: Tab): Promise<void> {
  return updateUi($, u => ({ ...leaveDetail(u), tab }))
}

/** An agent's tokens as `72k`, or `…` while it has reported none. */
const agentTokens = (a: { tokensIn?: number; tokensOut?: number }): string =>
  a.tokensIn !== undefined || a.tokensOut !== undefined ? tokenText((a.tokensIn ?? 0) + (a.tokensOut ?? 0)) : '…'

/** Now's readout cells: TASKS, AGENTS, STEPS, CTX and the hotter window, dropped by rank. */
function cellsOf(ctx: ViewCtx, $: EngineInterface): ReadoutCell[] {
  const { t, now } = ctx
  const s = summary(t)
  const subs = subagents(t)
  const live = subs.filter(a => a.status === 'running').length
  const failed = subs.filter(a => a.status === 'error').length
  const done = subs.length - live - failed
  const times = t.steps.map(x => x.startedAt)
  const from = times.length > 0 ? Math.min(...times) : now
  return [
    {
      label: 'TASKS',
      key: 'readout-tasks',
      onPress: () => openTab($, 'tasks'),
      value: s.total > 0 ? [{ text: String(s.done), bold: true }, { text: `/${s.total}`, dim: true }] : [{ text: '–', dim: true }],
      gfx: barCell(s.done, s.total),
    },
    {
      label: 'AGENTS',
      key: 'readout-agents',
      onPress: () => openTab($, 'agents'),
      value: [{ text: String(live), bold: true }, { text: ' live', dim: true }],
      gfx: stackCell([{ count: live, color: C.live }, { count: done }, { count: failed, color: C.fail }]),
    },
    {
      label: 'STEPS',
      key: 'readout-steps',
      onPress: () => openTab($, 'timeline'),
      drop: 2,
      value: [
        { text: String(s.steps), bold: true },
        ...(s.errors > 0 ? [{ text: ' ' }, { text: '✖', color: C.fail }, { text: ` ${s.errors}` }] : []),
      ],
      gfx: sparkCell(buckets10(times, from, now)),
    },
    ...budgetCells($, t),
  ]
}

/** The headline row and its `next` row. `cols` is the width of the half they sit in. */
function headRows(ctx: ViewCtx, $: EngineInterface, cols: number): RenderElement[] {
  const { t, now, e } = ctx
  const h = headline(t)
  const s = summary(t)
  const timeCol = tableCols(cols).time
  const room = (timeCol ?? cols) - 2 - COL.glyph
  const segs: Placed[] = [
    { col: 0, text: '▍', color: C.accent },
    { col: COL.glyph, text: wordFit(h.text, room), ...(h.isIdle ? { dim: true } : { bold: true }) },
  ]
  if (timeCol !== undefined && h.at !== undefined) segs.push({ col: timeCol, text: elapsed(h.at, now), dim: true })
  const out = [runsLine(e, $, segs, 'now-head')]
  if (s.next !== undefined) {
    out.push(
      runsLine(e, $, [{ col: COL.glyph, text: 'next', dim: true }, { col: 8, text: wordFit(s.next, cols - 8) }], 'now-next'),
    )
  }
  return out
}

function agentsBlock(ctx: ViewCtx, $: EngineInterface): RenderElement[] {
  const live = subagents(ctx.t)
    .filter(a => a.status === 'running')
    .sort((a, b) => a.startedAt - b.startedAt)
  if (live.length === 0) return []
  const rows = live.slice(0, MAX_LIST).map(a =>
    row(ctx, $, {
      key: `agent-${a.id}`,
      glyph: '▸',
      glyphColor: C.live,
      name: shortPaths(a.description || a.type),
      metric: agentTokens(a),
      time: elapsed(a.startedAt, ctx.now),
      onPress: () => updateUi($, u => ({ ...leaveDetail(u), tab: 'agents', agentOpen: a.id })),
    }),
  )
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

const who = (t: Timeline, agent: string): string => (agent === 'main' ? 'main' : t.agents[agent]?.type ?? agent)

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
      onPress: () => openStep($, x.id),
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
      glyphColor: C.live,
      name: x.pin !== undefined && x.pin !== '' ? x.pin : argOf(x.tool, x.label),
      metric: x.tool,
      time: clock(x.startedAt),
      onPress: () => openStep($, x.id),
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

const HALF = 50
// The right half's own columns: glyph 2, name 4, metric 24, time 36.
const RIGHT = { glyph: 2, name: 4, nameEnd: 22, arg: 10, metric: 24, time: 36 }

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

/** The right half: AGENTS (two rows), a blank, LATEST (one row). Six rows. */
function stripRight(ctx: ViewCtx, $: EngineInterface): RenderElement[] {
  const { t, now } = ctx
  const out: RenderElement[] = []
  const live = subagents(t)
    .filter(a => a.status === 'running')
    .sort((a, b) => a.startedAt - b.startedAt)
  const agentRow = (a: (typeof live)[number]): RenderElement =>
    stripRow($, ctx, {
      key: `agent-${a.id}`,
      glyph: '▸',
      color: C.live,
      name: shortPaths(a.description || a.type),
      metric: agentTokens(a),
      time: elapsed(a.startedAt, now),
      onPress: () => updateUi($, u => ({ ...leaveDetail(u), tab: 'agents', agentOpen: a.id })),
    })
  if (live.length > 0) {
    out.push(stripHead($, ctx, 'AGENTS', 'tokens', 'time', 'strip-agents'))
    if (live.length <= 2) out.push(...live.map(agentRow))
    else out.push(agentRow(live[0]!), runsLine(ctx.e, $, [{ col: RIGHT.glyph, text: '+', dim: true }, { col: RIGHT.name, text: `${live.length - 1} more`, dim: true }], 'strip-more'))
  }
  const steps = latestSteps(t)
  // One LATEST row: the newest error when there is one, else the step in flight.
  const x = steps.find(s => s.status === 'error') ?? steps[0]
  if (x !== undefined) {
    if (out.length > 0) out.push(blank(ctx, $, 'strip-gap'))
    out.push(
      stripHead($, ctx, 'LATEST', 'agent', 'time', 'strip-latest'),
      stripRow($, ctx, {
        key: `step-${x.id}`,
        glyph: STEP_GLYPH[x.status],
        ...(statusColor(x.status) !== undefined ? { color: statusColor(x.status)! } : {}),
        tool: x.tool,
        name: argOf(x.tool, x.label),
        metric: who(t, x.agent),
        time: x.status === 'running' ? 'now' : elapsed(x.endedAt ?? x.startedAt, now),
        onPress: () => openStep($, x.id),
      }),
    )
  }
  return out
}

function stripView(ctx: ViewCtx, $: EngineInterface, count: number): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const left = { ...ctx, cols: HALF }
  const head = headRows(left, $, HALF)
  if (count > 0 && head.length > 1) {
    head[1] = runsLine(ctx.e, $, [{ col: COL.glyph, text: `▲ ${count} need you`, color: C.wait, bold: true }], 'now-wait')
  }
  const cells = readout(left, $, cellsOf(left, $))
  const leftRows = [...head, blank(ctx, $, 'strip-blank'), ...(cells !== null ? [cells] : [])]
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
 * The Now tab (spec "Now"): headline and `next`; NEEDS YOU when anything
 * waits; the readout (TASKS, AGENTS, STEPS, CTX, 7D or 5H); AGENTS live only;
 * LATEST; KEPT; NOTES; the footer while the pane has the focus. From 96
 * columns the inline strip: the headline and four cells left, AGENTS and
 * LATEST right. The budget view replaces both while it is open.
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
    headRows(ctx, $, ctx.cols),
    needsSection(ctx, $),
    readout(ctx, $, cellsOf(ctx, $)),
    agentsBlock(ctx, $),
    latestBlock(ctx, $),
    keptBlock(ctx, $),
    notesBlock(ctx, $),
  ]
  const bar = footer(ctx, $, hints($, count, false))
  return <Box flexDirection="column">{stack(ctx, $, [...blocks, bar])}</Box>
}
