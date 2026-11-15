import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow, TaskItem } from '../../types'
import { agentTree, hasProblemIn, runningOnlyTree } from '../model/select'
import type { TreeNode } from '../model/select'
import { debug, errText, updateUi } from '../state'
import { EMPTY, RUN_GLYPH, signalFlag, tokensOf, toggleOpen } from './agentmeta'
import type { Jump } from './agentmeta'
import { tokenText } from './budget'
import { crewNode, factsOf, openedAgent } from './crewnode'
import { elapsed, fit, placed, wordFit, wrapWords } from './fit'
import { inst, runText, section } from './parts'
import type { Flag, Run } from './parts'
import type { ViewCtx } from './shell'
import type { PodState } from './style'
import { C, DECK, GRID, podOf, spriteOf, tableCols } from './style'

/** The crew map's columns: the trunk's tether starts at 5, each level 4 further in. */
const TRUNK = 5
const STEP = 4
const tetherCol = (level: number): number => TRUNK + STEP * level
/** The deepest level drawn: a node deeper than this stays at it. */
const MAX_LEVEL = 2

const FLAG_RUN: Record<Flag, Run> = {
  inView: { text: '◂', color: C.live },
  problem: { text: '!', color: C.fail },
  waiting: { text: '?', color: C.wait },
  stalled: { text: 'z', color: C.wait },
}

/** One branch of the trunk: the agents of a task, or a workflow run, or the ones with no task. */
type Branch = {
  key: string
  kind: 'task' | 'run' | 'none'
  label: string
  glyph: string
  glyphColor?: string
  nodes: TreeNode[]
  agents: AgentRow[]
  start: number
}

/** What the map draws, in order: main, a branch's row, a node (two rows), a nested run's row, or the `+ n done` line that stands for finished children. */
type Item =
  | { kind: 'branch'; branch: Branch; last: boolean; folded: boolean; problem: boolean }
  | { kind: 'node'; node: TreeNode; level: number; last: boolean; guides: boolean[]; problem: boolean }
  | { kind: 'run'; node: TreeNode; level: number; last: boolean; guides: boolean[]; folded: boolean; problem: boolean }
  | { kind: 'done'; key: string; n: number; level: number; last: boolean; guides: boolean[] }

/** The agents in a subtree, the node itself included when it is one (main and runs not counted). */
function agentsIn(node: TreeNode): AgentRow[] {
  const out: AgentRow[] = []
  const walk = (n: TreeNode) => {
    if (n.kind === 'agent' && n.agent !== undefined && n.agent.id !== 'main') out.push(n.agent)
    n.children.forEach(walk)
  }
  walk(node)
  return out
}

/**
 * A finished branch that folds into `+ n done`: every agent in it is done, none
 * has a problem, and the opened row is not in it. A run with no agent yet never folds.
 */
function isSettled(node: TreeNode, ids: Set<string>, open: string | undefined): boolean {
  if (node.kind === 'agent' && node.agent?.id === 'main') return false
  const agents = agentsIn(node)
  if (agents.length === 0) return false
  if (agents.some(a => a.status !== 'done' || a.id === open)) return false
  return !hasProblemIn(node, ids) && node.key !== open
}

const startOf = (nodes: TreeNode[]): number =>
  nodes.reduce((m, n) => Math.min(m, n.agent?.startedAt ?? n.run?.startedAt ?? Infinity), Infinity)

/**
 * The trunk's branches: one per task that has agents (an agent's `taskId`),
 * one per workflow run, and one for the agents with no task; by start. A task the timeline no longer holds is named by its id.
 */
export function branchesOf(tasks: TaskItem[], root: TreeNode): Branch[] {
  const byTask = new Map<string, TreeNode[]>()
  const none: TreeNode[] = []
  const out: Branch[] = []
  for (const c of root.children) {
    if (c.kind === 'run') {
      out.push({
        key: c.key,
        kind: 'run',
        label: c.run?.name ?? c.key,
        glyph: RUN_GLYPH,
        nodes: c.children,
        agents: agentsIn(c),
        start: c.run?.startedAt ?? 0,
      })
      continue
    }
    const id = c.agent?.taskId
    if (id === undefined) none.push(c)
    else byTask.set(id, [...(byTask.get(id) ?? []), c])
  }
  for (const [id, nodes] of byTask) {
    const task = tasks.find(x => x.id === id)
    const glyph = task === undefined ? '▫' : task.status === 'completed' ? '▪' : task.status === 'in_progress' ? '▸' : '▫'
    out.push({
      key: `task:${id}`,
      kind: 'task',
      label: task !== undefined ? `${id} ${task.subject}` : `task ${id}`,
      glyph,
      ...(task?.status === 'in_progress' ? { glyphColor: C.live } : {}),
      nodes,
      agents: nodes.flatMap(agentsIn),
      start: startOf(nodes),
    })
  }
  if (none.length > 0) {
    out.push({ key: 'task:none', kind: 'none', label: 'no task', glyph: '◇', nodes: none, agents: none.flatMap(agentsIn), start: startOf(none) })
  }
  return out.sort((a, b) => a.start - b.start)
}

/** The map as items. Only the branch and run keys in `folded` fold; finished children become one `+ n done` line. */
function itemsOf(branches: Branch[], folded: string[], ids: Set<string>, open: string | undefined): Item[] {
  const out: Item[] = []
  const walk = (nodes: TreeNode[], level: number, guides: boolean[]) => {
    const shown = nodes.filter(n => !isSettled(n, ids, open))
    const hidden = nodes.filter(n => isSettled(n, ids, open))
    const hiddenAgents = hidden.reduce((n, c) => n + agentsIn(c).length, 0)
    shown.forEach((node, i) => {
      const last = i === shown.length - 1 && hiddenAgents === 0
      // A node deeper than MAX_LEVEL keeps the guides of the level it shares.
      const next = level < MAX_LEVEL ? [...guides, !last] : guides
      const nextLevel = Math.min(level + 1, MAX_LEVEL)
      if (node.kind === 'run') {
        const isFolded = folded.includes(node.key)
        out.push({ kind: 'run', node, level, last, guides, folded: isFolded, problem: isFolded && hasProblemIn(node, ids) })
        if (!isFolded) walk(node.children, nextLevel, next)
        return
      }
      out.push({ kind: 'node', node, level, last, guides, problem: node.agent !== undefined && ids.has(node.agent.id) })
      walk(node.children, nextLevel, next)
    })
    if (hiddenAgents > 0) out.push({ kind: 'done', key: `${level}:${nodes[0]?.key ?? ''}`, n: hiddenAgents, level, last: true, guides })
  }
  branches.forEach((b, i) => {
    const last = i === branches.length - 1
    const isFolded = folded.includes(b.key)
    out.push({
      kind: 'branch',
      branch: b,
      last,
      folded: isFolded,
      problem: isFolded && b.nodes.some(n => hasProblemIn(n, ids)),
    })
    if (!isFolded) walk(b.nodes, 1, [!last])
  })
  return out
}

/**
 * The tether rows left of a node or a branch: the flag at 0, the trunk's `│`
 * and each ancestor's guide while it has siblings below, then this level's
 * `├╌` or `╰╌` on the first row (a branch's is `├╌╌`) and a `│` under it on
 * the second while siblings follow. `subtle`, as Neo's tethers.
 */
export function prefixOf(level: number, guides: boolean[], last: boolean, flag: Flag | undefined): [Run[], Run[]] {
  const own = tetherCol(level)
  const width = own + (level === 0 ? 3 : 2)
  const make = (row: 0 | 1): Run[] => {
    const cells: string[] = Array.from({ length: width }, () => ' ')
    for (let k = 0; k < level; k++) if (guides[k] === true) cells[tetherCol(k)] = '│'
    if (row === 0) {
      cells[own] = last ? '╰' : '├'
      cells[own + 1] = '╌'
      if (level === 0) cells[own + 2] = '╌'
    } else if (!last) {
      cells[own] = '│'
    }
    const runs: Run[] = []
    const push = (text: string, color?: string) => {
      if (text === '') return
      const prev = runs[runs.length - 1]
      if (prev !== undefined && prev.color === color) runs[runs.length - 1] = { ...prev, text: prev.text + text }
      else runs.push({ text, ...(color !== undefined ? { color } : {}) })
    }
    const f = row === 0 && flag !== undefined ? FLAG_RUN[flag] : undefined
    push(f !== undefined ? f.text : ' ', f?.color)
    push(' ')
    for (const ch of cells.slice(2)) push(ch, ch === ' ' ? undefined : C.subtle)
    return runs
  }
  return [make(0), make(1)]
}

/** A branch's or run's tokens: the sum over its agents, `–` when none reported. */
function tokensIn(agents: AgentRow[]): string {
  let sum: number | undefined
  for (const a of agents) {
    const n = tokensOf(a)
    if (n !== undefined) sum = (sum ?? 0) + n
  }
  return sum === undefined ? '–' : tokenText(sum)
}

/** A branch's time: from its start to now while anything runs, else to the last end. */
function timeIn(ctx: ViewCtx, agents: AgentRow[], start: number): string {
  if (!Number.isFinite(start)) return ''
  if (agents.length === 0 || agents.some(a => a.status === 'running')) return elapsed(start, ctx.now)
  const end = agents.reduce((m, a) => Math.max(m, a.endedAt ?? a.startedAt), start)
  return elapsed(start, end)
}

type LineOpts = {
  key: string
  level: number
  guides: boolean[]
  last: boolean
  flag?: Flag
  glyph: string
  glyphColor?: string
  label: string
  /** Kept whole after the label (`· 4 agents` on a folded branch): the label gives up room for it. */
  suffix?: string
  tokens: string
  time: string
  onPress: () => void | Promise<void>
}

/** A branch's row, or a nested run's: the tether, a glyph, the label as the row's one Button, tokens and time on the table's columns. */
function branchLine(ctx: ViewCtx, $: EngineInterface, o: LineOpts): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const [first] = prefixOf(o.level, o.guides, o.last, o.flag)
  const start = first.reduce((n, r) => n + r.text.length, 0)
  const tc = tableCols(ctx.cols)
  const nameCol = start + 2
  const nameEnd = Math.min(tc.nameEnd, ctx.cols)
  const suffix = o.suffix ?? ''
  const segs: (Run & { col: number })[] = [
    { col: start, text: o.glyph, ...(o.glyphColor !== undefined ? { color: o.glyphColor } : { dim: true }) },
    { col: nameCol, text: wordFit(o.label, Math.max(1, nameEnd - nameCol - suffix.length)), bold: true },
  ]
  if (suffix !== '') segs.push({ col: nameCol + segs[1]!.text.length, text: suffix, dim: true })
  if (tc.metric !== undefined) segs.push({ col: tc.metric, text: fit(o.tokens, Math.min(10, ctx.cols - tc.metric)), dim: true })
  if (tc.time !== undefined && o.time !== '') segs.push({ col: tc.time, text: fit(o.time, Math.min(10, ctx.cols - tc.time)), dim: true })
  const body = placed(segs, start).flatMap((p, i) => [p.gap, runText(p.seg, ctx.e, $, `${o.key}-s${i}`)])
  return (
    <Box key={`row-${o.key}`} flexDirection="row">
      <Text key={`${o.key}-prefix`}>{first.map((r, i) => runText(r, ctx.e, $, `${o.key}-p${i}`))}</Text>
      <Button key={o.key} plain onPress={o.onPress}>
        {body}
      </Button>
    </Box>
  )
}

/** `╰╌+ 3 done` at the child level: the tether in `subtle`, then the count, dim. */
function doneLine(ctx: ViewCtx, $: EngineInterface, it: Extract<Item, { kind: 'done' }>): RenderElement {
  const { Text } = $.ui.resolve(ctx.e)
  const [first] = prefixOf(it.level, it.guides, true, undefined)
  return (
    <Text key={`done-${it.key}`} wrap="truncate-end">
      {first.map((r, i) => runText(r, ctx.e, $, `done-${it.key}-p${i}`))}
      {runText({ text: fit(`+ ${it.n} done`, Math.max(1, ctx.cols - tetherCol(it.level) - 2)), dim: true }, ctx.e, $, `done-${it.key}-t`)}
    </Text>
  )
}

/** Main on top: its large character, its name as a Button, its facts and what it is doing. */
function mainNode(ctx: ViewCtx, $: EngineInterface, agent: AgentRow, state: PodState | undefined, problem: boolean): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const pod = podOf(state !== undefined ? { ...agent, state } : agent, ctx.now)
  const flag: Flag | undefined = signalFlag(pod) ?? (problem ? 'problem' : undefined)
  const f = flag !== undefined ? FLAG_RUN[flag] : undefined
  const room = Math.max(1, ctx.cols - DECK.gauge)
  return (
    <Box key="map-main" flexDirection="row">
      <Box key="map-main-flag" width={GRID.margin} flexShrink={0}>
        <Text color={f?.color} bold={f !== undefined && f.text !== '◂'}>{f !== undefined ? `${f.text} ` : '  '}</Text>
      </Box>
      <Box key="map-main-who" width={DECK.gauge - GRID.margin} flexShrink={0}>
        {inst(ctx, $, { key: 'who-main', ...spriteOf(agent, ctx.now, state) })}
      </Box>
      <Box key="map-main-text" flexDirection="column">
        <Button key="node-main" plain onPress={() => toggleOpen($, 'main')}>
          <Text bold>main</Text>
        </Button>
        <Text key="map-main-facts" dimColor wrap="truncate-end">{wordFit(factsOf(ctx, agent, state, true), room)}</Text>
        {agent.doing !== '' ? (
          <Text key="map-main-doing" dimColor wrap="truncate-end">{wordFit(agent.doing, room)}</Text>
        ) : null}
      </Box>
    </Box>
  )
}

/**
 * The crew map (spec "Agents, map"; the Tree grown up): main large at the
 * top; a trunk down from it with one branch per task (the agents it spawned
 * under that task), per workflow run, and one for agents with no task; the
 * agents hang under their branch as small characters on tethers, a nested
 * agent under its parent. A node is two rows (the character and the name,
 * its one Button, then its facts); a press on it opens it in place, on a
 * branch folds it. Finished children fold to `+ n done`. `!` `?` `z` climb to
 * the gutter. The text look draws the same map with hull glyphs in the
 * characters' place. `ids` are the agents with a problem; `targets` are the
 * rows `n`/`p` visit.
 */
export function treeView(ctx: ViewCtx, $: EngineInterface, ids: Set<string>, states: Map<string, PodState> = new Map()): { el: RenderElement; targets: Jump[] } {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const { t, u, cols } = ctx
  try {
    const full = agentTree(t)
    const root = u.runningOnly ? runningOnlyTree(full) : full
    const branches = branchesOf(t.tasks, root)
    const items = itemsOf(branches, u.folded, ids, u.agentOpen)
    const targets: Jump[] = []
    const rows: RenderElement[] = []
    const main = root.agent
    if (main !== undefined) {
      const problem = ids.has('main')
      if (problem) targets.push({ key: 'node-main', open: 'main' })
      rows.push(mainNode(ctx, $, main, states.get('main'), problem))
      const detail = openedAgent(ctx, $, main)
      if (detail !== null) rows.push(<Box key="blk-main" flexDirection="column">{detail}</Box>)
    }
    for (const it of items) {
      if (it.kind === 'done') {
        rows.push(doneLine(ctx, $, it))
        continue
      }
      if (it.kind === 'branch') {
        const b = it.branch
        if (it.problem) targets.push({ key: `node-${b.key}`, open: b.key })
        rows.push(
          branchLine(ctx, $, {
            key: `node-${b.key}`,
            level: 0,
            guides: [],
            last: it.last,
            ...(it.problem ? { flag: 'problem' as const } : {}),
            glyph: b.glyph,
            ...(b.glyphColor !== undefined ? { glyphColor: b.glyphColor } : {}),
            label: b.label,
            ...(it.folded ? { suffix: ` · ${b.agents.length} agents` } : {}),
            tokens: tokensIn(b.agents),
            time: timeIn(ctx, b.agents, b.start),
            onPress: () => updateUi($, cur => toggleFold(cur, b.key)),
          }),
        )
        continue
      }
      if (it.kind === 'run') {
        const { node } = it
        if (it.problem) targets.push({ key: `node-${node.key}`, open: node.key })
        const agents = agentsIn(node)
        rows.push(
          branchLine(ctx, $, {
            key: `node-${node.key}`,
            level: it.level,
            guides: it.guides,
            last: it.last,
            ...(it.problem ? { flag: 'problem' as const } : {}),
            glyph: RUN_GLYPH,
            label: node.run?.name ?? node.key,
            ...(it.folded ? { suffix: ` · ${agents.length} agents` } : {}),
            tokens: tokensIn(agents),
            time: timeIn(ctx, agents, node.run?.startedAt ?? Infinity),
            onPress: () => updateUi($, cur => toggleFold(cur, node.key)),
          }),
        )
        continue
      }
      const agent = it.node.agent
      if (agent === undefined) continue
      if (it.problem) targets.push({ key: `node-${it.node.key}`, open: it.node.key })
      const state = states.get(agent.id)
      const flag: Flag | undefined = it.problem ? 'problem' : undefined
      const [p0, p1] = prefixOf(it.level, it.guides, it.last, signalFlag(podOf(state !== undefined ? { ...agent, state } : agent, ctx.now)) ?? flag)
      const line = crewNode(ctx, $, agent, {
        key: `node-${it.node.key}`,
        ...(state !== undefined ? { state } : {}),
        ...(flag !== undefined ? { flag } : {}),
        prefix: [p0, p1],
        facts: factsOf(ctx, agent, state, true),
      })
      const detail = openedAgent(ctx, $, agent)
      rows.push(detail === null ? line : <Box key={`blk-${it.node.key}`} flexDirection="column">{line}{detail}</Box>)
    }
    const lonely = full.children.length === 0
    const idle = !lonely && root.children.length === 0
    const note = lonely ? EMPTY : idle ? 'Nothing is running.' : ''
    return {
      el: (
        <Box key="tree" flexDirection="column">
          {section(ctx, $, 'MAP', 'tokens', 'time')}
          {rows}
          {note !== ''
            ? wrapWords(note, Math.max(1, cols - GRID.margin), 4).map((l, i) => (
                <Text key={`empty-${i}`} dimColor wrap="truncate-end">{`${' '.repeat(GRID.margin)}${l}`}</Text>
              ))
            : null}
        </Box>
      ),
      targets,
    }
  } catch (err) {
    debug($, `tree view failed: ${errText(err)}`)
    return { el: <Text dimColor>{fit(`Agents map: ${errText(err)}`, cols)}</Text>, targets: [] }
  }
}

/** The fold toggle of a branch or run key. */
function toggleFold<U extends { folded: string[] }>(u: U, key: string): U {
  return { ...u, folded: u.folded.includes(key) ? u.folded.filter(k => k !== key) : [...u.folded, key] }
}
