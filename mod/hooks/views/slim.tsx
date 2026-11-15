import type { EngineInterface, RenderElement } from 'claude-code'

import type { Step, Tab } from '../../types'
import { summary } from '../model/select'
import { leaveDetail, updateUi } from '../state'
import { budgetView, isBudgetOpen, setBudgetOpen, windowName } from './budget'
import { crewSpec, lintelReadout, planSpec } from './overview'
import { beadsSpec, lintelSpec, sillSpec, toneOf } from './richkit'
import { bar, crewRow, GAUGE, pillRun, pips, wordFit, wrapWords } from './fit'
import { argOf, headline, laid, runsLine } from './lay'
import type { Placed } from './lay'
import { chatFor, crewPods, dismissNeed, needGlyph, needName, needsYou, openProblem, paneState, podFor, waitStates } from './needs'
import { blank, deck, inst, more, row } from './parts'
import type { DeckRow, Run } from './parts'
import type { ViewCtx } from './shell'
import { elapsed } from './fit'
import { C, COL, GLYPHS, GRID, statusColor } from './style'

// Under 32 columns: one stacked summary, no tab bar (spec "Slim mode").
// Grid: gutter 0, content from 2, a value at 14 (the second cell), `›` in the
// last column. A budget row has three stops: label 2, value 8, bar 14.
const VALUE = 14
const BAR = 8
const STEP_GLYPH: Record<Step['status'], string> = { running: '▸', done: '✓', error: '✖', denied: '✖', interrupted: '·' }

/** Whether `text` can be drawn in `room` without ending inside a word: its first word fits. */
function fits(text: string, room: number): boolean {
  return room > 0 && (text.split(' ')[0] ?? '').length <= room
}

/** The names that fit `room` whole at the first word, cut by word. A name whose first word is too wide is dropped. */
function names(texts: string[], room: number): string[] {
  return texts.filter(t => fits(t, room)).map(t => wordFit(t, room))
}

type Block = { els: RenderElement[]; rows: number }

/**
 * A section label as one Button: `┌` at 0, the label bold at 2, a dim value at
 * 14 (left out when it would touch `›`) and a dim `›` in the last column.
 */
function label(
  ctx: ViewCtx,
  $: EngineInterface,
  text: string,
  value: Run | undefined,
  key: string,
  onPress: () => void | Promise<void>,
  tone?: 'wait',
): RenderElement {
  const { Button } = $.ui.resolve(ctx.e)
  const tint = tone === 'wait' ? C.wait : C.accent
  const segs: Placed[] = [
    { col: 0, text: '┌', color: tint },
    { col: COL.glyph, text: wordFit(text, VALUE - 3), bold: true, ...(tone === 'wait' ? { color: C.wait } : {}) },
  ]
  if (value !== undefined && VALUE + value.text.length <= ctx.cols - 2) segs.push({ ...value, col: VALUE })
  segs.push({ col: ctx.cols - 1, text: '›', dim: true })
  return (
    <Button key={key} plain onPress={onPress}>
      {laid(segs, 0, ctx.e, $, `${key}-`)}
    </Button>
  )
}

function openTab($: EngineInterface, tab: Tab): Promise<void> {
  return updateUi($, u => ({ ...leaveDetail(u), tab }))
}

/** One name-only line: a glyph at 2 and the name at 4. */
function line(ctx: ViewCtx, $: EngineInterface, key: string, glyph: string, color: string | undefined, name: string, dim = false): RenderElement {
  return runsLine(
    ctx.e,
    $,
    [
      { col: COL.glyph, text: glyph, ...(color !== undefined ? { color } : { dim: true }) },
      { col: COL.name, text: name, ...(dim ? { dim: true } : {}) },
    ],
    key,
  )
}

/** The runs laid from `col`, one after the other. */
function runsAt(runs: Run[], col: number): Placed[] {
  let at = col
  return runs.map(r => {
    const p = { ...r, col: at }
    at += r.text.length
    return p
  })
}

/**
 * The head (spec "Slim"): a left-only bracket holding the state pill and the
 * focus wrapped to 2 lines. It turns `warning` when something waits.
 */
function headBlock(ctx: ViewCtx, $: EngineInterface): Block {
  const focus = headline(ctx.t)
  const state = paneState(ctx)
  const lines = wrapWords(focus.text, ctx.cols - COL.glyph, 2)
  if (ctx.look === 'rich') {
    // The lintel carries the pill (from 2) and the turn's age; the focus is two bold lines under it.
    const { Text } = $.ui.resolve(ctx.e)
    const ro = lintelReadout(ctx)
    const turn = ro.right?.startsWith('turn') === true ? ro.right.split(' ').slice(2).join(' ') : undefined
    const tone = state.word === 'WAITING' ? ('warning' as const) : ('accent' as const)
    const els: RenderElement[] = [
      inst(ctx, $, lintelSpec('slim-lintel', ctx.cols, { tone, pill: state.word, pillTone: toneOf(state.color), pillCol: 2, clamp: 1, ...(turn !== undefined && turn !== '' ? { right: turn, rightAmber: ro.amber } : {}) })),
      ...lines.map((l, i) => (
        <Text key={`slim-focus-${i}`} wrap="truncate-end" {...(focus.isIdle ? { dimColor: true } : { bold: true })}>
          {`  ${l}`}
        </Text>
      )),
    ]
    return { els, rows: els.length }
  }
  const rows: DeckRow[] = [
    { key: 'slim-pill', label: [pillRun(state.word, state.color)] },
    ...lines.map((l, i): DeckRow => ({ key: `slim-focus-${i}`, label: [{ text: l, ...(focus.isIdle ? { dim: true } : { bold: true }) }] })),
  ]
  const els = deck(ctx, $, rows, { key: 'slim-head', side: 'left', tone: state.word === 'WAITING' ? 'warning' : 'accent' })
  return { els: els !== null ? [els] : [], rows: rows.length }
}

function needsBlock(ctx: ViewCtx, $: EngineInterface): Block | undefined {
  const { Box, Button } = $.ui.resolve(ctx.e)
  const { t, u, cols, now } = ctx
  const list = needsYou(t, u, now)
  const first = list[0]
  if (first === undefined) return undefined
  const room = cols - COL.name
  const mark = needGlyph(first)
  // The command wraps to a second line instead of being cut.
  const text = needName(t, first)
  const wrapped = fits(text, room) ? wrapWords(text, room, 2) : [wordFit(text, room)]
  const els: RenderElement[] = [
    label(ctx, $, 'NEEDS YOU', { text: String(list.length), color: C.wait }, 'slim-go-needs', () => openProblem($, first), 'wait'),
    <Button key={`open-${first.key}`} plain autoFocus onPress={() => openProblem($, first)}>
      {laid(
        [
          { col: COL.glyph, text: mark.glyph, color: mark.color },
          { col: COL.name, text: wrapped[0] ?? '', bold: true },
        ],
        0,
        ctx.e,
        $,
        'slim-need-',
      )}
    </Button>,
  ]
  if (wrapped[1] !== undefined) els.push(runsLine(ctx.e, $, [{ col: COL.name, text: wrapped[1], bold: true }], 'slim-need-2'))
  // `g: chat  x: dismiss` as hotkeyed Buttons from column 4, the last left off when it does not fit.
  const chat = chatFor($, first)
  const actions = [
    ...(chat !== undefined ? [{ hotkey: 'g', text: 'chat', key: `chat-${first.key}`, run: chat }] : []),
    { hotkey: 'x', text: 'dismiss', key: `dismiss-${first.key}`, run: () => dismissNeed($, first) },
  ]
  const shown: typeof actions = []
  let used = COL.name
  for (const a of actions) {
    const w = (shown.length > 0 ? 3 : 0) + a.hotkey.length + 2 + a.text.length
    if (used + w > cols) break
    shown.push(a)
    used += w
  }
  if (shown.length > 0) {
    els.push(
      <Box key="slim-need-actions" flexDirection="row" paddingLeft={COL.name} columnGap={3}>
        {shown.map(a => (
          <Button key={a.key} hotkey={a.hotkey} plain onPress={a.run}>
            {a.text}
          </Button>
        ))}
      </Box>,
    )
  }
  const rest = list.slice(1, 3)
  const restNames = names(rest.map(p => needName(t, p)), room)
  if (restNames.length > 0) els.push(blank(ctx, $, 'slim-need-gap'))
  rest
    .filter(p => fits(needName(t, p), room))
    .forEach((p, i) => {
      const m = needGlyph(p)
      els.push(line(ctx, $, `slim-need-rest-${i}`, m.glyph, m.color, wordFit(needName(t, p), room)))
    })
  return { els, rows: els.length }
}

/** The plan strip from column 2 with the session's age beside it. */
function richPlan(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const times = ctx.t.steps.map(x => x.startedAt)
  const from = times.length > 0 ? Math.min(...times) : ctx.now
  const cells = Math.max(4, Math.min(14, ctx.cols - COL.glyph - 5))
  return (
    <Box key="slim-plan-row" flexDirection="row">
      <Text key="slim-plan-pad">{'  '}</Text>
      {inst(ctx, $, planSpec(ctx.t, cells))}
      {times.length > 0 ? (
        <Text key="slim-plan-age" dimColor>
          {` ${elapsed(from, ctx.now)}`}
        </Text>
      ) : null}
    </Box>
  )
}

function tasksBlock(ctx: ViewCtx, $: EngineInterface): Block | undefined {
  const { t, cols } = ctx
  const s = summary(t)
  if (s.total === 0) return undefined
  const active = t.tasks.filter(x => x.status === 'in_progress').length
  const plan = ctx.look === 'rich' ? richPlan(ctx, $) : runsLine(ctx.e, $, runsAt(pips(s.done, s.total, cols - COL.glyph >= GAUGE ? GAUGE : 10, active), COL.glyph), 'slim-pips')
  const els: RenderElement[] = [
    label(ctx, $, 'TASKS', { text: `${s.done}/${s.total}`, dim: true }, 'slim-go-tasks', () => openTab($, 'tasks')),
    plan,
  ]
  // The current task, or the next one when the current task is the focus.
  const current = s.current
  const isFocus = current !== undefined && s.focus === (current.activeForm ?? current.subject)
  const pick =
    current !== undefined && !isFocus
      ? { task: current, glyph: GLYPHS.pip[1], color: C.live }
      : s.upcoming !== undefined
        ? { task: s.upcoming, glyph: GLYPHS.pip[2], color: undefined }
        : undefined
  if (pick !== undefined) {
    const text = pick.task.subject.replace(/\s+/g, ' ').trim()
    if (fits(text, cols - COL.name)) els.push(line(ctx, $, 'slim-task', pick.glyph, pick.color, wordFit(text, cols - COL.name)))
  }
  return { els, rows: els.length }
}

const widthOf = (runs: Run[]): number => runs.reduce((n, r) => n + r.text.length, 0)

/** The crew row that fits `room`: as many pods as there are, up to 7, then `+n`. */
function crewFit(ctx: ViewCtx, room: number): Run[] {
  const pods = crewPods(ctx)
  for (let max = 7; max >= 1; max--) {
    const runs = crewRow(pods, max)
    if (widthOf(runs) <= room) return runs
  }
  return crewRow(pods, 1, { tight: true })
}

/** CREW in the rich look: up to three small characters from column 2, then `+n` for the rest and `!n` for the failed ones beside them. */
function richCrew(ctx: ViewCtx, $: EngineInterface, live: number): Block {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const pods = crewPods(ctx)
  const slots = Math.max(1, Math.min(3, Math.floor((ctx.cols - COL.glyph - 3) / 6)))
  const shown = pods.slice(0, slots)
  const over = pods.length - shown.length
  const failed = Object.values(ctx.t.agents).filter(a => a.id !== 'main' && a.status === 'error').length
  const els: RenderElement[] = [
    label(ctx, $, 'CREW', { text: `${live} live`, dim: true }, 'slim-go-agents', () => openTab($, 'agents')),
    <Box key="slim-crew-row" flexDirection="row">
      <Text key="slim-crew-pad">{'  '}</Text>
      {inst(ctx, $, crewSpec(shown, slots))}
      <Box key="slim-crew-counts" flexDirection="column" paddingLeft={2}>
        <Text key="slim-crew-over" dimColor>
          {over > 0 ? `+${over}` : ' '}
        </Text>
        {failed > 0 ? (
          <Text key="slim-crew-failed" color={C.fail} bold>
            {`!${failed}`}
          </Text>
        ) : null}
      </Box>
    </Box>,
  ]
  return { els, rows: 3 }
}

/** CREW (spec "Slim"): `┌ CREW 2 live ›`, one row of pods and the live names with their hulls. Nothing without a subagent. */
function crewBlock(ctx: ViewCtx, $: EngineInterface, withNames: boolean): Block | undefined {
  const { t, cols } = ctx
  const subs = Object.values(t.agents).filter(a => a.id !== 'main')
  if (subs.length === 0) return undefined
  const live = subs.filter(a => a.status === 'running').sort((a, b) => a.startedAt - b.startedAt)
  if (ctx.look === 'rich') return richCrew(ctx, $, live.length)
  const els: RenderElement[] = [
    label(ctx, $, 'CREW', { text: `${live.length} live`, dim: true }, 'slim-go-agents', () => openTab($, 'agents')),
    runsLine(ctx.e, $, runsAt(crewFit(ctx, cols - COL.glyph), COL.glyph), 'slim-crew'),
  ]
  if (withNames) {
    const waits = waitStates(t, ctx.u, ctx.now)
    live
      .slice(0, 3)
      .filter(a => fits(argOf('', a.description || a.type), cols - COL.name))
      .forEach(a => {
        const hull = podFor(a, waits, ctx.now).hull
        els.push(line(ctx, $, `slim-agent-${a.id}`, hull.text, hull.color, wordFit(argOf('', a.description || a.type), cols - COL.name)))
      })
  }
  return { els, rows: els.length }
}

function budgetBlock(ctx: ViewCtx, $: EngineInterface, withSeven: boolean): Block | undefined {
  const b = ctx.t.budget
  if (b === undefined) return undefined
  const rows: { label: string; pct: number }[] = []
  if (b.contextPct !== undefined) rows.push({ label: 'CTX', pct: b.contextPct })
  for (const name of ['five_hour', ...(withSeven ? ['seven_day'] : [])]) {
    const w = b.windows.find(x => x.name === name)
    if (w !== undefined) rows.push({ label: windowName(w.name).toUpperCase(), pct: w.pct })
  }
  if (rows.length === 0) return undefined
  const els: RenderElement[] = [
    label(ctx, $, 'BUDGET', undefined, 'slim-go-budget', () => setBudgetOpen($, true)),
  ]
  // The bar is 10 cells at 14 and ends by the last column; where it would not, it is left out (bars are 10 or 22, never in between).
  for (const r of rows) {
    const segs: Placed[] = [
      { col: COL.glyph, text: r.label, dim: true },
      { col: BAR, text: `${Math.round(r.pct)}%`, bold: true },
    ]
    if (ctx.look === 'rich' && ctx.cols >= VALUE + GRID.content) {
      // Five beads a row, where the bar was.
      const { Box, Text } = $.ui.resolve(ctx.e)
      els.push(
        <Box key={`slim-budget-${r.label}`} flexDirection="row">
          <Box key={`slim-budget-${r.label}-t`} width={VALUE} flexShrink={0}>
            <Text key={`slim-budget-${r.label}-text`} wrap="truncate-end">
              {laid(segs, 0, ctx.e, $, `slim-budget-${r.label}-`)}
            </Text>
          </Box>
          {inst(ctx, $, beadsSpec(`b-${r.label.toLowerCase()}`, 10, r.pct))}
        </Box>,
      )
      continue
    }
    if (ctx.cols >= VALUE + GRID.content) segs.push(...runsAt(bar(Math.max(0, Math.min(100, r.pct)), 100, 10), VALUE))
    els.push(runsLine(ctx.e, $, segs, `slim-budget-${r.label}`))
  }
  return { els, rows: els.length }
}

function latestBlock(ctx: ViewCtx, $: EngineInterface): Block | undefined {
  const { t, cols } = ctx
  const room = cols - COL.name
  const bySeq = [...t.steps].sort((a, b) => b.seq - a.seq)
  const error = bySeq.find(x => x.status === 'error')
  const kept = bySeq.find(x => x.pin !== undefined)
  const items: { id: string; glyph: string; color: string | undefined; text: string }[] = []
  if (error !== undefined) items.push({ id: error.id, glyph: STEP_GLYPH.error, color: statusColor('error'), text: argOf(error.tool, error.label) || error.tool })
  if (kept !== undefined) items.push({ id: kept.id, glyph: '★', color: C.spark, text: kept.pin !== undefined && kept.pin !== '' ? kept.pin : argOf(kept.tool, kept.label) })
  const shown = items.filter(i => fits(i.text, room))
  if (shown.length === 0) return undefined
  const errors = bySeq.filter(x => x.status === 'error').length
  const els: RenderElement[] = [
    label(ctx, $, 'LATEST', errors > 0 ? { text: `✖ ${errors}`, color: C.fail } : undefined, 'slim-go-latest', () => openTab($, 'timeline')),
    ...shown.map(i => line(ctx, $, `slim-latest-${i.id}`, i.glyph, i.color, wordFit(i.text, room))),
  ]
  return { els, rows: els.length }
}

/** The stack at a drop level: 0 all, 1 without LATEST, 2 also without 7D, 3 also without the agent names. */
function stackAt(ctx: ViewCtx, $: EngineInterface, level: number): { els: RenderElement[]; rows: number } {
  const blocks = [
    headBlock(ctx, $),
    needsBlock(ctx, $),
    crewBlock(ctx, $, level < 3),
    tasksBlock(ctx, $),
    budgetBlock(ctx, $, level < 2),
    level < 1 ? latestBlock(ctx, $) : undefined,
  ]
  const els: RenderElement[] = []
  let rows = 0
  let n = 0
  for (const b of blocks) {
    if (b === undefined || b.els.length === 0) continue
    if (els.length > 0) {
      els.push(blank(ctx, $, `slim-gap-${n}`))
      rows += 1
    }
    els.push(...b.els)
    rows += b.rows
    n += 1
  }
  // The rich form closes with the sill (one clamp cell), straight under the last row.
  if (ctx.look === 'rich') {
    els.push(inst(ctx, $, sillSpec('slim-sill', ctx.cols, { tone: needsYou(ctx.t, ctx.u, ctx.now).length > 0 ? 'warning' : 'accent', clamp: 1 })))
    rows += 1
  }
  return { els, rows }
}

/** `↵ open   esc prompt` from column 2 while the pane has the focus; one space apart where 3 would not fit. */
function slimFooter(ctx: ViewCtx, $: EngineInterface): RenderElement | null {
  if (ctx.isFocused !== true) return null
  const { Text } = $.ui.resolve(ctx.e)
  const gap = ctx.cols >= 23 ? '   ' : ' '
  return (
    <Text key="footer" dimColor wrap="truncate-end">
      {`  ↵ open${gap}esc prompt`}
    </Text>
  )
}

const TAB_TITLE: Record<Tab, string> = { overview: 'Now', tasks: 'Tasks', agents: 'Agents', timeline: 'Steps', artifacts: 'Artifacts' }

/** The name-only list of a tab, in slim form: `b: back` on its first row. */
function tabList(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Button } = $.ui.resolve(ctx.e)
  const { t, u, cols } = ctx
  const room = cols - COL.name
  type Item = { key: string; glyph: string; color?: string; text: string; dim?: boolean }
  const items: Item[] = []
  if (u.tab === 'tasks') {
    const rank = { in_progress: 0, pending: 1, completed: 2 }
    for (const x of [...t.tasks].sort((a, b) => rank[a.status] - rank[b.status])) {
      const glyph = x.status === 'completed' ? '✓' : x.status === 'in_progress' ? '▸' : '○'
      items.push({ key: `task-${x.id}`, glyph, ...(x.status === 'in_progress' ? { color: C.live } : {}), text: x.subject, dim: x.status === 'completed' })
    }
  } else if (u.tab === 'agents') {
    const rank = { running: 0, error: 1, done: 2 }
    for (const a of Object.values(t.agents).filter(x => x.id !== 'main').sort((x, y) => rank[x.status] - rank[y.status] || y.startedAt - x.startedAt)) {
      const color = statusColor(a.status)
      items.push({ key: `agent-${a.id}`, glyph: a.status === 'running' ? '▸' : a.status === 'error' ? '✖' : '✓', ...(color !== undefined ? { color } : {}), text: a.description || a.type })
    }
  } else if (u.tab === 'timeline') {
    for (const s of [...t.steps].sort((a, b) => b.seq - a.seq)) {
      const color = statusColor(s.status)
      items.push({ key: `step-${s.id}`, glyph: STEP_GLYPH[s.status], ...(color !== undefined ? { color } : {}), text: argOf(s.tool, s.label) || s.tool })
    }
  } else {
    for (const a of [...t.artifacts].sort((x, y) => y.updatedAt - x.updatedAt)) {
      items.push({ key: `artifact-${a.id}`, glyph: a.kind === 'link' ? '⎇' : '↗', text: a.title })
    }
  }
  const usable = items.filter(i => fits(i.text.replace(/\s+/g, ' ').trim(), room))
  const shown = usable.slice(0, 8)
  const els: RenderElement[] = [
    <Box key="slim-back-row" flexDirection="row" paddingLeft={GRID.margin} columnGap={3}>
      <Button key="slim-back" hotkey="b" plain onPress={() => openTab($, 'overview')}>
        back
      </Button>
    </Box>,
    runsLine(ctx.e, $, [{ col: 0, text: '┌', color: C.accent }, { col: COL.glyph, text: TAB_TITLE[u.tab].toUpperCase(), bold: true }], 'slim-tab-title'),
    ...shown.map(i =>
      row(ctx, $, { key: i.key, glyph: i.glyph, ...(i.color !== undefined ? { glyphColor: i.color } : {}), name: i.text.replace(/\s+/g, ' ').trim(), ...(i.dim === true ? { dim: true } : {}) }),
    ),
  ]
  if (usable.length > shown.length) els.push(more(ctx, $, usable.length - shown.length))
  if (shown.length === 0) els.push(runsLine(ctx.e, $, [{ col: COL.glyph, text: 'Nothing yet.', dim: true }], 'slim-empty'))
  const bar = slimFooter(ctx, $)
  return <Box flexDirection="column">{[...els, ...(bar !== null ? [blank(ctx, $, 'slim-tab-gap'), bar] : [])]}</Box>
}

/**
 * The pane under 32 columns (spec "Slim mode"): one stacked summary, no tab
 * bar. The shell calls it whenever `ctx.cols < 32`, whatever the tab.
 *
 * Top to bottom: the focus wrapped by word to 2 lines; NEEDS YOU with its
 * first item focused; TASKS; AGENTS; BUDGET; LATEST. Each `┌` label is a
 * Button that opens that tab's slim list (`b: back` on its first row), or the
 * budget view. When the stack is taller than `bodyRows`, whole parts drop from
 * the bottom: LATEST, then BUDGET's 7D row, then the agent names.
 */
export function slimView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box } = $.ui.resolve(ctx.e)
  if (isBudgetOpen()) return <Box flexDirection="column">{[budgetView(ctx, $)]}</Box>
  if (ctx.u.tab !== 'overview') return tabList(ctx, $)
  const bar = slimFooter(ctx, $)
  const spare = bar !== null ? 2 : 0
  let level = 0
  let built = stackAt(ctx, $, level)
  while (ctx.bodyRows !== undefined && built.rows + spare > ctx.bodyRows && level < 3) {
    level += 1
    built = stackAt(ctx, $, level)
  }
  return <Box flexDirection="column">{[...built.els, ...(bar !== null ? [blank(ctx, $, 'slim-foot-gap'), bar] : [])]}</Box>
}
