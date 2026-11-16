import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow, Timeline } from '../../types'
import { agentCols, cellTime, failReason, openAgentPage, runningStep, timeCell, tokensCell, tokensOf, agentActions } from './agentmeta'
import { tokenText } from './budget'
import { doing, nameFit, placed, wordFit, wrapWords } from './fit'
import type { DoingView } from './fit'
import { doingView } from './needs'
import { agentCard, inst, runText } from './parts'
import type { Run } from './parts'
import { CREW_PALETTE, ROLE_HUE } from './raster'
import type { Ground } from './raster'
import type { ViewCtx } from './shell'
import { CK, COCKPIT, critterGlyph, critterOf, crewRole, edges, typeName } from './style'
import type { CritterArgs, PodState, Role } from './style'

// The agent rows the cockpit's Agents list, crew map and run board share:
// the working card, the finished row, the failed block, role pips, and the
// map's lines (a row at absolute columns, a node with its critter).

/** A run at an absolute column. */
export type Seg = Run & { col: number }

const endOf = (segs: Seg[], from = 0): number => placed(segs, from).reduce((e, p) => Math.max(e, p.seg.col) + p.seg.text.length, from)

/**
 * The segments laid at their columns from `start`, as Texts and the gaps
 * between. A segment that would pass the content's right edge is cut at a word.
 */
function laid(ctx: ViewCtx, $: EngineInterface, segs: Seg[], start: number, key: string): (RenderElement | string)[] {
  const out: (RenderElement | string)[] = []
  const limit = edges(ctx.cols).right + 1
  const fitted = segs.map(s => (s.col + s.text.length > limit && s.text.length > 1 ? { ...s, text: wordFit(s.text, Math.max(0, limit - s.col)) } : s)).filter(s => s.text !== '')
  placed(fitted, start).forEach((p, i) => {
    if (p.gap !== '') out.push(p.gap)
    out.push(runText(p.seg, ctx.e, $, `${key}-${i}`))
  })
  return out
}

/**
 * One row at absolute columns: `pre` (the gutter flag, the tether) in a Text,
 * then `body` from where `pre` ends, as one plain Button when `onPress` is
 * given. Never wider than its segments.
 */
export function lineOf(ctx: ViewCtx, $: EngineInterface, o: { key: string; pre?: Seg[]; body: Seg[]; onPress?: () => void | Promise<void>; autoFocus?: boolean }): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const pre = (o.pre ?? []).filter(s => s.text !== '')
  const preEnd = endOf(pre)
  const body = o.body.filter(s => s.text !== '')
  if (o.onPress === undefined) {
    return (
      <Text key={`row-${o.key}`} wrap="truncate-end">
        {laid(ctx, $, pre, 0, `${o.key}-p`)}
        {laid(ctx, $, body, preEnd, `${o.key}-b`)}
      </Text>
    )
  }
  return (
    <Box key={`row-${o.key}`} flexDirection="row">
      <Text key={`${o.key}-pre`}>{laid(ctx, $, pre, 0, `${o.key}-p`)}</Text>
      <Button key={o.key} plain onPress={o.onPress} autoFocus={o.autoFocus === true ? true : undefined}>
        {laid(ctx, $, body, preEnd, `${o.key}-b`)}
      </Button>
    </Box>
  )
}

/** A critter with rows of text around it: `pre[i]` before it (to `critterCol`), `rows[i]` after it (absolute columns), the first row's `body` one Button. */
export function nodeOf(
  ctx: ViewCtx,
  $: EngineInterface,
  o: { key: string; critter: CritterArgs; critterCol: number; pre: Seg[][]; rows: Seg[][]; onPress?: () => void | Promise<void> },
): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const height = Math.max(o.critter.rows, o.rows.length, o.pre.length)
  const start = o.critterCol + o.critter.columns
  const pads = Array.from({ length: height }, (_, i) => (
    <Text key={`${o.key}-pre${i}`}>{laid(ctx, $, o.pre[i] ?? [], 0, `${o.key}-pre${i}`)}</Text>
  ))
  const bodies = Array.from({ length: Math.max(1, o.rows.length) }, (_, i) => {
    const segs = (o.rows[i] ?? []).filter(s => s.text !== '')
    if (i === 0 && o.onPress !== undefined) {
      return (
        <Button key={o.key} plain onPress={o.onPress}>
          {laid(ctx, $, segs, start, `${o.key}-r0`)}
        </Button>
      )
    }
    return <Text key={`${o.key}-r${i}`} wrap="truncate-end">{segs.length > 0 ? laid(ctx, $, segs, start, `${o.key}-r${i}`) : ' '}</Text>
  })
  return (
    <Box key={`node-${o.key}`} flexDirection="row">
      <Box key={`${o.key}-pre`} flexDirection="column" width={o.critterCol} flexShrink={0}>
        {pads}
      </Box>
      {inst(ctx, $, { key: `who-${o.key}`, ...o.critter })}
      <Box key={`${o.key}-text`} flexDirection="column">
        {bodies}
      </Box>
    </Box>
  )
}

/** A role's hue as the hex a pip is drawn in (the map only, R26). */
export function hueHex(role: Role, ground: Ground = 'night'): string {
  return `#${CREW_PALETTE[ground][ROLE_HUE[role]].toString(16).padStart(6, '0')}`
}

/** The most pips a folded group draws; its `+ n done` carries the real count. */
export const PIP_MAX = 8

/** One `▪` a done agent in its role's hue, run together by hue (at most PIP_MAX). */
export function pipRuns(agents: AgentRow[], ground: Ground = 'night'): Run[] {
  const out: Run[] = []
  for (const a of agents.slice(0, PIP_MAX)) {
    const color = hueHex(crewRole(a.id, a.type), ground)
    const last = out[out.length - 1]
    if (last !== undefined && last.color === color) out[out.length - 1] = { ...last, text: last.text + '▪' }
    else out.push({ text: '▪', color })
  }
  return out
}

/** An agent's state: what the model's wait states say, else its status. */
export function stateOf(a: AgentRow, states: Map<string, PodState>): PodState {
  return states.get(a.id) ?? (a.status === 'error' ? 'failed' : a.status === 'done' ? 'done' : 'working')
}

// ---------- the list ----------

/** The text a working card shows on its second row, in the state's colour. */
function cardDoing(t: Timeline, a: AgentRow, state: PodState, view?: DoingView): (room: number) => string | Run[] {
  return room => {
    if (state === 'waiting') return [{ text: room >= 23 ? 'Waiting for your answer' : 'Waiting for you', color: CK.ask }]
    if (state === 'stalled') return [{ text: room >= 40 ? 'No activity for a while, may be thinking' : room >= 18 ? 'No activity lately' : 'Quiet', dim: true }]
    return doing(runningStep(t, a.id), view, room)
  }
}

/**
 * A working card (CockpitAgents "Working"): the critter, the real type in
 * friendly case in bold and the job, the time at 59; under it what it is
 * doing and its tokens in words. A waiting agent's time is amber (R6).
 */
export function liveCard(
  ctx: ViewCtx,
  $: EngineInterface,
  a: AgentRow,
  o: { key: string; state: PodState; since?: number; tokens?: boolean; onPress: () => void | Promise<void> },
): RenderElement {
  const n = tokensOf(a)
  const time: string | Run[] = o.state === 'waiting' && o.since !== undefined ? [{ text: cellTime(ctx.now - o.since), color: CK.ask }] : timeCell(ctx, a)
  return agentCard(ctx, $, {
    key: o.key,
    critter: critterOf(a, { state: o.state, ground: ctx.ground ?? 'night', motion: ctx.motion === true }),
    name: typeName(a.type),
    job: a.description.replace(/\s+/g, ' ').trim(),
    time,
    doing: cardDoing(ctx.t, a, o.state, doingView(ctx)),
    ...(o.tokens !== false && n !== undefined ? { tokens: `${tokenText(n)} tokens` } : {}),
    onPress: o.onPress,
  })
}

/** The right-hand cells of a table row: tokens ending at 49, time ending at 59 (the tokens go under 46 columns). */
export function numberSegs(ctx: ViewCtx, a: Pick<AgentRow, 'tokensIn' | 'tokensOut' | 'status'>, time: string, style: Omit<Run, 'text'> = { dim: true }): Seg[] {
  const c = agentCols(ctx.cols)
  const segs: Seg[] = []
  if (c.tokens !== undefined) {
    const tok = tokensCell(a as AgentRow)
    segs.push({ col: c.tokens - tok.length + 1, text: tok, ...style })
  }
  if (time !== '') segs.push({ col: c.time - time.length + 1, text: time, ...style })
  return segs
}

/** Where the cells on the right start, so a name leaves two columns before them. */
export function nameEnd(ctx: ViewCtx, segs: Seg[]): number {
  const first = segs.reduce((m, s) => Math.min(m, s.col), agentCols(ctx.cols).right + 2)
  return first - 2
}

/** `✓ Checker  review the token bucket` dim, its tokens and time at the table's columns: one finished agent (or a workflow agent, glyph by state). */
export function agentLine(ctx: ViewCtx, $: EngineInterface, a: AgentRow, o: { key: string; state: PodState; onPress: () => void | Promise<void> }): RenderElement {
  const c = agentCols(ctx.cols)
  const { glyph } = critterGlyph(o.state)
  const nums = numberSegs(ctx, a, timeCell(ctx, a), o.state === 'done' ? { dim: true } : {})
  const nameCol = c.left + 2
  const room = Math.max(1, nameEnd(ctx, nums) - nameCol + 1)
  const type = nameFit(typeName(a.type), room)
  const job = a.description.replace(/\s+/g, ' ').trim()
  const style = o.state === 'done' ? { dim: true } : {}
  const jobRoom = room - type.length - 2
  const body: Seg[] = [
    { col: c.left, ...glyph },
    { col: nameCol, text: type, ...style },
    ...(job !== '' && jobRoom >= 4 ? [{ col: nameCol + type.length + 2, text: wordFit(job, jobRoom), ...style }] : []),
    ...nums,
  ]
  return lineOf(ctx, $, { key: o.key, body, onPress: o.onPress })
}

/**
 * A failed agent (R26): a micro critter with a red `!` at 2 (its badge column
 * reserved), the type in bold and the job at 9, tokens and time on the table's
 * columns; the reason under it, dim, wrapped in full to two lines; `keys` (the
 * first failed agent only) its `v g s` hotkeys on the row after.
 */
export function failedBlock(ctx: ViewCtx, $: EngineInterface, a: AgentRow, o: { key: string; keys: boolean }): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { left, right } = edges(ctx.cols)
  const textCol = COCKPIT.text
  const nums = numberSegs(ctx, a, timeCell(ctx, a))
  const room = Math.max(1, nameEnd(ctx, nums) - textCol + 1)
  const type = typeName(a.type)
  const job = a.description.replace(/\s+/g, ' ').trim()
  const head: Seg[] = [{ col: textCol, text: nameFit(type, room), bold: true }]
  const jobRoom = room - type.length - 2
  if (job !== '' && jobRoom >= 4) head.push({ col: textCol + type.length + 2, text: wordFit(job, jobRoom) })
  const reason = wrapWords(failReason(ctx.t, a), Math.max(1, right - textCol + 1), 2)
  const critter = critterOf(a, { state: 'failed', size: 'micro', ground: ctx.ground ?? 'night' })
  const rows: Seg[][] = [[...head, ...nums], ...reason.map(r => [{ col: textCol, text: r, dim: true }])]
  const acts = agentActions($, a)
  // `agentActions` lists s, v, g; the row reads v, g, s.
  const all = o.keys ? [...acts.slice(1), acts[0]!] : []
  // As many as fit before the right edge, whole.
  const keys: typeof all = []
  let used = textCol
  for (const k of all) {
    const w = (keys.length > 0 ? 3 : 0) + k.hotkey.length + 2 + k.label.length
    if (used + w > right + 1) break
    keys.push(k)
    used += w
  }
  const lines = Array.from({ length: Math.max(rows.length, critter.rows) }, (_, i) => rows[i] ?? [])
  return (
    <Box key={`failed-${o.key}`} flexDirection="column">
      <Box key={`${o.key}-box`} flexDirection="row" paddingLeft={left}>
        <Box key={`${o.key}-who`} width={textCol - left} flexShrink={0}>
          {inst(ctx, $, { key: `who-${o.key}`, ...critter })}
        </Box>
        <Box key={`${o.key}-text`} flexDirection="column">
          {lines.map((segs, i) =>
            i === 0 ? (
              <Button key={o.key} plain onPress={() => openAgentPage($, a.id, o.key)}>
                {laid(ctx, $, segs, textCol, `${o.key}-r0`)}
              </Button>
            ) : (
              <Text key={`${o.key}-r${i}`} wrap="truncate-end">{segs.length > 0 ? laid(ctx, $, segs, textCol, `${o.key}-r${i}`) : ' '}</Text>
            ),
          )}
        </Box>
      </Box>
      {keys.length > 0 ? (
        <Box key={`${o.key}-keys`} flexDirection="row" paddingLeft={textCol} columnGap={3}>
          {keys.map(k => (
            <Button key={k.key} hotkey={k.hotkey} plain dimColor onPress={k.onPress}>
              {k.label}
            </Button>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

