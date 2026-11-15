import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow } from '../../types'
import { agentTree, hasProblemIn, runningOnlyTree } from '../model/select'
import type { TreeNode } from '../model/select'
import { debug, errText, updateUi } from '../state'
import { EMPTY, RUN_GLYPH, agentOpened, agentRow, tokensOf } from './agentmeta'
import type { Jump } from './agentmeta'
import { at, elapsed, fit, placed, tether, wrapWords } from './fit'
import type { Seg } from './fit'
import { blank, row, runText, section } from './parts'
import type { Run } from './parts'
import type { ViewCtx } from './shell'
import type { PodState } from './style'
import { C, COL, GRID } from './style'
import { tokenText } from './budget'

/** What the tree draws, in order: a node's row, or the `+ n done` line that stands for its finished children. */
type Tether = { last: boolean; outer: boolean }
type Item =
  | { kind: 'node'; node: TreeNode; depth: 0 | 1 | 2; tether?: Tether; folded: boolean; problem: boolean }
  | { kind: 'done'; key: string; n: number; depth: 0 | 1 | 2; tether: Tether }

const clampDepth = (d: number): 0 | 1 | 2 => (d <= 0 ? 0 : d === 1 ? 1 : 2)

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

/** The tree as items. Only the `run:` keys in `folded` fold a node; a branch of finished agents becomes one `+ n done` line. */
function itemsOf(root: TreeNode, folded: string[], ids: Set<string>, open: string | undefined): Item[] {
  const out: Item[] = []
  // `outer`: the parent has siblings below, so a `┆` runs down beside this level.
  const walk = (node: TreeNode, actual: number, tether: Tether | undefined, outer: boolean) => {
    const depth = clampDepth(actual)
    const isFolded = node.kind === 'run' && folded.includes(node.key)
    const own = node.kind === 'agent' && node.agent !== undefined && ids.has(node.agent.id)
    out.push({
      kind: 'node', node, depth, ...(tether !== undefined ? { tether } : {}), folded: isFolded,
      problem: own || (isFolded && hasProblemIn(node, ids)),
    })
    if (isFolded) return
    const shown = node.children.filter(c => !isSettled(c, ids, open))
    const hidden = node.children.filter(c => isSettled(c, ids, open))
    const hiddenAgents = hidden.reduce((n, c) => n + agentsIn(c).length, 0)
    // `outer` for the children: this node has siblings below it (a depth-0 node has none).
    const below = tether !== undefined && !tether.last
    shown.forEach((c, i) => {
      const last = i === shown.length - 1 && hiddenAgents === 0
      walk(c, actual + 1, { last, outer: below }, below)
    })
    if (hiddenAgents > 0) {
      out.push({ kind: 'done', key: node.key, n: hiddenAgents, depth: clampDepth(actual + 1), tether: { last: true, outer: below } })
    }
  }
  walk(root, 0, undefined, false)
  return out
}

/** `╰╌+ 3 done` at the child depth: the tether (and the `┆` outer guide) in `subtle`, `+` where a hull would be. */
function doneLine(ctx: ViewCtx, $: EngineInterface, it: Extract<Item, { kind: 'done' }>): RenderElement {
  const { Text } = $.ui.resolve(ctx.e)
  const indent = 2 * it.depth
  const guide = tether(it.depth, it.tether.last, it.tether.outer)
  const lead = guide.length - guide.trimStart().length
  const segs: (Run & Seg)[] = [
    { ...at(COL.glyph + lead, guide.trimStart()), color: C.subtle },
    { ...at(COL.glyph + indent, '+'), dim: true },
    { ...at(COL.name + indent, fit(`${it.n} done`, Math.max(0, ctx.cols - COL.name - indent))), dim: true },
  ].filter(s => s.text !== '')
  return (
    <Text key={`done-${it.key}`} wrap="truncate-end">
      {placed(segs, 0).flatMap((p, i) => [p.gap, runText(p.seg, ctx.e, $, `done-${it.key}-${i}`)])}
    </Text>
  )
}

/** A run's tokens: the sum over its agents, `–` when none reported. */
function runTokens(node: TreeNode): string {
  let sum: number | undefined
  for (const a of agentsIn(node)) {
    const n = tokensOf(a)
    if (n !== undefined) sum = (sum ?? 0) + n
  }
  return sum === undefined ? '–' : tokenText(sum)
}

function runTime(ctx: ViewCtx, node: TreeNode): string {
  const run = node.run
  if (run === undefined) return ''
  const agents = agentsIn(node)
  if (agents.some(a => a.status === 'running')) return elapsed(run.startedAt, ctx.now)
  const end = agents.reduce((m, a) => Math.max(m, a.endedAt ?? a.startedAt), run.startedAt)
  return elapsed(run.startedAt, end)
}

function runRow(ctx: ViewCtx, $: EngineInterface, it: Extract<Item, { kind: 'node' }>): RenderElement {
  const { node } = it
  const key = node.key
  const label = node.run?.name ?? key
  const name: Run[] = [{ text: label }]
  if (it.folded) name.push({ text: ` · ${agentsIn(node).length} agents`, dim: true })
  return row(ctx, $, {
    key: `node-${key}`,
    glyph: RUN_GLYPH,
    name,
    metric: runTokens(node),
    time: runTime(ctx, node),
    depth: it.depth,
    ...(it.tether !== undefined ? { tether: it.tether } : {}),
    ...(it.problem ? { flag: 'problem' as const } : {}),
    onPress: () =>
      updateUi($, u => ({
        ...u,
        folded: u.folded.includes(key) ? u.folded.filter(k => k !== key) : [...u.folded, key],
      })),
  })
}

/**
 * The tree under the shared head: `┌ AGENTS` and main with every agent and run
 * under it. Tethers (`├╌ ╰╌`, and `┆` as the outer guide two deep) are `subtle`
 * at columns 2 and 4, hulls sit at 4 and 6, names at 6 and 8,
 * tokens and time on the same two columns as the list. A node with a problem,
 * and a folded run that holds one, carry `!`. Finished branches fold to
 * `+ n done`; a press on a run folds it, a press on an agent opens it.
 * `ids` are the agents with a problem; `targets` are the rows `n`/`p` visit.
 */
export function treeView(ctx: ViewCtx, $: EngineInterface, ids: Set<string>, states: Map<string, PodState> = new Map()): { el: RenderElement; targets: Jump[] } {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const { t, u, cols } = ctx
  try {
    const full = agentTree(t)
    const root = u.runningOnly ? runningOnlyTree(full) : full
    const items = itemsOf(root, u.folded, ids, u.agentOpen)
    const targets: Jump[] = []
    const rows: RenderElement[] = []
    items.forEach((it, i) => {
      if (it.kind === 'done') {
        rows.push(doneLine(ctx, $, it))
        return
      }
      const { node } = it
      if (it.problem) targets.push({ key: `node-${node.key}`, open: node.key })
      const agent = node.agent
      if (node.kind === 'run' || agent === undefined) {
        rows.push(runRow(ctx, $, it))
        return
      }
      const line = agentRow(ctx, $, agent, {
        key: `node-${node.key}`,
        depth: it.depth,
        ...(it.tether !== undefined ? { tether: it.tether } : {}),
        ...(states.has(agent.id) ? { state: states.get(agent.id)! } : {}),
        ...(it.problem ? { flag: 'problem' as const } : {}),
      })
      const detail = agentOpened(ctx, $, agent)
      if (detail === null) {
        rows.push(line)
        return
      }
      rows.push(
        <Box key={`blk-${node.key}`} flexDirection="column">
          {i === 0 ? null : blank(ctx, $, `pre-${node.key}`)}
          {line}
          {detail}
          {i === items.length - 1 ? null : blank(ctx, $, `post-${node.key}`)}
        </Box>,
      )
    })
    const lonely = full.children.length === 0
    const idle = !lonely && root.children.length === 0
    const note = lonely ? EMPTY : idle ? 'Nothing is running.' : ''
    return {
      el: (
        <Box key="tree" flexDirection="column">
          {section(ctx, $, 'AGENTS', 'tokens', 'time')}
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
    return { el: <Text dimColor>{fit(`Agents tree: ${errText(err)}`, cols)}</Text>, targets: [] }
  }
}
