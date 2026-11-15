import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow } from '../../types'
import { agentGroups } from '../model/select'
import { debug, errText, leaveDetail, updateUi } from '../state'
import { AGENT_GLYPH, EMPTY, MAIN_GLYPH, WORKFLOW_TYPE, metaOf } from './agentmeta'
import { modelsSection } from './budget'
import { fit, splitRow } from './fit'
import { flushRight, glyphText, sectionHeader } from './parts'
import { glyphColor } from './style'
import { runBoardView } from './runboard'
import { treeView } from './tree'
import type { ViewCtx } from './shell'

/**
 * One agent as one Button: a main line, then the dim `doing` line. The second
 * line is a `Text` child that begins with a newline (C7), so one press anywhere
 * on the row opens it. `prefix` is the indent or tree branch before the glyph.
 * `$` is a separate argument because the scan refuses it inside an object.
 */
export function agentRow(ctx: ViewCtx, agent: AgentRow, prefix: string, selected: boolean, $: EngineInterface): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { cols } = ctx
  const isMain = agent.id === 'main'
  const glyph = isMain ? MAIN_GLYPH : AGENT_GLYPH[agent.status]
  let name = `${agent.type} · ${agent.description}`
  if (isMain) name = 'main · this conversation'
  else if (agent.type === WORKFLOW_TYPE) name = agent.description
  const meta = metaOf(ctx, agent, ' steps', true)
  const head = splitRow(`${prefix}${glyph} ${name}`, meta, cols)
  const room = Math.max(0, head.left.length - prefix.length - glyph.length - 1)
  const lines: RenderElement[] = []
  if (prefix !== '') lines.push(<Text key="prefix">{prefix}</Text>)
  lines.push(glyphText(glyph, isMain ? undefined : glyphColor(agent.status), ctx.e, $, 'glyph'))
  lines.push(
    <Text key="head" bold={selected}>
      {` ${fit(name, room)}`}
    </Text>,
  )
  if (head.right !== '' && !head.stacked) {
    lines.push(
      <Text key="meta" dimColor>
        {flushRight(head.left.length, head.right, cols)}
      </Text>,
    )
  }
  if (head.stacked) {
    lines.push(<Text key="meta" dimColor>{`
${fit(`${' '.repeat(prefix.length)}└ ${head.right}`, cols)}`}</Text>)
  }
  if (agent.doing !== '') {
    lines.push(<Text key="doing" dimColor>{`
${fit(`${' '.repeat(prefix.length)}└ ${agent.doing}`, cols)}`}</Text>)
  }
  const row = (
    <Button
      key={`agent-${agent.id}`}
      plain
      onPress={() => updateUi($, u => ({ ...leaveDetail(u), tab: 'timeline', filter: { kind: 'agent', id: agent.id } }))}
    >
      {lines}
    </Button>
  )
  if (isMain) return row
  return (
    <Box key={`row-${agent.id}`} flexDirection="column">
      {row}
      <Box flexDirection="row">
        <Text>{' '.repeat(prefix.length + 2)}</Text>
        <Button key={`view-${agent.id}`} label="View" plain dimColor onPress={() => viewAgent($, agent.id)} />
      </Box>
    </Box>
  )
}

// A press only: the engine refuses `$.ui.view` outside one. A refusal is toasted.
async function viewAgent($: EngineInterface, agentId: string): Promise<void> {
  try {
    const shown = await $.ui.view({ agentId })
    if (shown.deny !== undefined && shown.deny !== '') $.ui.toast(shown.deny)
  } catch (err) {
    debug($, `view failed: ${errText(err)}`)
    $.ui.toast(errText(err))
  }
}

/** A run's section header as one Button that opens its board. */
function runHeader(ctx: ViewCtx, runId: string, label: string, meta: string, $: EngineInterface): RenderElement {
  const { Button } = $.ui.resolve(ctx.e)
  return (
    <Button key={`run-open-${runId}`} plain onPress={() => updateUi($, u => ({ ...u, run: runId }))}>
      {sectionHeader(label, meta, ctx.cols, ctx.e, $)}
    </Button>
  )
}

/** The Agents tab: a List or Tree mode row, then main and each group of agents. */
export function agentsView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { t, u, cols } = ctx
  try {
    if (u.run !== undefined) return runBoardView(ctx, u.run, $)
    const running = Object.values(t.agents).filter(a => a.id !== 'main' && a.status === 'running').length
    const finished = Object.values(t.agents).filter(a => a.id !== 'main' && a.status !== 'running').length
    const mode = (
      <Box key="mode" flexDirection="row" columnGap={1}>
        <Button
          key="mode-list"
          label="List"
          hotkey="l"
          plain
          dimColor={u.agentsMode !== 'list'}
          onPress={() => updateUi($, cur => ({ ...cur, agentsMode: 'list' }))}
        />
        <Button
          key="mode-tree"
          label="Tree"
          hotkey="t"
          plain
          dimColor={u.agentsMode !== 'tree'}
          onPress={() => updateUi($, cur => ({ ...cur, agentsMode: 'tree' }))}
        />
      </Box>
    )
    if (u.agentsMode === 'tree') {
      return (
        <Box flexDirection="column" rowGap={1}>
          {mode}
          {treeView(ctx, $)}
        </Box>
      )
    }
    const groups = agentGroups(t)
    if (groups.length === 0 && t.steps.length === 0) {
      return (
        <Box flexDirection="column" rowGap={1}>
          {mode}
          <Text dimColor>{EMPTY}</Text>
        </Box>
      )
    }
    const main = t.agents.main
    return (
      <Box flexDirection="column" rowGap={1}>
        {mode}
        <Box key="top" flexDirection="column">
          {sectionHeader('AGENTS', `${running} running · ${finished} done`, cols, ctx.e, $)}
          {main ? agentRow(ctx, main, '', false, $) : null}
        </Box>
        {groups.map(g => {
          const key = g.run ? `run-${g.run.runId}` : 'runless'
          const prefix = g.run ? '  ' : ''
          return (
            <Box key={key} flexDirection="column">
              {g.run ? runHeader(ctx, g.run.runId, `⚙ ${g.run.name}`, `workflow · ${g.done}/${g.agents.length} done`, $) : null}
              {g.agents.map(a => agentRow(ctx, a, prefix, false, $))}
            </Box>
          )
        })}
        {modelsSection(ctx, $)}
      </Box>
    )
  } catch (err) {
    debug($, `agents view failed: ${errText(err)}`)
    return <Text dimColor>{fit(`Agents: ${errText(err)}`, cols)}</Text>
  }
}
