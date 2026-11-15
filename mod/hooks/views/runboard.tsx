import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow, Step } from '../../types'
import { runBoard } from '../model/select'
import { updateUi } from '../state'
import { agentOpened, agentRow, podStates } from './agentmeta'
import { elapsed } from './fit'
import { openStepInline } from './openstep'
import { blank, section } from './parts'
import { COL, GRID, statusColor } from './style'
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
const INDENT = ' '.repeat(COL.name)

/** The steps a strip shows (the newest) and how many are hidden before them. */
export function stripOf(steps: Step[], room: number): { shown: Step[]; hidden: number } {
  const take = Math.max(0, Math.min(STRIP_MAX, room))
  const shown = take === 0 ? [] : steps.slice(-take)
  return { shown, hidden: steps.length - shown.length }
}

/** The room a strip has beside its `+n ` marker, within `cols`. */
function roomFor(cols: number, count: number): number {
  const marker = count > STRIP_MAX ? `+${count - STRIP_MAX} `.length : 0
  return Math.max(0, Math.min(STRIP_MAX, cols - INDENT.length - marker))
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
        <Text key="indent">{INDENT}</Text>
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
      <Text>{INDENT}</Text>
      {marker}
      {shown.map(s => blockText(s, $, ctx))}
    </Button>
  )
}

/** One agent of the run: its row (a press opens it), its strip of step blocks, and the opened part. */
function agentBlock(ctx: ViewCtx, agent: AgentRow, steps: Step[], perBlock: boolean, last: boolean, first: boolean, $: EngineInterface, states: Map<string, PodState>): RenderElement {
  const { Box } = $.ui.resolve(ctx.e)
  const line = agentRow(ctx, $, agent, { key: `run-agent-${agent.id}`, ...(states.has(agent.id) ? { state: states.get(agent.id)! } : {}) })
  const detail = agentOpened(ctx, $, agent)
  const blocks = strip(ctx, agent, steps, perBlock, $)
  if (detail === null) {
    return (
      <Box key={`run-block-${agent.id}`} flexDirection="column">
        {line}
        {blocks}
      </Box>
    )
  }
  return (
    <Box key={`run-block-${agent.id}`} flexDirection="column">
      {first ? null : blank(ctx, $, `pre-${agent.id}`)}
      {line}
      {blocks}
      {detail}
      {last ? null : blank(ctx, $, `post-${agent.id}`)}
    </Box>
  )
}

/**
 * One workflow run: `b: Back`, its counts, and a row per agent in spawn order
 * (tokens at 38, time at 50) with the newest steps as blocks under it. A press
 * on a row opens it (`result`, `agent`, `s v g`); a press on a block opens the step.
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
  const states = podStates(ctx)
  const stats = `${b.done}/${b.agents.length} done · ${b.failed} failed · ${elapsed(0, b.elapsed)}`
  return (
    <Box flexDirection="column">
      {back}
      {blank(ctx, $, 'gap-back')}
      {section(ctx, $, b.run.name, 'tokens', 'time')}
      <Text key="stats" dimColor wrap="truncate-end">{`${' '.repeat(COL.glyph)}${stats}`}</Text>
      {b.agents.length === 0 ? <Text dimColor>{`${' '.repeat(COL.glyph)}No agents in this run yet.`}</Text> : null}
      {b.agents.map((a, i) => agentBlock(ctx, a, b.steps[a.id] ?? [], perBlock, i === b.agents.length - 1, i === 0, $, states))}
    </Box>
  )
}
