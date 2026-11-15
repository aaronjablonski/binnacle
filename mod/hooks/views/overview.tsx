import type { EngineInterface, RenderElement } from 'claude-code'

import type { ArtifactKind, Tab } from '../../types'
import { summary } from '../model/select'
import { leaveDetail, updateUi } from '../state'
import { STEP_GLYPH } from './agentmeta'
import { budgetSection } from './budget'
import { blockBar, elapsed, fit } from './fit'
import { needsSection } from './needs'
import { openStep } from './openstep'
import { glyphLine, sectionHeader, splitLine } from './parts'
import type { ViewCtx } from './shell'
import { C, glyphColor } from './style'

const ARTIFACT_GLYPH: Record<ArtifactKind, string> = { page: '↗', document: '▤', result: '◆', link: '⎇' }
const ARTIFACT_COLOR: Record<ArtifactKind, string | undefined> = {
  page: C.accent,
  document: C.doc,
  result: C.done,
  link: undefined,
}
// From this width the Overview draws two columns.
const WIDE = 96
const COLUMN_GAP = 2

// A header that opens its tab.
function goHeader(ctx: ViewCtx, $: EngineInterface, tab: Tab, label: string, meta: string): RenderElement {
  const { Button } = $.ui.resolve(ctx.e)
  return (
    <Button key={`go-${tab}`} plain onPress={() => updateUi($, u => ({ ...leaveDetail(u), tab }))}>
      {sectionHeader(label, meta, ctx.cols, ctx.e, $)}
    </Button>
  )
}

// NOW: with no focus from Claude or a task, the step in flight, else the newest one.
function nowSection(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const { t, cols, now } = ctx
  const s = summary(t)
  const bySeq = [...t.steps].sort((a, b) => b.seq - a.seq)
  const stepNow = s.focus ? undefined : bySeq.find(x => x.status === 'running') ?? bySeq[0]
  let meta = ''
  if (s.fromClaude && s.focusAt !== undefined) meta = `from Claude · ${elapsed(s.focusAt, now)} ago`
  if (stepNow) meta = 'latest step'
  return (
    <Box key="now" flexDirection="column">
      {sectionHeader('NOW', meta, cols, ctx.e, $)}
      {s.focus ? <Text bold>{fit(s.focus, cols)}</Text> : null}
      {stepNow ? glyphLine(ctx, $, STEP_GLYPH[stepNow.status], glyphColor(stepNow.status), stepNow.label, true) : null}
      {!s.focus && !stepNow ? <Text dimColor>{fit('Idle. Nothing running yet.', cols)}</Text> : null}
      {s.next ? (
        <Text>
          <Text dimColor>Next </Text>
          {fit(s.next, Math.max(0, cols - 'Next '.length))}
        </Text>
      ) : null}
    </Box>
  )
}

// TASKS: the count in the header, a block bar, the task in progress and the next one.
function tasksSection(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const { t, cols, now } = ctx
  const s = summary(t)
  const more = Math.max(0, t.tasks.filter(x => x.status === 'pending').length - (s.upcoming ? 1 : 0))
  const blocks = blockBar(s.done, s.total, cols)
  return (
    <Box key="tasks" flexDirection="column">
      {goHeader(ctx, $, 'tasks', 'TASKS', s.total > 0 ? `${s.done}/${s.total}` : '')}
      {s.total > 0 ? (
        <Text>
          <Text color={C.done}>{blocks.filled}</Text>
          <Text color={C.rule}>{blocks.rest}</Text>
        </Text>
      ) : (
        <Text dimColor>No tasks yet.</Text>
      )}
      {s.current ? splitLine(ctx, $, '▶', glyphColor('in_progress'), s.current.subject, elapsed(s.current.updatedAt, now)) : null}
      {s.upcoming ? glyphLine(ctx, $, '○', undefined, s.upcoming.subject) : null}
      {s.done > 0 || more > 0 ? (
        <Text>
          <Text color={C.done}>✔</Text>
          <Text dimColor>{fit(` ${s.done} done · ○ ${more} more`, Math.max(0, cols - 1))}</Text>
        </Text>
      ) : null}
    </Box>
  )
}

// AGENTS: each running agent, its doing line second.
function agentsSection(ctx: ViewCtx, $: EngineInterface): RenderElement | null {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const s = summary(ctx.t)
  if (s.running.length === 0 && s.finished === 0) return null
  return (
    <Box key="agents" flexDirection="column">
      {goHeader(ctx, $, 'agents', 'AGENTS', `${s.running.length} running · ${s.finished} done`)}
      {s.running.map(a => (
        <Box key={`agent-${a.id}`} flexDirection="column">
          {glyphLine(ctx, $, '▶', glyphColor('running'), `${a.type} · ${a.description}`)}
          {a.doing !== '' ? <Text dimColor>{fit(`└ ${a.doing}`, ctx.cols)}</Text> : null}
        </Box>
      ))}
    </Box>
  )
}

// LATEST: the newest steps, each one opens its detail.
function latestSection(ctx: ViewCtx, $: EngineInterface): RenderElement | null {
  const { Box, Button, Text } = $.ui.resolve(ctx.e)
  const { t, cols } = ctx
  const s = summary(t)
  if (s.steps === 0) return null
  return (
    <Box key="latest" flexDirection="column">
      {goHeader(ctx, $, 'timeline', 'LATEST', `${s.steps} steps · ${s.errors} errors · ${s.changed} files changed`)}
      {s.latest.map(x => {
        const star = x.pin !== undefined ? '★ ' : ''
        const note = x.pin ? ` · ${x.pin}` : ''
        const who = x.agent !== 'main' ? ` · ${t.agents[x.agent]?.type ?? x.agent}` : ''
        const glyph = STEP_GLYPH[x.status]
        const color = glyphColor(x.status)
        const text = fit(`${star}${x.label}${note}${who}`, Math.max(0, cols - glyph.length - 1))
        return (
          <Button key={`step-${x.id}`} plain label={fit(`${glyph} ${text}`, cols)} onPress={() => openStep($, x.id)}>
            {color !== undefined ? <Text color={color}>{glyph}</Text> : <Text dimColor>{glyph}</Text>}
            <Text>{` ${text}`}</Text>
          </Button>
        )
      })}
    </Box>
  )
}

// NOTES, one bullet each.
function notesSection(ctx: ViewCtx, $: EngineInterface): RenderElement | null {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const { t, cols } = ctx
  const s = summary(t)
  if (s.notes.length === 0) return null
  return (
    <Box key="notes" flexDirection="column">
      {sectionHeader('NOTES', '', cols, ctx.e, $)}
      {s.notes.map((n, i) => {
        const who = n.agent !== 'main' ? ` · ${t.agents[n.agent]?.type ?? n.agent}` : ''
        return <Text key={`note-${i}`}>{fit(`• ${n.text}${who}`, cols)}</Text>
      })}
    </Box>
  )
}

// ARTIFACTS: the newest few, kind and age on the right.
function artifactsSection(ctx: ViewCtx, $: EngineInterface): RenderElement | null {
  const { Box } = $.ui.resolve(ctx.e)
  const { t, now } = ctx
  if (t.artifacts.length === 0) return null
  return (
    <Box key="artifacts" flexDirection="column">
      {goHeader(ctx, $, 'artifacts', 'ARTIFACTS', String(t.artifacts.length))}
      {summary(t).artifacts.map(a => (
        <Box key={`artifact-${a.id}`} flexDirection="column">
          {splitLine(ctx, $, ARTIFACT_GLYPH[a.kind], ARTIFACT_COLOR[a.kind], a.title, `${a.kind} · ${elapsed(a.updatedAt, now)}`)}
        </Box>
      ))}
    </Box>
  )
}

function keep(list: (RenderElement | null)[]): RenderElement[] {
  return list.filter((x): x is RenderElement => x !== null)
}

/** The Overview tab: what is happening now, in short sections; two columns when wide. */
export function overviewView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  if (ctx.cols >= WIDE) {
    const width = Math.floor((ctx.cols - COLUMN_GAP) / 2)
    const half = { ...ctx, cols: width }
    const left = keep([nowSection(half, $), tasksSection(half, $), budgetSection(half, $)])
    const right = keep([agentsSection(half, $), latestSection(half, $)])
    const needs = needsSection(ctx, $)
    const notes = ctx.t.notes.length
    const artifacts = ctx.t.artifacts.length
    const counts = [notes > 0 ? `notes ${notes}` : '', artifacts > 0 ? `artifacts ${artifacts}` : ''].filter(x => x !== '')
    return (
      <Box flexDirection="column" rowGap={1}>
        {needs}
        <Box flexDirection="row" columnGap={COLUMN_GAP}>
          <Box key="col-left" flexDirection="column" rowGap={1} width={width}>
            {left}
          </Box>
          {right.length > 0 ? (
            <Box key="col-right" flexDirection="column" rowGap={1} width={width}>
              {right}
            </Box>
          ) : null}
        </Box>
        {counts.length > 0 ? <Text dimColor>{fit(`↓ ${counts.join(' · ')}`, ctx.cols)}</Text> : null}
      </Box>
    )
  }
  const sections = keep([
    needsSection(ctx, $),
    nowSection(ctx, $),
    tasksSection(ctx, $),
    agentsSection(ctx, $),
    budgetSection(ctx, $),
    latestSection(ctx, $),
    notesSection(ctx, $),
    artifactsSection(ctx, $),
  ])
  return (
    <Box flexDirection="column" rowGap={1}>
      {sections}
    </Box>
  )
}
