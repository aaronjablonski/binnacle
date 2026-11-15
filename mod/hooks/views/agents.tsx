import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow } from '../../types'
import { agentGroups } from '../model/select'
import { debug, errText, leaveDetail, updateUi } from '../state'
import { AGENT_GLYPH, EMPTY, MAIN_GLYPH, WORKFLOW_TYPE, metaOf } from './agentmeta'
import { fit, splitRow } from './fit'
import { treeView } from './tree'
import type { ViewCtx } from './shell'

/**
 * One agent as one Button: a main line, then the dim `doing` line. The second
 * line is a `Text` child that begins with a newline (C7), so one press anywhere
 * on the row opens it. `prefix` is the indent or tree branch before the glyph.
 * `$` is a separate argument because the scan refuses it inside an object.
 */
export function agentRow(ctx: ViewCtx, agent: AgentRow, prefix: string, selected: boolean, $: EngineInterface): RenderElement {
  const { Text, Button } = $.ui.resolve(ctx.e)
  const { cols } = ctx
  const isMain = agent.id === 'main'
  const glyph = isMain ? MAIN_GLYPH : AGENT_GLYPH[agent.status]
  let name = `${agent.type} · ${agent.description}`
  if (isMain) name = 'main · this conversation'
  else if (agent.type === WORKFLOW_TYPE) name = agent.description
  const indent = ' '.repeat(prefix.length + 2)
  const head = splitRow(`${prefix}${glyph} ${name}`, metaOf(ctx, agent), cols)
  const lines: RenderElement[] = [<Text key="head" bold={selected}>{head.left}</Text>]
  if (head.right !== '' && !head.stacked) {
    lines.push(<Text key="meta" dimColor>{` ${head.right}`}</Text>)
  }
  if (head.stacked) {
    lines.push(<Text key="meta" dimColor>{`\n${fit(`${indent}${head.right}`, cols)}`}</Text>)
  }
  if (agent.doing !== '') {
    lines.push(<Text key="doing" dimColor>{`\n${fit(`${indent}${agent.doing}`, cols)}`}</Text>)
  }
  return (
    <Button
      key={`agent-${agent.id}`}
      plain
      onPress={() => updateUi($, u => ({ ...leaveDetail(u), tab: 'timeline', filter: { kind: 'agent', id: agent.id } }))}
    >
      {lines}
    </Button>
  )
}

/** The Agents tab: a List or Tree mode row, then main and each group of agents. */
export function agentsView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { t, u, cols } = ctx
  try {
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
        {main ? agentRow(ctx, main, '', false, $) : null}
        {groups.map(g => {
          const key = g.run ? `run-${g.run.runId}` : 'runless'
          const prefix = g.run ? '  ' : ''
          return (
            <Box key={key} flexDirection="column">
              {g.run ? (
                <Text bold>{fit(`⚙ ${g.run.name} · workflow · ${g.done}/${g.agents.length} done`, cols)}</Text>
              ) : null}
              {g.agents.map(a => agentRow(ctx, a, prefix, false, $))}
            </Box>
          )
        })}
      </Box>
    )
  } catch (err) {
    debug($, `agents view failed: ${errText(err)}`)
    return <Text dimColor>{fit(`Agents: ${errText(err)}`, cols)}</Text>
  }
}
