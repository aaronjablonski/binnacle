import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow, Step } from '../../types'
import { runBoard } from '../model/select'
import { updateUi } from '../state'
import { AGENT_GLYPH } from './agentmeta'
import { elapsed, fit } from './fit'
import { openStep } from './openstep'
import { glyphText, sectionHeader } from './parts'
import { glyphColor } from './style'
import type { ViewCtx } from './shell'

/** Blocks shown per agent. */
export const STRIP_MAX = 20
/**
 * Above this many blocks on the board the strips stop being one Button per
 * block (the Timeline keeps its own list under 200 Buttons) and become one
 * Button per agent that opens its newest step.
 */
export const BLOCK_BUDGET = 150
const INDENT = '  '

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
  return glyphText('■', glyphColor(s.status), ctx.e, $, key)
}

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
          <Button key={`block-${s.id}`} plain onPress={() => void openStep($, s.id)}>
            {blockText(s, $, ctx)}
          </Button>
        ))}
      </Box>
    )
  }
  const newest = steps[steps.length - 1]!
  return (
    <Button key={`strip-${agent.id}`} plain onPress={() => void openStep($, newest.id)}>
      <Text>{INDENT}</Text>
      {marker}
      {shown.map(s => blockText(s, $, ctx))}
    </Button>
  )
}

function agentBlock(ctx: ViewCtx, agent: AgentRow, steps: Step[], perBlock: boolean, $: EngineInterface): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const { cols } = ctx
  const end = agent.status === 'running' ? ctx.now : (agent.endedAt ?? ctx.now)
  const right = elapsed(agent.startedAt, end)
  const index = String((agent.agentIndex ?? 0) + 1)
  const glyph = AGENT_GLYPH[agent.status]
  const used = index.length + glyph.length + 2
  const room = Math.max(0, cols - used - right.length - 1)
  return (
    <Box key={`run-agent-${agent.id}`} flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text dimColor>{`${index} `}</Text>
          {glyphText(glyph, glyphColor(agent.status), ctx.e, $)}
          {` ${fit(agent.description, room)}`}
        </Text>
        <Text dimColor>{right}</Text>
      </Box>
      {strip(ctx, agent, steps, perBlock, $)}
      {agent.result !== undefined && agent.result !== '' ? (
        <Text key="result" dimColor>{fit(`${INDENT}└ ${agent.result}`, cols)}</Text>
      ) : null}
    </Box>
  )
}

/** One workflow run: a header, its counts, and a row per agent in spawn order. */
export function runBoardView(ctx: ViewCtx, runId: string, $: EngineInterface): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { cols } = ctx
  const back = (
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
  )
  const b = runBoard(ctx.t, runId, ctx.now)
  if (b === undefined) {
    return (
      <Box flexDirection="column" rowGap={1}>
        {back}
        <Text dimColor>This run is gone.</Text>
      </Box>
    )
  }
  const total = b.agents.reduce((n, a) => n + Math.min(STRIP_MAX, b.steps[a.id]?.length ?? 0), 0)
  const perBlock = total <= BLOCK_BUDGET
  const stats = `${b.done}/${b.agents.length} done · ${b.failed} failed · ${elapsed(0, b.elapsed)}`
  return (
    <Box flexDirection="column" rowGap={1}>
      {back}
      <Box flexDirection="column">
        {sectionHeader(`⚙ ${b.run.name}`, '', cols, ctx.e, $)}
        <Text dimColor>{fit(stats, cols)}</Text>
      </Box>
      {b.agents.length === 0 ? <Text dimColor>No agents in this run yet.</Text> : null}
      {b.agents.map(a => agentBlock(ctx, a, b.steps[a.id] ?? [], perBlock, $))}
    </Box>
  )
}
