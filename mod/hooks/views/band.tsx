import type { EngineInterface, On, RenderElement, RenderInput } from 'claude-code'

import type { AgentRow, Timeline, UiState } from '../../types'
import { problems, summary } from '../model/select'
import type { Problem } from '../model/select'
import { debug, errText, readTimeline, readUi } from '../state'
import { bar, crewRow, elapsed, fit, fitRuns, meter, pillRun, pips } from './fit'
import { ASK_MS, needsYou, problemText } from './needs'
import { deck, runText } from './parts'
import type { DeckCell, DeckRow } from './parts'
import type { ViewCtx } from './shell'
import { C, cellCol, podOf } from './style'
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
function podsOf(t: Timeline, needs: Problem[], now: number, settled: boolean): { agent: AgentRow; pod: Pod }[] {
  const list = Object.values(t.agents)
  const main = list.filter(a => a.id === 'main')
  const rest = list.filter(a => a.id !== 'main').sort((a, b) => a.startedAt - b.startedAt)
  return [...main, ...rest].map(agent => {
    const asked = needs.some(p => p.kind === 'asking' && p.agent === agent.id)
    const stalled = needs.some(p => p.kind === 'stalled' && p.agent === agent.id)
    // A finished session leaves `main` running for good: all done draws it solid.
    const status = settled && agent.id === 'main' ? 'done' : agent.status
    const state: PodState | undefined = asked ? 'waiting' : stalled ? 'stalled' : undefined
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

/** The three rows (spec "Band"), at 86 columns or more while the pane is closed. */
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
    const why = first.kind === 'asking' ? 'permission' : first.kind === 'stalled' ? 'stalled' : first.kind === 'failed-turn' ? 'failed' : first.kind === 'repeat' ? 'repeated' : 'looping'
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
type Piece = { id: string; runs: Run[]; gap: number }

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
    return <Text wrap="truncate-end" color={tone}>{fit(fallback, Math.max(1, cols))}</Text>
  }
  const runs: Run[] = [
    text('┃', { color: tone }),
    text(' '),
    ...lead,
    ...(chosen.flex.length > 0 ? [spaces(2), ...chosen.flex] : []),
    spaces(cols - used),
    ...chosen.right.flatMap(p => [...(p.gap > 0 ? [spaces(p.gap)] : []), ...p.runs]),
    text(' '),
    text('┃', { color: tone }),
  ]
  return (
    <Text wrap="truncate-end">
      {runs.filter(r => r.text !== '').map((r, i) => runText(r, ctx.e, $, `band-${i}`))}
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
  const dial: Piece[] = t.budget?.contextPct !== undefined ? [{ id: 'dial', runs: meter('CTX', t.budget.contextPct), gap: 3 }] : []
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
  const facts = [
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
 */
export function registerBand(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    try {
      const t = await readTimeline($)
      const u: UiState = await readUi($)
      const now = await $.clock.now()
      const s = summary(t)
      const needs = needsYou(t, u, now)
      const live = s.running.length
      if (needs.length === 0 && s.total === 0 && live === 0 && !s.focus) return next(e)

      const cols = e.props.bodyColumns
      const ctx: ViewCtx = { e: e as RenderInput, t, u, cols, now }
      const allDone = needs.length === 0 && s.total > 0 && s.done === s.total && live === 0
      // The asks the pods show are the unfiltered problems: a dismissed one is still waiting.
      const crew = podsOf(t, problems(t, now, []).filter(p => p.kind !== 'asking' || now - p.since >= ASK_MS), now, allDone)
      if (allDone) return doneRow(ctx, $, crew)

      const word: Word = needs.length > 0 ? 'WAITING' : live > 0 || e.props.isWorking || t.steps.some(x => x.status === 'running') ? 'WORKING' : 'IDLE'
      const compact = u.paneOpen === true || cols < THREE_ROWS_FROM || e.props.maxRows < 3
      if (!compact) {
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
