import type { EngineInterface, RenderElement } from 'claude-code'

import type { Step, TaskItem, Timeline } from '../../types'
import { cacheLine } from '../model/meter'
import { summary } from '../model/select'
import type { Problem } from '../model/select'
import { leaveDetail, updateUi } from '../state'
import { resetClock, setBudgetOpen, tokenText } from './budget'
import { COMPARTMENTS_FROM, compartments, elapsed, layOut, meter, shortPaths, typeShort, wordFit } from './fit'
import { argOf, laid, runsLine } from './lay'
import type { Placed } from './lay'
import { needDetail, needGlyph, needName, needsYou, podFor, problemText, waitStates } from './needs'
import { openStepInline } from './openstep'
import { openPage } from './pagenav'
import { andThen, agentTokens, frameRows, HALF, MAX_LIST, nowFrame, nowRows, ringsOf, STEP_GLYPH, STRIP, stripRight, subagents, who } from './overview'
import type { FrameParts } from './overview'
import { blank, deckRows, inst } from './parts'
import type { DeckRow } from './parts'
import { lintelSpec, ringsSpec, sillSpec, stackSpec } from './richkit'
import type { ViewCtx } from './shell'
import { C, cellCol, GRID, spriteOf, statusColor } from './style'

// ---------- the band's strip (`/mc strip`) ----------

/** The strip's height at most: the Now deck's six rows. */
const STRIP_ROWS = 6
/** From this width the strip has a compartment for AGENTS and one for LATEST. */
const THREE_FROM = 140
/** From this width it adds NEEDS YOU (or TASKS) and BUDGET. */
const FIVE_FROM = 180
/** Deck rows the strip gives up first when it is short of rows; FOCUS goes last. */
const DECK_DROP = ['deck-budget', 'deck-steps', 'deck-next', 'deck-tasks', 'deck-crew', 'deck-wait']
/** Under this many columns the stacked strip has no room for the right half's time column. */
// overview.tsx imports this file, so nothing here may read its constants while loading: 36 is RIGHT.time and 50 is HALF.
const STACK_RIGHT_FROM = 36 + GRID.content + 2

/**
 * The narrowest each compartment is drawn: NOW keeps its deck cells to 50;
 * AGENTS and LATEST keep a name or argument of 22 from 14 and the time on
 * cell 38. NOW and BUDGET keep their width; the lists take what is spare.
 */
const MIN = { now: 50, tasks: 22, agents: 42, latest: 42, budget: 24 } as const
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
  const rich = richStrip(ctx, $, { maxRows: Math.max(0, opts.maxRows - 1), after: opts.after })
  if (rich !== undefined) {
    return (
      <Box flexDirection="column">
        {rich}
        <Box key="strip-line" flexDirection="column">
          {opts.line}
        </Box>
      </Box>
    )
  }
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

// ---------- Neo Rich: the strip's compartments ----------

/** The rich strip's height at most: a frame's lintel and sill and nine rows. */
const RICH_ROWS = 11
/** Under this many rows the rich strip is not drawn: the text strip is. */
const RICH_MIN_ROWS = 8

/** One compartment: its lintel and sill (one clamp cell, the pill at column 2) around its rows, at most `tall` rows with them. */
function framed(ctx: ViewCtx, $: EngineInterface, key: string, w: number, tall: number, pill: string, right: string | undefined, rows: RenderElement[], tone?: 'warning'): RenderElement {
  const { Box } = $.ui.resolve(ctx.e)
  const sub = { ...ctx, cols: w }
  const t = tone !== undefined ? { tone } : {}
  return (
    <Box key={`strip-${key}`} flexDirection="column" width={w}>
      {inst(sub, $, lintelSpec(`${key}-lintel`, w, { ...t, pill, pillCol: 2, clamp: 1, ...(right !== undefined ? { right } : {}) }))}
      {rows.slice(0, Math.max(0, tall - 2))}
      {inst(sub, $, sillSpec(`${key}-sill`, w, { ...t, clamp: 1 }))}
    </Box>
  )
}

/** The NOW compartment's deck rows for `tall` rows: the fullest set that fits (STEPS, then the beads, then TASKS go first). */
function nowKeep(t: Timeline, now: number, w: number, tall: number, narrow: boolean, count: number): FrameParts {
  const base = { cols: w, count, strip: true, key: 'strip-now' } as const
  const tries: Pick<FrameParts, 'keep' | 'beads'>[] = narrow
    ? [
        { keep: { next: false, steps: false, tasks: true }, beads: true },
        { keep: { next: false, steps: false, tasks: true } },
        { keep: { next: false, steps: false, tasks: false } },
      ]
    : [
        { keep: { next: false, steps: true, tasks: true } },
        { keep: { next: false, steps: false, tasks: true } },
        { keep: { next: false, steps: false, tasks: false } },
      ]
  for (const o of tries) if (frameRows(t, now, { ...base, ...o }) <= tall) return { ...base, ...o }
  return { ...base, ...tries[tries.length - 1]! }
}

/** One text row of a compartment: runs at columns, a plain Button when it opens something. */
function crow(ctx: ViewCtx, $: EngineInterface, segs: Placed[], key: string, onPress?: () => void | Promise<void>): RenderElement {
  return line(ctx, $, segs, key, onPress)
}

function richTasks(ctx: ViewCtx, $: EngineInterface, w: number, tall: number, press: (f: () => void | Promise<void>) => () => void | Promise<void>): RenderElement {
  const { t } = ctx
  const s = summary(t)
  const of = (status: TaskItem['status']) => t.tasks.filter(x => x.status === status)
  const items = [...of('in_progress'), ...of('pending'), ...of('completed').sort((a, b) => b.updatedAt - a.updatedAt)]
  const room = Math.max(0, tall - 2)
  const hidden = items.length > room ? items.length - (room - 1) : 0
  const shown = hidden > 0 ? items.slice(0, Math.max(0, room - 1)) : items
  const rows: RenderElement[] = shown.map(x => {
    const isActive = x.status === 'in_progress'
    return crow(
      ctx,
      $,
      [
        { col: 2, text: TASK_GLYPH[x.status], ...(isActive ? { color: C.live } : { dim: true }) },
        { col: 4, text: whole(isActive ? x.activeForm ?? x.subject : x.subject, w - 4), ...(isActive ? { bold: true } : x.status === 'completed' ? { dim: true } : {}) },
      ],
      `task-${x.owner}-${x.id}`,
      press(() => openPage($, 'task', `${x.owner}:${x.id}`)),
    )
  })
  if (hidden > 0) rows.push(runsLine(ctx.e, $, [{ col: 2, text: '+', dim: true }, { col: 4, text: `${hidden} more`, dim: true }], 'strip-tasks-more'))
  if (items.length === 0) rows.push(none(ctx, $, 'no tasks', 'strip-tasks-none'))
  return framed(ctx, $, 'tasks', w, tall, 'TASKS', s.total > 0 ? `${s.done} of ${s.total}` : undefined, rows)
}

function richNeeds(ctx: ViewCtx, $: EngineInterface, w: number, tall: number, needs: Problem[], press: (f: () => void | Promise<void>) => () => void | Promise<void>): RenderElement {
  const rows: RenderElement[] = needs.slice(0, Math.max(0, tall - 2)).map(p => {
    const mark = needGlyph(p)
    const detail = needDetail(p, ctx.now)
    const stepId = p.stepId
    const open = stepId !== undefined ? () => openPage($, 'step', stepId) : () => updateUi($, u => ({ ...leaveDetail(u), tab: 'overview' }))
    return crow(
      ctx,
      $,
      [
        { col: 2, text: mark.glyph, bold: true, color: mark.color },
        { col: 4, text: whole(needName(ctx.t, p), Math.max(0, w - 4 - detail.length - 2)), bold: true },
        { col: Math.max(4, w - detail.length - 1), text: detail, color: C.wait },
      ],
      `need-${p.key}`,
      press(open),
    )
  })
  const oldest = Math.min(...needs.map(p => p.since))
  return framed(ctx, $, 'needs', w, tall, `NEEDS YOU ${needs.length}`, `oldest ${elapsed(oldest, ctx.now)}`, rows, 'warning')
}

function richAgents(ctx: ViewCtx, $: EngineInterface, w: number, tall: number, press: (f: () => void | Promise<void>) => () => void | Promise<void>): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { t, now } = ctx
  const waits = waitStates(t, ctx.u, now)
  const subs = subagents(t)
  const live = subs.filter(a => a.status === 'running').sort((a, b) => a.startedAt - b.startedAt)
  const failed = subs.filter(a => a.status === 'error').sort((a, b) => b.startedAt - a.startedAt)
  const done = subs.filter(a => a.status === 'done').length
  const items = [...live, ...failed]
  const room = Math.max(0, tall - 2)
  const fold = done > 0 || items.length * 2 > room
  const slots = Math.max(0, Math.floor((room - (fold ? 1 : 0)) / 2))
  const shown = items.slice(0, slots)
  const rows: RenderElement[] = shown.map(a => {
    const pod = podFor(a, waits, now)
    const spec = spriteOf({ id: a.id, type: a.type, status: a.status }, now, pod.state, 'S')
    const facts = a.status === 'error' ? `${typeShort(a.type)} · failed · ${agentTokens(a)}` : `${typeShort(a.type)} · ${agentTokens(a)} · ${elapsed(a.startedAt, now)}`
    return (
      <Box key={`agent-row-${a.id}`} flexDirection="row">
        {inst({ ...ctx, cols: w }, $, { key: `ag-${a.id}`, ...spec })}
        <Box key={`agent-text-${a.id}`} flexDirection="column" paddingLeft={1}>
          <Button key={`agent-${a.id}`} plain onPress={press(() => updateUi($, u => ({ ...leaveDetail(u), tab: 'agents', agentOpen: a.id })))}>
            {wordFit(shortPaths(a.description || a.type), Math.max(1, w - 7))}
          </Button>
          <Text key={`agent-facts-${a.id}`} wrap="truncate-end" dimColor={a.status !== 'error'} color={a.status === 'error' ? C.fail : undefined}>
            {wordFit(facts, Math.max(1, w - 7))}
          </Text>
        </Box>
      </Box>
    )
  })
  if (fold) {
    const n = items.length - shown.length + done
    if (n > 0) rows.push(runsLine(ctx.e, $, [{ col: 6, text: `+ ${n} ${items.length > shown.length ? 'more' : 'done'}`, dim: true }], 'strip-agents-more'))
  }
  if (items.length === 0 && done === 0) rows.push(none(ctx, $, 'none live', 'strip-agents-none'))
  return framed(ctx, $, 'agents', w, tall, 'AGENTS', `${live.length} live`, rows)
}

function richLatest(ctx: ViewCtx, $: EngineInterface, w: number, tall: number, press: (f: () => void | Promise<void>) => () => void | Promise<void>): RenderElement {
  const { t, now } = ctx
  const room = Math.max(0, tall - 2)
  const steps = latestOrder(t.steps)
  const s = summary(t)
  const foot = s.errors > 0 ? `${s.errors} ${s.errors === 1 ? 'error' : 'errors'} of ${s.steps} steps` : `${s.steps} steps`
  const fits = steps.length > 0 && room >= 3
  const rows: RenderElement[] = steps.slice(0, Math.max(0, room - (fits ? 1 : 0))).map(x => {
    const color = statusColor(x.status)
    const tool = toolName(x.tool)
    return crow(
      ctx,
      $,
      [
        { col: 2, text: STEP_GLYPH[x.status], ...(color !== undefined ? { color } : { dim: true }) },
        { col: 4, text: whole(`${tool}  ${argOf(x.tool, x.label)}`, w - 4) },
      ],
      `step-${x.id}`,
      press(() => openStepInline($, x.id)),
    )
  })
  if (fits) rows.push(runsLine(ctx.e, $, [{ col: 2, text: foot, dim: true }], 'strip-latest-foot'))
  if (steps.length === 0) rows.push(none(ctx, $, 'no steps yet', 'strip-latest-none'))
  return framed(ctx, $, 'latest', w, tall, 'LATEST', undefined, rows)
}

/** A reset in a figure that fits eight columns: `in 45m`, `in 3h`, `in 4d`. */
function inText(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `in ${m}m`
  const h = Math.round(m / 60)
  return h < 48 ? `in ${h}h` : `in ${Math.round(h / 24)}d`
}

function richBudget(ctx: ViewCtx, $: EngineInterface, w: number, tall: number, press: (f: () => void | Promise<void>) => () => void | Promise<void>): RenderElement {
  const { t, now } = ctx
  const b = t.budget
  const rings = ringsOf(t, now)
  const rows: RenderElement[] = []
  if (rings.length === 0) rows.push(none(ctx, $, 'no reading yet', 'strip-budget-none'))
  else {
    rows.push(inst({ ...ctx, cols: w }, $, ringsSpec('strip-dials', rings)))
    const figures: Placed[] = []
    rings.forEach((r, i) => {
      const win = r.name === 'CTX' ? undefined : b?.windows.find(x => (r.name === '5H' ? x.name === 'five_hour' : x.name === 'seven_day'))
      const text = r.name === 'CTX' ? (b?.contextTokens !== undefined ? tokenText(b.contextTokens) : '') : win?.resetsAt !== undefined ? inText(win.resetsAt - now) : ''
      if (text !== '') figures.push({ col: i * 8, text, dim: true })
    })
    const { Button } = $.ui.resolve(ctx.e)
    rows.push(
      <Button key="strip-budget" plain onPress={press(() => setBudgetOpen($, true))}>
        {laid(figures, 0, ctx.e, $, 'strip-budget-')}
      </Button>,
    )
  }
  const cl = cacheLine(t)
  if (cl.total > 0 && rows.length + 2 <= tall - 2 + 1) {
    rows.push(inst({ ...ctx, cols: w }, $, stackSpec('strip-cache', Math.min(23, w), [[cl.read, 'mint'], [cl.write, 'orchid'], [cl.fresh, 'mute']], [C.result, C.model])))
    rows.push(runsLine(ctx.e, $, [{ col: 0, text: `cache ${Math.round(cl.readShare * 100)}% read` }], 'strip-cache-text'))
    const warm = cl.warmUntil !== undefined && cl.warmUntil > now ? cl.warmUntil - now : undefined
    if (warm !== undefined) {
      const s = Math.floor(warm / 1000)
      rows.push(runsLine(ctx.e, $, [{ col: 0, text: `warm ~${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, color: C.result }], 'strip-cache-warm'))
    }
  }
  return framed(ctx, $, 'budget', w, tall, 'BUDGET', undefined, rows)
}

/**
 * The strip in the rich look (spec "Strip"): compartments from `compartments(cols, waiting)`, each with its own lintel and sill, three clear columns
 * between, dropped whole and never squeezed. NOW is the Now frame without
 * rings (three bead meters from 96 columns, the plan strip and trace); NEEDS
 * YOU takes the second place whenever something waits; TASKS lists tasks;
 * AGENTS shows each agent's small character, name and facts; LATEST lists
 * steps; BUDGET has the rings, their resets and the cache. From 96 to 116
 * AGENTS over LATEST share one text compartment. Undefined when the look is
 * not rich, the strip is under 96 columns or `maxRows` is under 8 (the text strip
 * is drawn then). Every row that opens something is a plain Button; a press
 * opens the pane on what it names (`after`).
 */
export function richStrip(ctx: ViewCtx, $: EngineInterface, o: { maxRows: number; after?: () => Promise<void> }): RenderElement | undefined {
  if (ctx.look !== 'rich' || ctx.cols < COMPARTMENTS_FROM) return undefined
  const tall = Math.min(o.maxRows, RICH_ROWS)
  if (tall < RICH_MIN_ROWS) return undefined
  const { Box } = $.ui.resolve(ctx.e)
  const needs = needsYou(ctx.t, ctx.u, ctx.now)
  const count = Math.min(needs.length, MAX_LIST)
  const { comps, gap } = compartments(ctx.cols, needs.length > 0)
  const after = o.after
  const press = (f: () => void | Promise<void>): (() => void | Promise<void>) => andThen(f, after)
  const narrow = ctx.cols < 117
  const drawn = comps.map(c => {
    switch (c.key) {
      case 'now':
        return <Box key="strip-now-box" flexDirection="column" width={c.width}>{nowFrame(ctx, $, { ...nowKeep(ctx.t, ctx.now, c.width, tall, narrow, count), press })}</Box>
      case 'needs':
        return richNeeds(ctx, $, c.width, tall, needs, press)
      case 'tasks':
        return richTasks(ctx, $, c.width, tall, press)
      case 'agents':
        return richAgents(ctx, $, c.width, tall, press)
      case 'latest':
        return richLatest(ctx, $, c.width, tall, press)
      case 'budget':
        return richBudget(ctx, $, c.width, tall, press)
      default:
        return (
          <Box key="strip-activity" flexDirection="column" width={c.width}>
            {activityRows(ctx, $, c.width, tall, after ?? (async () => {}))}
          </Box>
        )
    }
  })
  return (
    <Box key="strip" flexDirection="row" columnGap={gap}>
      {drawn}
    </Box>
  )
}
