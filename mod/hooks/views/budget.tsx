import type { EngineInterface, RenderElement } from 'claude-code'

import type { Budget, BudgetWindow, LedgerRow, Timeline } from '../../types'
import { stamp } from '../model/digest'
import { ledgerCsv, week } from '../model/ledger'
import type { LedgerDay } from '../model/ledger'
import { cacheLine, pace, turnShare } from '../model/meter'
import type { Pace, PaceRow } from '../model/meter'
import { budgetOf } from '../model/usage'
import { journalRoot } from '../journal'
import { apply, debug, errText, leaveDetail, readLedgerRows, readTimeline, readUi, updateUi } from '../state'
import { openAgentPage } from './agentmeta'
import { clock, growLists, listSplit, pctBar, ruleBar, shortPaths, span, warmWords, wordFit, fitRuns } from './fit'
import { podFor, waitStates } from './needs'
import { blank, frameFootInst, frameTopInst, heightOf, inst, more, runText, section } from './parts'
import type { InstSpec, Run } from './parts'
import { drawGaugeRing, GAUGE_RING, gaugeFigure, getCellAspect, Grid } from './raster'
import type { Ground } from './raster'
import { TAB_ROWS } from './shell'
import type { ViewCtx } from './shell'
import { accentName, C, CK, edges, gaugeStyle, critterGlyph, palette } from './style'

/** A budget older than this is a restored one: it was toasted (or not) when it arrived. */
const FRESH_MS = 30_000
const CONTEXT_TOAST = 80
const WINDOW_FROM = 70
const WINDOW_STEP = 10

/** `claude-sonnet-5-5` as `sonnet`; an unknown id loses only its `claude-` prefix. */
export function modelName(id: string): string {
  const bare = id.replace(/^claude-/, '')
  const family = /^(opus|sonnet|haiku)\b/.exec(bare)
  return family?.[1] ?? bare
}

/** A token count in a few characters: 950, 1.2k, 5k, 41k, 1.3M (a trailing `.0` is dropped: 5k, never 5.0k). */
export function tokenText(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)))
  if (n < 10_000) {
    const v = (n / 1000).toFixed(1)
    if (v !== '10.0') return `${v.replace(/\.0$/, '')}k`
  }
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** A window's kind as a short label: `five_hour` is `5h`, `seven_day` is `7d`; others lose their underscores. */
export function windowName(name: string): string {
  if (name === 'five_hour') return '5h'
  if (name === 'seven_day') return '7d'
  return name.replace(/_/g, ' ')
}

/** `resets in 2 h 4 min` (R27, M3), from the reset time and now (both ms). */
export function resetText(at: number, now: number): string {
  return at <= now ? 'resets now' : `resets in ${span(at - now)}`
}

const dollars = (usd: number): string => `$${usd.toFixed(2)}`
const percent = (pct: number): string => `${Math.round(pct)}%`

/** One total per model, biggest first, over every agent that reported both a model and tokens. */
export function modelTotals(t: Timeline): { model: string; tokens: number; agents: number }[] {
  const by = new Map<string, { model: string; tokens: number; agents: number }>()
  for (const a of Object.values(t.agents)) {
    if (a.model === undefined || (a.tokensIn === undefined && a.tokensOut === undefined)) continue
    const model = modelName(a.model)
    const row = by.get(model) ?? { model, tokens: 0, agents: 0 }
    row.tokens += (a.tokensIn ?? 0) + (a.tokensOut ?? 0)
    row.agents += 1
    by.set(model, row)
  }
  return [...by.values()].sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model))
}

// ---------- the Now BUDGET row and the budget view ----------

// Whether Now shows the budget view in place of its sections. Ephemeral pane
// state like onscreen.ts's: a render hook may not write `$.state`, and a
// reload starting it closed loses nothing.
let budgetOpen = false

/** Whether the budget view replaces Now's sections. */
export function isBudgetOpen(): boolean {
  return budgetOpen
}

/** Opens or closes the budget view, and redraws the pane. Press handlers only. */
export function setBudgetOpen($: EngineInterface, open: boolean): void {
  budgetOpen = open
  if (open) void loadLedger($)
  try {
    $.ui.invalidate('ui.render')
  } catch (err) {
    debug($, `invalidate failed: ${errText(err)}`)
  }
}

const DAY = 86_400_000
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * When a window resets, short enough for the aside cell: the time of day
 * inside the next 24 hours (`15:40`), the weekday and time beyond it
 * (`Thu 09:00`), `now` once it has passed.
 */
export function resetClock(at: number, now: number): string {
  if (at <= now) return 'now'
  if (at - now < DAY) return clock(at)
  return `${WEEKDAYS[new Date(at).getDay()] ?? ''} ${clock(at)}`
}

const MAX_LIST = 4
// What the lists share a pane with: the two table heads and their gaps, the week block and the footer.
const FIXED_ROWS = 4 + 6 + 2

/**
 * Binding rule 2 in the budget view: how many Models and Agents rows show in
 * the rows the header, Windows and Cache leave (`above` rows), each at least
 * MAX_LIST. Answers the items each lists before its more line.
 */
function shareCaps(ctx: ViewCtx, above: number, models: number, agents: number): { models: number; agents: number } {
  const grown = growLists((ctx.bodyRows ?? 40) - TAB_ROWS - above - FIXED_ROWS, [
    { key: 'models', count: models, least: MAX_LIST },
    { key: 'agents', count: agents, least: MAX_LIST },
  ])
  return { models: listSplit(models, grown.get('models') ?? 0).shown, agents: listSplit(agents, grown.get('agents') ?? 0).shown }
}

/** One row of a share table: an optional state glyph, a name, the tokens, a `━` bar of its share. */
type Share = { key: string; glyph?: Run; name: string; tokens: number; color: string; dim?: boolean; onPress?: () => void | Promise<void> }

const runsWidth = (runs: Run[]): number => runs.reduce((n, r) => n + r.text.length, 0)

/** The runs cut to `width` characters, a cut one ending in `…`. */
function cutRuns(runs: Run[], width: number): Run[] {
  const out: Run[] = []
  let used = 0
  for (const r of runs) {
    if (r.text === '') continue
    if (used + r.text.length <= width) {
      out.push(r)
      used += r.text.length
      continue
    }
    const room = width - used
    if (room > 1) out.push({ ...r, text: r.text.slice(0, room - 1) + '…' })
    else if (room === 1) out.push({ ...r, text: '…' })
    break
  }
  return out
}

/** The runs as one Text row from column `left` (the content margin), cut at the pane's right edge. */
function textRow(ctx: ViewCtx, $: EngineInterface, key: string, runs: Run[], left = edges(ctx.cols).left): RenderElement {
  const { Text } = $.ui.resolve(ctx.e)
  const { right } = edges(ctx.cols)
  return (
    <Text key={key} wrap="truncate-end">
      {' '.repeat(left)}
      {cutRuns(runs, Math.max(1, right + 1 - left)).map((r, i) => runText(r, ctx.e, $, `${key}-${i}`))}
    </Text>
  )
}

/**
 * `name   tokens  ━━━━━━━━━━`: the name from column 2, the tokens, then a
 * 10-cell share bar ending at 59 (R26: tokens end at 49 at 62 columns). From
 * 50 to 61 columns the bar is 6 cells; under 50 there is none.
 */
function shareRow(ctx: ViewCtx, $: EngineInterface, x: Share, total: number): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { left, right } = edges(ctx.cols)
  const content = right - left + 1
  const barW = ctx.cols >= 62 ? 10 : ctx.cols >= 50 ? 6 : 0
  const tokW = 5
  const nameRoom = Math.max(1, content - (barW > 0 ? barW + 2 : 0) - (tokW + 1) - (x.glyph !== undefined ? 2 : 0))
  const dim = x.dim === true ? { dim: true } : {}
  const share = total > 0 ? (x.tokens / total) * 100 : 0
  const runs: Run[] = [
    ...(x.glyph !== undefined ? [x.glyph, { text: ' ' }] : []),
    { text: wordFit(x.name, nameRoom).padEnd(nameRoom), ...dim },
    { text: ` ${tokenText(x.tokens).padStart(tokW)}`, dim: true },
    ...(barW > 0 ? [{ text: '  ' }, ...pctBar(barW, share, x.color)] : []),
  ]
  const body = runs.filter(r => r.text !== '').map((r, i) => runText(r, ctx.e, $, `${x.key}-${i}`))
  return (
    <Box key={`row-${x.key}`} flexDirection="row">
      <Text>{' '.repeat(left)}</Text>
      {x.onPress !== undefined ? (
        <Button key={x.key} plain onPress={x.onPress}>
          {body}
        </Button>
      ) : (
        <Text key={x.key} wrap="truncate-end">
          {body}
        </Text>
      )}
    </Box>
  )
}

/** A window the view draws: its ring, its word, when it resets (or the context's tokens). */
type Win = { key: string; word: string; pct: number; reset?: number; tokens?: number }

/** The windows the reading has, in the order of the rings: context, 5 hours, this week, others after. */
function windowsOf(b: Budget | undefined): Win[] {
  if (b === undefined) return []
  const out: Win[] = []
  if (b.contextPct !== undefined) out.push({ key: 'context', word: 'context', pct: b.contextPct, ...(b.contextTokens !== undefined ? { tokens: b.contextTokens } : {}) })
  const name = (k: string): string => (k === 'five_hour' ? '5 hours' : k === 'seven_day' ? 'this week' : windowName(k))
  const order = (k: string): number => (k === 'five_hour' ? 0 : k === 'seven_day' ? 1 : 2)
  for (const w of [...b.windows].sort((x, y) => order(x.name) - order(y.name))) {
    out.push({ key: w.name, word: name(w.name), pct: w.pct, ...(w.resetsAt !== undefined ? { reset: w.resetsAt } : {}) })
  }
  return out
}

/** The most rings the view draws: context, 5 hours, this week. */
const RINGS = 3
const RING_PITCH = GAUGE_RING.columns + 2

/**
 * The view's rings as one instrument: up to three 9 x 5 rings, 2 columns
 * apart (31 x 5), the figure in each middle row. As text (R22) the figure
 * alone, centred; the words go under it as Text either way.
 */
function ringsInst(key: string, wins: readonly Win[], ground: Ground): InstSpec {
  const shown = wins.slice(0, RINGS)
  const columns = shown.length * RING_PITCH - 2
  const mid: Run[] = []
  shown.forEach((w, i) => {
    const s = gaugeFigure(w.pct)
    const at = i * RING_PITCH + Math.floor((GAUGE_RING.columns - s.length) / 2)
    mid.push({ text: ' '.repeat(Math.max(0, at - runsWidth(mid))) }, { text: s, ...figureOf(w.pct) })
  })
  const blankRow: Run[] = [{ text: ' '.repeat(columns) }]
  return {
    key,
    columns,
    rows: GAUGE_RING.rows,
    sig: `rings:${ground}:${accentName()}:${getCellAspect()}:${shown.map(w => Math.round(w.pct)).join(',')}`,
    frames: () => {
      const g = new Grid(columns, GAUGE_RING.rows, palette(ground))
      shown.forEach((w, i) => drawGaugeRing(g, i * RING_PITCH, 0, w.pct))
      return [g]
    },
    fallback: [blankRow, blankRow, mid, blankRow, blankRow],
  }
}

/** A figure's style under a ring or beside a bar: ink, bold from 70 %, red from 90 % (R9; never amber). */
const figureOf = (pct: number): Omit<Run, 'text'> => (pct >= 90 ? { color: CK.fail } : pct >= 70 ? { bold: true } : {})

/** The `━` bar of a percentage: the accent under 70 %, bold ink from 70, red from 90; the rest `subtle`. */
function gaugeBar(cells: number, pct: number): Run[] {
  const n = Math.max(0, cells)
  const lit = pct > 0 ? Math.max(1, Math.min(n, Math.round((n * Math.min(100, pct)) / 100))) : 0
  const style: Omit<Run, 'text'> = pct >= 90 ? { color: CK.fail } : pct >= 70 ? { bold: true } : { color: CK.accent }
  return [
    { text: '━'.repeat(lit), ...style },
    { text: '━'.repeat(n - lit), color: C.subtle },
  ].filter(r => r.text !== '')
}

/**
 * The budget view (cockpit spec: the rich spec's content in the cockpit's
 * palette, section head and plain words; replaces the Neo deck). Top to
 * bottom: the header (lintel, a `BUDGET` pill that goes back, the three rings
 * of context, 5 hours and this week at 9 x 5 with their words under them, the
 * context figure beside them, sill), then Windows (per window: when it resets,
 * points per 10 min, when it fills; and the output rate), Cache (a `━` stack,
 * what it read, wrote and sent fresh, how long it stays warm, what going cold
 * re-sends), Cost (only with `showCost`), Models and Agents (tokens and a
 * share bar; an agent row opens that agent) and This week (the ledger).
 * Gauge figures are ink, bold from 70 % and red from 90 % (R9).
 *
 * Under 35 columns the rings give way to a word, a figure and a `━` bar per
 * window; in slim (under 32) a `b: back` row leads and there is no frame.
 */
export function budgetView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box } = $.ui.resolve(ctx.e)
  const { t, now } = ctx
  const wins = windowsOf(t.budget)
  const out: RenderElement[] = [budgetHeader(ctx, $, wins), ...paceBlock(ctx, $, wins), ...cacheBlock(ctx, $), ...costBlock(ctx, $)]
  const above = out.reduce((n, el) => n + heightOf(el), 0)

  const totals = modelTotals(t)
  const reportedCount = Object.values(t.agents).filter(a => a.tokensIn !== undefined || a.tokensOut !== undefined).length
  const caps = shareCaps(ctx, above, totals.length, reportedCount)
  if (totals.length > 0) {
    const all = totals.reduce((n, x) => n + x.tokens, 0)
    const items: Share[] = totals.slice(0, caps.models).map(x => ({ key: `model-${x.model}`, name: x.model, tokens: x.tokens, color: CK.accent }))
    out.push(
      blank(ctx, $, 'budget-gap-1'),
      section(ctx, $, 'Models', `${tokenText(all)} tokens`, { key: 'sec-models' }),
      ...items.map(x => shareRow(ctx, $, x, all)),
      ...(totals.length > items.length ? [more(ctx, $, totals.length - items.length, 'more models')] : []),
    )
  }
  const waits = waitStates(ctx)
  const reported = Object.values(t.agents)
    .filter(a => a.tokensIn !== undefined || a.tokensOut !== undefined)
    .map(a => ({ a, tokens: (a.tokensIn ?? 0) + (a.tokensOut ?? 0) }))
    .sort((x, y) => y.tokens - x.tokens || x.a.id.localeCompare(y.a.id))
  if (reported.length > 0) {
    const all = reported.reduce((n, x) => n + x.tokens, 0)
    const items: Share[] = reported.slice(0, caps.agents).map(({ a, tokens }) => {
      const state = podFor(a, waits, now).state
      const id = a.id
      return {
        key: `budget-agent-${id}`,
        glyph: critterGlyph(state).glyph,
        name: id === 'main' ? 'main' : shortPaths(a.description || a.type),
        tokens,
        color: CK.accent,
        ...(state === 'done' || state === 'queued' ? { dim: true } : {}),
        ...(id !== 'main' ? { onPress: () => openAgentPage($, id, `budget-agent-${id}`) } : {}),
      }
    })
    out.push(
      blank(ctx, $, 'budget-gap-2'),
      section(ctx, $, 'Agents', `${reported.length} ${reported.length === 1 ? 'agent' : 'agents'}`, { key: 'sec-agents' }),
      ...items.map(x => shareRow(ctx, $, x, all)),
      ...(reported.length > items.length ? [more(ctx, $, reported.length - items.length, 'more agents')] : []),
    )
    const low = cacheLine(t).byAgent.find(x => x.readShare < 0.3 && x.read + x.write + x.fresh >= 10_000 && x.id !== 'main')
    if (low !== undefined) {
      const a = t.agents[low.id]
      out.push(textRow(ctx, $, 'budget-cache-low', [{ text: wordFit(`${shortPaths(a?.description || low.type)} reads only ${Math.round(low.readShare * 100)}% from cache`, Math.max(1, ctx.cols - 6)), dim: true }]))
    }
  }
  out.push(...weekBlock(ctx, $))
  return <Box flexDirection="column">{out}</Box>
}

/** The pill: ` BUDGET ` on the accent, as Now's pill is. */
// The head row's word: plain bold text, since a pill is for a state only (O M8).
const BUDGET_PILL: Run = { text: 'Budget', bold: true }

/**
 * The header: lintel, the pill row (one plain Button, `budget-back`: a press
 * goes back), the rings with the context figure to their left, the words
 * under the rings, sill. Under 35 columns see `narrowHeader`.
 */
function budgetHeader(ctx: ViewCtx, $: EngineInterface, wins: Win[]): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { t, cols } = ctx
  const b = t.budget
  const back = (): void => setBudgetOpen($, false)
  if (cols < 35) return narrowHeader(ctx, $, wins, back)
  const { left, right } = edges(cols)
  const ground = ctx.ground ?? 'night'
  const shown = wins.slice(0, RINGS)
  const ringsW = Math.max(0, shown.length * RING_PITCH - 2)
  // From 62 columns the rings sit flush right (29, 40 and 51 at 62, as Now's two), the figure in the room on the left; narrower they start at the margin.
  const ringsAt = cols >= 62 ? right + 1 - ringsW : left
  const side = cols >= 62 ? ringsAt - left - 2 : 0
  // M6: the words after the pill go when they do not fit inside the body.
  const metaWords = b !== undefined ? 'what this session has used' : 'no reading yet'
  const meta: Run = { text: left + BUDGET_PILL.text.length + 2 + metaWords.length <= cols ? metaWords : '', dim: true }
  const pillRow = (
    <Box key="budget-pill-row" flexDirection="row">
      <Text>{' '.repeat(left)}</Text>
      <Button key="budget-back" plain onPress={back}>
        {[BUDGET_PILL, ...(meta.text !== '' ? [{ text: '  ' }, meta] : [])].map((r, i) => runText(r, ctx.e, $, `budget-pill-${i}`))}
      </Button>
    </Box>
  )
  // The figure beside the rings: tokens against the window, else the context's share.
  const size = contextSize(b)
  const figure: Run[] =
    b?.contextTokens !== undefined && size !== undefined
      ? [{ text: `${tokenText(b.contextTokens)} of ${sizeText(size)}`, bold: true }]
      : b?.contextPct !== undefined
        ? [{ text: `${Math.round(b.contextPct)}%`, bold: true }]
        : [{ text: 'No reading yet', bold: true }]
  const hasContext = b?.contextPct !== undefined
  const sideEl =
    side >= 14 ? (
      <Box key="budget-side" flexDirection="column" width={side + 2} flexShrink={0}>
        <Text key="budget-side-above"> </Text>
        <Text key="budget-side-kicker" dimColor wrap="truncate-end">{wordFit(hasContext ? 'In the context window' : 'Budget', side)}</Text>
        <Text key="budget-side-figure" wrap="truncate-end">{figure.map((r, i) => runText(r, ctx.e, $, `budget-side-f${i}`))}</Text>
        <Text key="budget-side-sub" dimColor wrap="truncate-end">{wordFit(hasContext ? 'used so far' : 'it fills in with the next reply', side)}</Text>
        <Text key="budget-side-below"> </Text>
      </Box>
    ) : null
  const block = (
    <Box key="budget-block" flexDirection="row">
      <Text>{' '.repeat(left)}</Text>
      {sideEl}
      {shown.length > 0 ? inst(ctx, $, ringsInst('budget-rings', shown, ground)) : null}
    </Box>
  )
  // The words under each ring, centred under its 9 cells.
  const words: Run[] = []
  shown.forEach((w, i) => {
    const word = wordFit(w.word, GAUGE_RING.columns)
    const at = i * RING_PITCH + Math.floor((GAUGE_RING.columns - word.length) / 2)
    words.push({ text: ' '.repeat(Math.max(0, at - runsWidth(words))) }, { text: word, ...gaugeStyle(w.pct) })
  })
  return (
    <Box key="budget-header" flexDirection="column">
      {inst(ctx, $, frameTopInst('budget-lintel', cols, 'iris', ground))}
      {pillRow}
      {shown.length > 0 || sideEl !== null ? block : <Text key="budget-gap-ring"> </Text>}
      {textRow(ctx, $, 'budget-words', words, ringsAt)}
      {inst(ctx, $, frameFootInst('budget-sill', cols, 'iris', ground))}
    </Box>
  )
}

/** Under 35 columns: no rings. A word, the figure and a `━` bar for each window; slim has `b: back` first and no frame. */
function narrowHeader(ctx: ViewCtx, $: EngineInterface, wins: Win[], back: () => void): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { cols } = ctx
  const { left, right } = edges(cols)
  const content = right - left + 1
  const ground = ctx.ground ?? 'night'
  const slim = cols < 32
  const out: RenderElement[] = []
  if (slim) {
    out.push(
      <Box key="budget-top" flexDirection="row" paddingLeft={left}>
        <Button key="budget-back" hotkey="b" plain onPress={back}>
          back
        </Button>
      </Box>,
      blank(ctx, $, 'budget-gap-0'),
    )
  } else {
    out.push(
      inst(ctx, $, frameTopInst('budget-lintel', cols, 'iris', ground)),
      <Box key="budget-pill-row" flexDirection="row">
        <Text>{' '.repeat(left)}</Text>
        <Button key="budget-back" plain onPress={back}>
          {runText(BUDGET_PILL, ctx.e, $, 'budget-pill')}
        </Button>
      </Box>,
    )
  }
  if (wins.length === 0) out.push(textRow(ctx, $, 'budget-none', [{ text: 'No reading yet.', dim: true }]))
  for (const w of wins) {
    const fig = gaugeFigure(w.pct)
    out.push(
      textRow(ctx, $, `budget-${w.key}`, [{ text: wordFit(w.word, content - fig.length - 1).padEnd(Math.max(1, content - fig.length)), dim: true }, { text: fig, ...figureOf(w.pct) }]),
      textRow(ctx, $, `budget-bar-${w.key}`, gaugeBar(content, w.pct)),
    )
  }
  if (!slim) out.push(inst(ctx, $, frameFootInst('budget-sill', cols, 'iris', ground)))
  return (
    <Box key="budget-header" flexDirection="column">
      {out}
    </Box>
  )
}

/** `resets 15:40`, `resets Thu 09:00`, `resets now`: when a window resets, in words. */
const resetWords = (at: number, now: number): string => (at <= now ? 'resets now' : `resets ${resetClock(at, now)}`)

/**
 * Windows: a row each with when it resets, its rate (points per 10 min) and
 * when it fills ("full in 37 min", "lasts" when it resets first; bold when it
 * fills before it resets, and how long before on a row of its own), then the
 * output rate. From 62 columns it is one row a window in columns; from 50 the
 * rate and the fill share the row under it; narrower each is a row of its
 * own, indented by two, and under 32 the reset is the time alone (the head
 * says "resets"). Nothing when there is nothing to say.
 */
function paceBlock(ctx: ViewCtx, $: EngineInterface, wins: Win[]): RenderElement[] {
  const { t, now, cols } = ctx
  const p = pace(t, now)
  const { left, right } = edges(cols)
  const content = right - left + 1
  const rows: RenderElement[] = []
  const nameW = 10
  const wide = cols >= 62
  const mid = cols >= 50
  const slim = cols < 32
  const indent = mid ? nameW : 2
  for (const w of wins) {
    const pr = paceFor(p, w.key)
    const clock = w.reset === undefined ? '' : w.reset <= now ? 'now' : resetClock(w.reset, now)
    const reset = w.reset !== undefined ? (slim ? clock : resetWords(w.reset, now)) : w.tokens !== undefined ? `${tokenText(w.tokens)} tokens` : ''
    if (reset === '' && pr === undefined) continue
    const hot: Omit<Run, 'text'> = pr?.beforeReset === true ? { bold: true } : { dim: true }
    const runs: Run[] = [{ text: w.word.padEnd(nameW) }, { text: wide ? reset.padEnd(17) : reset, dim: true }]
    // From 62 columns the fill sits in the row when it fits; else it goes under, with the rest.
    const inline = pr !== undefined && wide && nameW + 17 + 17 + fullText(pr).length <= content
    if (pr !== undefined && wide) runs.push({ text: `${perTen(pr.per10)} per 10 min`.padEnd(17), dim: true }, ...(inline ? [{ text: fullText(pr), ...hot }] : []))
    rows.push(textRow(ctx, $, `budget-pace-${w.key}`, runs))
    if (pr !== undefined && wide && !inline) rows.push(textRow(ctx, $, `budget-pace2-${w.key}`, [{ text: ' '.repeat(nameW) }, { text: fullText(pr), ...hot }]))
    if (pr !== undefined && !wide) {
      const rate = `${perTen(pr.per10)} per 10 min`
      if (mid) rows.push(textRow(ctx, $, `budget-pace2-${w.key}`, [{ text: ' '.repeat(indent) }, { text: `${rate} · ${fullText(pr)}`, ...hot }]))
      else
        rows.push(
          textRow(ctx, $, `budget-pace2-${w.key}`, [{ text: ' '.repeat(indent) }, { text: rate, dim: true }]),
          textRow(ctx, $, `budget-pace3-${w.key}`, [{ text: ' '.repeat(indent) }, { text: fullText(pr), ...hot }]),
        )
    }
    if (pr?.shortBy !== undefined) rows.push(textRow(ctx, $, `budget-short-${w.key}`, [{ text: ' '.repeat(wide ? nameW : indent) }, { text: `fills ${span(pr.shortBy)} before it resets`, dim: true }]))
  }
  if (p.outPerMin !== undefined) {
    const out: Run[] = [{ text: 'Output'.padEnd(nameW) }, { text: `${tokenText(p.outPerMin)}/min`, bold: true }]
    if (nameW + `${tokenText(p.outPerMin)}/min`.length + '  of the turn'.length <= content) out.push({ text: '  of the turn', dim: true })
    rows.push(textRow(ctx, $, 'budget-output', out))
  }
  if (rows.length === 0) return []
  return [blank(ctx, $, 'budget-gap-windows'), section(ctx, $, 'Windows', slim ? 'resets' : undefined, { key: 'sec-windows' }), ...rows]
}

/** What `showCost` adds: the session's cost, and this turn's share of it. The one dollar figure. */
function costBlock(ctx: ViewCtx, $: EngineInterface): RenderElement[] {
  const { t } = ctx
  const b = t.budget
  if (ctx.showCost !== true || b?.costUsd === undefined) return []
  const share = turnShare(t)
  return [
    blank(ctx, $, 'budget-gap-cost'),
    section(ctx, $, 'Cost', undefined, { key: 'sec-cost' }),
    textRow(ctx, $, 'budget-cost', [{ text: `${dollars(b.costUsd)} session`, bold: true }, ...(share !== undefined ? [{ text: `   ${dollars(share)} turn`, dim: true }] : [])]),
  ]
}

/**
 * Cache: a `━` stack (read in the accent, written in the accent dim, sent fresh in
 * grey), what each is (items drop from the right when the row is short), how
 * long it stays warm (whole minutes, one shared word helper) and what going
 * cold re-sends. Nothing without cache counts.
 */
function cacheBlock(ctx: ViewCtx, $: EngineInterface): RenderElement[] {
  const { t, now, cols } = ctx
  const cl = cacheLine(t)
  if (cl.total <= 0) return []
  const { left, right } = edges(cols)
  const content = right - left + 1
  const sum: Run[] = [{ text: `${Math.round(cl.readShare * 100)}%`, bold: true }, { text: ' read', dim: true }]
  const items: Run[][] = [
    [{ text: '━', color: CK.accent }, { text: ` read ${tokenText(cl.read)}`, dim: true }],
    [{ text: '━', color: CK.accent, dim: true }, { text: ` written ${tokenText(cl.write)}`, dim: true }],
    [{ text: '━', color: C.subtle }, { text: ` fresh ${tokenText(cl.fresh)}`, dim: true }],
  ]
  const key: Run[] = []
  for (const item of items) {
    const next = [...key, ...(key.length > 0 ? [{ text: '   ' }] : []), ...item]
    if (runsWidth(next) > content) break
    key.splice(0, key.length, ...next)
  }
  const rows: RenderElement[] = [
    blank(ctx, $, 'budget-gap-cache'),
    section(ctx, $, 'Cache', sum, { key: 'sec-cache' }),
    textRow(ctx, $, 'budget-cache-bar', ruleBar(content, [{ count: cl.read, color: CK.accent }, { count: cl.write, color: CK.accent, dim: true }, { count: cl.fresh, color: C.subtle }])),
    textRow(ctx, $, 'budget-cache-key', key),
  ]
  if (cl.warmUntil !== undefined) {
    rows.push(textRow(ctx, $, 'budget-cache-warm', [{ text: cl.warmUntil <= now ? 'cold now' : `stays warm ${warmWords(cl.warmUntil - now)}`, dim: true }]))
  }
  if (cl.resend !== undefined) {
    const full = `going cold re-sends ${tokenText(cl.resend)} uncached`
    rows.push(textRow(ctx, $, 'budget-cache-cold', [{ text: full.length <= content ? full : `cold re-sends ${tokenText(cl.resend)}`, dim: true }]))
  }
  return rows
}

/**
 * The clock's call: a toast when the context reaches 80 % and when a window
 * reaches 70 % and each 10 points past it, once each. Each marker is written
 * to `ui.toasted` before the toast is sent. A budget older than FRESH_MS is a
 * restored one and raises nothing. Never throws.
 */
export async function budgetTick($: EngineInterface): Promise<void> {
  try {
    const t = await readTimeline($)
    const b = t.budget
    if (b === undefined) return
    const now = await $.clock.now()
    if (now - b.at > FRESH_MS) return
    const u = await readUi($)
    const seen = (m: string): boolean => u.toasted.includes(m)
    const marks: string[] = []
    const toasts: string[] = []
    if (b.contextPct !== undefined && b.contextPct >= CONTEXT_TOAST && !seen('budget:ctx:80')) {
      marks.push('budget:ctx:80')
      toasts.push(`Context at ${percent(b.contextPct)}`)
    }
    for (const w of b.windows) {
      const fresh: string[] = []
      for (let level = WINDOW_FROM; level <= 100 && level <= w.pct; level += WINDOW_STEP) {
        const m = `budget:${w.name}:${level}`
        if (!seen(m)) fresh.push(m)
      }
      if (fresh.length === 0) continue
      marks.push(...fresh)
      const reset = w.resetsAt !== undefined ? ` · ${resetText(w.resetsAt, now)}` : ''
      toasts.push(`${windowName(w.name)} window at ${percent(w.pct)}${reset}`)
    }
    if (toasts.length === 0) return
    await updateUi($, cur => ({ ...cur, toasted: [...cur.toasted, ...marks.filter(m => !cur.toasted.includes(m))] }))
    for (const text of toasts) $.ui.toast(text)
  } catch (err) {
    debug($, `budget tick failed: ${errText(err)}`)
  }
}

/** A budget newer than this is left alone when `/mc` asks for a first reading. */
const SEED_FRESH_MS = 60_000

/** The toast markers a budget has already reached: what budgetTick would raise for it. */
function reachedMarks(b: Budget): string[] {
  const marks: string[] = []
  if (b.contextPct !== undefined && b.contextPct >= CONTEXT_TOAST) marks.push('budget:ctx:80')
  for (const w of b.windows) {
    for (let level = WINDOW_FROM; level <= 100 && level <= w.pct; level += WINDOW_STEP) marks.push(`budget:${w.name}:${level}`)
  }
  return marks
}

/**
 * A first reading of the budget from `$.session.usage()`, which has the
 * figures a `session.measure` input has, so `budgetOf` reads both. It is
 * taken at session start and when `/mc` opens the pane, because nothing else
 * records a budget until Claude next replies. With `onlyIfOlderThanMs` set
 * an existing budget newer than that is kept and nothing is read.
 *
 * The reached toast markers are written before the budget, so the clock's
 * budgetTick cannot toast figures that were already there. Never throws.
 */
export async function seedBudget($: EngineInterface, opts: { skipIfFresh?: boolean } = {}): Promise<void> {
  try {
    const at = await $.clock.now()
    if (opts.skipIfFresh === true) {
      const had = (await readTimeline($)).budget
      if (had !== undefined && at - had.at < SEED_FRESH_MS) return
    }
    const b = budgetOf(await $.session.usage(), at)
    if (b.contextPct === undefined && b.costUsd === undefined && b.windows.length === 0) return
    const marks = reachedMarks(b)
    if (marks.length > 0) {
      await updateUi($, cur => ({ ...cur, toasted: [...cur.toasted, ...marks.filter(m => !cur.toasted.includes(m))] }))
    }
    await apply($, { kind: 'measure', at, budget: b })
  } catch (err) {
    debug($, `budget seed failed: ${errText(err)}`)
  }
}

// ---------- the ledger (This week) ----------

// The ledger rows THIS WEEK reads. Ephemeral pane state like `budgetOpen`: a
// render hook cannot await the store, so the press that opens the view loads
// them (`loadLedger`) and redraws; a reload starts empty and loads again.
let ledger: LedgerRow[] = []

/** Replaces the rows the view draws from. For `loadLedger` and tests. */
export function setLedgerRows(rows: LedgerRow[]): void {
  ledger = rows
}

/** Reads the ledger from `$.store` and redraws. Press handlers and the clock only. Never throws. */
export async function loadLedger($: EngineInterface): Promise<void> {
  try {
    ledger = await readLedgerRows($)
    $.ui.invalidate('ui.render')
  } catch (err) {
    debug($, `ledger load failed: ${errText(err)}`)
  }
}

/**
 * `e` in the budget view: writes the ledger as CSV beside the journal
 * (`<journal root>/ledger-<stamp>.csv`; the cost column only with `showCost`),
 * and toasts the path. A press only. Never throws.
 */
export async function exportLedger($: EngineInterface, withCost: boolean): Promise<void> {
  try {
    const root = await journalRoot($)
    if (root === undefined) {
      $.ui.toast('Could not write the ledger: no home folder.')
      return
    }
    const rows = await readLedgerRows($)
    const path = `${root}/ledger-${stamp(await $.clock.now())}.csv`
    await $.fs.write(path, ledgerCsv(rows, withCost))
    $.ui.toast(`Ledger written: ${path}`)
  } catch (err) {
    debug($, `ledger export failed: ${errText(err)}`)
    try {
      $.ui.toast(`Could not write the ledger: ${errText(err)}`)
    } catch {
      // a toast that cannot show is not worth more
    }
  }
}

const WEEKDAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

/** A day key (`2026-11-15`) as `sun` to `sat`. */
const weekdayOf = (day: string): string => WEEKDAY[new Date(`${day}T12:00:00`).getDay()] ?? ''

/** The week's seven days as a Raster of stacked day columns (4 wide, pitch 6): the heaviest model `iris` under the rest `irisSoft` (I-4: no orchid in the pane); an empty day is a rest tick. */
export function weekSpec(days: LedgerDay[], ground: Ground = 'night'): { spec: InstSpec; primary?: string; second: boolean } {
  const totals = new Map<string, number>()
  for (const d of days) for (const [m, n] of Object.entries(d.tokens)) totals.set(m, (totals.get(m) ?? 0) + n)
  const primary = [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const max = Math.max(1, ...days.map(d => d.total))
  const columns = days.length * 6 - 2
  const spec: InstSpec = {
    key: 'week',
    columns,
    rows: 3,
    sig: `week:${ground}:${accentName()}:${days.map(d => `${d.day}:${primary !== undefined ? (d.tokens[primary] ?? 0) : 0}:${d.total}`).join(',')}`,
    frames: () => {
      const g = new Grid(columns, 3, palette(ground))
      days.forEach((d, i) => {
        const a = Math.round((((primary !== undefined ? d.tokens[primary] : 0) ?? 0) / max) * 24)
        const b = Math.round((d.total / max) * 24)
        if (b === 0) {
          for (let x = 0; x < 4; x++) g.lv(i * 6 + x, 2, 1, 'rest')
          return
        }
        for (let k = 0; k < 3; k++) {
          const lo = k * 8
          const pa = Math.max(0, Math.min(8, a - lo))
          const pb = Math.max(0, Math.min(8, b - lo))
          if (pb === 0) continue
          for (let x = 0; x < 4; x++) {
            if (pa >= 8) g.lv(i * 6 + x, 2 - k, 8, 'iris')
            else if (pa > 0) g.lv(i * 6 + x, 2 - k, pa, 'iris', pb >= 8 ? 'irisSoft' : undefined)
            else g.lv(i * 6 + x, 2 - k, pb, 'irisSoft')
          }
        }
      })
      return [g]
    },
    fallback: [0, 1, 2].map(r => [{ text: r === 2 ? sparkText(days.map(d => d.total)).padEnd(columns) : ' '.repeat(columns) }]),
  }
  return { spec, ...(primary !== undefined ? { primary } : {}), second: [...totals.keys()].length > 1 }
}

/** Values as one row of eighth blocks (the text form of a trace). */
function sparkText(vals: number[]): string {
  const max = Math.max(1, ...vals)
  return vals.map(v => (v <= 0 ? '▁' : '▁▂▃▄▅▆▇█'[Math.max(0, Math.min(7, Math.round((v / max) * 7)))]!)).join('')
}

/** `5.9` as `+5.9` for a rate per ten minutes. */
const perTen = (n: number): string => `+${n.toFixed(1)}`

/** `full in 37 min`, or `lasts` (a window that resets first), from a pace row (R27 durations). */
function fullText(r: PaceRow): string {
  return r.beforeReset === false ? 'lasts' : `full in ${span(r.fullIn)}`
}

/** The pace row for a window name (`context` for the context). */
const paceFor = (p: Pace, key: string): PaceRow | undefined => (key === 'context' ? p.context : p.windows.find(w => w.name === key))

/**
 * This week (the ledger): the head with the week's tokens and sessions, the
 * seven stacked day columns with the model legend beside them and the
 * weekdays under them (narrower, or without Rasters, one row of eighth
 * blocks). An empty ledger draws nothing. `e` in the footer writes the CSV.
 */
function weekBlock(ctx: ViewCtx, $: EngineInterface): RenderElement[] {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const days = week(ledger, ctx.now)
  const total = days.reduce((n, d) => n + d.total, 0)
  const sessions = days.reduce((n, d) => n + d.sessions, 0)
  if (total === 0 && sessions === 0) return []
  const { left } = edges(ctx.cols)
  const sum: Run[] = [{ text: tokenText(total), bold: true }, { text: ` tokens · ${sessions} ${sessions === 1 ? 'session' : 'sessions'}`, dim: true }]
  const out: RenderElement[] = [blank(ctx, $, 'budget-gap-3'), section(ctx, $, 'This week', sum, { key: 'sec-this-week' })]
  const { spec, primary, second } = weekSpec(days, ctx.ground ?? 'night')
  const useCost = ctx.showCost === true && days.some(d => d.usd !== undefined)
  const chartAt = left + 12
  if (chartAt + spec.columns <= ctx.cols - 3 && ctx.cols >= 62) {
    out.push(
      <Box key="week-row" flexDirection="row">
        <Box key="week-legend" flexDirection="column" width={chartAt} paddingLeft={left} flexShrink={0}>
          {primary !== undefined ? (
            <Text key="week-primary" color={CK.accent} wrap="truncate-end">
              {wordFit(modelName(primary), 9)}
            </Text>
          ) : null}
          {second ? (
            <Text key="week-rest" color={CK.accent} dimColor wrap="truncate-end">
              others
            </Text>
          ) : null}
        </Box>
        {inst(ctx, $, spec)}
      </Box>,
      <Text key="week-days" dimColor wrap="truncate-end">
        {' '.repeat(chartAt) + days.map((d, i) => weekdayOf(d.day) + (i < days.length - 1 ? '   ' : '')).join('')}
      </Text>,
    )
  } else {
    out.push(textRow(ctx, $, 'week-spark', [{ text: sparkText(days.map(d => d.total)), color: CK.accent }]))
  }
  if (useCost) {
    const usd = days.reduce((n, d) => n + (d.usd ?? 0), 0)
    out.push(textRow(ctx, $, 'week-cost', [{ text: `${dollars(usd)} this week`, dim: true }]))
  }
  return out
}

// ---------- the cockpit's budget words and gauges (cockpit spec "Header", R9, R29) ----------

/** The context window's size from a reading: the nearest of 200k and 1M to tokens over the share; undefined without both. */
export function contextSize(b: Budget | undefined): number | undefined {
  if (b?.contextTokens === undefined || b.contextPct === undefined || b.contextPct <= 0) return undefined
  const raw = (b.contextTokens * 100) / b.contextPct
  return Math.abs(Math.log(raw / 200_000)) < Math.abs(Math.log(raw / 1_000_000)) ? 200_000 : 1_000_000
}

/** A window size in words: `1M`, `200k`. */
const sizeText = (n: number): string => (n >= 1_000_000 ? `${Math.round(n / 1_000_000)}M` : `${Math.round(n / 1000)}k`)

/**
 * The header's budget line: "620k of 1M used" (the figure in ink, the rest
 * dim), "context 62% used" without a token count, "no budget reading yet"
 * without one (the line stays, so the budget view is a press away); while
 * `idle` and the cache is still warm, " · cache warm 4 min" (R29, R40:
 * shown at idle only, in whole minutes, "under 1 min" in the last one).
 * Longer than `room` the figure drops "used", then " of 1M" ("644k · cache
 * warm 4 min"), then the countdown goes.
 */
export function budgetWords(t: Timeline, now: number, o: { idle: boolean; room?: number }): Run[] {
  const width = (runs: Run[]): number => runs.reduce((n, r) => n + r.text.length, 0)
  // Short of room the figure loses "used", then " of 1M", before the countdown is left out.
  const tries: Run[][] = [budgetRuns(t, now, o.idle, 'full'), budgetRuns(t, now, o.idle, 'short'), budgetRuns(t, now, o.idle, 'figure')]
  if (o.room === undefined) return tries[0]!
  return tries.find(r => width(r) <= o.room!) ?? budgetRuns(t, now, false, 'full')
}

type Fullness = 'full' | 'short' | 'figure'

function budgetRuns(t: Timeline, now: number, idle: boolean, how: Fullness): Run[] {
  const b = t.budget
  const out: Run[] = []
  const size = contextSize(b)
  if (b?.contextTokens !== undefined && size !== undefined) {
    out.push({ text: tokenText(b.contextTokens) })
    if (how !== 'figure') out.push({ text: ` of ${sizeText(size)}${how === 'full' ? ' used' : ''}`, dim: true })
  } else if (b?.contextPct !== undefined) out.push({ text: 'context ', dim: true }, { text: `${Math.round(b.contextPct)}%` }, { text: ' used', dim: true })
  else out.push({ text: 'no budget reading yet', dim: true })
  if (idle) {
    const warm = cacheLine(t).warmUntil
    if (warm !== undefined && warm > now) out.push({ text: `${out.length > 0 ? ' · ' : ''}cache warm ${warmWords(warm - now)}`, dim: true })
  }
  return out
}

/**
 * Now's two gauges (cockpit spec: the third ring goes to the budget view):
 * the context, and the hotter of the 5-hour and weekly windows, each with
 * its word ("context", "5 hours", "this week"). Empty without a reading.
 */
export function nowGauges(t: Timeline): { pct: number; label: string }[] {
  const b = t.budget
  if (b === undefined) return []
  const out: { pct: number; label: string }[] = []
  if (b.contextPct !== undefined) out.push({ pct: b.contextPct, label: 'context' })
  const five = b.windows.find(w => w.name === 'five_hour')
  const week = b.windows.find(w => w.name === 'seven_day')
  const hot = five !== undefined && (week === undefined || five.pct > week.pct) ? { pct: five.pct, label: '5 hours' } : week !== undefined ? { pct: week.pct, label: 'this week' } : undefined
  if (hot !== undefined) out.push(hot)
  return out
}

/** The slim Budget rows: the context and the hotter window, as a short label and a percentage ("context", "week", "5 hours"). */
export function slimGauges(t: Timeline): { pct: number; label: string }[] {
  return nowGauges(t).map(g => ({ ...g, label: g.label === 'this week' ? 'week' : g.label }))
}
