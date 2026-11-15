import type { EngineInterface, RenderElement } from 'claude-code'

import type { Step, StepFilter, Timeline, TurnRow } from '../../types'
import { stepGroups } from '../model/select'
import { windowRows } from '../model/window'
import { apply, debug, errText, readTimeline, updateUi } from '../state'
import { STEP_GLYPH } from './agentmeta'
import { clock, elapsed, fit, splitRow } from './fit'
import { openStep } from './openstep'
import type { ViewCtx } from './shell'

const INDENT = '  '
const MIN_PAD = 20

type Group = { turn?: TurnRow; steps: Step[] }

// One row-block of the list. The window works in terminal rows, so each item
// knows how tall it draws.
type Item =
  | { kind: 'turn'; id: string; group: Group; isNewest: boolean; isOpen: boolean; height: number }
  | { kind: 'step'; step: Step; height: number }

const groupId = (g: Group): string => g.turn?.id ?? 'none'

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

function agentName(t: Timeline, id: string): string {
  return t.agents[id]?.type ?? id
}

function countLine(t: Timeline, g: Group): string {
  const agents = new Set(g.steps.filter(s => s.agent !== 'main').map(s => s.agent))
  const n = g.steps.length
  const steps = `${n} ${n === 1 ? 'step' : 'steps'}`
  if (agents.size === 0) return steps
  return `${steps} · ${agents.size} ${agents.size === 1 ? 'agent' : 'agents'}`
}

function turnLayout(g: Group, isOpen: boolean, cols: number) {
  const mark = isOpen ? '▾' : '▸'
  const title = g.turn ? oneLine(g.turn.prompt) || '(no prompt)' : 'Earlier steps'
  const time = g.turn ? clock(g.turn.startedAt) : ''
  return { mark, ...splitRow(`${mark} ${title}`, time, cols) }
}

function stepLayout(t: Timeline, s: Step, cols: number, now: number) {
  const glyph = STEP_GLYPH[s.status]
  const star = s.pin !== undefined ? '★ ' : ''
  const end = s.status === 'running' ? now : (s.endedAt ?? s.startedAt)
  const right = [s.agent !== 'main' ? agentName(t, s.agent) : '', elapsed(s.startedAt, end)].filter(x => x !== '').join(' · ')
  const head = splitRow(`${INDENT}${glyph} ${star}${s.label}`, right, cols)
  const note = s.pin !== undefined && s.pin !== '' ? fit(`${INDENT}${INDENT}${s.pin}`, cols) : ''
  const height = 1 + (head.stacked ? 1 : 0) + (note !== '' ? 1 : 0)
  return { head, note, height }
}

async function setFilter($: EngineInterface, requestId: string, filter: StepFilter): Promise<void> {
  await updateUi($, u => ({ ...u, filter }))
  // The list changes length: back to its top (E3).
  try {
    await $.ui.scroll({ in: requestId, to: 'start' })
  } catch (err) {
    debug($, `scroll failed: ${errText(err)}`)
  }
}

async function toggleTurn($: EngineInterface, id: string): Promise<void> {
  await updateUi($, u => ({
    ...u,
    openTurns: u.openTurns.includes(id) ? u.openTurns.filter(x => x !== id) : [...u.openTurns, id],
  }))
}

/** Pins the newest step of the main loop with `note`; the answer of `/mc pin`. */
export async function pinNewest($: EngineInterface, note: string): Promise<{ text: string }> {
  const t = await readTimeline($)
  let newest: Step | undefined
  for (const s of t.steps) {
    if (s.agent !== 'main') continue
    if (newest === undefined || s.seq > newest.seq) newest = s
  }
  if (newest === undefined) return { text: 'Nothing to pin yet.' }
  await apply($, { kind: 'pin', id: newest.id, note })
  return { text: `Pinned: ${newest.label}` }
}

function turnRow(ctx: ViewCtx, item: Extract<Item, { kind: 'turn' }>, $: EngineInterface): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { t, cols } = ctx
  const lay = turnLayout(item.group, item.isOpen, cols)
  const parts: RenderElement[] = [
    <Text key="head" bold>
      {lay.left}
    </Text>,
  ]
  if (lay.right !== '' && !lay.stacked) {
    parts.push(
      <Text key="time" dimColor>
        {` ${lay.right}`}
      </Text>,
    )
  }
  if (lay.stacked) {
    parts.push(
      <Text key="time" dimColor>
        {`\n${lay.right}`}
      </Text>,
    )
  }
  if (!item.isOpen) {
    parts.push(
      <Text key="count" dimColor>
        {`\n${fit(`${INDENT}${countLine(t, item.group)}`, cols)}`}
      </Text>,
    )
  }
  // The newest turn is always open: it is drawn as a heading, not a control.
  if (item.isNewest) {
    return (
      <Box key={`turn-${item.id}`}>
        <Text>{parts}</Text>
      </Box>
    )
  }
  return (
    <Button key={`turn-${item.id}`} plain onPress={() => toggleTurn($, item.group.turn?.id ?? item.id)}>
      {parts}
    </Button>
  )
}

function stepRow(ctx: ViewCtx, s: Step, $: EngineInterface): RenderElement {
  const { Text, Button } = $.ui.resolve(ctx.e)
  const { t, cols, now } = ctx
  const lay = stepLayout(t, s, cols, now)
  const parts: RenderElement[] = [<Text key="head">{lay.head.left}</Text>]
  if (lay.head.right !== '' && !lay.head.stacked) {
    parts.push(
      <Text key="meta" dimColor>
        {` ${lay.head.right}`}
      </Text>,
    )
  }
  if (lay.head.stacked) {
    parts.push(
      <Text key="meta" dimColor>
        {`\n${fit(`${INDENT}${INDENT}${lay.head.right}`, cols)}`}
      </Text>,
    )
  }
  if (lay.note !== '') {
    parts.push(
      <Text key="note" dimColor>
        {`\n${lay.note}`}
      </Text>,
    )
  }
  return (
    <Button key={`step-${s.id}`} plain onPress={() => openStep($, s.id)}>
      {parts}
    </Button>
  )
}

// The pane's scroll seat, read off the render input (K4: never viewport.rows).
function scrollOf(ctx: ViewCtx): { offset: number; bodyRows: number } {
  const props = ctx.e.props as { scroll?: { offset?: number; bodyRows?: number } }
  return { offset: props.scroll?.offset ?? 0, bodyRows: props.scroll?.bodyRows ?? 30 }
}

/** The Timeline tab: filters, then the turns newest first, each a heading over its steps. */
export function timelineView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { t, u, cols } = ctx
  try {
    if (t.steps.length === 0) return <Text dimColor>No steps yet.</Text>

    const requestId = ctx.e.requestId
    const pinned = t.steps.filter(s => s.pin !== undefined).length
    const errors = t.steps.filter(s => s.status === 'error').length
    const f = u.filter
    const filters = (
      <Box key="filters" flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button key="filter-all" label="All" plain dimColor={f.kind !== 'all'} onPress={() => setFilter($, requestId, { kind: 'all' })} />
        <Button
          key="filter-pinned"
          label={`★ Pinned ${pinned}`}
          plain
          dimColor={f.kind !== 'pinned'}
          onPress={() => setFilter($, requestId, { kind: 'pinned' })}
        />
        <Button
          key="filter-errors"
          label={`✖ Errors ${errors}`}
          plain
          dimColor={f.kind !== 'errors'}
          onPress={() => setFilter($, requestId, { kind: 'errors' })}
        />
        {f.kind === 'agent' ? (
          <Button
            key="filter-agent"
            label={fit(`${agentName(t, f.id)} ✕`, cols)}
            plain
            onPress={() => setFilter($, requestId, { kind: 'all' })}
          />
        ) : null}
      </Box>
    )

    const groups = stepGroups(t, f)
    if (groups.length === 0) {
      return (
        <Box flexDirection="column" rowGap={1}>
          {filters}
          <Text dimColor>No steps match.</Text>
        </Box>
      )
    }

    // Every item with its height, then only those near the window are drawn.
    const items: Item[] = []
    groups.forEach((g, i) => {
      const isNewest = i === 0
      const id = groupId(g)
      const isOpen = isNewest || u.openTurns.includes(id)
      const lay = turnLayout(g, isOpen, cols)
      const height = 1 + (lay.stacked ? 1 : 0) + (isOpen ? 0 : 1)
      items.push({ kind: 'turn', id, group: g, isNewest, isOpen, height })
      if (!isOpen) return
      for (const s of g.steps) items.push({ kind: 'step', step: s, height: stepLayout(t, s, cols, ctx.now).height })
    })
    const total = items.reduce((sum, it) => sum + it.height, 0)
    const { offset, bodyRows } = scrollOf(ctx)
    const win = windowRows(total, offset, bodyRows, Math.max(MIN_PAD, bodyRows))

    const drawn: RenderElement[] = []
    let top = 0
    let bottom = 0
    let at = 0
    for (const it of items) {
      const start = at
      const end = at + it.height
      at = end
      if (end <= win.from) {
        top = end
        continue
      }
      if (start >= win.to) {
        bottom += it.height
        continue
      }
      drawn.push(it.kind === 'turn' ? turnRow(ctx, it, $) : stepRow(ctx, it.step, $))
    }

    return (
      <Box flexDirection="column" rowGap={1}>
        {filters}
        <Box flexDirection="column">
          {top > 0 ? <Box key="space-top" height={top} /> : null}
          {drawn}
          {bottom > 0 ? <Box key="space-bottom" height={bottom} /> : null}
        </Box>
      </Box>
    )
  } catch (err) {
    debug($, `timeline view failed: ${errText(err)}`)
    return <Text dimColor>{fit(`Timeline: ${errText(err)}`, cols)}</Text>
  }
}
