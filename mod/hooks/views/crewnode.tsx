import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow } from '../../types'
import { STATE_WORD, agentOpened, openAgentPage, signalFlag, timeCell, toggleOpen, tokensCell } from './agentmeta'
import type { AgentRowOpts } from './agentmeta'
import { modelName } from './budget'
import { placed, wordFit } from './fit'
import { inst, runText } from './parts'
import type { Flag, Run } from './parts'
import type { ViewCtx } from './shell'
import { C, COL, podOf, spriteOf, tableCols } from './style'
import type { PodState } from './style'

const FLAG_RUN: Record<Flag, Run> = {
  inView: { text: '◂', color: C.live },
  problem: { text: '!', color: C.fail },
  waiting: { text: '?', color: C.wait },
  stalled: { text: 'z', color: C.wait },
}

/** What `crewNode` draws beside the character: its prefix, and whether the table's metric and time columns follow the name. */
export type CrewNodeOpts = AgentRowOpts & {
  /** The two rows left of the character (the flag at 0, the tether). Both rows must be the same width. Default: the flag and a blank, 2 wide. */
  prefix?: [Run[], Run[]]
  /** The table's metric (38) and time (50) on the name row, as the list has them. The map leaves them to its facts line. */
  columns?: boolean
  /** The facts line (dim) under the name; absent, role, state and model. */
  facts?: string
}

const widthOf = (runs: Run[]): number => runs.reduce((n, r) => n + r.text.length, 0)

/** The facts line of an agent: role, state, then tokens and time when asked (else its model). */
export function factsOf(ctx: ViewCtx, a: AgentRow, state: PodState | undefined, numbers: boolean): string {
  const pod = podOf(state !== undefined ? { ...a, state } : a, ctx.now)
  const parts: string[] = [pod.role, STATE_WORD[pod.state]]
  if (numbers) {
    parts.push(tokensCell(a))
    const t = timeCell(ctx, a)
    if (t !== '') parts.push(t)
  } else if (a.model !== undefined && a.model !== '') parts.push(modelName(a.model))
  return parts.join(' · ')
}

/**
 * An agent as two rows with its small character (5 x 2) in front: `prefix`,
 * the character (an `inst`, so its text form is its hull and signal in the
 * same box), then the name as the row's one Button over a dim facts line.
 * The Button never holds the character's cells. Rich look only: callers
 * check `ctx.look` (the text look keeps `row`'s hull glyph).
 */
export function crewNode(ctx: ViewCtx, $: EngineInterface, a: AgentRow, o: CrewNodeOpts): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const isMain = a.id === 'main'
  const sprite = spriteOf(a, ctx.now, o.state, 'S')
  const pod = podOf(o.state !== undefined ? { ...a, state: o.state } : a, ctx.now)
  const flag: Flag | undefined = signalFlag(pod) ?? o.flag
  const first: Run[] = o.prefix?.[0] ?? [flag !== undefined ? { ...FLAG_RUN[flag] } : { text: ' ' }, { text: ' ' }]
  const second: Run[] = o.prefix?.[1] ?? [{ text: '  ' }]
  const prefixWidth = widthOf(first)
  const nameCol = prefixWidth + sprite.columns + 1
  const tc = tableCols(ctx.cols)
  const nameEnd = o.columns === true ? Math.min(tc.nameEnd, ctx.cols) : ctx.cols
  const label = o.name ?? (isMain ? 'main' : a.description !== '' ? a.description : a.type)
  const labelText = typeof label === 'string' ? label : label.map(r => r.text).join('')
  const name = wordFit(labelText, Math.max(1, nameEnd - nameCol))
  const bold = ctx.u.agentOpen === a.id
  const segs: (Run & { col: number })[] = [{ col: nameCol, text: name, ...(bold ? { bold: true } : {}) }]
  if (o.columns === true) {
    if (tc.metric !== undefined) segs.push({ col: tc.metric, text: wordFit(tokensCell(a), Math.min(10, ctx.cols - tc.metric)), dim: true })
    if (tc.time !== undefined) segs.push({ col: tc.time, text: wordFit(timeCell(ctx, a), Math.min(10, ctx.cols - tc.time)), dim: true })
  }
  const body = placed(segs.filter(s => s.text !== ''), nameCol).flatMap((p, i) => [p.gap, runText(p.seg, ctx.e, $, `${o.key}-n${i}`)])
  const facts = o.facts ?? factsOf(ctx, a, o.state, o.columns !== true)
  const failed = pod.state === 'failed'
  return (
    <Box key={`node-${o.key}`} flexDirection="row">
      <Box key={`${o.key}-prefix`} flexDirection="column" width={prefixWidth} flexShrink={0}>
        <Text key={`${o.key}-p0`}>{first.map((r, i) => runText(r, ctx.e, $, `${o.key}-p0-${i}`))}</Text>
        <Text key={`${o.key}-p1`}>{second.map((r, i) => runText(r, ctx.e, $, `${o.key}-p1-${i}`))}</Text>
      </Box>
      {inst(ctx, $, { key: `who-${a.id}`, ...sprite })}
      <Box key={`${o.key}-text`} flexDirection="column" paddingLeft={1}>
        <Button key={o.key} plain onPress={() => toggleOpen($, a.id)}>
          {body}
        </Button>
        <Text key={`${o.key}-facts`} wrap="truncate-end" dimColor={!failed} color={failed ? C.fail : undefined}>
          {wordFit(facts, Math.max(1, ctx.cols - nameCol))}
        </Text>
      </Box>
    </Box>
  )
}

/**
 * An agent's row opened in place (`agentOpened`), with `e: page` on a line of its own under the
 * actions (`opened` shows three actions at most): the way into the agent's page.
 */
export function openedAgent(ctx: ViewCtx, $: EngineInterface, a: AgentRow): RenderElement | null {
  const base = agentOpened(ctx, $, a)
  if (base === null) return null
  const { Box, Button } = $.ui.resolve(ctx.e)
  return (
    <Box key={`opened-${a.id}`} flexDirection="column">
      {base}
      <Box key={`opened-page-${a.id}`} flexDirection="row" paddingLeft={COL.action}>
        <Button key={`agent-page-${a.id}`} hotkey="e" plain onPress={() => openAgentPage($, a.id)}>
          page
        </Button>
      </Box>
    </Box>
  )
}
