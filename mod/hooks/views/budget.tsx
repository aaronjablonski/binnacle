import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow, Budget, BudgetWindow, Timeline } from '../../types'
import { budgetOf } from '../model/usage'
import { apply, debug, errText, leaveDetail, readTimeline, readUi, updateUi } from '../state'
import { bar, clock, elapsed, meter, shortPaths, wordFit } from './fit'
import { laid } from './lay'
import type { Placed } from './lay'
import { podFor, waitStates } from './needs'
import { blank, deck, more, section } from './parts'
import type { DeckCell, DeckRow, ReadoutCell, Run } from './parts'
import type { ViewCtx } from './shell'
import { C, COL, DECK, GRID, tableCols } from './style'

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

type Row = { label: string; pct: number; reset?: string; at?: number }

function rowsOf(b: Budget, now: number): Row[] {
  const rows: Row[] = []
  if (b.contextPct !== undefined) rows.push({ label: 'ctx', pct: b.contextPct })
  for (const w of b.windows) {
    const row: Row = { label: windowName(w.name), pct: w.pct }
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
  // The person's explicit opt-in (`showCost`): the one exception to Neo's "no dollar figure".
  if (ctx.showCost === true && b?.costUsd !== undefined) {
    deckRows.push({ key: 'budget-cost', label: 'COST', cells: [{ col: wide ? DECK.value : 8, runs: [{ text: dollars(b.costUsd), bold: true }] }] })
  }
  out.push(deck(ctx, $, deckRows, { key: 'budget', side: slim ? 'left' : 'both' }))

  const totals = modelTotals(t)
  if (totals.length > 0) {
    const all = totals.reduce((n, x) => n + x.tokens, 0)
    const items: Share[] = totals.slice(0, MAX_LIST).map(x => ({
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
    const items: Share[] = reported.slice(0, MAX_LIST).map(({ a, tokens }) => {
      const pod = podFor(a, waits, now)
      const id = a.id
      return {
        key: `budget-agent-${id}`,
        glyph: pod.hull,
        name: id === 'main' ? 'main' : shortPaths(a.description || a.type),
        tokens,
        color: C.live,
        ...(pod.state === 'done' || pod.state === 'queued' ? { dim: true } : {}),
        ...(id !== 'main' ? { onPress: () => updateUi($, u => ({ ...leaveDetail(u), tab: 'agents', agentOpen: id })) } : {}),
      }
    })
    out.push(blank(ctx, $, 'budget-gap-2'), ...shareTable(ctx, $, 'AGENTS', items, all, reported.length - items.length))
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
