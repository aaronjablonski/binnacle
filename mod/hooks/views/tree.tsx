import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow } from '../../types'
import { agentTree, branchCounts, hasProblemIn, problems, runningOnlyTree, treeLines } from '../model/select'
import type { TreeLine, TreeNode } from '../model/select'
import { debug, errText, leaveDetail, updateUi } from '../state'
import { AGENT_GLYPH, EMPTY, MAIN_GLYPH, metaOf } from './agentmeta'
import { fit } from './fit'
import { flushRight, glyphText, sectionHeader, viewAgent } from './parts'
import type { ViewCtx } from './shell'
import { C, glyphColor } from './style'

const MAX_DEPTH = 6
const BRANCH = 3
// Under a fold glyph or its blank: the glyph and one space.
const FOLD_COLUMNS = 2

/** The prefix as drawn: past 6 levels it becomes `<depth>› ` so it cannot eat the row. */
function prefixOf(line: TreeLine): string {
  const depth = line.prefix.length / BRANCH
  if (depth > MAX_DEPTH) return `${depth}› `
  return line.prefix
}

/**
 * Type and description cut to `room`. The meta is the first thing to go: it is
 * drawn only when the whole name fits beside it. Then the description is cut,
 * then the type.
 */
function agentName(agent: AgentRow, meta: string, room: number): { name: string; meta: string } {
  const full = `${agent.type} · ${agent.description}`
  if (full.length + 1 + meta.length <= room) return { name: full, meta }
  if (full.length <= room) return { name: full, meta: '' }
  const descRoom = room - agent.type.length - 3
  if (descRoom >= 1) return { name: `${agent.type} · ${fit(agent.description, descRoom)}`, meta: '' }
  return { name: fit(agent.type, room), meta: '' }
}

// The `!` mark and the space before the name.
const BANG = 2
const branchText = (node: TreeNode): string => {
  const { agents, running } = branchCounts(node)
  return `${agents} agents · ${running} running`
}

function runLabel(line: TreeLine): string {
  const { run } = line.node
  return `⚙ ${run ? run.name : line.key}`
}

function runMeta(line: TreeLine): string {
  const { done, children } = line.node
  return `workflow · ${done ?? 0}/${children.length} done`
}

function nodeButton(ctx: ViewCtx, line: TreeLine, room: number, bang: boolean, $: EngineInterface): RenderElement {
  const { Text, Button } = $.ui.resolve(ctx.e)
  const { node, key } = line
  const agent = node.agent
  if (node.kind === 'run' || !agent) {
    return (
      <Button
        key={`node-${key}`}
        plain
        onPress={() =>
          updateUi($, u => ({
            ...u,
            folded: u.folded.includes(key) ? u.folded.filter(k => k !== key) : [...u.folded, key],
          }))
        }
      >
        {bang ? (
          <Text key="bang" color={C.error}>
            !
          </Text>
        ) : null}
        {bang ? <Text key="bang-gap"> </Text> : null}
        {sectionHeader(runLabel(line), line.folded ? branchText(node) : runMeta(line), bang ? Math.max(0, room - BANG) : room, ctx.e, $)}
      </Button>
    )
  }
  const isMain = agent.id === 'main'
  const glyph = isMain ? MAIN_GLYPH : AGENT_GLYPH[agent.status]
  const bangW = bang ? BANG : 0
  const inner = room - 2 - bangW
  const folded = line.folded && node.children.length > 0
  const meta = folded ? branchText(node) : metaOf(ctx, agent, '', agent.tokensIn !== undefined || agent.tokensOut !== undefined)
  const parts = isMain ? { name: fit('main', inner), meta: fit(meta, Math.max(0, inner - 5)) } : agentName(agent, meta, inner)
  const lines: RenderElement[] = [
    glyphText(glyph, isMain ? undefined : glyphColor(agent.status), ctx.e, $, 'glyph'),
  ]
  if (bang) {
    lines.push(<Text key="bang-gap"> </Text>)
    lines.push(
      <Text key="bang" color={C.error}>
        !
      </Text>,
    )
  }
  lines.push(
    <Text key="head" bold={isMain}>
      {` ${fit(parts.name, Math.max(0, room - glyph.length - 1 - bangW))}`}
    </Text>,
  )
  const used = glyph.length + bangW + 1 + parts.name.length
  if (parts.meta !== '' && used + parts.meta.length + 1 <= room) {
    lines.push(
      <Text key="meta" dimColor>
        {flushRight(used, parts.meta, room)}
      </Text>,
    )
  }
  // The type file has no per-element focus for a render hook, so the dim
  // `doing` line sits under every running subagent instead of the focused one.
  if (!isMain && agent.status === 'running' && agent.doing !== '') {
    lines.push(
      <Text key="doing" dimColor>
        {`\n${fit(`└ ${agent.doing}`, room)}`}
      </Text>,
    )
  }
  return (
    <Button
      key={`node-${key}`}
      plain
      onPress={() => updateUi($, u => ({ ...leaveDetail(u), tab: 'timeline', filter: { kind: 'agent', id: agent.id } }))}
    >
      {lines}
    </Button>
  )
}

function treeRow(ctx: ViewCtx, line: TreeLine, ids: Set<string>, $: EngineInterface): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const prefix = prefixOf(line)
  const room = Math.max(0, ctx.cols - prefix.length - FOLD_COLUMNS)
  const hasKids = line.node.children.length > 0
  const key = line.key
  const items: RenderElement[] = []
  if (prefix !== '') {
    items.push(
      <Text key="prefix" dimColor>
        {prefix}
      </Text>,
    )
  }
  if (hasKids) {
    items.push(
      <Button
        key={`fold-${key}`}
        plain
        onPress={() =>
          updateUi($, u => ({
            ...u,
            folded: u.folded.includes(key) ? u.folded.filter(k => k !== key) : [...u.folded, key],
          }))
        }
      >
        <Text key="glyph" color={C.accent}>
          {line.folded ? '▸' : '▾'}
        </Text>
      </Button>,
    )
    items.push(<Text key="gap"> </Text>)
  } else {
    items.push(<Text key="gap">{'  '}</Text>)
  }
  // A node shows the mark for itself, and for anything under it that a fold hides.
  const { node } = line
  const ownProblem = node.kind === 'agent' && node.agent !== undefined && ids.has(node.agent.id)
  const bang = ownProblem || (line.folded && hasProblemIn(node, ids))
  items.push(nodeButton(ctx, line, room, bang, $))
  const agent = node.agent
  const row = (
    <Box key={`row-${key}`} flexDirection="row">
      {items}
    </Box>
  )
  if (node.kind !== 'agent' || !agent || agent.id === 'main') return row
  return (
    <Box key={`tree-${key}`} flexDirection="column">
      {row}
      <Box flexDirection="row">
        <Text>{' '.repeat(Math.min(prefix.length + FOLD_COLUMNS, Math.max(0, ctx.cols - 4)))}</Text>
        <Button key={`view-${agent.id}`} label="View" plain dimColor onPress={() => viewAgent($, agent.id)} />
      </Box>
    </Box>
  )
}

/** The Agents tab in Tree mode: a count line, then main with every agent and run under it. */
export function treeView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { t, u, cols } = ctx
  try {
    const full = agentTree(t)
    const root = u.runningOnly ? runningOnlyTree(full) : full
    const lines = treeLines(root, u.folded)
    const ids = new Set(problems(t, ctx.now, u.dismissed).map(p => p.agent))
    let count = 0
    let running = 0
    for (const a of Object.values(t.agents)) {
      if (a.id === 'main') continue
      count += 1
      if (a.status === 'running') running += 1
    }
    return (
      <Box flexDirection="column">
        {sectionHeader('AGENTS', `${count} agents · ${running} running`, cols, ctx.e, $)}
        <Button
          key="running-only"
          label={`${u.runningOnly ? '✔ ' : ''}running only`}
          plain
          dimColor={!u.runningOnly}
          onPress={() => updateUi($, cur => ({ ...cur, runningOnly: !cur.runningOnly }))}
        />
        {lines.map(l => treeRow(ctx, l, ids, $))}
        {lines.length <= 1 ? (
          <Text key="empty" dimColor>
            {EMPTY}
          </Text>
        ) : null}
      </Box>
    )
  } catch (err) {
    debug($, `tree view failed: ${errText(err)}`)
    return <Text dimColor>{fit(`Agents tree: ${errText(err)}`, cols)}</Text>
  }
}
