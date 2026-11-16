import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow, TaskItem, Timeline } from '../../types'
import { agentTree, runningOnlyTree } from '../model/select'
import type { TreeNode } from '../model/select'
import { debug, errText, updateUi } from '../state'
import { EMPTY, RUN_GLYPH, agentCols, cellTime, failReason, isOpen, openAgentPage, runningStep, timeCell, tokensCell, tokensOf, toggleOpen } from './agentmeta'
import { modelName, tokenText } from './budget'
import { hueHex, lineOf, nodeOf, pipRuns, stateOf } from './crewnode'
import type { Seg } from './crewnode'
import { clauseFit, doing, nameFit, wordFit, wrapWords } from './fit'
import { doingView } from './needs'
import { blank, frameTopInst, inst } from './parts'
import type { Run } from './parts'
import type { ViewCtx } from './shell'
import { C, CK, COCKPIT, critterOf, crewRole, edges, typeName } from './style'
import type { PodState } from './style'

// The crew map (crew spec "Crew map rules", re-laid per R26 in the cockpit's
// words): only working agents are drawn as characters; done agents fold into
// role-hue pips and `+ n done`; flagged agents never fold and climb to the
// gutter; three bands top-down (Doing now, Up next, Done); the right side is
// a table (state from 36, tokens ending at 49, time ending at 59 at 62
// columns); `d` unfolds. Trunk at column 4, task names at 9, tethers at 7,
// agent names at 17.

const TRUNK = 4
const TASK_MARK = 7
const TASK_NAME = 9
const TETHER = 7
const AGENT_CRITTER = 10
const AGENT_NAME = 17
/** The most done tasks the Done band lists before `+ n more`; `d` or a press shows them all. */
export const DONE_ROWS = 12
/** The most queued tasks the Up next band lists before `+ n more`. */
export const NEXT_ROWS = 5

export type Band = 'now' | 'next' | 'done'

/** One row of the trunk: a task, a workflow run, the agents with no task, or a queued task with no agent yet. */
export type MapGroup = {
  key: string
  kind: 'task' | 'run' | 'none' | 'queued'
  label: string
  mark: string
  band: Band
  /** Working, waiting, stalled and failed agents: drawn in full, never folded. */
  drawn: AgentRow[]
  /** Finished agents with nothing to flag: pips and `+ n done`. */
  folded: AgentRow[]
  agents: AgentRow[]
  start: number
  end: number
}

/** The agents under a node, itself included when it is one (main and run nodes not counted), nested ones flattened. */
function agentsIn(node: TreeNode): AgentRow[] {
  const out: AgentRow[] = []
  const walk = (n: TreeNode) => {
    if (n.kind === 'agent' && n.agent !== undefined && n.agent.id !== 'main') out.push(n.agent)
    n.children.forEach(walk)
  }
  walk(node)
  return out
}

/** A flagged agent is never folded: it failed, or it waits or is stalled (`states`), or it has a problem (`ids`). */
const flagged = (a: AgentRow, ids: Set<string>, states: Map<string, PodState>): boolean => a.status === 'error' || ids.has(a.id) || states.has(a.id)

/**
 * The map's groups, by band. Doing now: a task, run or no-task group with a
 * working or flagged agent, and the open task in progress. Up next: queued
 * tasks (a task with no agent yet), then the agents with no task. Done:
 * everything else, newest first.
 */
export function groupsOf(t: Timeline, root: TreeNode, ids: Set<string>, states: Map<string, PodState>): MapGroup[] {
  const owner = root.agent?.id ?? 'main'
  const byTask = new Map<string, AgentRow[]>()
  const runs: { node: TreeNode }[] = []
  const none: AgentRow[] = []
  for (const c of root.children) {
    if (c.kind === 'run') {
      runs.push({ node: c })
      continue
    }
    const id = c.agent?.taskId
    if (id === undefined) none.push(...agentsIn(c))
    else byTask.set(id, [...(byTask.get(id) ?? []), ...agentsIn(c)])
  }
  type Raw = { key: string; kind: MapGroup['kind']; label: string; task?: TaskItem; agents: AgentRow[] }
  const raws: Raw[] = []
  for (const r of runs) raws.push({ key: r.node.key, kind: 'run', label: r.node.run?.name ?? r.node.key, agents: agentsIn(r.node) })
  for (const [id, agents] of byTask) {
    const task = t.tasks.find(x => x.owner === owner && x.id === id)
    raws.push({ key: `task:${id}`, kind: 'task', label: task !== undefined ? `${id} ${task.subject}` : `task ${id}`, ...(task !== undefined ? { task } : {}), agents })
  }
  if (none.length > 0) raws.push({ key: 'task:none', kind: 'none', label: 'no task', agents: none })
  // Tasks with no agent yet: the open ones are rows too (queued, or the one in progress).
  for (const task of t.tasks) {
    if (task.owner !== owner || task.status === 'completed' || byTask.has(task.id)) continue
    raws.push({ key: `queued:${task.id}`, kind: 'queued', label: `${task.id} ${task.subject}`, task, agents: [] })
  }
  const out = raws.map((r): MapGroup => {
    const drawn = r.agents.filter(a => a.status === 'running' || flagged(a, ids, states)).sort((x, y) => x.startedAt - y.startedAt)
    const folded = r.agents.filter(a => !drawn.includes(a))
    const start = r.agents.reduce((m, a) => Math.min(m, a.startedAt), Infinity)
    const end = r.agents.reduce((m, a) => Math.max(m, a.endedAt ?? a.startedAt), 0)
    const inProgress = r.task?.status === 'in_progress'
    const band: Band = drawn.length > 0 || inProgress ? 'now' : r.kind === 'queued' || r.kind === 'none' ? 'next' : 'done'
    const mark = band === 'now' ? '▸' : r.kind === 'run' ? RUN_GLYPH : r.kind === 'none' ? '◇' : band === 'next' ? '▫' : '▪'
    return { key: r.key, kind: r.kind, label: r.label, mark, band, drawn, folded, agents: r.agents, start, end }
  })
  const order = (g: MapGroup): number => (g.kind === 'queued' ? (t.tasks.findIndex(x => x.owner === owner && g.key === `queued:${x.id}`) + 1) : Number.MAX_SAFE_INTEGER)
  return [
    ...out.filter(g => g.band === 'now').sort((a, b) => a.start - b.start),
    ...out.filter(g => g.band === 'next').sort((a, b) => order(a) - order(b) || a.start - b.start),
    ...out.filter(g => g.band === 'done').sort((a, b) => b.end - a.end),
  ]
}

const tokensSum = (agents: AgentRow[]): string => {
  let sum: number | undefined
  for (const a of agents) {
    const n = tokensOf(a)
    if (n !== undefined) sum = (sum ?? 0) + n
  }
  return sum === undefined ? '–' : tokenText(sum)
}

/** A group's time: from its first start to now while anything runs, else to the last end. */
function timeOf(ctx: ViewCtx, g: MapGroup): string {
  if (g.agents.length === 0 || !Number.isFinite(g.start)) return ''
  return cellTime((g.drawn.some(a => a.status === 'running') ? ctx.now : g.end) - g.start)
}

/** The cells on a row's right: a state word from the state column, tokens ending at the tokens column, time ending at the time column. */
function rightSegs(ctx: ViewCtx, o: { state?: Run; pips?: Run[]; tokens?: string; time?: string; ink?: boolean }): Seg[] {
  const c = agentCols(ctx.cols)
  const style: Omit<Run, 'text'> = o.ink === true ? {} : { dim: true }
  const out: Seg[] = []
  if (c.state !== undefined && o.state !== undefined) {
    out.push({ ...o.state, col: c.state })
    if (o.pips !== undefined && o.pips.length > 0) {
      let col = c.state - 1 - o.pips.reduce((n, p) => n + p.text.length, 0)
      for (const p of o.pips) {
        out.push({ ...p, col })
        col += p.text.length
      }
    }
  }
  if (c.tokens !== undefined && o.tokens !== undefined && o.tokens !== '') out.push({ col: c.tokens - o.tokens.length + 1, text: o.tokens, ...style })
  if (o.time !== undefined && o.time !== '') out.push({ col: c.time - o.time.length + 1, text: o.time, ...style })
  return out.sort((a, b) => a.col - b.col)
}

const firstCol = (segs: Seg[], fallback: number): number => segs.reduce((m, s) => Math.min(m, s.col), fallback)

const FLAG: Record<'waiting' | 'stalled' | 'failed', Run> = {
  waiting: { text: '?', color: CK.ask, bold: true },
  stalled: { text: 'z', color: CK.ask, bold: true },
  failed: { text: '!', color: CK.fail, bold: true },
}

/** The gutter flag of an agent's state, column 0: the map only (R26). */
const flagOf = (state: PodState): Seg[] => (state === 'waiting' || state === 'stalled' || state === 'failed' ? [{ col: 0, ...FLAG[state] }] : [])

const STATE_STYLE: Record<PodState, Omit<Run, 'text'>> = {
  queued: { dim: true },
  working: { color: CK.accent, bold: true },
  waiting: { color: CK.ask, bold: true },
  stalled: { dim: true },
  failed: { color: CK.fail },
  done: { dim: true },
}

const stateRun = (state: PodState, word: string = state): Run => ({ text: word, ...STATE_STYLE[state] })

/** The tether characters a row draws at the trunk and at the tether column. */
const trunk = (chars: Record<number, string | undefined>): Seg[] =>
  Object.entries(chars).flatMap(([col, text]) => (text === undefined ? [] : [{ col: Number(col), text, color: C.subtle }]))

type Ctx = { ctx: ViewCtx; ids: Set<string>; states: Map<string, PodState>; targets: { key: string; open: string }[] }

/** Main on top: its small critter, its name (the real type, "Claude"), its model and role, and what it is working on. */
function mainNode(k: Ctx, $: EngineInterface, main: AgentRow, working: boolean): RenderElement {
  const { ctx, ids, states } = k
  const t = ctx.t
  const c = agentCols(ctx.cols)
  const state: PodState = states.get('main') ?? (working ? 'working' : 'done')
  const problem = ids.has('main')
  if (problem) k.targets.push({ key: 'node-main', open: 'main' })
  const nums = rightSegs(ctx, {
    state: stateRun(state, state === 'done' ? 'idle' : state),
    tokens: tokensCell(main),
    time: timeText(ctx, main),
    ink: true,
  })
  const model = main.model !== undefined && main.model !== '' ? ` · ${modelName(main.model)}` : ''
  const room = Math.max(1, firstCol(nums, c.right + 2) - 2 - TASK_NAME + 1)
  const what = t.now?.focus ?? (working ? doing(runningStep(t, 'main'), doingView(ctx)) : '')
  const critter = critterOf(main, { state, ground: ctx.ground ?? 'night', motion: ctx.motion === true })
  return nodeOf(ctx, $, {
    key: 'node-main',
    critter,
    critterCol: COCKPIT.left,
    pre: [flagOf(state), [], []],
    rows: [
      [{ col: TASK_NAME, text: nameFit(typeName('main'), room), bold: true }, ...nums],
      [{ col: TASK_NAME, text: `lead${model}`, dim: true }],
      [{ col: TASK_NAME, text: wordFit(what, Math.max(1, c.right - TASK_NAME + 1)), dim: true }],
    ],
    onPress: () => openAgentPage($, 'main', 'node-main'),
  })
}

const timeText = timeCell

/** A drawn agent under its group: a small critter (a micro one when it failed) with name, real type and model, and the current step. */
function agentNode(k: Ctx, $: EngineInterface, a: AgentRow, last: boolean, innerTrunk: boolean): RenderElement {
  const { ctx, states } = k
  const c = agentCols(ctx.cols)
  const state = stateOf(a, states)
  const key = `node-${a.id}`
  if (state !== 'done' && k.ids.has(a.id)) k.targets.push({ key, open: a.id })
  else if (state === 'failed') k.targets.push({ key, open: a.id })
  const live = state !== 'failed'
  const nums = rightSegs(ctx, { state: stateRun(state), tokens: tokensCellOf(a), time: timeText(ctx, a), ink: live })
  const room = Math.max(1, firstCol(nums, c.right + 2) - 2 - AGENT_NAME + 1)
  const model = a.model !== undefined && a.model !== '' ? ` · ${modelName(a.model)}` : ''
  const critter = critterOf(a, { state, size: live ? 'small' : 'micro', ground: ctx.ground ?? 'night', motion: ctx.motion === true })
  const tr = (first: boolean): Seg[] =>
    trunk({
      ...(innerTrunk ? { [TRUNK]: '│' } : {}),
      ...(first ? { [TETHER]: last ? '╰' : '├', [TETHER + 1]: '╌' } : last ? {} : { [TETHER]: '│' }),
    })
  const name = a.description.replace(/\s+/g, ' ').trim() || typeName(a.type)
  const rows: Seg[][] = [[{ col: AGENT_NAME, text: clauseFit(name, room), ...(live ? {} : { bold: true }) }, ...nums]]
  if (live) {
    rows.push([{ col: AGENT_NAME, text: `${typeName(a.type)}${model}`, dim: true }])
    const what =
      state === 'waiting'
        ? [{ col: AGENT_NAME, text: '▸ ', color: CK.accent }, { col: AGENT_NAME + 2, text: 'Waiting for your answer', color: CK.ask }]
        : [{ col: AGENT_NAME, text: '▸ ', color: CK.accent }, { col: AGENT_NAME + 2, text: doing(runningStep(ctx.t, a.id), doingView(ctx), Math.max(1, c.right - AGENT_NAME - 1)), dim: true }]
    rows.push(what)
  } else {
    wrapWords(failReason(ctx.t, a), Math.max(1, c.right - AGENT_NAME + 1), 2).forEach(r => rows.push([{ col: AGENT_NAME, text: r, dim: true }]))
    rows.push([{ col: AGENT_NAME, text: `${typeName(a.type)}${model}`, dim: true }])
  }
  const height = Math.max(critter.rows, rows.length)
  return nodeOf(ctx, $, {
    key,
    critter,
    critterCol: AGENT_CRITTER,
    pre: Array.from({ length: height }, (_, i) => [...(i === 0 ? flagOf(state) : []), ...tr(i === 0)]),
    rows,
    onPress: () => openAgentPage($, a.id, key),
  })
}

const tokensCellOf = tokensCell
/** `╰╌ + 3 done` under a working task: the pips before the state column, "done", the folded agents' sums. */
function chipRow(k: Ctx, $: EngineInterface, g: MapGroup, last: boolean, innerTrunk: boolean): RenderElement {
  const { ctx } = k
  const key = `chip:${g.key}`
  const ground = ctx.ground ?? 'night'
  const start = g.folded.reduce((m, a) => Math.min(m, a.startedAt), Infinity)
  const end = g.folded.reduce((m, a) => Math.max(m, a.endedAt ?? a.startedAt), 0)
  const nums = rightSegs(ctx, { state: stateRun('done'), pips: pipRuns(g.folded, ground), tokens: tokensSum(g.folded), time: cellTime(end - start) })
  const body: Seg[] = [{ col: AGENT_CRITTER, text: `+ ${g.folded.length} done`, dim: true }, ...nums]
  return lineOf(ctx, $, {
    key,
    pre: trunk({ ...(innerTrunk ? { [TRUNK]: '│' } : {}), [TETHER]: last ? '╰' : '├', [TETHER + 1]: '╌' }),
    body,
    onPress: () => updateUi($, cur => toggleOpen(cur, g.key)),
  })
}

/** One folded agent listed on `d`: its pip, its real type, its job, and the three columns. Still no character. */
function foldedRow(k: Ctx, $: EngineInterface, g: MapGroup, a: AgentRow, last: boolean, innerTrunk: boolean): RenderElement {
  const { ctx } = k
  const c = agentCols(ctx.cols)
  const role = crewRole(a.id, a.type)
  const nums = rightSegs(ctx, { state: stateRun('done'), tokens: tokensCellOf(a), time: timeText(ctx, a) })
  const typeCol = AGENT_CRITTER + 2
  const type = typeName(a.type)
  const jobCol = typeCol + type.length + 2
  const end = firstCol(nums, c.right + 2) - 2
  const job = a.description.replace(/\s+/g, ' ').trim()
  const body: Seg[] = [
    { col: AGENT_CRITTER, text: '▪', color: hueHex(role, ctx.ground ?? 'night') },
    { col: typeCol, text: nameFit(type, Math.max(1, end - typeCol + 1)), color: hueHex(role, ctx.ground ?? 'night') },
    ...(job !== '' && end - jobCol + 1 >= 4 ? [{ col: jobCol, text: clauseFit(job, end - jobCol + 1), dim: true }] : []),
    ...nums,
  ]
  const key = `done-${g.key}-${a.id}`
  return lineOf(ctx, $, {
    key,
    pre: trunk({ ...(innerTrunk ? { [TRUNK]: '│' } : {}), [TETHER]: last ? '╰' : '├', [TETHER + 1]: '╌' }),
    body,
    onPress: () => openAgentPage($, a.id, key),
  })
}

/** A group's row on the trunk, and the agents under it. */
function groupRows(k: Ctx, $: EngineInterface, g: MapGroup, last: boolean): RenderElement[] {
  const { ctx } = k
  const c = agentCols(ctx.cols)
  const out: RenderElement[] = []
  const open = isOpen(ctx.u.folded, g.key)
  const hasDrawn = g.drawn.length > 0
  // A group with nothing drawn carries its folded agents on its own row; with agents drawn they get a chip row under them.
  const onRow = !hasDrawn && g.folded.length > 0
  const live = g.drawn.filter(a => a.status === 'running').length
  const failed = g.drawn.filter(a => a.status === 'error').length
  const waiting = g.drawn.filter(a => k.states.get(a.id) === 'waiting').length
  const word = g.band === 'next' && g.kind === 'queued' ? 'queued' : onRow ? `+ ${g.folded.length} done` : waiting > 0 ? `${waiting} waiting` : live > 0 ? `${live} working` : failed > 0 ? `${failed} failed` : ''
  const stateStyle: Omit<Run, 'text'> = g.band === 'now' ? (failed > 0 && live === 0 ? { color: CK.fail } : { color: CK.accent, bold: true }) : { dim: true }
  const ink = g.band === 'now'
  const nums = rightSegs(ctx, {
    ...(word !== '' ? { state: { text: word, ...stateStyle } } : {}),
    ...(onRow ? { pips: pipRuns(g.folded, ctx.ground ?? 'night') } : {}),
    tokens: g.agents.length > 0 ? tokensSum(g.agents) : '',
    time: timeOf(ctx, g),
    ink,
  })
  const room = Math.max(1, firstCol(nums, c.right + 2) - 1 - TASK_NAME)
  const mark = onRow && open ? '▾' : g.mark
  const markStyle: Omit<Run, 'text'> = g.band === 'now' ? { color: CK.accent, bold: true } : { dim: true }
  const key = `group-${g.key}`
  const foldable = g.folded.length > 0
  out.push(
    lineOf(ctx, $, {
      key,
      pre: trunk({ [TRUNK]: last ? '╰' : '├', [TRUNK + 1]: '─' }),
      body: [{ col: TASK_MARK, text: mark, ...markStyle }, { col: TASK_NAME, text: clauseFit(g.label, room), ...(g.band === 'now' ? { bold: true } : { dim: true }) }, ...nums],
      ...(foldable ? { onPress: () => updateUi($, cur => toggleOpen(cur, g.key)) } : {}),
    }),
  )
  const inner = !last
  if (onRow && open) {
    const list = [...g.folded].sort((a, b) => a.startedAt - b.startedAt)
    list.forEach((a, i) => out.push(foldedRow(k, $, g, a, i === list.length - 1, inner)))
    return out
  }
  g.drawn.forEach((a, i) => {
    const lastChild = i === g.drawn.length - 1 && g.folded.length === 0
    out.push(agentNode(k, $, a, lastChild, inner))
  })
  if (hasDrawn && g.folded.length > 0) {
    if (open) {
      const list = [...g.folded].sort((a, b) => a.startedAt - b.startedAt)
      list.forEach((a, i) => out.push(foldedRow(k, $, g, a, i === list.length - 1, inner)))
    } else out.push(chipRow(k, $, g, true, inner))
  }
  return out
}

const BAND_WORD: Record<Band, string> = { now: 'Doing now', next: 'Up next', done: 'Done' }

/** The trunk row of a band's head: `│` at 4, the plain word at 7, dim. */
function bandHead(ctx: ViewCtx, $: EngineInterface, band: Band): RenderElement {
  return lineOf(ctx, $, { key: `band-${band}`, pre: trunk({ [TRUNK]: '│' }), body: [{ col: TETHER, text: BAND_WORD[band], dim: true }] })
}

function spacer(ctx: ViewCtx, $: EngineInterface, key: string): RenderElement {
  return lineOf(ctx, $, { key, pre: trunk({ [TRUNK]: '│' }), body: [] })
}

/** What the map says it counts: agents (without the lead), tasks that have agents, finished agents. */
export function mapTotals(t: Timeline, groups: MapGroup[]): { agents: number; tasks: number; done: number } {
  const subs = Object.values(t.agents).filter(a => a.id !== 'main')
  return { agents: subs.length, tasks: groups.filter(g => g.kind === 'task' && g.agents.length > 0).length, done: subs.filter(a => a.status === 'done').length }
}

/**
 * The crew map as the Agents tab's body: the lintel, the column heads, main,
 * the three bands on the trunk, the total. `ids` are the agents with a
 * problem, `states` the waits; `targets` are the rows `n`/`p` visit.
 */
export function treeView(ctx: ViewCtx, $: EngineInterface, ids: Set<string>, states: Map<string, PodState> = new Map()): { el: RenderElement; targets: { key: string; open: string }[]; unfoldable: boolean } {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const { t, u, cols } = ctx
  try {
    const full = agentTree(t)
    const root = u.runningOnly ? runningOnlyTree(full) : full
    const k: Ctx = { ctx, ids, states, targets: [] }
    const all = groupsOf(t, full, ids, states)
    let groups = groupsOf(t, root, ids, states)
    if (u.runningOnly) groups = groups.filter(g => g.drawn.length > 0).map(g => ({ ...g, folded: [] }))
    const c = agentCols(cols)
    const { left } = edges(cols)
    const rows: RenderElement[] = []
    const heads: Seg[] = [{ col: left, text: 'Crew map', dim: true }]
    if (c.state !== undefined) heads.push({ col: c.state, text: 'State', dim: true })
    if (c.tokens !== undefined) heads.push({ col: c.tokens - 5, text: 'Tokens', dim: true })
    heads.push({ col: c.time - 3, text: 'Time', dim: true })
    rows.push(inst(ctx, $, frameTopInst('map-lintel', cols, 'iris', ctx.ground ?? 'night')))
    rows.push(lineOf(ctx, $, { key: 'map-heads', body: heads }))
    const main = root.agent
    if (main !== undefined) {
      const turn = t.turns.filter(x => x.agent === 'main').at(-1)
      const working = t.steps.some(s => s.agent === 'main' && s.status === 'running') || Object.values(t.agents).some(a => a.id !== 'main' && a.status === 'running') || (turn !== undefined && turn.endedAt === undefined)
      rows.push(mainNode(k, $, main, working))
    }
    const bands: Band[] = ['now', 'next', 'done']
    let unfoldable = false
    const present = bands.filter(b => groups.some(g => g.band === b))
    present.forEach((band, bi) => {
      if (bi > 0) rows.push(spacer(ctx, $, `gap-${band}`))
      rows.push(bandHead(ctx, $, band))
      const list = groups.filter(g => g.band === band)
      const cap = band === 'done' ? DONE_ROWS : band === 'next' ? NEXT_ROWS : Infinity
      const more = !isOpen(u.folded, `band-${band}`) && list.length > cap
      const shown = more ? list.slice(0, cap) : list
      shown.forEach((g, gi) => {
        const last = bi === present.length - 1 && gi === shown.length - 1 && !more
        if (g.folded.length > 0) unfoldable = true
        rows.push(...groupRows(k, $, g, last))
      })
      if (more) {
        rows.push(
          lineOf(ctx, $, {
            key: `more-${band}`,
            pre: trunk({ [TRUNK]: bi === present.length - 1 ? '╰' : '├', [TRUNK + 1]: '─' }),
            body: [{ col: TASK_NAME, text: `+ ${list.length - cap} more`, dim: true }],
            onPress: () => updateUi($, cur => toggleOpen(cur, `band-${band}`)),
          }),
        )
      }
    })
    const lonely = full.children.length === 0 && t.tasks.length === 0
    const idle = !lonely && groups.length === 0
    const note = lonely ? EMPTY : idle ? 'Nothing is running.' : ''
    const tot = mapTotals(t, all)
    const everyone = Object.values(t.agents)
    const mainAgent = t.agents.main
    const since = mainAgent !== undefined ? (t.steps.filter(s => s.agent === 'main').reduce((m, s) => Math.min(m, s.startedAt), Infinity)) : Infinity
    const sums = rightSegs(ctx, { state: { text: `${tot.done} done`, dim: true }, tokens: tokensSum(everyone), time: Number.isFinite(since) ? cellTime(ctx.now - since) : '', ink: true })
    const totals: Seg[] = [
      { col: left, text: 'Total', dim: true },
      { col: TASK_NAME, text: wordFit(`${tot.agents} agents · ${tot.tasks} tasks`, Math.max(0, firstCol(sums, c.right + 2) - 2 - TASK_NAME + 1)), dim: true },
      ...sums,
    ]
    const body: RenderElement[] = [...rows]
    if (lonely || idle) {
      body.push(blank(ctx, $, 'gap-note'))
      wrapWords(note, Math.max(1, cols - left), 4).forEach((l, i) => body.push(<Text key={`empty-${i}`} dimColor wrap="truncate-end">{`${' '.repeat(left)}${l}`}</Text>))
    }
    if (everyone.length > 0 && !lonely) {
      body.push(blank(ctx, $, 'gap-total'))
      body.push(lineOf(ctx, $, { key: 'map-total', body: totals }))
    }
    return { el: <Box key="tree" flexDirection="column">{body}</Box>, targets: k.targets, unfoldable }
  } catch (err) {
    debug($, `tree view failed: ${errText(err)}`)
    return { el: <Text dimColor>{wordFit(`Agents map: ${errText(err)}`, cols)}</Text>, targets: [], unfoldable: false }
  }
}
