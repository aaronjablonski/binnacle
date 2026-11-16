import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow, Step } from '../../types'
import { runBoard } from '../model/select'
import { updateUi } from '../state'
import { cellTime, openAgentPage } from './agentmeta'
import { agentLine, stateOf } from './crewnode'
import { wordFit } from './fit'
import { openStepInline } from './openstep'
import { blank, section } from './parts'
import { waitStates } from './needs'
import { GRID, edges, statusColor } from './style'
import type { ViewCtx } from './shell'
import type { PodState } from './style'

/** Blocks shown per agent. */
export const STRIP_MAX = 20
/**
 * Above this many blocks on the board the strips stop being one Button per
 * block (the Timeline keeps its own list under 200 Buttons) and become one
 * Button per agent that opens its newest step.
 */
export const BLOCK_BUDGET = 150
// Under an agent's row, from its name column.
const indentOf = (cols: number): string => ' '.repeat(edges(cols).left + 2)

/** The steps a strip shows (the newest) and how many are hidden before them. */
export function stripOf(steps: Step[], room: number): { shown: Step[]; hidden: number } {
  const take = Math.max(0, Math.min(STRIP_MAX, room))
  const shown = take === 0 ? [] : steps.slice(-take)
  return { shown, hidden: steps.length - shown.length }
}

/** The room a strip has beside its `+n ` marker, within `cols`. */
function roomFor(cols: number, count: number): number {
  const marker = count > STRIP_MAX ? `+${count - STRIP_MAX} `.length : 0
  return Math.max(0, Math.min(STRIP_MAX, cols - indentOf(cols).length - marker))
}

function blockText(s: Step, $: EngineInterface, ctx: ViewCtx, key?: string): RenderElement {
  const { Text } = $.ui.resolve(ctx.e)
  const color = statusColor(s.status)
  return color !== undefined ? (
    <Text key={key} color={color}>
      ■
    </Text>
  ) : (
    <Text key={key} dimColor>
      ■
    </Text>
  )
}

/** The newest steps of one agent as blocks under its row: one Button each, or one Button for the strip. */
function strip(ctx: ViewCtx, agent: AgentRow, steps: Step[], perBlock: boolean, $: EngineInterface): RenderElement | null {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  if (steps.length === 0) return null
  const { shown, hidden } = stripOf(steps, roomFor(ctx.cols, steps.length))
  const marker = hidden > 0 ? <Text key="more" dimColor>{`+${hidden} `}</Text> : null
  if (perBlock) {
    return (
      <Box key={`strip-row-${agent.id}`} flexDirection="row">
        <Text key="indent">{indentOf(ctx.cols)}</Text>
        {marker}
        {shown.map(s => (
          <Button key={`block-${s.id}`} plain onPress={() => void openStepInline($, s.id)}>
            {blockText(s, $, ctx)}
          </Button>
        ))}
      </Box>
    )
  }
  const newest = steps[steps.length - 1]!
  return (
    <Button key={`strip-${agent.id}`} plain onPress={() => void openStepInline($, newest.id)}>
      <Text>{indentOf(ctx.cols)}</Text>
      {marker}
      {shown.map(s => blockText(s, $, ctx))}
    </Button>
  )
}

/** One agent of the run: its row (a press opens its page) and its strip of step blocks. */
function agentBlock(ctx: ViewCtx, agent: AgentRow, steps: Step[], perBlock: boolean, $: EngineInterface, states: Map<string, PodState>): RenderElement {
  const { Box } = $.ui.resolve(ctx.e)
  const key = `run-agent-${agent.id}`
  const line = agentLine(ctx, $, agent, { key, state: stateOf(agent, states), onPress: () => openAgentPage($, agent.id, key) })
  return (
    <Box key={`run-block-${agent.id}`} flexDirection="column">
      {line}
      {strip(ctx, agent, steps, perBlock, $)}
    </Box>
  )
}

/**
 * One workflow run: `b: Back`, its head (the run's name, its counts), and a row
 * per agent in spawn order (tokens ending at 49, time at 59) with the newest
 * steps as blocks under it. A press on a row opens the agent's page; a press
 * on a block opens the step.
 */
export function runBoardView(ctx: ViewCtx, runId: string, $: EngineInterface): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const back = (
    <Box key="run-back-row" flexDirection="row" paddingLeft={GRID.margin}>
      <Button
        key="run-back"
        label="Back"
        hotkey="b"
        plain
        onPress={() => updateUi($, u => {
          const { run: _run, ...rest } = u
          return rest
        })}
      />
    </Box>
  )
  const b = runBoard(ctx.t, runId, ctx.now)
  if (b === undefined) {
    return (
      <Box flexDirection="column">
        {back}
        {blank(ctx, $, 'gap-back')}
        <Text dimColor>{`${' '.repeat(GRID.margin)}This run is gone.`}</Text>
      </Box>
    )
  }
  const total = b.agents.reduce((n, a) => n + Math.min(STRIP_MAX, b.steps[a.id]?.length ?? 0), 0)
  const perBlock = total <= BLOCK_BUDGET
  const states = waitStates(ctx)
  const stats = `${b.done} of ${b.agents.length} agents done · ${b.failed} failed · ${cellTime(b.elapsed)}`
  return (
    <Box flexDirection="column">
      {back}
      {blank(ctx, $, 'gap-back')}
      {section(ctx, $, b.run.name, `${b.agents.length} ${b.agents.length === 1 ? 'agent' : 'agents'}`, { key: 'sec-run' })}
      <Text key="stats" dimColor wrap="truncate-end">{`${' '.repeat(edges(ctx.cols).left)}${wordFit(stats, Math.max(1, ctx.cols - 2 * edges(ctx.cols).left))}`}</Text>
      {b.agents.length === 0 ? <Text dimColor>{`${' '.repeat(edges(ctx.cols).left)}No agents in this run yet.`}</Text> : null}
      {b.agents.map(a => agentBlock(ctx, a, b.steps[a.id] ?? [], perBlock, $, states))}
    </Box>
  )
}
