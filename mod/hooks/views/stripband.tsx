import type { EngineInterface, RenderElement } from 'claude-code'

import type { Step, TaskItem } from '../../types'
import { summary } from '../model/select'
import type { Problem } from '../model/select'
import { leaveDetail, updateUi } from '../state'
import { resetClock, setBudgetOpen } from './budget'
import { elapsed, meter, shortPaths, wordFit } from './fit'
import { argOf, laid, runsLine } from './lay'
import type { Placed } from './lay'
import { needsYou, podFor, problemText, waitStates } from './needs'
import { openStepInline } from './openstep'
import { andThen, agentTokens, HALF, MAX_LIST, nowRows, RIGHT, STEP_GLYPH, STRIP, stripRight, subagents, who } from './overview'
import { blank, deckRows } from './parts'
import type { DeckRow } from './parts'
import type { ViewCtx } from './shell'
import { C, cellCol, GRID, statusColor } from './style'

// ---------- the band's strip (`/mc strip`) ----------

/** The strip's height at most: the Now deck's six rows. */
const STRIP_ROWS = 6
/** From this width the strip has a compartment for AGENTS and one for LATEST. */
const THREE_FROM = 140
/** From this width it adds NEEDS YOU (or TASKS) and BUDGET. */
const FIVE_FROM = 180
/** The gap between compartments: 3 columns, or 2 where 3 would drop one. */
const GAPS = [3, 2]
/** Deck rows the strip gives up first when it is short of rows; FOCUS goes last. */
const DECK_DROP = ['deck-budget', 'deck-steps', 'deck-next', 'deck-tasks', 'deck-crew', 'deck-wait']
/** Under this many columns the stacked strip has no room for the right half's time column. */
const STACK_RIGHT_FROM = RIGHT.time + GRID.content + 2

/**
 * The narrowest each compartment is drawn: NOW keeps its deck cells to 50;
 * AGENTS and LATEST keep a name or argument of 22 from 14 and the time on
 * cell 38. NOW and BUDGET keep their width; the lists take what is spare.
 */
const MIN = { now: HALF, tasks: 22, agents: 42, latest: 42, budget: 24 } as const
/** The room a time takes in its cell: `8s`, `2m`, `1h04`, `12h`. */
const TIME = 4

/**
 * What the band's strip is handed: the rows the band may take (its
 * `maxRows`), the band's own compact line to draw under the strip, and
 * what a press does once its own write is done (the pane opens).
 */
export type BandStrip = { maxRows: number; line: RenderElement; after: () => Promise<void> }

/** The deck in at most `room` rows: rows go in DECK_DROP's order, then from the bottom. */
function trimDeck(rows: DeckRow[], room: number): DeckRow[] {
  let out = rows
  for (const key of DECK_DROP) {
    if (out.length <= room) break
    out = out.filter(r => r.key !== key)
  }
  return out.slice(0, Math.max(0, room))
}

/** The index of the last 12-column cell of a compartment `w` wide that still holds `need` columns. */
function lastIndex(w: number, need: number): number {
  return Math.max(0, Math.floor((w - GRID.margin - need) / GRID.cell))
}

/** A span short enough for TIME: `1h04` as it is, `12h05` as `12h`. */
function brief(span: string): string {
  return span.length <= TIME ? span : span.replace(/h\d\d$/, 'h')
}

/**
 * `text` cut at a word to `room`, as `wordFit` does, or '' when not even
 * its first word fits: a compartment never cuts inside a word.
 */
function whole(text: string, room: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (one.length <= room) return one
  const first = one.split(' ')[0] ?? ''
  if (first.length + 1 > room) return ''
  return wordFit(one, room)
}

/**
 * One compartment row from column 0 of the compartment. With `onPress` it
 * is a plain Button (no hotkey) holding the runs from column 2.
 */
function line(ctx: ViewCtx, $: EngineInterface, segs: Placed[], key: string, onPress?: () => void | Promise<void>): RenderElement {
  if (onPress === undefined) return runsLine(ctx.e, $, segs, key)
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  return (
    <Box key={`row-${key}`} flexDirection="row">
      <Text>{'  '}</Text>
      <Button key={key} plain onPress={onPress}>
        {laid(segs.filter(s => s.col >= GRID.margin), GRID.margin, ctx.e, $, `${key}-`)}
      </Button>
    </Box>
  )
}

/** A compartment's head: `┌` at 0, the label at 2 in bold, dim column names after. */
function head(ctx: ViewCtx, $: EngineInterface, label: string, meta: Placed[], key: string, color: string = C.accent): RenderElement {
  return runsLine(ctx.e, $, [
    { col: 0, text: '┌', color },
    { col: 2, text: label, bold: true, ...(color !== C.accent ? { color } : {}) },
    ...meta.map(m => ({ ...m, dim: true })),
  ], key)
}

/** One dim row saying the compartment has nothing. */
function none(ctx: ViewCtx, $: EngineInterface, text: string, key: string): RenderElement {
  return runsLine(ctx.e, $, [{ col: 4, text, dim: true }], key)
}

/**
 * AGENTS in `h` rows `w` wide: the head, then each live subagent (hull at 2,
 * what it does from 4, its tokens in the last-but-one cell when there are
 * five cells, its time in the last cell), the last row `+ n more` when they
 * do not all fit.
 */
function agentsRows(ctx: ViewCtx, $: EngineInterface, w: number, h: number, after: () => Promise<void>): RenderElement[] {
  if (h <= 0) return []
  const { t, now } = ctx
  const live = subagents(t)
    .filter(a => a.status === 'running')
    .sort((a, b) => a.startedAt - b.startedAt)
  const li = lastIndex(w, TIME)
  const last = cellCol(li)
  const tokCol = li >= 4 ? cellCol(li - 1) : undefined
  const nameEnd = (tokCol ?? last) - 2
  const meta: Placed[] = [...(tokCol !== undefined ? [{ col: tokCol, text: 'tokens' }] : []), { col: last, text: 'time' }]
  const out = [head(ctx, $, 'AGENTS', meta, 'strip-agents')]
  if (h === 1) return out
  if (live.length === 0) return [...out, none(ctx, $, 'none live', 'strip-agents-none')]
  const slots = h - 1
  const shown = live.length <= slots ? live : live.slice(0, slots - 1)
  const waits = waitStates(t, ctx.u, now)
  for (const a of shown) {
    const hull = podFor(a, waits, now).hull
    out.push(
      line(ctx, $, [
        { col: 2, text: hull.text, ...(hull.color !== undefined ? { color: hull.color } : { dim: true }) },
        { col: 4, text: whole(shortPaths(a.description || a.type), nameEnd - 4) },
        ...(tokCol !== undefined ? [{ col: tokCol, text: agentTokens(a), dim: true }] : []),
        { col: last, text: brief(elapsed(a.startedAt, now)), dim: true },
      ], `agent-${a.id}`, andThen(() => updateUi($, u => ({ ...leaveDetail(u), tab: 'agents', agentOpen: a.id })), after)),
    )
  }
  if (shown.length < live.length) {
    out.push(runsLine(ctx.e, $, [{ col: 2, text: '+', dim: true }, { col: 4, text: `${live.length - shown.length} more`, dim: true }], 'strip-agents-more'))
  }
  return out
}

/** The steps LATEST lists: the newest error, the one running, then the rest newest first. */
function latestOrder(steps: Step[]): Step[] {
  const bySeq = [...steps].sort((a, b) => b.seq - a.seq)
  const error = bySeq.find(x => x.status === 'error')
  const running = bySeq.find(x => x.status === 'running')
  const first = [error, running].filter((x): x is Step => x !== undefined)
  return [...first, ...bySeq.filter(x => !first.includes(x))]
}

/** A tool's name as drawn: an MCP tool by its own last part. */
const toolName = (tool: string): string => {
  const parts = tool.split('__')
  return parts[parts.length - 1] ?? tool
}

/**
 * LATEST in `h` rows `w` wide: the head, then steps (glyph at 2, the tool
 * dim at 4, its argument from 14 or after the tool, the agent in the
 * last-but-one cell when there are five cells, the time in the last).
 */
function latestRows(ctx: ViewCtx, $: EngineInterface, w: number, h: number, after: () => Promise<void>): RenderElement[] {
  if (h <= 0) return []
  const { t, now } = ctx
  const li = lastIndex(w, TIME)
  const last = cellCol(li)
  const agentCol = li >= 4 ? cellCol(li - 1) : undefined
  const meta: Placed[] = [...(agentCol !== undefined ? [{ col: agentCol, text: 'agent' }] : []), { col: last, text: 'time' }]
  const out = [head(ctx, $, 'LATEST', meta, 'strip-latest')]
  if (h === 1) return out
  const steps = latestOrder(t.steps).slice(0, h - 1)
  if (steps.length === 0) return [...out, none(ctx, $, 'no steps yet', 'strip-latest-none')]
  const end = (agentCol ?? last) - 2
  for (const x of steps) {
    const tool = whole(toolName(x.tool), end - 4)
    const argCol = Math.max(cellCol(1), 4 + tool.length + 2)
    const color = statusColor(x.status)
    out.push(
      line(ctx, $, [
        { col: 2, text: STEP_GLYPH[x.status], ...(color !== undefined ? { color } : { dim: true }) },
        { col: 4, text: tool, dim: true },
        { col: argCol, text: whole(argOf(x.tool, x.label), end - argCol) },
        ...(agentCol !== undefined ? [{ col: agentCol, text: whole(who(t, x.agent), last - 2 - agentCol), dim: true }] : []),
        { col: last, text: x.status === 'running' ? 'now' : brief(elapsed(x.endedAt ?? x.startedAt, now)), dim: true },
      ], `step-${x.id}`, andThen(() => openStepInline($, x.id), after)),
    )
  }
  return out
}

/**
 * AGENTS and LATEST in one compartment (96 to 139 columns): AGENTS whole,
 * a blank and LATEST filling the rest; short of rows, LATEST keeps its head
 * and one step, then the blank goes, then LATEST.
 */
function activityRows(ctx: ViewCtx, $: EngineInterface, w: number, h: number, after: () => Promise<void>): RenderElement[] {
  const live = subagents(ctx.t).filter(a => a.status === 'running').length
  const agentsNeed = 1 + Math.max(1, live)
  if (h >= agentsNeed + 3) return [...agentsRows(ctx, $, w, agentsNeed, after), blank(ctx, $, 'strip-gap'), ...latestRows(ctx, $, w, h - agentsNeed - 1, after)]
  if (h >= 5) return [...agentsRows(ctx, $, w, h - 3, after), blank(ctx, $, 'strip-gap'), ...latestRows(ctx, $, w, 2, after)]
  if (h >= 4) return [...agentsRows(ctx, $, w, h - 2, after), ...latestRows(ctx, $, w, 2, after)]
  return agentsRows(ctx, $, w, h, after)
}

const TASK_GLYPH: Record<TaskItem['status'], string> = { in_progress: '▸', pending: '▫', completed: '▪' }

/** TASKS in `h` rows: the head with done/total, then the active tasks, the queued ones, then the newest done. */
function tasksRows(ctx: ViewCtx, $: EngineInterface, w: number, h: number, after: () => Promise<void>): RenderElement[] {
  if (h <= 0) return []
  const s = summary(ctx.t)
  const count = `${s.done}/${s.total}`
  const last = cellCol(lastIndex(w, count.length))
  const meta: Placed[] = s.total > 0 && last > 2 + 'TASKS'.length + 1 ? [{ col: last, text: count }] : []
  const out = [head(ctx, $, 'TASKS', meta, 'strip-tasks')]
  if (h === 1) return out
  const of = (status: TaskItem['status']) => ctx.t.tasks.filter(x => x.status === status)
  const done = of('completed').sort((a, b) => b.updatedAt - a.updatedAt)
  const list = [...of('in_progress'), ...of('pending'), ...done].slice(0, h - 1)
  if (list.length === 0) return [...out, none(ctx, $, 'no tasks', 'strip-tasks-none')]
  for (const x of list) {
    const isActive = x.status === 'in_progress'
    const subject = isActive ? x.activeForm ?? x.subject : x.subject
    out.push(
      line(ctx, $, [
        { col: 2, text: TASK_GLYPH[x.status], ...(isActive ? { color: C.live } : { dim: true }) },
        { col: 4, text: whole(subject, w - 4), ...(isActive ? { bold: true } : x.status === 'completed' ? { dim: true } : {}) },
      ], `task-${x.owner}-${x.id}`, andThen(() => updateUi($, u => ({ ...leaveDetail(u), tab: 'tasks' })), after)),
    )
  }
  return out
}

/** NEEDS YOU in `h` rows: the head in warning, then each thing waiting with how long. */
function needsRows(ctx: ViewCtx, $: EngineInterface, w: number, h: number, needs: Problem[], after: () => Promise<void>): RenderElement[] {
  if (h <= 0) return []
  const last = cellCol(lastIndex(w, TIME))
  const out = [head(ctx, $, 'NEEDS YOU', [{ col: last, text: 'for' }], 'strip-needs', C.wait)]
  for (const p of needs.slice(0, h - 1)) {
    const glyph = p.kind === 'asking' ? '?' : p.kind === 'stalled' ? '▲' : '✖'
    const color = p.kind === 'asking' || p.kind === 'stalled' ? C.wait : C.fail
    const stepId = p.stepId
    const press = stepId !== undefined ? () => openStepInline($, stepId) : () => updateUi($, u => ({ ...leaveDetail(u), tab: 'overview' }))
    out.push(
      line(ctx, $, [
        { col: 2, text: glyph, bold: true, color },
        { col: 4, text: whole(problemText(p), last - 2 - 4), bold: true },
        { col: last, text: brief(elapsed(p.since, ctx.now)), color: C.wait },
      ], `need-${p.key}`, andThen(press, after)),
    )
  }
  return out
}

/** BUDGET in `h` rows: the head, then CTX, 5H and 7D as dials at 2 with the window's reset time at 14. */
function budgetRows(ctx: ViewCtx, $: EngineInterface, w: number, h: number, after: () => Promise<void>): RenderElement[] {
  if (h <= 0) return []
  const out = [head(ctx, $, 'BUDGET', [{ col: cellCol(1), text: 'resets' }], 'strip-budget')]
  const b = ctx.t.budget
  const rows: { key: string; dial: ReturnType<typeof meter>; resets?: number }[] = []
  if (b?.contextPct !== undefined) rows.push({ key: 'ctx', dial: meter('CTX', b.contextPct) })
  for (const [name, label] of [['five_hour', '5H'], ['seven_day', '7D']] as const) {
    const win = b?.windows.find(x => x.name === name)
    if (win !== undefined) rows.push({ key: name, dial: meter(label, win.pct), ...(win.resetsAt !== undefined ? { resets: win.resetsAt } : {}) })
  }
  if (rows.length === 0) return h > 1 ? [...out, none(ctx, $, 'no reading yet', 'strip-budget-none')] : out
  for (const r of rows.slice(0, h - 1)) {
    const segs: Placed[] = []
    let col = 2
    for (const run of r.dial) {
      segs.push({ ...run, col })
      col += run.text.length
    }
    if (r.resets !== undefined) segs.push({ col: cellCol(1), text: whole(resetClock(r.resets, ctx.now), w - cellCol(1)), dim: true })
    out.push(line(ctx, $, segs, `budget-${r.key}`, andThen(() => setBudgetOpen($, true), after)))
  }
  return out
}

/** One compartment: its key, the narrowest it is drawn, whether it takes spare width, and its rows. */
type Comp = { key: string; min: number; grows: boolean; rows: (w: number, h: number) => RenderElement[] }

/**
 * The compartments' widths across `cols`: the gap is 3, or 2 where 3 would
 * drop one; compartments that still do not fit are dropped from the right.
 * Spare columns go evenly to those that grow, the remainder to the first.
 */
export function layOut(mins: { min: number; grows: boolean }[], cols: number): { widths: number[]; gap: number } {
  for (let n = mins.length; n >= 1; n--) {
    const kept = mins.slice(0, n)
    const sum = kept.reduce((a, c) => a + c.min, 0)
    for (const gap of GAPS) {
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
  return { widths: [Math.max(1, cols)], gap: GAPS[0]! }
}

/**
 * The strip in the band (`/mc strip`), then the band's compact line under
 * it. Laid out by `bodyColumns` into compartments, each a block with its
 * own head, side by side with a gap:
 * - under 96: the deck, then AGENTS and LATEST stacked under it;
 * - 96 to 139: NOW (the deck) | AGENTS and LATEST;
 * - 140 to 179: NOW | AGENTS | LATEST;
 * - 180 and up: NOW | NEEDS YOU (or TASKS) | AGENTS | LATEST | BUDGET,
 *   dropped from the right where the width runs out; NOW gives its BUDGET
 *   row to the BUDGET compartment.
 * Short of `maxRows` the lists are trimmed first, then the deck from its
 * bottom; the compact line always stays. Every row that opens something is
 * a plain Button with no hotkey: a bare digit in an empty prompt can press
 * a band Button. A press opens the pane on what it names.
 */
export function stripBandView(ctx: ViewCtx, $: EngineInterface, opts: BandStrip): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const needs = needsYou(ctx.t, ctx.u, ctx.now)
  const count = Math.min(needs.length, MAX_LIST)
  const all = nowRows(ctx, $, true, count)
    .filter((r): r is DeckRow => r !== null)
    .map(r => (r.onPress !== undefined ? { ...r, onPress: andThen(r.onPress, opts.after) } : r))
  // The compact line takes one row of the band.
  const body = Math.max(0, opts.maxRows - 1)
  const compact = (
    <Box key="strip-line" flexDirection="column">
      {opts.line}
    </Box>
  )
  const cols = ctx.cols
  const after = opts.after

  if (cols < STRIP) {
    const left = trimDeck(all, body)
    // The blank between the halves takes a row; the right half needs two at least.
    const room = body - left.length - (left.length > 0 ? 1 : 0)
    const right = cols >= STACK_RIGHT_FROM && room >= 2 ? stripRight(ctx, $, room, after) : []
    return (
      <Box flexDirection="column">
        {left.length > 0 ? (
          <Box key="strip-left" flexDirection="column">
            {deckRows(ctx, $, left, { key: 'strip-deck', side: 'left', cols: Math.min(HALF, cols) })}
          </Box>
        ) : null}
        {left.length > 0 && right.length > 0 ? <Text key="strip-halves-gap">{' '}</Text> : null}
        {right.length > 0 ? (
          <Box key="strip-right" flexDirection="column">
            {right}
          </Box>
        ) : null}
        {compact}
      </Box>
    )
  }

  const height = Math.min(body, STRIP_ROWS)
  const nowComp = (deck: DeckRow[]): Comp => ({
    key: 'now',
    min: MIN.now,
    grows: false,
    rows: w => deckRows(ctx, $, trimDeck(deck, height), { key: 'strip-deck', side: 'left', cols: w }),
  })
  const agents: Comp = { key: 'agents', min: MIN.agents, grows: true, rows: (w, rh) => agentsRows(ctx, $, w, rh, after) }
  const latest: Comp = { key: 'latest', min: MIN.latest, grows: true, rows: (w, rh) => latestRows(ctx, $, w, rh, after) }
  let comps: Comp[]
  if (cols < THREE_FROM) {
    comps = [nowComp(all), { key: 'activity', min: MIN.agents, grows: true, rows: (w, rh) => activityRows(ctx, $, w, rh, after) }]
  } else if (cols < FIVE_FROM) {
    comps = [nowComp(all), agents, latest]
  } else {
    const second: Comp =
      needs.length > 0
        ? { key: 'needs', min: MIN.tasks, grows: true, rows: (w, rh) => needsRows(ctx, $, w, rh, needs, after) }
        : { key: 'tasks', min: MIN.tasks, grows: true, rows: (w, rh) => tasksRows(ctx, $, w, rh, after) }
    const budget: Comp = { key: 'budget', min: MIN.budget, grows: false, rows: (w, rh) => budgetRows(ctx, $, w, rh, after) }
    const five = [nowComp(all), second, agents, latest, budget]
    const fitted = layOut(five, cols).widths.length
    // With the BUDGET compartment drawn, NOW's own BUDGET row would say it twice.
    comps = fitted === five.length ? [nowComp(all.filter(r => r.key !== 'deck-budget')), ...five.slice(1)] : five.slice(0, fitted)
  }

  const { widths, gap } = layOut(comps, cols)
  const drawn = comps
    .slice(0, widths.length)
    .map((c, i) => ({ c, w: widths[i]!, rows: c.rows(widths[i]!, height) }))
    .filter(x => x.rows.length > 0)
  if (drawn.length === 0) return <Box flexDirection="column">{compact}</Box>
  return (
    <Box flexDirection="column">
      <Box key="strip" flexDirection="row" columnGap={gap}>
        {drawn.map(x => (
          <Box key={`strip-${x.c.key}`} flexDirection="column" width={x.w}>
            {x.rows}
          </Box>
        ))}
      </Box>
      {compact}
    </Box>
  )
}
