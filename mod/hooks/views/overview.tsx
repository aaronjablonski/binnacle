import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow, Step, Tab, TaskItem, Timeline } from '../../types'
import { commandOf, headerState } from '../model/alerts'
import type { HeaderState, NeedsView, Watch } from '../model/alerts'
import { oneLine } from '../model/label'
import { thisTurn } from '../model/meter'
import { todoBlock } from '../model/todo'
import type { TodoBlock } from '../model/todo'
import { leaveDetail, updateUi } from '../state'
import { budgetView, budgetWords, exportLedger, isBudgetOpen, nowGauges, setBudgetOpen } from './budget'
import { doing, fitRuns, sinceWords, span, todoBar, wordFit, wrapWords } from './fit'
import { argOf, headline } from './lay'
import { exportDigest } from './handoff'
import { moveNeed, needsSlot, needsSlotHeight, needsView, spreadRuns } from './needs'
import { openAgentPage } from './agentmeta'
import { openPage } from './pagenav'
import { openStep } from './openstep'
import { agentCard, blank, header, heightOf, inst, runText, section } from './parts'
import type { InstSpec, Run } from './parts'
import { drawCritter, Grid } from './raster'
import type { ViewCtx } from './shell'
import { TAB_ROWS } from './shell'
import { deckSvg } from './svgview'
import { accentName, C, CK, COCKPIT, critterArgs, critterOf, crewRole, edges, palette, typeName } from './style'
import type { PodState, Tone4 } from './style'
import { stripNow } from './stripband'
import { watchBlock, watchHeight, watchRows } from './watch'
import type { Press } from './watch'

// Now (cockpit spec "Screens": CockpitNow, CockpitNowNeedsYou, CockpitNowWatch,
// CockpitNowIdle; rulings R5, R7, R8, R12 to R14, R27 to R30). Top to bottom:
// the header (what is happening), the needs slot (does anything need me),
// Watch when it has rows, To do (how far along), This turn once the request
// ended, Agents, Notes and decisions; the footer on the last row while the
// pane has the keys. Now holds no log: no command, no step count, no error
// count. From STRIP columns the pane is the inline strip (stripband.tsx).

/** From this width the pane draws the inline strip (R34): the header left, To do and Agents right. */
export const STRIP = 96

const asIs: Press = f => f

/** The subagents of a session (every agent but the lead). */
export const subagents = (t: Timeline): AgentRow[] => Object.values(t.agents).filter(a => a.id !== 'main')

function openTab($: EngineInterface, tab: Tab): Promise<void> {
  return updateUi($, u => ({ ...leaveDetail(u), tab }))
}

/** When the current request began: the newest main turn's start (0 before any). */
function requestStart(t: Timeline): number {
  for (let i = t.turns.length - 1; i >= 0; i--) if (t.turns[i]!.agent === 'main') return t.turns[i]!.startedAt
  return 0
}

/** The newest main turn's end, while it has one. */
function turnEnd(t: Timeline): number | undefined {
  for (let i = t.turns.length - 1; i >= 0; i--) if (t.turns[i]!.agent === 'main') return t.turns[i]!.endedAt
  return undefined
}

/** R3-B M7: no request has been made yet (no turn of the lead), so there is no list to say is missing. */
export const noRequest = (t: Timeline): boolean => !t.turns.some(x => x.agent === 'main')

/** R3-B M7: something a digest can hold (a request, a task, an artifact or a note); else the export hint stays off the footer. */
export const hasExport = (t: Timeline): boolean => !noRequest(t) || t.tasks.length > 0 || t.artifacts.length > 0 || t.notes.length > 0

/** Whether the header state is one of rest: the request ended, nothing runs. */
export const isRest = (hs: HeaderState): boolean => hs.state !== 'working' && hs.state !== 'waiting'

// ---------- the header ----------

/** What the header says for a state (R7, R8, R12): the pill, its tone, the meta, the kicker and the lead's state. */
export type HeadWords = { tone: Tone4; pill: string; pillColor?: string; meta: Run[]; kicker: string; lead: PodState }

export function headWords(ctx: ViewCtx, view: NeedsView, hs: HeaderState, todo: TodoBlock): HeadWords {
  const { t, now } = ctx
  const ended = turnEnd(t)
  const ago: Run[] = ended !== undefined ? [{ text: sinceWords('finished', now - ended), dim: true }] : []
  // F M12a: a request that ended with tasks open stopped; it did not finish.
  const stoppedAgo: Run[] = ended !== undefined ? [{ text: sinceWords('stopped', now - ended), dim: true }] : []
  switch (hs.state) {
    case 'working': {
      const meta: Run[] = hs.turnMs !== undefined ? [{ text: `${span(hs.turnMs)} this turn`, dim: true }] : []
      if (hs.quiet !== 'none' && hs.quietMs !== undefined) {
        const q = `quiet ${span(hs.quietMs)}`
        meta.push({ text: meta.length > 0 ? ' · ' : '', dim: true }, hs.quiet === 'bold' ? { text: q, bold: true } : { text: q, dim: true })
      }
      return { tone: 'iris', pill: 'WORKING', meta, kicker: 'Working on', lead: 'working' }
    }
    case 'waiting': {
      const oldest = Math.min(...view.items.map(n => n.since))
      const leadAsks = view.items.some(n => n.agent === 'main')
      return {
        tone: 'amber',
        pill: 'WAITING FOR YOU',
        meta: [{ text: span(now - oldest), dim: true }],
        kicker: todo.paused ? 'Paused on' : 'Working on',
        lead: leadAsks ? 'waiting' : 'working',
      }
    }
    case 'stopped':
      return { tone: 'red', pill: 'STOPPED', meta: [{ text: hs.reason ?? 'An error ended the turn', color: CK.fail }], kicker: 'Stopped by an error', lead: 'failed' }
    case 'idle-open':
      return { tone: 'iris', pill: 'IDLE', pillColor: C.subtle, meta: stoppedAgo, kicker: `Stopped with ${hs.open} to do open`, lead: 'done' }
    case 'all-done':
      return { tone: 'mint', pill: 'ALL DONE', meta: ago, kicker: 'Finished', lead: 'done' }
    default:
      return { tone: 'iris', pill: 'IDLE', pillColor: C.subtle, meta: ago, kicker: ended !== undefined ? 'Finished' : 'Ready', lead: 'done' }
  }
}

/** The rows `nowHeader` takes: 9, or the Svg's on the desktop app. */
export const HEADER_ROWS = 9

/**
 * The header (cockpit spec "Header"): the lintel, the pill and its meta, the
 * lead's critter with the kicker and the request's goal (R14) on two lines,
 * the budget line and two gauges, the sill. The goal opens the Tasks tab, the
 * budget line the budget view. On the desktop app the Svg deck stands in for
 * it (C6 restyles that Svg).
 */
export function nowHeader(ctx: ViewCtx, $: EngineInterface, view: NeedsView, hs: HeaderState, todo: TodoBlock, o: { key?: string; press?: Press; short?: boolean; svg?: boolean; compact?: boolean } = {}): RenderElement {
  const press = o.press ?? asIs
  // I4: the Svg ends at the header; no button row repeats the tab bar and the sections below.
  const svg = o.press === undefined && o.svg !== false ? deckSvg(ctx, $) : null
  if (svg !== null) return svg
  const w = headWords(ctx, view, hs, todo)
  const ground = ctx.ground ?? 'night'
  const { left, right } = edges(ctx.cols)
  // The budget line's room: up to the gauges at 62 columns and up, else the content width (header in parts.tsx).
  const budget = budgetWords(ctx.t, ctx.now, { idle: isRest(hs), room: ctx.cols >= 62 ? right + 1 - 20 - left - 2 : right - left + 1 })
  // Slim: the turn's time alone ("41 min"), and nothing beside WAITING FOR YOU.
  if (o.short === true) w.meta = hs.state === 'working' && hs.turnMs !== undefined ? [{ text: span(hs.turnMs), dim: true }] : hs.state === 'waiting' ? [] : w.meta
  return header(ctx, $, {
    key: o.key ?? 'now',
    tone: w.tone,
    pill: w.pill,
    ...(w.pillColor !== undefined ? { pillColor: w.pillColor } : {}),
    meta: w.meta,
    critter: critterArgs('lead', w.lead, { ground, motion: ctx.motion === true }),
    kicker: w.kicker,
    title: headline(ctx.t).text,
    ...(headline(ctx.t).isPast === true ? { dimTitle: true } : {}),
    onTitle: press(() => openTab($, 'tasks')),
    ...(budget.length > 0 ? { budget, onBudget: press(() => setBudgetOpen($, true)) } : {}),
    gauges: nowGauges(ctx.t),
    ground,
    ...(o.compact === true ? { compact: true } : {}),
  })
}

// ---------- To do (R11 to R14) ----------

/** The list rows To do draws in `n` rows: the done row, the current task, the open ones, `+ k more`. */
type TodoPlan = { lastDone?: TaskItem; current?: TaskItem; open: TaskItem[]; more: number; allDone: boolean }

export function todoPlan(todo: TodoBlock, n: number): TodoPlan {
  if (todo.empty) return { open: [], more: 0, allDone: false }
  const pending = todo.items.filter(x => x.status === 'pending' || (x.status === 'in_progress' && x !== todo.current))
  if (todo.current === undefined && pending.length === 0) return { open: [], more: 0, allDone: true }
  const cur = todo.current !== undefined ? 1 : 0
  const room = Math.max(1, n)
  const fits = (withDone: boolean, k: number): boolean => (withDone ? 1 : 0) + cur + k + (pending.length > k ? 1 : 0) <= room
  for (const withDone of [todo.lastDone !== undefined, false]) {
    for (let k = pending.length; k >= (withDone ? 1 : 0); k--) {
      if (!fits(withDone, k)) continue
      if (withDone && k === 0 && pending.length > 0) continue
      const plan: TodoPlan = { open: pending.slice(0, k), more: pending.length - k, allDone: false }
      if (withDone && todo.lastDone !== undefined) plan.lastDone = todo.lastDone
      if (todo.current !== undefined) plan.current = todo.current
      return plan
    }
  }
  const plan: TodoPlan = { open: [], more: pending.length, allDone: false }
  if (todo.current !== undefined) plan.current = todo.current
  return plan
}

/** The list rows a plan draws. */
export const planRows = (p: TodoPlan, empty: boolean): number =>
  empty || p.allDone ? 1 : (p.lastDone !== undefined ? 1 : 0) + (p.current !== undefined ? 1 : 0) + p.open.length + (p.more > 0 ? 1 : 0)

/** The extra row the current task takes when its title wraps to two rows (F I12): 1, else 0. */
export function todoWrapRows(todo: TodoBlock, cols: number): number {
  if (todo.empty || todo.current === undefined) return 0
  const { left, right } = edges(cols)
  return 2 + oneLine(todo.current.subject).length > right - left + 1 ? 1 : 0
}

/** The list rows To do wants at most (every row its tasks can fill), and its floor (current, next, `+ k`). */
export function todoWants(todo: TodoBlock): { floor: number; want: number } {
  if (todo.empty) return { floor: 1, want: 1 }
  const want = planRows(todoPlan(todo, 99), false)
  return { floor: Math.min(3, want), want: Math.min(7, want) }
}

/**
 * The To do block: the head ("9 of 14 done", the title opens Tasks), the bar
 * (R13: proportional past the width) and a blank, then the list: one done
 * row (R14), the current task behind the `▍` marker (`now · 12 min`, or
 * `paused` in amber while a dialog blocks it, R5), the open tasks (`next` on
 * the first), `+ k more to do`. All done: one line. No list: the head and
 * one dim row (R12). Each task row opens its page.
 */
export function todoSection(ctx: ViewCtx, $: EngineInterface, todo: TodoBlock, n: number, o: { press?: Press; ended?: boolean } = {}): RenderElement[] {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const press = o.press ?? asIs
  const { left, right } = edges(ctx.cols)
  const content = Math.max(1, right - left + 1)
  const openTasks = press(() => openTab($, 'tasks'))
  // R3-B M7: before any request there is nothing to say is missing: no To do block at all.
  if (todo.empty && noRequest(ctx.t)) return []
  if (todo.empty) {
    return [
      section(ctx, $, 'To do', undefined, { key: 'sec-todo', onPress: openTasks }),
      <Text key="todo-none" dimColor wrap="truncate-end">
        {' '.repeat(left)}
        {wordFit('No to-do list for this request', content)}
      </Text>,
    ]
  }
  const out: RenderElement[] = [
    section(ctx, $, 'To do', [{ text: String(todo.done), bold: true }, { text: ` of ${todo.total} done`, dim: true }], { key: 'sec-todo', onPress: openTasks }),
    <Text key="todo-bar">
      {' '.repeat(left)}
      {todoBar(content, todo.total, todo.done, todo.current !== undefined ? 1 : 0, todo.paused ? { current: { color: CK.ask } } : {}).map((r, i) => runText(r, ctx.e, $, `todo-bar-${i}`))}
    </Text>,
    blank(ctx, $, 'todo-gap'),
  ]
  const p = todoPlan(todo, n)
  if (p.allDone) {
    const last = todo.lastDone
    const head: Run[] = [{ text: '✓', color: CK.ok }, { text: ` All ${todo.total} done`, dim: true }]
    const tail = last !== undefined ? `the last was “${oneLine(last.subject)}”` : ''
    // F M10: the last task wraps to a second row before any of it is cut.
    const together = head.reduce((n, r) => n + r.text.length, 0) + (tail !== '' ? 3 + tail.length : 0) <= content
    const row1: Run[] = together && tail !== '' ? [...head, { text: ` · ${tail}`, dim: true }] : head
    out.push(
      <Text key="todo-all" wrap="truncate-end">
        {' '.repeat(left)}
        {(fitRuns(row1, content) as Run[]).filter(r => r.text !== '').map((r, i) => runText(r, ctx.e, $, `todo-all-${i}`))}
      </Text>,
    )
    if (!together && tail !== '') {
      // R3-B I5: the last task wraps by word under the count, up to three rows, before anything is cut.
      wrapWords(tail, Math.max(1, content - 2), 3).forEach((line, i) =>
        out.push(
          <Text key={`todo-all-last-${i}`} dimColor wrap="truncate-end">
            {`${' '.repeat(left + 2)}${line}`}
          </Text>,
        ),
      )
    }
    return out
  }
  // F I12: a task's tag shortens ("now · 12 min", then "now") and then goes before its title is cut; the current
  // task, still too long, wraps to two rows as slim's does.
  const row = (x: TaskItem, runs: Run[], tags: Run[][], mark?: string, wrap = false): RenderElement => {
    const key = `task-${x.owner}-${x.id}`
    const titleW = runs.reduce((n, r) => n + r.text.length, 0)
    const tag = tags.find(g => titleW + 2 + g.reduce((n, r) => n + r.text.length, 0) <= content) ?? (titleW <= content ? [] : undefined)
    const lines = tag === undefined && wrap ? wrapWords(oneLine(x.subject), Math.max(1, content - 2), 2) : undefined
    const body = lines === undefined ? spreadRuns(runs, tag ?? [], content) : []
    const markEl = (k: string): RenderElement =>
      mark !== undefined ? (
        <Text key={k} color={mark}>
          {'▍ '}
        </Text>
      ) : (
        <Text key={k}>{' '.repeat(left)}</Text>
      )
    const press1 = press(() => openPage($, 'task', `${x.owner}:${x.id}`, key))
    if (lines !== undefined) {
      return (
        <Box key={`row-${key}`} flexDirection="row">
          <Box key={`${key}-marks`} flexDirection="column" width={left} flexShrink={0}>
            {lines.map((_, i) => (mark !== undefined ? <Text key={`${key}-mark-${i}`} color={mark}>{'▍'}</Text> : <Text key={`${key}-mark-${i}`}>{' '}</Text>))}
          </Box>
          <Box key={`${key}-lines`} flexDirection="column">
            <Button key={key} plain onPress={press1}>
              {[runs[0]!, { ...runs[1]!, text: lines[0]! }].map((r, i) => runText(r, ctx.e, $, `${key}-${i}`))}
            </Button>
            <Text key={`${key}-line2`} bold>{`  ${lines[1] ?? ''}`}</Text>
          </Box>
        </Box>
      )
    }
    return (
      <Box key={`row-${key}`} flexDirection="row">
        {markEl(`${key}-mark`)}
        <Button key={key} plain onPress={press1}>
          {body.map((r, i) => runText(r, ctx.e, $, `${key}-${i}`))}
        </Button>
      </Box>
    )
  }
  if (p.lastDone !== undefined) out.push(row(p.lastDone, [{ text: `✓ ${oneLine(p.lastDone.subject)}`, dim: true }], [[]]))
  if (p.current !== undefined) {
    const tint = todo.paused ? CK.ask : CK.accent
    const notes: Run[][] = todo.paused
      ? [[{ text: 'paused', color: CK.ask }]]
      : o.ended === true
        ? [[{ text: 'stopped', dim: true }]]
        : [[{ text: 'now', color: CK.accent }, { text: ` · ${span(ctx.now - p.current.updatedAt)}`, dim: true }], [{ text: 'now', color: CK.accent }]]
    out.push(row(p.current, [{ text: '▸ ', color: tint }, { text: oneLine(p.current.subject), bold: true }], notes, tint, true))
  }
  const firstOpen = p.open.find(o => o.status !== 'in_progress')
  p.open.forEach(x => {
    // R3-B M2: every task in progress draws `▸`; only the open ones draw `○`.
    const going = x.status === 'in_progress'
    out.push(row(x, [going ? { text: '▸ ', color: CK.accent } : { text: '○ ', color: CK.rule }, { text: oneLine(x.subject) }], x === firstOpen ? [[{ text: 'next', dim: true }]] : [[]]))
  })
  if (p.more > 0) {
    out.push(
      <Text key="todo-more" dimColor wrap="truncate-end">
        {`${' '.repeat(left + 2)}+ ${p.more} more to do`}
      </Text>,
    )
  }
  return out
}


// ---------- Agents ----------

/** The agents Now draws a card for: the live ones (oldest first), then the ones that failed in this request (newest first). */
export function cardAgents(t: Timeline): AgentRow[] {
  const from = requestStart(t)
  const subs = subagents(t)
  const live = subs.filter(a => a.status === 'running').sort((a, b) => a.startedAt - b.startedAt)
  const failed = subs.filter(a => a.status === 'error' && (a.endedAt ?? a.startedAt) >= from).sort((a, b) => b.startedAt - a.startedAt)
  return [...live, ...failed]
}

/** The newest running step of an agent. */
function runningStep(t: Timeline, agent: string): Step | undefined {
  let out: Step | undefined
  for (const s of t.steps) if (s.agent === agent && s.status === 'running' && (out === undefined || s.seq > out.seq)) out = s
  return out
}

/** How many rows the Agents block takes with `cards` cards. */
export function agentsHeight(t: Timeline, rest: boolean, cards: number): number {
  const all = cardAgents(t)
  const finished = subagents(t).filter(a => a.status === 'done').length
  if (rest || all.length === 0) return rest || finished > 0 ? 1 + (rest ? 2 : 1) : 0
  const shown = Math.min(cards, all.length)
  return 1 + 3 * shown + (all.length > shown ? 1 : 0) + (finished > 0 ? 1 : 0)
}

/** Whether the Agents block ends on a card's empty third row (then no gap follows it). */
export function agentsEndOnCard(t: Timeline, rest: boolean, cards: number): boolean {
  const all = cardAgents(t)
  const finished = subagents(t).filter(a => a.status === 'done').length
  return !rest && all.length > 0 && all.length <= cards && finished === 0
}

/** The resting crew at idle: the lead and up to three agents that finished, micro critters at a pitch of 5, lamps off. */
export function restingSpec(t: Timeline, ground: 'night' | 'day'): InstSpec {
  const seen = new Set<string>(['lead'])
  const roles: ('lead' | 'scout' | 'build' | 'check')[] = ['lead']
  for (const a of subagents(t).sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0))) {
    if (roles.length >= 4) break
    const r = crewRole(a.id, a.type)
    if (seen.has(r)) continue
    seen.add(r)
    roles.push(r)
  }
  const columns = roles.length * 5 - 1
  return {
    key: 'rest',
    columns,
    rows: 2,
    sig: `rest:${ground}:${accentName()}:${roles.join(',')}`,
    frames: () => {
      const g = new Grid(columns, 2, palette(ground))
      roles.forEach((r, i) => drawCritter(g, i * 5, 0, r, 'done', 'micro', { ground }))
      return [g]
    },
    fallback: [[{ text: roles.map(() => '✓').join('    '), dim: true }], []],
  }
}

/**
 * The Agents block: the head ("2 working", "1 working · 1 waiting", "none
 * working"; the title opens Agents), a card for each live agent (and each
 * that failed in this request) up to `cards`, `+ k more working`, and
 * "31 finished earlier". A card's critter waits (`?`) while its agent asks,
 * dozes (`z`) while it is stalled; its time is its own run time (the wait is
 * the block's, R30), bold past its limit (R6). At rest: the resting crew and two dim lines.
 */
export function agentsSection(
  ctx: ViewCtx,
  $: EngineInterface,
  cards: number,
  o: { view: NeedsView; watch: Watch[]; rest: boolean; press?: Press },
): RenderElement[] {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { t, now } = ctx
  const press = o.press ?? asIs
  const { left } = edges(ctx.cols)
  const ground = ctx.ground ?? 'night'
  const all = cardAgents(t)
  const finished = subagents(t).filter(a => a.status === 'done').length
  const openAgents = press(() => openTab($, 'agents'))
  if (o.rest || all.length === 0) {
    if (!o.rest && finished === 0) return []
    const head = section(ctx, $, 'Agents', 'none working', { key: 'sec-agents', onPress: openAgents })
    if (!o.rest) {
      return [
        head,
        <Box key="agents-finished-row" flexDirection="row">
          <Text>{' '.repeat(COCKPIT.text)}</Text>
          <Button key="agents-finished" plain dimColor onPress={openAgents}>
            {`${finished} finished earlier`}
          </Button>
        </Box>,
      ]
    }
    const spec = restingSpec(t, ground)
    const textAt = Math.max(left + spec.columns + 3, 24)
    const words = ['Everyone is resting.', 'A new prompt wakes them.']
    // R3-B I5: both sentences beside the crew when they fit whole; else under it, wrapped by word, never cut.
    if (ctx.cols - 2 - textAt + 1 < 24) {
      const room = Math.max(1, ctx.cols - 2 - left)
      return [
        head,
        <Box key="agents-rest" flexDirection="row">
          <Text>{' '.repeat(left)}</Text>
          {inst(ctx, $, spec)}
        </Box>,
        ...words.flatMap((w, i) =>
          wrapWords(w, room, 3).map((line, j) => (
            <Text key={`agents-rest-${i}-${j}`} dimColor wrap="truncate-end">
              {' '.repeat(left) + line}
            </Text>
          )),
        ),
      ]
    }
    return [
      head,
      <Box key="agents-rest" flexDirection="row">
        <Text>{' '.repeat(left)}</Text>
        {inst(ctx, $, spec)}
        <Box key="agents-rest-words" flexDirection="column" paddingLeft={textAt - left - spec.columns}>
          {words.map((w, i) => (
            <Text key={`agents-rest-${i}`} dimColor wrap="truncate-end">
              {w}
            </Text>
          ))}
        </Box>
      </Box>,
    ]
  }
  const asking = new Map(o.view.items.map(n => [n.agent, n]))
  const dozing = new Set(o.watch.filter(w => w.kind === 'stalled' || w.kind === 'quiet').map(w => w.agent))
  const longRun = new Set(o.watch.filter(w => w.kind === 'long-run').map(w => w.agent))
  const live = all.filter(a => a.status === 'running')
  const waiting = live.filter(a => asking.has(a.id)).length
  const failed = all.length - live.length
  const sum: Run[] = [{ text: String(live.length - waiting), bold: true }, { text: ' working', dim: true }]
  if (waiting > 0) sum.push({ text: ' · ', dim: true }, { text: String(waiting), color: CK.ask, bold: true }, { text: ' waiting', color: CK.ask })
  if (failed > 0) sum.push({ text: ' · ', dim: true }, { text: String(failed), color: CK.fail, bold: true }, { text: ' failed', color: CK.fail })
  // F I5, M5: when "1 working · 1 waiting" does not fit beside the title, the working count goes and the words stay (R30): "1 waiting".
  const sumShort: Run[][] = []
  if (waiting > 0 || failed > 0) {
    const s: Run[] = []
    if (waiting > 0) s.push({ text: String(waiting), color: CK.ask, bold: true }, { text: ' waiting', color: CK.ask })
    if (failed > 0) s.push(...(s.length > 0 ? [{ text: ' · ', dim: true }] : []), { text: String(failed), color: CK.fail, bold: true }, { text: ' failed', color: CK.fail })
    sumShort.push(s)
  }
  const out: RenderElement[] = [section(ctx, $, 'Agents', sum, { key: 'sec-agents', onPress: openAgents, short: sumShort })]
  // F M10: when not every card fits, the agents that need you are kept first, and the cards stay in their own order.
  const room = Math.max(1, cards)
  const kept = new Set([...all.filter(a => asking.has(a.id)), ...all.filter(a => !asking.has(a.id))].slice(0, room).map(a => a.id))
  const shown = all.length <= room ? all : all.filter(a => kept.has(a.id))
  for (const a of shown) {
    const need = asking.get(a.id)
    const state: PodState = a.status === 'error' ? 'failed' : need !== undefined ? 'waiting' : dozing.has(a.id) ? 'stalled' : a.status === 'done' ? 'done' : 'working'
    const key = `agent-${a.id}`
    // R30 (F M11): the wait shows in the pill and the block, not again on the card: the card keeps the agent's own time.
    const time: string | Run[] =
      a.status === 'error'
        ? [{ text: 'failed', color: CK.fail }]
        : longRun.has(a.id)
          ? [{ text: span(now - a.startedAt), bold: true, dim: true }]
          : span(now - a.startedAt)
    // F I1: in auto mode's checking gap the card says "Checking a permission", as the needs slot and the band do.
    const what: string | Run[] | ((room: number) => string | Run[]) =
      a.status === 'error'
        ? [{ text: oneLine((a.result ?? a.doing ?? '').split('\n')[0] ?? '') || 'Stopped by an error', color: CK.fail }]
        : need !== undefined
          ? (room: number): Run[] => [{ text: room >= 23 ? 'Waiting for your answer' : 'Waiting for you', color: CK.ask }]
          : (room: number) => doing(runningStep(t, a.id), o.view, room)
    out.push(
      agentCard(ctx, $, {
        key,
        critter: critterOf(a, { state, ground, motion: ctx.motion === true }),
        name: typeName(a.type),
        job: oneLine(a.description),
        time,
        doing: what,
        onPress: press(() => openAgentPage($, a.id, key)),
      }),
    )
  }
  if (all.length > shown.length) {
    out.push(
      <Text key="agents-more" dimColor wrap="truncate-end">
        {`${' '.repeat(COCKPIT.text)}+ ${all.length - shown.length} more working`}
      </Text>,
    )
  }
  if (finished > 0) {
    out.push(
      <Box key="agents-finished-row" flexDirection="row">
        <Text>{' '.repeat(COCKPIT.text)}</Text>
        <Button key="agents-finished" plain dimColor onPress={openAgents}>
          {`${finished} finished earlier`}
        </Button>
      </Box>,
    )
  }
  return out
}

// ---------- This turn (idle) ----------

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** What the request that ended left behind: one fact a row (a bold count, its words, a detail at 26). */
export type TurnFact = { key: string; n: number; words: string; detail: string; tab: Tab }

export function turnFacts(t: Timeline): { ms?: number; facts: TurnFact[] } {
  const x = thisTurn(t)
  if (x === undefined) return { facts: [] }
  const from = x.turn.startedAt
  const to = x.turn.endedAt ?? Infinity
  const within = (at: number | undefined): boolean => at !== undefined && at >= from && at <= to
  const files: string[] = []
  for (const s of t.steps) {
    if (!within(s.startedAt) || s.status !== 'done' || !EDIT_TOOLS.has(s.tool)) continue
    const f = commandOf(s)
    if (f !== '' && !files.includes(f)) files.push(f)
  }
  const facts: TurnFact[] = []
  if (files.length > 0) {
    facts.push({ key: 'turn-files', n: files.length, words: files.length === 1 ? 'file changed' : 'files changed', detail: files.length > 1 ? `${files[0]} and ${files.length - 1} more` : files[0]!, tab: 'artifacts' })
  }
  const made = t.artifacts.filter(a => within(a.updatedAt))
  if (made.length > 0) facts.push({ key: 'turn-artifacts', n: made.length, words: made.length === 1 ? 'artifact' : 'artifacts', detail: made.map(a => oneLine(a.title)).join(', '), tab: 'artifacts' })
  const agents = x.agentsFinished
  if (agents.length > 0) {
    const bad = agents.filter(a => a.status === 'error')
    facts.push({
      key: 'turn-agents',
      n: agents.length,
      words: bad.length === 0 ? (agents.length === 1 ? 'agent, done' : 'agents, all done') : `${agents.length === 1 ? 'agent' : 'agents'}, ${bad.length} failed`,
      detail: bad.length > 0 ? bad.map(a => typeName(a.type)).join(', ') : '',
      tab: 'agents',
    })
  }
  if (facts.length === 0 && x.tasksClosed.length > 0) facts.push({ key: 'turn-tasks', n: x.tasksClosed.length, words: x.tasksClosed.length === 1 ? 'task closed' : 'tasks closed', detail: '', tab: 'tasks' })
  return { ...(x.ms !== undefined ? { ms: x.ms } : {}), facts }
}

/** Where a This turn fact's detail starts at 62 columns. */
const FACT_DETAIL = 26

/** The This turn block (idle): the head with the request's length, then each fact as a plain Button opening its tab. */
export function turnSection(ctx: ViewCtx, $: EngineInterface, o: { press?: Press } = {}): RenderElement[] {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const press = o.press ?? asIs
  const { left, right } = edges(ctx.cols)
  const { ms, facts } = turnFacts(ctx.t)
  if (facts.length === 0) return []
  const out: RenderElement[] = [section(ctx, $, 'This turn', ms !== undefined ? span(ms) : undefined, { key: 'sec-this-turn' })]
  for (const f of facts) {
    const head = `${f.n} ${f.words}`
    const at = Math.max(FACT_DETAIL, left + head.length + 2)
    const room = right - at + 1
    // R3-B I5: a detail that does not fit beside its count goes on its own row under it, wrapped by word.
    const beside = f.detail !== '' && f.detail.length <= room
    out.push(
      <Box key={`row-${f.key}`} flexDirection="row">
        <Text>{' '.repeat(left)}</Text>
        <Button key={f.key} plain onPress={press(() => openTab($, f.tab))}>
          <Text bold>{String(f.n)}</Text>
          <Text dimColor>{` ${f.words}`}</Text>
        </Button>
        {beside ? <Text key={`${f.key}-detail`} wrap="truncate-end">{`${' '.repeat(at - left - head.length)}${f.detail}`}</Text> : null}
      </Box>,
    )
    if (f.detail !== '' && !beside) {
      wrapWords(f.detail, Math.max(1, right - left - 1), 2).forEach((line, i) =>
        out.push(
          <Text key={`${f.key}-detail-${i}`} dimColor wrap="truncate-end">
            {`${' '.repeat(left + 2)}${line}`}
          </Text>,
        ),
      )
    }
  }
  return out
}

// ---------- Notes and decisions ----------

/** The rows of Notes and decisions: kept steps (`★`, newest first), then notes (`·`, newest first). */
export function noteItems(t: Timeline): { key: string; star: boolean; text: string; stepId?: string }[] {
  const kept = t.steps
    .filter(s => s.pin !== undefined)
    .sort((a, b) => b.seq - a.seq)
    .map(s => ({ key: `kept-${s.id}`, star: true, text: s.pin !== undefined && s.pin !== '' ? s.pin : argOf(s.tool, s.label), stepId: s.id }))
  const notes = [...t.notes].reverse().map((n, i) => ({ key: `note-${i}`, star: false, text: n.text }))
  return [...kept, ...notes]
}

/** Notes and decisions: the head with the count, then `n` rows (`★` in the accent, `·` in `subtle`); a kept row opens its step. */
export function notesSection(ctx: ViewCtx, $: EngineInterface, n: number, o: { press?: Press } = {}): RenderElement[] {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const press = o.press ?? asIs
  const items = noteItems(ctx.t)
  if (items.length === 0 || n <= 0) return []
  const { left, right } = edges(ctx.cols)
  const room = Math.max(1, right - left - 1)
  const out: RenderElement[] = [section(ctx, $, 'Notes and decisions', String(items.length), { key: 'sec-notes' })]
  for (const x of items.slice(0, n)) {
    const glyph = <Text color={x.star ? CK.accent : CK.rule}>{x.star ? '★ ' : '· '}</Text>
    const words = wordFit(oneLine(x.text), room)
    const id = x.stepId
    out.push(
      <Box key={`row-${x.key}`} flexDirection="row">
        <Text>{' '.repeat(left)}</Text>
        {id !== undefined ? (
          <Button key={x.key} plain onPress={press(() => openStep($, id, x.key))}>
            {glyph}
            <Text>{words}</Text>
          </Button>
        ) : (
          <Text key={x.key} wrap="truncate-end">
            {glyph}
            {words}
          </Text>
        )}
      </Box>,
    )
  }
  return out
}

// ---------- the footer ----------

// The footer's hint type and row live in tabkit.tsx (R28 amended); re-exported for the views that import them from here.
import { footerRow, footerSlot } from './tabkit'
import type { FootHint } from './tabkit'
export type { FootHint }

/** Now's footer for its state: a need, a Watch row, rest, or busy (the mocks' footers). */
function nowHints($: EngineInterface, view: NeedsView, watch: Watch[], hs: HeaderState, cols: number, compact = false, exportable = true): FootHint[] {
  // Under 40 columns, or under 30 rows (F M13), the compact header has no budget line: `b` opens the budget view from here.
  if (cols < 40 || compact) return [{ hotkey: 'b', label: 'budget', id: 'hint-budget', onPress: () => setBudgetOpen($, true) }, { key: '↵', label: 'open' }, { key: 'esc', label: 'prompt' }]
  if (view.items.length > 0) {
    const count = view.items.length
    return [
      { key: '↵', label: 'open' },
      ...(count > 1 ? [{ hotkey: 'n', label: 'next ask', id: 'hint-next', onPress: () => moveNeed($, 1, count) }] : []),
      { key: 'esc', label: 'prompt' },
    ]
  }
  if (watch.length > 0) return [{ key: '↵', label: 'open' }, ...(watch[0]!.agent !== 'main' ? [{ key: 'v', label: 'transcript' }] : []), { key: 'x', label: 'dismiss' }]
  if (isRest(hs) && !exportable) return [{ key: '↵', label: 'open' }, { key: 'esc', label: 'prompt' }]
  if (isRest(hs)) return [{ key: '↵', label: 'open' }, { hotkey: 'e', label: 'export digest', id: 'hint-export', onPress: async () => { await exportDigest($) } }, { key: 'esc', label: 'prompt' }]
  return [{ key: '↵', label: 'open' }, { key: '0', label: 'options' }, { key: 'esc', label: 'prompt' }]
}

// ---------- the height rule ----------

/** The rows each list gets: To do floor 3 up to 7, Agents 1 card up to 3, Notes 1 up to 4; spare rows to To do, then Agents, then Notes. */
export function dealRows(spare: number, todo: { floor: number; want: number }, agents: { floor: number; want: number }, notes: { floor: number; want: number }): { todo: number; cards: number; notes: number } {
  let left = spare
  const give = (floor: number, want: number, per: number): number => {
    let n = floor
    while (n < want && left >= per) {
      n++
      left -= per
    }
    return n
  }
  const td = give(todo.floor, todo.want, 1)
  const cards = give(agents.floor, agents.want, 3)
  const ns = give(notes.floor, notes.want, 1)
  return { todo: td, cards, notes: ns }
}

/** What Now draws, shared with the strip and slim: the alert state, the list and the rows. */
export type NowState = { view: NeedsView; watch: Watch[]; hs: HeaderState; todo: TodoBlock }

export function nowState(ctx: ViewCtx): NowState {
  const view = needsView(ctx)
  const watch = watchRows(ctx)
  return { view, watch, hs: headerState(ctx.t, ctx.now, view), todo: todoBlock(ctx.t, view.items.map(n => n.agent)) }
}

/** The watch rows Now lists at most. */
export const WATCH_CAP = 3

/**
 * The Now tab. The budget view replaces it while open; from STRIP columns
 * the pane is the inline strip (stripband.tsx). Otherwise the blocks in
 * order, one blank row between them, the lists sized by the height rule
 * (`dealRows`) to the pane's rows under the tab bar, and the footer on the
 * last row while the pane has the keys (spare rows stay empty above it).
 */
export function overviewView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  if (isBudgetOpen()) {
    const bar = footerSlot(ctx, $, [
      { hotkey: 'b', label: 'back', id: 'hint-back', onPress: () => setBudgetOpen($, false) },
      { hotkey: 'e', label: 'csv', id: 'hint-csv', onPress: () => exportLedger($, ctx.showCost === true) },
      { key: 'esc', label: 'prompt' },
    ])
    return (
      <Box flexDirection="column">
        {budgetView(ctx, $)}
        {bar !== null ? <Text key="footer-gap"> </Text> : null}
        {bar}
      </Box>
    )
  }
  if (ctx.cols >= STRIP) return stripNow(ctx, $)
  const st = nowState(ctx)
  const { view, watch, hs, todo } = st
  const rest = isRest(hs)
  const rows = (ctx.bodyRows ?? 46) - TAB_ROWS
  // F M13: under 30 rows the header is the compact one (no critter block or gauges), so To do and an agent stay in view.
  const compact = (ctx.bodyRows ?? 46) < 30
  const bar = footerSlot(ctx, $, nowHints($, view, watch, hs, ctx.cols, compact, hasExport(ctx.t)))
  const footRows = bar !== null ? 2 : 0

  const headEl = nowHeader(ctx, $, view, hs, todo, compact ? { compact: true } : {})
  const turn = rest ? turnSection(ctx, $) : []
  const tw = todoWants(todo)
  const cards = cardAgents(ctx.t).length
  const ag = rest || cards === 0 ? { floor: 0, want: 0 } : { floor: 1, want: Math.min(3, cards) }
  const nn = noteItems(ctx.t).length
  const nw = nn === 0 ? { floor: 0, want: 0 } : { floor: 1, want: Math.min(4, nn) }
  const headH = ctx.look === 'svg' ? 9 : compact ? heightOf(headEl) : HEADER_ROWS
  const fixed =
    headH + 1 +
    needsSlotHeight(view, 3, { cols: ctx.cols, now: ctx.now }) + 1 +
    (watch.length > 0 ? watchHeight(ctx, watch, WATCH_CAP) + 1 : 0) +
    (todo.empty ? (noRequest(ctx.t) ? 0 : 1) : 3) + todoWrapRows(todo, ctx.cols) + (todo.empty && noRequest(ctx.t) ? 0 : 1) +
    (turn.length > 0 ? turn.length + 1 : 0) +
    agentsHeight(ctx.t, rest, ag.floor) - 3 * ag.floor + 1 +
    (nn > 0 ? 1 : 0)
  const deal = dealRows(rows - footRows - fixed - tw.floor - 3 * ag.floor - nw.floor, tw, ag, nw)

  const blocks: RenderElement[][] = [
    [headEl],
    needsSlot(ctx, $, view, { watchCount: watch.length }),
    watchBlock(ctx, $, watch, WATCH_CAP),
    todoSection(ctx, $, todo, deal.todo, { ended: rest }),
    turn,
    agentsSection(ctx, $, Math.max(1, deal.cards), { view, watch, rest }),
    notesSection(ctx, $, Math.max(1, deal.notes)),
  ]
  // A card's third row is empty: when the Agents block ends on one, it is the gap.
  const endsOnCard = agentsEndOnCard(ctx.t, rest, Math.max(1, deal.cards))
  const out: RenderElement[] = []
  let prev = -1
  blocks.forEach((b, i) => {
    if (b.length === 0) return
    if (prev >= 0 && !(prev === 5 && endsOnCard)) out.push(blank(ctx, $, `gap-${i}`))
    out.push(...b)
    prev = i
  })
  if (bar !== null) {
    const used = out.reduce((n, el) => n + heightOf(el), 0)
    const pad = Math.max(1, rows - 1 - used)
    for (let i = 0; i < pad; i++) out.push(blank(ctx, $, `pad-${i}`))
    out.push(bar)
  }
  return <Box flexDirection="column">{out}</Box>
}
