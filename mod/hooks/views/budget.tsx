import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow, Budget, BudgetWindow, LedgerRow, Timeline } from '../../types'
import { stamp } from '../model/digest'
import { ledgerCsv, week } from '../model/ledger'
import type { LedgerDay } from '../model/ledger'
import { cacheLine, pace, turnShare } from '../model/meter'
import type { Pace, PaceRow } from '../model/meter'
import { budgetOf } from '../model/usage'
import { journalRoot } from '../journal'
import { apply, debug, errText, leaveDetail, readLedgerRows, readTimeline, readUi, updateUi } from '../state'
import { openAgentPage } from './agentmeta'
import { bar, clock, elapsed, growLists, listSplit, meter, shortPaths, wordFit } from './fit'
import { laid, runsLine } from './lay'
import type { Placed } from './lay'
import { podFor, waitStates } from './needs'
import { blank, deck, heightOf, inst, more, section } from './parts'
import type { DeckCell, DeckRow, InstSpec, ReadoutCell, Run } from './parts'
import { Grid } from './raster'
import type { Ink } from './raster'
import { barsSpec, beadsSpec, deckRowEl, lintelSpec, sillSpec, stackSpec } from './richkit'
import type { DeckRowSpec } from './richkit'
import type { ViewCtx } from './shell'
import { C, COL, DECK, GRID, rateColor, tableCols } from './style'

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

/** A token count in a few characters: 950, 1.2k, 41k, 1.3M. */
export function tokenText(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)))
  if (n < 10_000) {
    const v = (n / 1000).toFixed(1)
    if (v !== '10.0') return `${v}k`
  }
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** A window's kind as a short label: `five_hour` is `5h`, `seven_day` is `7d`; others lose their underscores. */
export function windowName(name: string): string {
  if (name === 'five_hour') return '5h'
  if (name === 'seven_day') return '7d'
  return name.replace(/_/g, ' ')
}

/** `resets in 2h00`, from the reset time and now (both ms). */
export function resetText(at: number, now: number): string {
  return at <= now ? 'resets now' : `resets in ${elapsed(now, at)}`
}

const dollars = (usd: number): string => `$${usd.toFixed(2)}`
const percent = (pct: number): string => `${Math.round(pct)}%`

/** The agent's model and tokens as `sonnet 41k`; `…` while it runs with no usage; '' when there is nothing to say. */
export function usageText(agent: AgentRow): string {
  const model = agent.model !== undefined ? modelName(agent.model) : ''
  const has = agent.tokensIn !== undefined || agent.tokensOut !== undefined
  if (!has) {
    if (agent.status === 'running') return model !== '' ? `${model} …` : '…'
    return model
  }
  const total = tokenText((agent.tokensIn ?? 0) + (agent.tokensOut ?? 0))
  return model !== '' ? `${model} ${total}` : total
}

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

type Row = { label: string; pct: number; reset?: string; at?: number; key?: string }

function rowsOf(b: Budget, now: number): Row[] {
  const rows: Row[] = []
  if (b.contextPct !== undefined) rows.push({ label: 'ctx', pct: b.contextPct, key: 'context' })
  for (const w of b.windows) {
    const row: Row = { label: windowName(w.name), pct: w.pct, key: w.name }
    if (w.resetsAt !== undefined) {
      row.reset = resetText(w.resetsAt, now)
      row.at = w.resetsAt
    }
    rows.push(row)
  }
  return rows
}

/** `ctx 62% · 5h 71%`, with the cost when asked for; '' when there is nothing to show. */
export function budgetLine(b: Budget, showCost: boolean): string {
  const parts = rowsOf(b, 0).map(r => `${r.label} ${percent(r.pct)}`)
  if (showCost && b.costUsd !== undefined) parts.push(dollars(b.costUsd))
  return parts.join(' · ')
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

/**
 * The meters of Now's BUDGET row, left to right: CTX, then the 5-hour and
 * 7-day windows, those the reading has (`CTX ◔ 9%`, each at most 10 wide).
 */
export function budgetMeters(t: Timeline): Run[][] {
  const b = t.budget
  if (b === undefined) return []
  const out: Run[][] = []
  if (b.contextPct !== undefined) out.push(meter('CTX', b.contextPct))
  for (const [name, label] of [['five_hour', '5H'], ['seven_day', '7D']] as const) {
    const w = b.windows.find(x => x.name === name)
    if (w !== undefined) out.push(meter(label, w.pct))
  }
  return out
}

/** The two heaviest models as readout cells: the model and its share of all tokens. */
export function modelCells(t: Timeline): ReadoutCell[] {
  const totals = modelTotals(t)
  const all = totals.reduce((n, x) => n + x.tokens, 0)
  return totals.slice(0, 2).map((x, i) => {
    const share = all > 0 ? Math.round((x.tokens / all) * 100) : 0
    return {
      label: x.model.toUpperCase(),
      value: `${share}%`,
      gfx: bar(share, 100, 10, C.model),
      drop: 2 - i,
    }
  })
}

const MAX_LIST = 6
// THIS WEEK's rows under the shares: its gap, header, sparkline and weekdays.
const WEEK_ROWS = 4

/**
 * Binding rule 2 in the budget view: how many MODELS and AGENTS rows show in
 * the rows the deck above (`above` rows) and THIS WEEK leave, each at least
 * MAX_LIST as before. Answers the items each lists before its more line.
 */
function shareCaps(ctx: ViewCtx, above: number, models: number, agents: number): { models: number; agents: number } {
  const grown = growLists((ctx.bodyRows ?? 40) - above - 1 - WEEK_ROWS, [
    { key: 'models', count: models, least: MAX_LIST },
    { key: 'agents', count: agents, least: MAX_LIST },
  ])
  return { models: listSplit(models, grown.get('models') ?? 0).shown, agents: listSplit(agents, grown.get('agents') ?? 0).shown }
}

/** One row of a share table: a hull or `▪`, a name, the tokens at 38 and a 10-cell bar at 50. */
type Share = { key: string; glyph: Run; name: string; tokens: number; color: string; dim?: boolean; onPress?: () => void | Promise<void> }

/**
 * `┌ LABEL tokens share` and one row per item: glyph at 2, name at 4, tokens
 * at the metric column and a 10-cell `▮▯` bar of its share of `total` at the
 * time column (`row` takes one run per cell and a bar has two, so the row is
 * laid here). Under 38 columns there is only the name.
 */
function shareTable(ctx: ViewCtx, $: EngineInterface, label: string, items: Share[], total: number, extra: number): RenderElement[] {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const tc = tableCols(ctx.cols)
  const out: RenderElement[] = [section(ctx, $, label, 'tokens', 'share')]
  for (const x of items) {
    const dim = x.dim === true ? { dim: true } : {}
    const segs: Placed[] = [
      { ...x.glyph, col: COL.glyph },
      { col: COL.name, text: wordFit(x.name, Math.max(0, tc.nameEnd - COL.name)), ...dim },
    ]
    if (tc.metric !== undefined) segs.push({ col: tc.metric, text: wordFit(tokenText(x.tokens), Math.min(GRID.content, ctx.cols - tc.metric)), dim: true })
    if (tc.time !== undefined && ctx.cols - tc.time >= 10) {
      let col = tc.time
      for (const r of bar(x.tokens, total, 10, x.color)) {
        segs.push({ ...r, col })
        col += r.text.length
      }
    }
    const body = laid(segs, COL.glyph, ctx.e, $, `${x.key}-`)
    out.push(
      <Box key={`row-${x.key}`} flexDirection="row">
        <Text>{'  '}</Text>
        {x.onPress !== undefined ? (
          <Button key={x.key} plain onPress={x.onPress}>
            {body}
          </Button>
        ) : (
          <Text key={x.key} wrap="truncate-end">
            {body}
          </Text>
        )}
      </Box>,
    )
  }
  if (extra > 0) out.push(more(ctx, $, extra, `more ${label.toLowerCase()}`))
  return out
}

/**
 * The budget view (spec "Budget view"): a deck with `used` and `resets` heads
 * and one row per window, CTX first, each a 22-cell bar, the percentage at
 * 38 and when it resets at 50; `┌ MODELS tokens share` and `┌ AGENTS tokens
 * share` with a 10-cell bar in the time column. No dollar figure is drawn,
 * except a `COST` row (the value on 38) when the person turned `showCost` on.
 * Pressing the head row (or `b`, from the footer) goes back; an agent row
 * opens that agent.
 *
 * Under 62 columns the percentage moves to 8, the bar is 10 cells at 14 and
 * the reset follows at 26, or on a row of its own at 8 under 42 columns; in
 * slim (under 32) the bracket is the left one only and a `b: back` row leads.
 */
export function budgetView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  return ctx.look === 'rich' && ctx.cols >= 38 ? richBudgetView(ctx, $) : textBudgetView(ctx, $)
}

function textBudgetView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Button } = $.ui.resolve(ctx.e)
  const { t, cols, now } = ctx
  const b = t.budget
  const slim = cols < 32
  const wide = cols >= 62
  const back = (): void => setBudgetOpen($, false)
  const out: (RenderElement | null)[] = []
  if (slim) {
    out.push(
      <Box key="budget-top" flexDirection="row" paddingLeft={GRID.margin}>
        <Button key="budget-back" hotkey="b" plain onPress={back}>
          back
        </Button>
      </Box>,
      blank(ctx, $, 'budget-gap-0'),
    )
  }
  const head: DeckRow = {
    key: slim ? 'budget-head' : 'budget-back',
    label: [{ text: 'BUDGET', bold: true }],
    ...(slim ? {} : { onPress: back }),
    cells: wide ? [{ col: DECK.value, runs: [{ text: 'used', dim: true }] }, { col: DECK.aside, runs: [{ text: 'resets', dim: true }] }] : [],
  }
  const rows = b !== undefined ? rowsOf(b, now) : []
  const p = pace(t, now)
  const cl = cacheLine(t)
  const deckRows: DeckRow[] = [head]
  if (b === undefined || rows.length === 0) {
    deckRows.push({ key: 'budget-none', label: [{ text: 'No reading yet.', dim: true }] })
  }
  for (const r of rows) {
    const share = Math.max(0, Math.min(100, r.pct))
    const label = r.label.toUpperCase()
    const pct = { text: percent(r.pct), bold: true }
    if (wide) {
      const cells: DeckCell[] = [
        { col: DECK.gauge, runs: bar(share, 100, 22), narrow: bar(share, 100, 10), whole: true },
        { col: DECK.value, runs: [pct] },
      ]
      if (r.at !== undefined) cells.push({ col: DECK.aside, runs: [{ text: resetClock(r.at, now), dim: true }] })
      deckRows.push({ key: `budget-${r.label}`, label, cells })
      const pr = r.key !== undefined ? paceFor(p, r.key) : undefined
      if (pr !== undefined) {
        deckRows.push({
          key: `budget-pace-${r.label}`,
          cells: [
            { col: DECK.gauge, runs: [{ text: `${perTen(pr.per10)} per 10m`, dim: true }], whole: true },
            { col: DECK.value, runs: [{ text: fullText(pr), ...(pr.beforeReset === true ? { color: C.wait, bold: true } : { dim: true }) }], whole: true },
            ...(pr.shortBy !== undefined ? [{ col: DECK.aside, runs: [{ text: `short ${elapsed(0, pr.shortBy)}`, color: C.wait }], whole: true }] : []),
          ],
        })
      }
      continue
    }
    const cells: DeckCell[] = [
      { col: 8, runs: [pct] },
      { col: DECK.gauge, runs: bar(share, 100, 10), whole: true },
    ]
    const inline = cols >= 42
    if (inline && r.at !== undefined) cells.push({ col: 26, runs: [{ text: resetText(r.at, now), dim: true }], whole: true })
    deckRows.push({ key: `budget-${r.label}`, label, cells })
    if (!inline && r.at !== undefined) {
      deckRows.push({ key: `budget-${r.label}-reset`, cells: [{ col: 8, runs: [{ text: resetText(r.at, now), dim: true }] }] })
    }
  }
  if (p.outPerMin !== undefined) {
    deckRows.push({ key: 'budget-output', label: 'OUTPUT', cells: [{ col: wide ? DECK.gauge : 8, runs: [{ text: `${tokenText(p.outPerMin)}/min`, bold: true }] }] })
  }
  if (cl.total > 0) {
    const warm = warmText(cl.warmUntil, now)
    deckRows.push({
      key: 'budget-cache',
      label: 'CACHE',
      cells: [
        { col: wide ? DECK.gauge : 8, runs: [{ text: `${Math.round(cl.readShare * 100)}% read`, bold: true }] },
        ...(warm !== undefined && wide ? [{ col: DECK.value, runs: [{ text: warm.text, ...(warm.warm ? { color: C.result } : { dim: true }) }], whole: true }] : []),
      ],
    })
  }
  // The person's explicit opt-in (`showCost`): the one exception to Neo's "no dollar figure".
  if (ctx.showCost === true && b?.costUsd !== undefined) {
    deckRows.push({ key: 'budget-cost', label: 'COST', cells: [{ col: wide ? DECK.value : 8, runs: [{ text: dollars(b.costUsd), bold: true }] }] })
  }
  out.push(deck(ctx, $, deckRows, { key: 'budget', side: slim ? 'left' : 'both' }))

  const totals = modelTotals(t)
  const reportedCount = Object.values(t.agents).filter(a => a.tokensIn !== undefined || a.tokensOut !== undefined).length
  const caps = shareCaps(ctx, heightOf(out), totals.length, reportedCount)
  if (totals.length > 0) {
    const all = totals.reduce((n, x) => n + x.tokens, 0)
    const items: Share[] = totals.slice(0, caps.models).map(x => ({
      key: `model-${x.model}`,
      glyph: { text: '▪', color: C.model },
      name: x.model,
      tokens: x.tokens,
      color: C.model,
    }))
    out.push(blank(ctx, $, 'budget-gap-1'), ...shareTable(ctx, $, 'MODELS', items, all, totals.length - items.length))
  }
  const waits = waitStates(t, ctx.u, now)
  const reported = Object.values(t.agents)
    .filter(a => a.tokensIn !== undefined || a.tokensOut !== undefined)
    .map(a => ({ a, tokens: (a.tokensIn ?? 0) + (a.tokensOut ?? 0) }))
    .sort((x, y) => y.tokens - x.tokens || x.a.id.localeCompare(y.a.id))
  if (reported.length > 0) {
    const all = reported.reduce((n, x) => n + x.tokens, 0)
    const items: Share[] = reported.slice(0, caps.agents).map(({ a, tokens }) => {
      const pod = podFor(a, waits, now)
      const id = a.id
      return {
        key: `budget-agent-${id}`,
        glyph: pod.hull,
        name: id === 'main' ? 'main' : shortPaths(a.description || a.type),
        tokens,
        color: C.live,
        ...(pod.state === 'done' || pod.state === 'queued' ? { dim: true } : {}),
        ...(id !== 'main' ? { onPress: () => openAgentPage($, id, `budget-agent-${id}`) } : {}),
      }
    })
    out.push(blank(ctx, $, 'budget-gap-2'), ...shareTable(ctx, $, 'AGENTS', items, all, reported.length - items.length))
  }
  const days = week(ledger, now)
  const weekTotal = days.reduce((n, d) => n + d.total, 0)
  if (weekTotal > 0) {
    out.push(
      blank(ctx, $, 'budget-gap-3'),
      runsLine(ctx.e, $, [{ col: 0, text: '┌', color: C.accent }, { col: COL.glyph, text: 'THIS WEEK', bold: true }], 'sec-this-week'),
      runsLine(ctx.e, $, [{ col: COL.glyph, text: sparkText(days.map(d => d.total)) }, { col: DECK.gauge, text: `${tokenText(weekTotal)} tokens`, dim: true }], 'week-spark'),
    )
  }
  return <Box flexDirection="column">{out.filter((x): x is RenderElement => x !== null)}</Box>
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

// ---------- Neo Rich: the budget view ----------

// The ledger rows THIS WEEK reads. Ephemeral pane state like `budgetOpen`: a
// render hook cannot await the store, so the press that opens the view loads
// them (`loadLedger`) and redraws; a reload starts empty and loads again.
let ledger: LedgerRow[] = []

/** The ledger rows the view draws from (what the last `loadLedger` read). */
export function ledgerRows(): LedgerRow[] {
  return ledger
}

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

/** The week's seven days as a Raster of stacked day columns (4 wide, pitch 6): the heaviest model `orchid` under the rest `iris`; an empty day is a rest tick. */
export function weekSpec(days: LedgerDay[]): { spec: InstSpec; primary?: string; second: boolean } {
  const totals = new Map<string, number>()
  for (const d of days) for (const [m, n] of Object.entries(d.tokens)) totals.set(m, (totals.get(m) ?? 0) + n)
  const primary = [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const max = Math.max(1, ...days.map(d => d.total))
  const columns = days.length * 6 - 2
  const spec: InstSpec = {
    key: 'week',
    columns,
    rows: 3,
    sig: `week:${days.map(d => `${d.day}:${primary !== undefined ? (d.tokens[primary] ?? 0) : 0}:${d.total}`).join(',')}`,
    frames: () => {
      const g = new Grid(columns, 3)
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
            if (pa >= 8) g.lv(i * 6 + x, 2 - k, 8, 'orchid')
            else if (pa > 0) g.lv(i * 6 + x, 2 - k, pa, 'orchid', pb >= 8 ? 'iris' : undefined)
            else g.lv(i * 6 + x, 2 - k, pb, 'iris')
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

/** `full 37m`, `lasts` (a window that resets first) or `full 9h`, from a pace row. */
function fullText(r: PaceRow): string {
  return r.beforeReset === false ? 'lasts' : `full ${elapsed(0, r.fullIn)}`
}

/** The text for `CACHE`'s warm cell: `warm ~3:48`, or `cold` once the estimate ran out. */
function warmText(warmUntil: number | undefined, now: number): { text: string; warm: boolean } | undefined {
  if (warmUntil === undefined) return undefined
  if (warmUntil <= now) return { text: 'cold', warm: false }
  const s = Math.floor((warmUntil - now) / 1000)
  return { text: `warm ~${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, warm: true }
}

const labelOf = (key: string): string => (key === 'context' ? 'CTX' : windowName(key).toUpperCase())

/** The pace row for a window name (`context` for the context). */
const paceFor = (p: Pace, key: string): PaceRow | undefined => (key === 'context' ? p.context : p.windows.find(w => w.name === key))

/** The model colours THIS WEEK's legend and the share bars use. */
const hueOfModel = (i: number): Ink => (i === 0 ? 'orchid' : i === 1 ? 'iris' : 'mute')

/** A share-table row in the rich look: glyph and name (a Button when it opens something), the tokens at 38, a stacked share bar at 50. */
function richShareRow(ctx: ViewCtx, $: EngineInterface, x: Share, total: number, hue: Ink): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const tc = tableCols(ctx.cols)
  const dim = x.dim === true ? { dim: true } : {}
  const left: Placed[] = [
    { ...x.glyph, col: COL.glyph },
    { col: COL.name, text: wordFit(x.name, Math.max(0, tc.nameEnd - COL.name)), ...dim },
  ]
  const leftWidth = tc.metric ?? ctx.cols
  const body = laid(left, COL.glyph, ctx.e, $, `${x.key}-`)
  const share = total > 0 ? Math.round((x.tokens / total) * 100) : 0
  const bar = tc.time !== undefined && ctx.cols - tc.time >= 10 ? stackSpec(`share-${x.key}`, 10, [[Math.max(1, share), hue], [100 - Math.max(1, share), 'rest']], [x.color]) : undefined
  return (
    <Box key={`row-${x.key}`} flexDirection="row">
      <Box key={`${x.key}-left`} width={leftWidth} flexShrink={0}>
        <Text key={`${x.key}-pad`}>{'  '}</Text>
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
      {tc.metric !== undefined ? (
        <Box key={`${x.key}-metric`} width={tc.time !== undefined ? tc.time - tc.metric : undefined} flexShrink={0}>
          <Text key={`${x.key}-tokens`} dimColor wrap="truncate-end">
            {wordFit(tokenText(x.tokens), Math.min(GRID.content, ctx.cols - tc.metric))}
          </Text>
        </Box>
      ) : null}
      {bar !== undefined ? inst(ctx, $, bar) : null}
    </Box>
  )
}

/** The budget view in the rich look (spec "Screens: Budget view"): beads per window over their rate trends, OUTPUT, CACHE, COST, then MODELS, AGENTS and THIS WEEK. */
function richBudgetView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box } = $.ui.resolve(ctx.e)
  const { t, cols, now } = ctx
  const b = t.budget
  const p = pace(t, now)
  const cl = cacheLine(t)
  const back = (): void => setBudgetOpen($, false)
  const rows: DeckRowSpec[] = []
  const cell = (col: number, text: string, extra: Omit<Run, 'text'> = {}): Placed => ({ col, text, ...extra })
  const wide = cols >= 62
  rows.push({
    key: 'budget-back',
    label: 'WINDOW',
    onPress: back,
    cells: [cell(26, 'per 10m', { dim: true }), cell(DECK.value, 'used', { dim: true }), cell(DECK.aside, 'resets', { dim: true })],
  })
  const wins: { key: string; pct: number; reset?: number; tokens?: number }[] = []
  if (b?.contextPct !== undefined) wins.push({ key: 'context', pct: b.contextPct, ...(b.contextTokens !== undefined ? { tokens: b.contextTokens } : {}) })
  for (const w of b?.windows ?? []) wins.push({ key: w.name, pct: w.pct, ...(w.resetsAt !== undefined ? { reset: w.resetsAt } : {}) })
  if (wins.length === 0) rows.push({ key: 'budget-none', label: [{ text: 'No reading yet.', dim: true }] })
  for (const w of wins) {
    const name = labelOf(w.key)
    const hot = w.pct >= 70
    const pr = paceFor(p, w.key)
    const cells: Placed[] = [cell(DECK.value, `${Math.round(w.pct)}%`, { bold: true, ...(hot ? { color: rateColor(w.pct) } : {}) })]
    if (w.reset !== undefined) cells.push(cell(DECK.aside, w.reset <= now ? 'now' : `in ${elapsed(now, w.reset)}`, { dim: true }))
    else if (w.tokens !== undefined) cells.push(cell(DECK.aside, `${tokenText(w.tokens)} tokens`, { dim: true }))
    rows.push({ key: `budget-${name.toLowerCase()}`, label: name, inst: beadsSpec(`win-${name.toLowerCase()}`, 22, w.pct), cells })
    // The rate trend appears only once the window has moved enough to have a pace (pace is silent early).
    if (pr !== undefined) {
      const amber = pr.beforeReset === true
      const trend = barsSpec(`rate-${name.toLowerCase()}`, 1, pr.trend, pr.trend.map(() => (amber ? 'amber' : w.pct >= 90 ? 'red' : 'iris')))
      rows.push({
        key: `budget-pace-${name.toLowerCase()}`,
        inst: trend,
        cells: [
          cell(26, perTen(pr.per10), { dim: true }),
          cell(DECK.value, fullText(pr), amber ? { color: C.wait, bold: true } : { dim: true }),
          ...(pr.shortBy !== undefined ? [cell(DECK.aside, `short ${elapsed(0, pr.shortBy)}`, { color: C.wait })] : []),
        ],
      })
    }
  }
  if (p.outPerMin !== undefined) {
    rows.push({
      key: 'budget-output',
      label: 'OUTPUT',
      cells: [cell(DECK.gauge, `${tokenText(p.outPerMin)}/min`, { bold: true }), cell(26, 'output per minute of turn', { dim: true })],
    })
  }
  if (cl.total > 0) {
    const warm = warmText(cl.warmUntil, now)
    rows.push({
      key: 'budget-cache',
      label: 'CACHE',
      inst: stackSpec('cache', 22, [[cl.read, 'mint'], [cl.write, 'orchid'], [cl.fresh, 'mute']], [C.result, C.model]),
      cells: [
        cell(DECK.value, `${Math.round(cl.readShare * 100)}% read`, { bold: true }),
        ...(warm !== undefined ? [cell(DECK.aside, warm.text, warm.warm ? { color: C.result } : { dim: true })] : []),
      ],
    })
    rows.push({ key: 'budget-cache-sizes', cells: [cell(DECK.gauge, `read ${tokenText(cl.read)}  written ${tokenText(cl.write)}  fresh ${tokenText(cl.fresh)}`, { dim: true })] })
    if (cl.resend !== undefined) rows.push({ key: 'budget-cache-cold', cells: [cell(DECK.gauge, `going cold re-sends ${tokenText(cl.resend)} uncached`, { dim: true })] })
  }
  // The person's explicit opt-in (`showCost`): the one dollar figure.
  if (ctx.showCost === true && b?.costUsd !== undefined) {
    const share = turnShare(t)
    rows.push({
      key: 'budget-cost',
      label: 'COST',
      cells: [cell(DECK.gauge, `${dollars(b.costUsd)} session`, { bold: true }), ...(share !== undefined ? [cell(DECK.value, `${dollars(share)} turn`, { dim: true })] : [])],
    })
  }
  const out: (RenderElement | null)[] = [
    <Box key="budget" flexDirection="column">
      {inst(ctx, $, lintelSpec('budget-lintel', cols, { pill: 'BUDGET', right: 'esc back' }))}
      {rows.map(r => deckRowEl(ctx, $, cols, r))}
      {inst(ctx, $, sillSpec('budget-sill', cols, {}))}
    </Box>,
  ]
  const totals = modelTotals(t)
  const all = totals.reduce((n, x) => n + x.tokens, 0)
  const reportedCount = Object.values(t.agents).filter(a => a.tokensIn !== undefined || a.tokensOut !== undefined).length
  const caps = shareCaps(ctx, heightOf(out), totals.length, reportedCount)
  if (totals.length > 0) {
    const items: Share[] = totals.slice(0, caps.models).map(x => ({ key: `model-${x.model}`, glyph: { text: '◆', color: C.model }, name: x.model, tokens: x.tokens, color: C.model }))
    out.push(
      blank(ctx, $, 'budget-gap-1'),
      section(ctx, $, 'MODELS', 'tokens', 'share'),
      ...items.map(x => richShareRow(ctx, $, x, all, 'orchid')),
      ...(totals.length > items.length ? [more(ctx, $, totals.length - items.length, 'more models')] : []),
    )
  }
  const waits = waitStates(t, ctx.u, now)
  const reported = Object.values(t.agents)
    .filter(a => a.tokensIn !== undefined || a.tokensOut !== undefined)
    .map(a => ({ a, tokens: (a.tokensIn ?? 0) + (a.tokensOut ?? 0) }))
    .sort((x, y) => y.tokens - x.tokens || x.a.id.localeCompare(y.a.id))
  if (reported.length > 0) {
    const sum = reported.reduce((n, x) => n + x.tokens, 0)
    const items: Share[] = reported.slice(0, caps.agents).map(({ a, tokens }) => {
      const pod = podFor(a, waits, now)
      const id = a.id
      return {
        key: `budget-agent-${id}`,
        glyph: pod.hull,
        name: id === 'main' ? 'main' : shortPaths(a.description || a.type),
        tokens,
        color: C.live,
        ...(pod.state === 'done' || pod.state === 'queued' ? { dim: true } : {}),
        ...(id !== 'main' ? { onPress: () => openAgentPage($, id, `budget-agent-${id}`) } : {}),
      }
    })
    out.push(
      blank(ctx, $, 'budget-gap-2'),
      section(ctx, $, 'AGENTS', 'tokens', 'share'),
      ...items.map(x => richShareRow(ctx, $, x, sum, 'iris')),
      ...(reported.length > items.length ? [more(ctx, $, reported.length - items.length, 'more agents')] : []),
    )
    const low = cl.byAgent.find(x => x.readShare < 0.3 && x.read + x.write + x.fresh >= 10_000 && x.id !== 'main')
    if (low !== undefined) {
      const a = t.agents[low.id]
      out.push(
        runsLine(ctx.e, $, [{ col: COL.name, text: wordFit(`${shortPaths(a?.description || low.type)} reads only ${Math.round(low.readShare * 100)}% from cache`, ctx.cols - COL.name), dim: true }], 'budget-cache-low'),
      )
    }
  }
  out.push(...weekBlock(ctx, $, wide))
  return <Box flexDirection="column">{out.filter((x): x is RenderElement => x !== null)}</Box>
}

/** THIS WEEK (the ledger, spec "Features: Ledger"): the header with the week's tokens and sessions, the seven stacked day columns, the weekdays. Empty ledger: nothing. */
function weekBlock(ctx: ViewCtx, $: EngineInterface, wide: boolean): RenderElement[] {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const days = week(ledger, ctx.now)
  const total = days.reduce((n, d) => n + d.total, 0)
  const sessions = days.reduce((n, d) => n + d.sessions, 0)
  if (total === 0 && sessions === 0) return []
  const segs: Placed[] = [{ col: 0, text: '┌', color: C.accent }, { col: COL.glyph, text: 'THIS WEEK', bold: true }]
  if (ctx.cols >= 50) segs.push({ col: DECK.value, text: `${tokenText(total)} tokens`, dim: true })
  if (ctx.cols >= 62) segs.push({ col: DECK.aside, text: `${sessions} ${sessions === 1 ? 'session' : 'sessions'}`, dim: true })
  const out: RenderElement[] = [blank(ctx, $, 'budget-gap-3'), runsLine(ctx.e, $, segs, 'sec-this-week')]
  const { spec, primary, second } = weekSpec(days)
  const useCost = ctx.showCost === true && days.some(d => d.usd !== undefined)
  if (DECK.gauge + spec.columns <= ctx.cols && wide) {
    out.push(
      <Box key="week-row" flexDirection="row">
        <Box key="week-legend" flexDirection="column" width={DECK.gauge} paddingLeft={COL.name} flexShrink={0}>
          {primary !== undefined ? (
            <Text key="week-primary" color={C.model} wrap="truncate-end">
              {wordFit(modelName(primary), 9)}
            </Text>
          ) : null}
          {second ? (
            <Text key="week-rest" color={C.live} wrap="truncate-end">
              others
            </Text>
          ) : null}
        </Box>
        {inst(ctx, $, spec)}
      </Box>,
      <Text key="week-days" dimColor wrap="truncate-end">
        {' '.repeat(DECK.gauge) + days.map((d, i) => weekdayOf(d.day) + (i < days.length - 1 ? '   ' : '')).join('')}
      </Text>,
    )
  } else {
    out.push(runsLine(ctx.e, $, [{ col: COL.glyph, text: sparkText(days.map(d => d.total)) }], 'week-spark'))
  }
  if (useCost) {
    const usd = days.reduce((n, d) => n + (d.usd ?? 0), 0)
    out.push(runsLine(ctx.e, $, [{ col: COL.glyph, text: `${dollars(usd)} this week`, dim: true }], 'week-cost'))
  }
  return out
}
