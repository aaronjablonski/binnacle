import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow } from '../../types'
import { agentTree, treeLines } from '../model/select'
import type { TreeLine } from '../model/select'
import { debug, errText, updateUi } from '../state'
import { AGENT_GLYPH, EMPTY, MAIN_GLYPH, metaOf } from './agentmeta'
import { fit } from './fit'
import type { ViewCtx } from './shell'

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

/** Type and description cut to `room`: the description goes first, then the type. */
function agentName(agent: AgentRow, meta: string, room: number): { name: string; meta: string } {
  const full = `${agent.type} · ${agent.description}`
  if (full.length + 1 + meta.length <= room) return { name: full, meta }
  const descRoom = room - agent.type.length - 3 - meta.length - 1
  if (descRoom >= 1) return { name: `${agent.type} · ${fit(agent.description, descRoom)}`, meta }
  const typeRoom = room - meta.length - 1
  if (typeRoom >= 1) return { name: fit(agent.type, typeRoom), meta }
  return { name: fit(agent.type, room), meta: '' }
}

function runName(line: TreeLine): string {
  const { run, done, children } = line.node
  return `⚙ ${run ? run.name : line.key} · workflow · ${done ?? 0}/${children.length} done`
}

function nodeButton(ctx: ViewCtx, line: TreeLine, room: number, $: EngineInterface): RenderElement {
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
        <Text key="head" bold>
          {fit(runName(line), room)}
        </Text>
      </Button>
    )
  }
  const isMain = agent.id === 'main'
  const glyph = isMain ? MAIN_GLYPH : AGENT_GLYPH[agent.status]
  const inner = room - 2
  const meta = metaOf(ctx, agent, '')
  const parts = isMain ? { name: fit('main', inner), meta: fit(meta, Math.max(0, inner - 5)) } : agentName(agent, meta, inner)
  const lines: RenderElement[] = [
    <Text key="head" bold={isMain}>
      {fit(`${glyph} ${parts.name}`, room)}
    </Text>,
  ]
  if (parts.meta !== '' && parts.name.length + parts.meta.length + 3 <= room) {
    lines.push(
      <Text key="meta" dimColor>
        {` ${parts.meta}`}
      </Text>,
    )
  }
  // The type file has no per-element focus for a render hook, so the dim
  // `doing` line sits under every running subagent instead of the focused one.
  if (!isMain && agent.status === 'running' && agent.doing !== '') {
    lines.push(
      <Text key="doing" dimColor>
        {`\n${fit(`  ${agent.doing}`, room)}`}
      </Text>,
    )
  }
  return (
    <Button
      key={`node-${key}`}
      plain
      onPress={() => updateUi($, u => ({ ...u, tab: 'timeline', filter: { kind: 'agent', id: agent.id } }))}
    >
      {lines}
    </Button>
  )
}

function treeRow(ctx: ViewCtx, line: TreeLine, $: EngineInterface): RenderElement {
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
        <Text key="glyph">{line.folded ? '▸' : '▾'}</Text>
      </Button>,
    )
    items.push(<Text key="gap"> </Text>)
  } else {
    items.push(<Text key="gap">{'  '}</Text>)
  }
  items.push(nodeButton(ctx, line, room, $))
  return (
    <Box key={`row-${key}`} flexDirection="row">
      {items}
    </Box>
  )
}

/** The Agents tab in Tree mode: a count line, then main with every agent and run under it. */
export function treeView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const { t, u, cols } = ctx
  try {
    const root = agentTree(t)
    const lines = treeLines(root, u.folded)
    let count = 0
    let running = 0
    for (const a of Object.values(t.agents)) {
      if (a.id === 'main') continue
      count += 1
      if (a.status === 'running') running += 1
    }
    return (
      <Box flexDirection="column">
        <Text key="count" dimColor>
          {fit(`${count} agents · ${running} running`, cols)}
        </Text>
        {lines.map(l => treeRow(ctx, l, $))}
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
