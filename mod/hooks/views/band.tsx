import type { EngineInterface, On, RenderElement, RenderInput } from 'claude-code'

import type { AgentRow, Timeline, UiState } from '../../types'
import { pace, taskMeter, thisTurn } from '../model/meter'
import { summary } from '../model/select'
import type { Problem } from '../model/select'
import { debug, errText, readTimeline, readUi } from '../state'
import { bar, beadCount, crewRow, elapsed, fitRuns, meter, pillRun, pips, wordFit } from './fit'
import { kindLabel, needsYou, problemText, waitStates } from './needs'
import { stripBandView } from './stripband'
import { begin } from './paint'
import { deck, inst, runText } from './parts'
import type { DeckCell, DeckRow, InstSpec } from './parts'
import { beads, bars, Grid, drawSprite, SPRITE } from './raster'
import type { Hue } from './raster'
import { leaveStrip } from './shell'
import { bandSvgOf, lookFor } from './svgview'
import type { ViewCtx } from './shell'
import { C, cellCol, podOf, rateColor } from './style'
import type { Pod, PodState, Run } from './style'

/** Under this many columns the band is the compact row, whatever the pane does. */
const THREE_ROWS_FROM = 86
const MC = '/mc'
/** The least room a cut focus is worth: under it the right side gives up the count, then the crew. */
const MIN_FOCUS = 8
/** Pods in the band's crew cell (14 to 48): 11 pods, or 10 and `+n`, take 32 columns. */
const BAND_PODS = 11
/** The gap kept between the left and right sides of a one-row band. */
const MIN_GAP = 2

type Word = 'WORKING' | 'WAITING' | 'ALL DONE' | 'IDLE'

const widthOf = (runs: Run[]): number => runs.reduce((n, r) => n + r.text.length, 0)
const spaces = (n: number): Run => ({ text: ' '.repeat(Math.max(0, n)) })

/** The crew as pods: the lead (`main`) first, then the subagents in the order they started. */
function podsOf(t: Timeline, waits: Map<string, PodState>, now: number, settled: boolean): { agent: AgentRow; pod: Pod }[] {
  const list = Object.values(t.agents)
  const main = list.filter(a => a.id === 'main')
  const rest = list.filter(a => a.id !== 'main').sort((a, b) => a.startedAt - b.startedAt)
  return [...main, ...rest].map(agent => {
    // A finished session leaves `main` running for good: all done draws it solid.
    const status = settled && agent.id === 'main' ? 'done' : agent.status
    const state = waits.get(agent.id)
    return { agent, pod: podOf({ id: agent.id, type: agent.type, status, ...(state !== undefined ? { state } : {}) }, now) }
  })
}

type Counts = { live: number; stalled: number; failed: number; done: number }

/** The crew's tallies: subagents only, the lead is the crew's own row. */
function countsOf(crew: { agent: AgentRow; pod: Pod }[]): Counts {
  const c: Counts = { live: 0, stalled: 0, failed: 0, done: 0 }
  for (const { agent, pod } of crew) {
    if (agent.id === 'main') continue
    if (pod.state === 'working') c.live++
    else if (pod.state === 'stalled') c.stalled++
    else if (pod.state === 'failed') c.failed++
    else if (pod.state === 'done') c.done++
  }
  return c
}

/** The state pill's word and colour. */
function pillFor(word: Word): Run {
  return pillRun(word, word === 'WAITING' ? C.wait : word === 'WORKING' ? C.live : C.subtle)
}

function budgetCells(t: Timeline, first: number): DeckCell[] {
  const cells: DeckCell[] = []
  const at = (i: number): number => cellCol(first + i)
  if (t.budget?.contextPct !== undefined) cells.push({ col: at(0), runs: meter('CTX', t.budget.contextPct), whole: true })
  const win = (name: string): number | undefined => t.budget?.windows.find(w => w.name === name)?.pct
  const five = win('five_hour')
  const seven = win('seven_day')
  if (five !== undefined) cells.push({ col: at(1), runs: meter('5H', five), whole: true })
  if (seven !== undefined) cells.push({ col: at(2), runs: meter('7D', seven), whole: true })
  return cells
}

const text = (s: string, style: Omit<Run, 'text'> = {}): Run => ({ text: s, ...style })

/** `2 live`, a count in bold and its word dim; the count takes `color` when given. */
const tally = (n: number, word: string, color?: string): Run[] => [text(String(n), { bold: true, ...(color !== undefined ? { color } : {}) }), text(` ${word}`, { dim: true })]

/** The first need's glyph, its tool (dim) and its words. */
function askRuns(p: Problem): Run[] {
  const glyph = p.kind === 'asking' ? '?' : p.kind === 'stalled' ? '▲' : '✖'
  const color = p.kind === 'asking' || p.kind === 'stalled' ? C.wait : C.fail
  if (p.kind !== 'asking') return [text(glyph, { bold: true, color }), text(' '), text(problemText(p), { bold: true })]
  const label = p.label.replace(/\s+/g, ' ').trim()
  const at = label.indexOf(' ')
  const tool = at < 0 ? label : label.slice(0, at)
  const rest = at < 0 ? '' : label.slice(at + 1)
  return [text(glyph, { bold: true, color }), text(' '), text(tool, { dim: true }), ...(rest !== '' ? [text('  '), text(rest, { bold: true })] : [])]
}

// ---------- the rich band: Rasters on the terminal (spec "Band") ----------

/** The band's address for the paint registry. Its Rasters are all still, so the clock never blits it. */
const BAND_SITE = 'mission-control-band'
/** The crew's sprite pitch: a small sprite is 5 wide and a gap makes 6. */
const PITCH = 6
/** The plan strip's most cells. */
const PLAN_MAX = 14
/** From the right edge: where the meters begin (a label, ten beads, the figure, then the pace, `/mc` and the clamp). */
const METERS_FROM_RIGHT = 33

/** A run that stands for an instrument: its text is blank to the instrument's width so every width sum holds. */
type Part = Run & { inst?: InstSpec }
const instPart = (spec: InstSpec): Part => ({ text: ' '.repeat(spec.columns), inst: spec })

/** Beads of one meter as an instrument: `cells` wide, in the rate colour; the text form is `▮▮` a lit bead and `▯▯` an unlit one. */
function beadsInst(key: string, cells: number, pct: number): InstSpec {
  const n = cells >> 1
  const lit = beadCount(pct, n)
  return {
    key,
    columns: cells,
    rows: 1,
    sig: `beads:${cells}:${Math.round(pct)}`,
    frames: () => [beads(cells, pct)],
    fallback: [[{ text: '▮▮'.repeat(lit), color: rateColor(pct) }, { text: '▯▯'.repeat(n - lit), color: C.subtle }]],
  }
}

/** `CTX`, beads of `cells`, the figure: one meter's parts. The figure turns the rate colour from 70 %. */
function beadMeter(label: string, pct: number, key: string, cells: number, gap: number): Part[] {
  const p = Number.isFinite(pct) ? pct : 0
  return [
    { text: label.padEnd(3), dim: true },
    { text: ' ' },
    instPart(beadsInst(key, cells, p)),
    { text: ' '.repeat(gap) },
    { text: `${Math.min(999, Math.max(0, Math.round(p)))}%`, bold: true, ...(p >= 70 ? { color: rateColor(p) } : {}) },
  ]
}

/** A hull and its signal as the small crew's text form: one cell of the pitch. */
function podCell(pod: Pod): Run[] {
  const runs: Run[] = [pod.hull]
  if (pod.signal !== undefined) runs.push(pod.signal)
  const used = runs.reduce((n, r) => n + r.text.length, 0)
  runs.push({ text: ' '.repeat(Math.max(0, PITCH - used)) })
  return runs
}

/** The small crew, the lead first: `slots` sprites 5 by 2 at a pitch of 6; the text form a hull and signal a slot. */
function crewInst(crew: { agent: AgentRow; pod: Pod }[], slots: number): InstSpec {
  const shown = crew.slice(0, slots)
  const columns = slots * PITCH - 1
  return {
    key: 'band-crew',
    columns,
    rows: 2,
    sig: `crew:${columns}:${shown.map(c => `${c.pod.role}.${c.pod.state}`).join(',')}`,
    frames: () => {
      const g = new Grid(columns, SPRITE.S.rows)
      shown.forEach((c, i) => drawSprite(g, i * PITCH, 0, c.pod.role, c.pod.state, 'S', 'on'))
      return [g]
    },
    fallback: [shown.flatMap(c => podCell(c.pod)), []],
  }
}

/** The plan strip: one bar a task (the newest 14), as tall as its tokens, mute when done, iris while it runs, rest when queued. */
function planInst(t: Timeline): InstSpec | undefined {
  const rows = taskMeter(t).rows.slice(-PLAN_MAX)
  if (rows.length === 0) return undefined
  const hueOf = (i: number): Hue | 'mute' | 'rest' => (rows[i]?.task.status === 'completed' ? 'mute' : rows[i]?.task.status === 'in_progress' ? 'iris' : 'rest')
  return {
    key: 'band-plan',
    columns: rows.length,
    rows: 1,
    sig: `plan:${rows.map(r => `${r.task.status[0]}${r.tokens}`).join(',')}`,
    frames: () => [bars(1, rows.map(r => r.tokens), { hueOf })],
    fallback: [
      rows.map((r): Run =>
        r.task.status === 'completed' ? { text: '▪', dim: true } : r.task.status === 'in_progress' ? { text: '▸', color: C.live } : { text: '▫', color: C.subtle },
      ),
    ],
  }
}

/** The clamp at either end of the three rows: `█▀` top left, `▄█` bottom right; the text form `┏` and `┛`. */
function clampInst(key: string, end: boolean, hue: Hue, tone: string): InstSpec {
  return {
    key,
    columns: 2,
    rows: 1,
    sig: `clamp:${end ? 'end' : 'start'}:${hue}`,
    frames: () => {
      const g = new Grid(2, 1)
      if (end) {
        g.px(0, 1, hue)
        g.full(1, 0, hue)
      } else {
        g.full(0, 0, hue)
        g.px(1, 0, hue)
      }
      return [g]
    },
    fallback: [end ? [{ text: ' ' }, { text: '┛', color: tone }] : [{ text: '┏', color: tone }, { text: ' ' }]],
  }
}

/** Runs cut to `room` by word, but left whole when they fit: `fitRuns` would collapse the double spaces that set a label apart. */
const fitKeep = (runs: Run[], room: number): Run[] => (widthOf(runs) <= room ? runs : (fitRuns(runs, room) as Run[]))

type Seg = { col: number; width: number; el: RenderElement }

/** Elements side by side at columns (from the lane's own left edge): blank boxes fill the gaps. */
function lane($: EngineInterface, ctx: ViewCtx, key: string, segs: Seg[]): RenderElement {
  const { Box } = $.ui.resolve(ctx.e)
  const kids: RenderElement[] = []
  let at = 0
  for (const s of [...segs].sort((a, b) => a.col - b.col)) {
    if (s.col > at) kids.push(<Box key={`${key}-gap-${s.col}`} width={s.col - at} flexShrink={0} />)
    kids.push(
      <Box key={`${key}-${s.col}`} width={s.width} flexShrink={0}>
        {s.el}
      </Box>,
    )
    at = s.col + s.width
  }
  return (
    <Box key={key} flexDirection="row">
      {kids}
    </Box>
  )
}

/** Runs as one segment of a lane. */
function textSeg(ctx: ViewCtx, $: EngineInterface, key: string, col: number, runs: Run[]): Seg {
  const { Text } = $.ui.resolve(ctx.e)
  const live = runs.filter(r => r.text !== '')
  return {
    col,
    width: widthOf(live),
    el: <Text key={key} wrap="truncate-end">{live.map((r, i) => runText(r, ctx.e, $, `${key}-${i}`))}</Text>,
  }
}

/** Parts as one segment: the runs between instruments are Texts, an instrument is its own Box. */
function partsSeg(ctx: ViewCtx, $: EngineInterface, key: string, col: number, parts: Part[]): Seg {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const kids: RenderElement[] = []
  let buf: Run[] = []
  const flush = (): void => {
    if (buf.length > 0) {
      const at = kids.length
      kids.push(<Text key={`${key}-t${at}`}>{buf.map((r, i) => runText(r, ctx.e, $, `${key}-t${at}-${i}`))}</Text>)
      buf = []
    }
  }
  for (const p of parts) {
    if (p.text === '') continue
    if (p.inst !== undefined) {
      flush()
      kids.push(inst(ctx, $, p.inst))
    } else buf.push(p)
  }
  flush()
  return {
    col,
    width: widthOf(parts),
    el: (
      <Box key={key} flexDirection="row">
        {kids}
      </Box>
    ),
  }
}

/** What the other needs read in one line: `long run 24m, stalled 4m` (the kind lower-cased, how long it has waited). */
function othersLine(needs: Problem[], now: number): string {
  return needs
    .slice(1)
    .map(p => `${kindLabel(p).toLowerCase()} ${elapsed(p.since, now)}`)
    .join(', ')
}

/** `▲ 37m`: the 5H window will fill before it resets. Nothing when pace has no reading, or the window will not fill in time. */
function paceSeg(ctx: ViewCtx, $: EngineInterface, five: number | undefined, col: number): Seg[] {
  if (five === undefined) return []
  const row = pace(ctx.t, ctx.now).windows.find(w => w.name === 'five_hour')
  if (row === undefined || row.beforeReset !== true) return []
  return [textSeg(ctx, $, 'band-pace', col, [text('▲ ', { bold: true, color: C.wait }), text(elapsed(0, row.fullIn), { bold: true, color: C.wait })])]
}

/**
 * The three rows of the rich band (spec "Band"; from 86 columns, pane
 * closed, terminal only). A clamp and the pill, then the focus and its age
 * (waiting: the first ask and how long it has waited); under it the small
 * crew, the lead first, two rows tall, beside `next` and the plan strip with
 * its count; a bead meter per window at the right (CTX, 5H, 7D, a row each)
 * with `▲ 37m` beside 5H when it will fill before it resets, then `/mc` and
 * the closing clamp. Everything that is a picture is an `inst`, so each has
 * its text form in the same box. The band holds no Button.
 */
function richRows(ctx: ViewCtx, $: EngineInterface, word: Word, needs: Problem[], crew: { agent: AgentRow; pod: Pod }[]): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const { t, now, cols } = ctx
  const s = summary(t)
  const waiting = needs.length > 0
  const hue: Hue = waiting ? 'amber' : 'iris'
  const tone = waiting ? C.wait : C.live
  const mstart = cols - METERS_FROM_RIGHT
  const slots = Math.max(1, Math.min(6, Math.floor((mstart - 35) / PITCH)))
  const crewWidth = slots * PITCH - 1
  const midCol = 3 + crewWidth + 5
  const midRoom = Math.max(1, mstart - 2 - midCol)

  // ---- row 1: clamp, pill, the focus (or the first ask), its age, CTX
  const pill = pillRun(waiting ? `NEEDS YOU ${needs.length}` : word, waiting ? C.wait : word === 'WORKING' ? C.live : C.subtle)
  const head: Seg[] = [{ col: 0, width: 2, el: inst(ctx, $, clampInst('band-clamp', false, hue, tone)) }, textSeg(ctx, $, 'band-pill', 3, [pill])]
  const leadCol = waiting ? 3 + pill.text.length + 2 : 14
  const ageCol = mstart - 6
  if (waiting) {
    const first = needs[0]!
    const ask = fitKeep(askRuns(first), Math.max(1, ageCol - 2 - leadCol))
    head.push(textSeg(ctx, $, 'band-ask', leadCol, ask))
    head.push(textSeg(ctx, $, 'band-age', Math.min(ageCol, leadCol + widthOf(ask) + 2), [text(elapsed(first.since, now), { color: C.wait })]))
  } else {
    if (s.focus !== undefined) head.push(textSeg(ctx, $, 'band-focus', leadCol, fitKeep([text(s.focus, { bold: true })], Math.max(1, ageCol - 2 - leadCol))))
    if (s.focusAt !== undefined) head.push(textSeg(ctx, $, 'band-age', ageCol, [text(elapsed(s.focusAt, now), { dim: true })]))
  }
  const win = (name: string): number | undefined => t.budget?.windows.find(w => w.name === name)?.pct
  const ctxPct = t.budget?.contextPct
  const five = win('five_hour')
  const seven = win('seven_day')
  if (ctxPct !== undefined) head.push(partsSeg(ctx, $, 'band-ctx', mstart, beadMeter('CTX', ctxPct, 'band-ctx-beads', 10, 2)))

  // ---- rows 2 and 3: the crew beside next and the plan, the meters on the right
  const upcoming = s.next ?? s.upcoming?.subject
  const nextRuns: Run[] =
    waiting && needs.length > 1
      ? [text(`+${needs.length - 1} `, { dim: true }), text(othersLine(needs, now), { color: C.wait })]
      : upcoming !== undefined && upcoming !== ''
        ? [text('next', { dim: true }), text('  '), text(upcoming)]
        : []
  const plan = planInst(t)
  const taskParts: Part[] =
    plan !== undefined
      ? [text('TASKS', { dim: true }), text(' '), instPart(plan), text(' '), text(String(s.done), { bold: true }), text(`/${s.total}`, { dim: true })]
      : [text('TASKS', { dim: true }), text(' '), text('no tasks', { dim: true })]
  const mid = (
    <Box key="band-mid" flexDirection="column" width={midRoom} flexShrink={0}>
      {lane($, ctx, 'band-next', nextRuns.length > 0 ? [textSeg(ctx, $, 'band-next-t', 0, fitKeep(nextRuns, midRoom))] : [])}
      {lane($, ctx, 'band-tasks', [partsSeg(ctx, $, 'band-tasks-p', 0, taskParts)])}
    </Box>
  )
  const more = crew.length - slots
  const side = (
    <Box key="band-side" flexDirection="column" width={METERS_FROM_RIGHT} flexShrink={0}>
      {lane($, ctx, 'band-5h', [
        ...(five !== undefined ? [partsSeg(ctx, $, 'band-5h-p', 0, beadMeter('5H', five, 'band-5h-beads', 10, 2))] : []),
        ...paceSeg(ctx, $, five, METERS_FROM_RIGHT - 11),
      ])}
      {lane($, ctx, 'band-7d', [
        ...(seven !== undefined ? [partsSeg(ctx, $, 'band-7d-p', 0, beadMeter('7D', seven, 'band-7d-beads', 10, 2))] : []),
        textSeg(ctx, $, 'band-mc', METERS_FROM_RIGHT - 6, [text(MC, { dim: true })]),
        { col: METERS_FROM_RIGHT - 2, width: 2, el: inst(ctx, $, clampInst('band-end', true, hue, tone)) },
      ])}
    </Box>
  )
  const lower = (
    <Box key="band-lower" flexDirection="row">
      <Box key="band-lead-gap" width={3} flexShrink={0} />
      {inst(ctx, $, crewInst(crew, slots))}
      <Box key="band-more" width={5} flexShrink={0} flexDirection="column">
        {more > 0 ? (
          <Text key="band-more-t" dimColor>
            {` +${more}`}
          </Text>
        ) : null}
      </Box>
      {mid}
      <Box key="band-mid-gap" width={2} flexShrink={0} />
      {side}
    </Box>
  )
  return (
    <Box key="band" flexDirection="column">
      {lane($, ctx, 'band-head', head)}
      {lower}
    </Box>
  )
}

/** The three rows (spec "Band"), at 86 columns or more while the pane is closed: the Neo text form, drawn where there is no Raster. */
function threeRows(ctx: ViewCtx, $: EngineInterface, word: Word, needs: Problem[], crew: { agent: AgentRow; pod: Pod }[]): RenderElement | null {
  const { t, now } = ctx
  const s = summary(t)
  const waiting = needs.length > 0
  const counts = countsOf(crew)
  const pods = crewRow(crew.map(c => c.pod), BAND_PODS)
  // `/mc` sits on the last whole cell of the last row.
  let last = 0
  while (cellCol(last + 1) + MC.length <= ctx.cols - 2) last++
  const mc: DeckCell = { col: cellCol(last), runs: [text(MC, { dim: true })], whole: true }

  const head: DeckRow = {
    label: [pillFor(word)],
    cells: [
      ...(s.focus !== undefined ? [{ col: cellCol(1), runs: [text(s.focus, { bold: true })] }] : []),
      ...(s.focusAt !== undefined ? [{ col: cellCol(4), runs: [text(elapsed(s.focusAt, now), { dim: true })], whole: true }] : []),
      ...budgetCells(t, 6),
    ],
  }

  const crewCells: DeckCell[] = [{ col: cellCol(1), runs: pods, whole: true }]
  const tallies: Run[][] = [
    tally(counts.live, 'live'),
    ...(counts.stalled > 0 ? [tally(counts.stalled, 'stalled', C.wait)] : []),
    ...(counts.failed > 0 ? [tally(counts.failed, 'failed', C.fail)] : []),
    ...(counts.done > 0 ? [[text(`${counts.done} done`, { dim: true })]] : []),
  ]
  tallies.forEach((runs, i) => crewCells.push({ col: cellCol(4 + i), runs, whole: true }))

  if (waiting) {
    const first = needs[0]!
    const why = first.kind === 'asking' ? 'permission' : first.kind === 'stalled' ? 'stalled' : first.kind === 'failed-turn' ? 'failed' : first.kind === 'repeat' ? 'repeated' : first.kind === 'long-run' ? kindLabel(first).toLowerCase() : 'looping'
    const asks: DeckRow = {
      label: [text(first.kind === 'asking' ? 'ASKS' : 'NEEDS', { bold: true, color: C.wait })],
      cells: [
        { col: cellCol(1), runs: askRuns(first) },
        { col: cellCol(4), runs: [text(why, { color: C.wait })], whole: true },
        { col: cellCol(5), runs: [text(elapsed(first.since, now), { color: C.wait })], whole: true },
        ...(needs.length > 1 ? [{ col: cellCol(6), runs: [text(`+ ${needs.length - 1} more`, { dim: true })], whole: true }] : []),
      ],
    }
    return deck(ctx, $, [head, asks, { label: 'CREW', cells: [...crewCells, mc] }], { key: 'band', tone: 'warning' })
  }

  const open = t.tasks.filter(x => x.status === 'in_progress').length
  const upcoming = s.next ?? s.upcoming?.subject
  const tasks: DeckRow = {
    label: 'TASKS',
    cells: [
      s.total > 0
        ? { col: cellCol(1), runs: pips(s.done, s.total, 22, open), narrow: bar(s.done, s.total, 10, C.live), whole: true }
        : { col: cellCol(1), runs: [text('no tasks', { dim: true })] },
      ...(s.total > 0 ? [{ col: cellCol(3), runs: [text(String(s.done), { bold: true }), text(`/${s.total}`, { dim: true })], whole: true }] : []),
      ...(upcoming !== undefined && upcoming !== '' ? [{ col: cellCol(4), runs: [text('next', { dim: true })], whole: true }, { col: cellCol(5), runs: upcoming }] : []),
      mc,
    ],
  }
  return deck(ctx, $, [head, { label: 'CREW', cells: crewCells }, tasks], { key: 'band' })
}

/** One side of a one-row band that can give way: `id` names it in a drop order. */
type Piece = { id: string; runs: Part[]; gap: number }

/** What the row shows at one stage of giving way: the cut-able middle and the right side. */
type Variant = { flex: Run[]; right: Piece[] }

const piecesWidth = (right: Piece[]): number => right.reduce((n, p) => n + p.gap + widthOf(p.runs), 0)

/**
 * A one-row band: the bracket folded to its two rails (`┃ … ┃`), `lead` (the
 * pill), a middle that may be cut, and a right side. The first variant that
 * fits whole is drawn. When none does, the last one is drawn with its middle
 * cut at a word; if that leaves under MIN_FOCUS, the right side gives up its
 * last pieces (the count, then the crew) first.
 */
function foldedRow(ctx: ViewCtx, $: EngineInterface, tone: string, lead: Run[], variants: Variant[], fallback: string): RenderElement {
  const { cols } = ctx
  const { Text } = $.ui.resolve(ctx.e)
  const fixed = 2 + widthOf(lead) + 2 // `┃ `, the lead, ` ┃`
  const midGap = (flex: Run[]): number => (flex.length > 0 ? 2 : 0)
  const fits = (v: Variant): boolean => fixed + midGap(v.flex) + widthOf(v.flex) + (v.right.length > 0 ? MIN_GAP + piecesWidth(v.right) : 0) <= cols

  let chosen = variants.find(fits)
  if (chosen === undefined) {
    const lastV = variants[variants.length - 1]!
    const right = [...lastV.right]
    const roomFor = (): number => cols - fixed - 2 - (right.length > 0 ? MIN_GAP + piecesWidth(right) : 0)
    while (right.length > 0 && roomFor() < Math.min(MIN_FOCUS, widthOf(lastV.flex))) right.pop()
    const room = roomFor()
    const flex = room > 0 ? (fitRuns(lastV.flex, room) as Run[]) : []
    chosen = { flex: widthOf(flex) > 0 ? flex : [], right }
  }

  const used = fixed + midGap(chosen.flex) + widthOf(chosen.flex) + piecesWidth(chosen.right)
  if (used > cols) {
    // Not even the pill fits beside the rails: a plain cut of the one word.
    return <Text wrap="truncate-end" color={tone}>{wordFit(fallback, Math.max(1, cols))}</Text>
  }
  const runs: Part[] = [
    text('┃', { color: tone }),
    text(' '),
    ...lead,
    ...(chosen.flex.length > 0 ? [spaces(2), ...chosen.flex] : []),
    spaces(cols - used),
    ...chosen.right.flatMap(p => [...(p.gap > 0 ? [spaces(p.gap)] : []), ...p.runs]),
    text(' '),
    text('┃', { color: tone }),
  ]
  const live = runs.filter(r => r.text !== '')
  if (live.some(r => r.inst !== undefined)) {
    // An instrument in the row: Texts between, each instrument a Box of its own.
    return partsSeg(ctx, $, 'band-row', 0, live).el
  }
  return (
    <Text wrap="truncate-end">
      {live.map((r, i) => runText(r, ctx.e, $, `band-${i}`))}
    </Text>
  )
}

/** The compact row: pill, focus (or the first need), tight crew, done/total, the CTX dial, `/mc`. */
function compactRow(ctx: ViewCtx, $: EngineInterface, word: Word, needs: Problem[], crew: { agent: AgentRow; pod: Pod }[]): RenderElement {
  const { t } = ctx
  const s = summary(t)
  const waiting = needs.length > 0
  const tone = waiting ? C.wait : C.live
  const flex: Run[] = waiting
    ? [text(`${needs.length} need you`, { bold: true, color: C.wait }), ...(askLine(needs[0]!).length > 0 ? [text('  '), ...askLine(needs[0]!)] : [])]
    : s.focus !== undefined ? [text(s.focus, { bold: true })] : []
  const count: Piece[] = s.total > 0 ? [{ id: 'count', runs: [text(String(s.done), { bold: true }), text(`/${s.total}`, { dim: true })], gap: 3 }] : []
  const tight = crewRow(crew.map(c => c.pod), 12, { tight: true })
  const crewPiece: Piece[] = tight.length > 0 ? [{ id: 'crew', runs: tight, gap: 0 }] : []
  // Rich: beads in place of the dial, the Raster's text form being `▮▮` and `▯▯`.
  const dialRuns = (pct: number): Part[] => (ctx.look === 'rich' ? beadMeter('CTX', pct, 'band-ctx-beads', 8, 1) : meter('CTX', pct))
  const dial: Piece[] = t.budget?.contextPct !== undefined ? [{ id: 'dial', runs: dialRuns(t.budget.contextPct), gap: 3 }] : []
  const mc: Piece = { id: 'mc', runs: [text(MC, { dim: true })], gap: 3 }
  const right = (...parts: Piece[][]): Piece[] => parts.flat().map((p, i) => (i === 0 ? { ...p, gap: 0 } : p))
  const variants: Variant[] = [
    { flex, right: right(crewPiece, count, dial, [mc]) },
    { flex, right: right(crewPiece, count, [mc]) },
    { flex, right: right(crewPiece, count) },
  ]
  return foldedRow(ctx, $, tone, [pillFor(word)], variants, `┃ ${word}`)
}

/** The tool (dim) and words of a need as plain runs for the one-row form. */
function askLine(p: Problem): Run[] {
  if (p.kind !== 'asking') return [text(problemText(p), { dim: true })]
  const label = p.label.replace(/\s+/g, ' ').trim()
  const at = label.indexOf(' ')
  if (at < 0) return [text(label, { dim: true })]
  return [text(label.slice(0, at), { dim: true }), text(' '), text(label.slice(at + 1))]
}

/** The all-done row: one dim row, totals, every hull solid, `/mc`. */
function doneRow(ctx: ViewCtx, $: EngineInterface, crew: { agent: AgentRow; pod: Pod }[]): RenderElement {
  const { t } = ctx
  const s = summary(t)
  const starts = [...t.turns.map(x => x.startedAt), ...t.steps.map(x => x.startedAt)]
  const ends = [...t.turns.map(x => x.endedAt ?? x.startedAt), ...t.steps.map(x => x.endedAt ?? x.startedAt), ...(t.now !== undefined ? [t.now.at] : [])]
  const from = Math.min(...starts)
  const to = Math.max(...ends, ...starts)
  const span = starts.length > 0 && to - from >= 1000 ? elapsed(from, to) : undefined
  // THIS TURN (spec "Band", all done): how long the last turn took, the agents it finished, its errors and files.
  const turn = thisTurn(t)
  const n = (k: number, one: string, many: string): string => `${k} ${k === 1 ? one : many}`
  const facts =
    turn !== undefined
      ? [
          `${s.done}/${s.total} tasks`,
          ...(turn.ms !== undefined ? [`done in ${elapsed(0, turn.ms)}`] : []),
          n(turn.agentsFinished.length, 'agent', 'agents'),
          n(turn.errors, 'error', 'errors'),
          n(turn.files, 'file', 'files'),
        ]
      : [
          `${s.done}/${s.total} tasks`,
          ...(s.steps > 0 ? [`${s.steps} ${s.steps === 1 ? 'step' : 'steps'}`] : []),
          ...(t.artifacts.length > 0 ? [`${t.artifacts.length} ${t.artifacts.length === 1 ? 'artifact' : 'artifacts'}`] : []),
          ...(span !== undefined ? [span] : []),
        ]
  const flexOf = (n: number): Run[] => [text(facts.slice(0, n).join('   '), { dim: true })]
  const tight = crewRow(crew.map(c => c.pod), 12, { tight: true })
  const crewPiece: Piece[] = tight.length > 0 ? [{ id: 'crew', runs: tight, gap: 0 }] : []
  const mc: Piece = { id: 'mc', runs: [text(MC, { dim: true })], gap: crewPiece.length > 0 ? 3 : 0 }
  const variants: Variant[] = []
  for (let n = facts.length; n >= 1; n--) variants.push({ flex: flexOf(n), right: [...crewPiece, mc] })
  variants.push({ flex: flexOf(1), right: [...crewPiece] })
  return foldedRow(ctx, $, C.subtle, [pillFor('ALL DONE')], variants, '┃ ALL DONE')
}

/**
 * The row above the prompt (spec "Band"). While the pane is closed and the band
 * has 86 columns or more it is three rows: state pill, focus and the budget
 * dials; the crew; the tasks (waiting: ASKS, then the crew). Otherwise, whenever
 * the pane is open or the band is narrower, it is one compact row that drops
 * the CTX dial, then `/mc`, then cuts the focus at a word. All done is one dim
 * row. The band holds no Button: nothing lives only here.
 *
 * While `ui.strip` (`/mc strip`) the band draws the strip in place of the
 * pane: overview.tsx's strip halves over the compact row (or the all-done
 * row), even when there is nothing to say. Its rows are plain Buttons with
 * no hotkey; a press opens the pane on what it names and ends the strip.
 */
export function registerBand(on: On, options: { look?: string } = {}): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    try {
      const t = await readTimeline($)
      const u: UiState = await readUi($)
      const now = await $.clock.now()
      const s = summary(t)
      const needs = needsYou(t, u, now)
      const live = s.running.length
      const isStrip = u.strip === true
      if (!isStrip && needs.length === 0 && s.total === 0 && live === 0 && !s.focus) return next(e)

      const cols = e.props.bodyColumns
      // The look comes from the surface's element table, once per draw; the Rasters here are all still, so none is ever blitted.
      begin(BAND_SITE)
      const look = lookFor($.ui.resolve(e), e.surface, options)
      const ctx: ViewCtx = { e: e as RenderInput, t, u, cols, now, look, site: BAND_SITE }
      // The desktop app draws the band as one Svg; /mc strip keeps its own rows.
      if (!isStrip) {
        const svg = bandSvgOf($, { e: e as RenderInput, look, t, u, now, cols })
        if (svg !== null) return svg
      }
      const allDone = needs.length === 0 && s.total > 0 && s.done === s.total && live === 0
      // The pods and the pill answer to the same rule: `waitStates` is built on `needsYou`.
      const crew = podsOf(t, waitStates(t, u, now), now, allDone)
      const word: Word = needs.length > 0 ? 'WAITING' : live > 0 || e.props.isWorking || t.steps.some(x => x.status === 'running') ? 'WORKING' : 'IDLE'
      if (isStrip) {
        const line = allDone ? doneRow(ctx, $, crew) : compactRow(ctx, $, word, needs, crew)
        return stripBandView(ctx, $, { maxRows: e.props.maxRows, line, after: () => leaveStrip($) })
      }
      if (allDone) return doneRow(ctx, $, crew)

      const compact = u.paneOpen === true || cols < THREE_ROWS_FROM || e.props.maxRows < 3
      if (!compact) {
        if (look === 'rich') return richRows(ctx, $, word, needs, crew)
        const rows = threeRows(ctx, $, word, needs, crew)
        if (rows !== null) return rows
      }
      return compactRow(ctx, $, word, needs, crew)
    } catch (err) {
      debug($, `band failed: ${errText(err)}`)
      return next(e)
    }
  })
}
