import type { EngineInterface, RenderElement } from 'claude-code'

import type { Step, StepFilter, Timeline, TurnRow } from '../../types'
import { findSteps, stepGroups } from '../model/select'
import { windowRows } from '../model/window'
import { apply, debug, errText, readTimeline, updateUi } from '../state'
import { STEP_GLYPH } from './agentmeta'
import { clock, elapsed, fit, splitRow } from './fit'
import { openStep } from './openstep'
import { deepSearch, setQuery, showInChat } from './find'
import { flushRight, glyphText, sectionHeader } from './parts'
import type { ViewCtx } from './shell'
import { C, glyphColor } from './style'

const INDENT = '  '
const MIN_PAD = 20

type Group = { turn?: TurnRow; steps: Step[] }

// One row-block of the list. The window works in terminal rows, so each item
// knows how tall it draws.
type Item =
  | { kind: 'turn'; id: string; group: Group; isNewest: boolean; isOpen: boolean; height: number }
  | { kind: 'step'; step: Step; height: number }

// What the row needs of the find: a hit marks `in result`, and while a query is
// active each row carries a Show in chat line under it.
type Find = { active: boolean; hits: ReadonlySet<string> }

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

function stepLayout(t: Timeline, s: Step, cols: number, now: number, find: Find) {
  const glyph = STEP_GLYPH[s.status]
  const star = s.pin !== undefined ? '★ ' : ''
  const end = s.status === 'running' ? now : (s.endedAt ?? s.startedAt)
  const right = [s.agent !== 'main' ? agentName(t, s.agent) : '', elapsed(s.startedAt, end), find.hits.has(s.id) ? 'in result' : '']
    .filter(x => x !== '')
    .join(' · ')
  const head = splitRow(`${INDENT}${glyph} ${star}${s.label}`, right, cols)
  const note = s.pin !== undefined && s.pin !== '' ? fit(`${INDENT}└ ${s.pin}`, cols) : ''
  const height = 1 + (head.stacked ? 1 : 0) + (note !== '' ? 1 : 0) + (find.active ? 1 : 0)
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
  const title = lay.left.slice(lay.mark.length + 1)
  const mark = (
    <Text key="mark" color={C.accent}>
      {lay.mark}
    </Text>
  )
  // The newest turn is always open: it is drawn as a heading, not a control,
  // with its time right-aligned in a space-between row.
  if (item.isNewest) {
    return (
      <Box key={`turn-${item.id}`} flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            {mark}
            <Text bold>{` ${title}`}</Text>
          </Text>
          {lay.right !== '' && !lay.stacked ? <Text dimColor>{lay.right}</Text> : null}
        </Box>
        {lay.stacked ? <Text dimColor>{lay.right}</Text> : null}
      </Box>
    )
  }
  const parts: RenderElement[] = [
    mark,
    <Text key="head" bold>
      {` ${title}`}
    </Text>,
  ]
  if (lay.right !== '' && !lay.stacked) {
    parts.push(
      <Text key="time" dimColor>
        {flushRight(lay.left.length, lay.right, cols)}
      </Text>,
    )
  }
  if (lay.stacked) {
    parts.push(
      <Text key="time" dimColor>
        {`
${lay.right}`}
      </Text>,
    )
  }
  if (!item.isOpen) {
    parts.push(
      <Text key="count" dimColor>
        {`
${fit(`${INDENT}└ ${countLine(t, item.group)}`, cols)}`}
      </Text>,
    )
  }
  return (
    <Button key={`turn-${item.id}`} plain onPress={() => toggleTurn($, item.group.turn?.id ?? item.id)}>
      {parts}
    </Button>
  )
}

function stepRow(ctx: ViewCtx, s: Step, $: EngineInterface, find: Find): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { t, cols, now } = ctx
  const lay = stepLayout(t, s, cols, now, find)
  const glyph = STEP_GLYPH[s.status]
  const parts: RenderElement[] = [
    <Text key="indent">{INDENT}</Text>,
    glyphText(glyph, glyphColor(s.status), ctx.e, $, 'glyph'),
    <Text key="head">{lay.head.left.slice(INDENT.length + glyph.length)}</Text>,
  ]
  if (lay.head.right !== '' && !lay.head.stacked) {
    parts.push(
      <Text key="meta" dimColor>
        {flushRight(lay.head.left.length, lay.head.right, cols)}
      </Text>,
    )
  }
  if (lay.head.stacked) {
    parts.push(
      <Text key="meta" dimColor>
        {`
${fit(`${INDENT}${INDENT}${lay.head.right}`, cols)}`}
      </Text>,
    )
  }
  if (lay.note !== '') {
    parts.push(
      <Text key="note" dimColor>
        {`
${lay.note}`}
      </Text>,
    )
  }
  const row = (
    <Button key={`step-${s.id}`} plain onPress={() => openStep($, s.id)}>
      {parts}
    </Button>
  )
  if (!find.active) return row
  return (
    <Box key={`row-${s.id}`} flexDirection="column">
      {row}
      <Button
        key={`chat-${s.id}`}
        plain
        dimColor
        label={fit(`${INDENT}${INDENT}↗ Show in chat`, cols)}
        onPress={() => showInChat($, s.id)}
      />
    </Box>
  )
}

// The pane's scroll seat, read off the render input (K4: never viewport.rows).
function scrollOf(ctx: ViewCtx): { offset: number; bodyRows: number } {
  const props = ctx.e.props as { scroll?: { offset?: number; bodyRows?: number } }
  return { offset: props.scroll?.offset ?? 0, bodyRows: props.scroll?.bodyRows ?? 30 }
}

/** The Timeline tab: filters, then the turns newest first, each a heading over its steps. */
export function timelineView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text, Button, Input } = $.ui.resolve(ctx.e)
  const { t, u, cols } = ctx
  try {
    if (t.steps.length === 0) return <Text dimColor>No steps yet.</Text>

    const requestId = ctx.e.requestId
    const pinned = t.steps.filter(s => s.pin !== undefined).length
    const errors = t.steps.filter(s => s.status === 'error').length
    const f = u.filter
    // The active chip is a Text in the accent, bold; the others are dim labels.
    const chip = (key: string, label: string, on: boolean, filter: StepFilter): RenderElement =>
      on ? (
        <Button key={key} plain onPress={() => setFilter($, requestId, filter)}>
          <Text color={C.accent} bold>
            {label}
          </Text>
        </Button>
      ) : (
        <Button key={key} label={label} plain dimColor onPress={() => setFilter($, requestId, filter)} />
      )
    const filters = (
      <Box key="filters" flexDirection="row" flexWrap="wrap" columnGap={1}>
        {chip('filter-all', 'All', f.kind === 'all', { kind: 'all' })}
        {chip('filter-pinned', `★ Pinned ${pinned}`, f.kind === 'pinned', { kind: 'pinned' })}
        {chip('filter-errors', `✖ Errors ${errors}`, f.kind === 'errors', { kind: 'errors' })}
        {f.kind === 'agent' ? chip('filter-agent', fit(`${agentName(t, f.id)} ✕`, cols), true, { kind: 'all' }) : null}
      </Box>
    )
    const search = (
      <Input
        key="timeline-find"
        placeholder="find a step"
        value={u.query}
        submitLabel="deep search"
        onInput={(value: string) => void setQuery($, value)}
        onSubmit={(value: string) => deepSearch($, value)}
      />
    )

    // The query narrows the steps (tool, label, agent, pin note); the hits of a
    // deep search stay in even when only their result matched.
    const q = u.query.trim()
    const find: Find = { active: q !== '', hits: new Set(q === '' ? [] : (u.hits ?? [])) }
    let shown = t
    if (find.active) {
      const keep = new Set(findSteps(t, q).map(s => s.id))
      for (const id of find.hits) keep.add(id)
      shown = { ...t, steps: t.steps.filter(s => keep.has(s.id)) }
    }

    const groups = stepGroups(shown, f)
    if (groups.length === 0) {
      return (
        <Box flexDirection="column" rowGap={1}>
          {search}
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
      for (const s of g.steps) items.push({ kind: 'step', step: s, height: stepLayout(t, s, cols, ctx.now, find).height })
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
      drawn.push(it.kind === 'turn' ? turnRow(ctx, it, $) : stepRow(ctx, it.step, $, find))
    }

    return (
      <Box flexDirection="column" rowGap={1}>
        {search}
        {filters}
        {find.active
          ? sectionHeader('MATCHES', `${groups.reduce((n, g) => n + g.steps.length, 0)} of ${t.steps.length} steps`, cols, ctx.e, $)
          : null}
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
