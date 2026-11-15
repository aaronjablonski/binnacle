import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow, Budget, BudgetWindow, Timeline } from '../../types'
import { budgetOf } from '../model/usage'
import { apply, debug, errText, readTimeline, readUi, updateUi } from '../state'
import { elapsed, fit, wordFit } from './fit'
import { runsLine } from './lay'
import type { Placed } from './lay'
import { barCell, blank, more, row, section } from './parts'
import type { ReadoutCell, Run } from './parts'
import type { ViewCtx } from './shell'
import { C, GRID, rateColor } from './style'

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

type Row = { label: string; pct: number; reset?: string }

function rowsOf(b: Budget, now: number): Row[] {
  const rows: Row[] = []
  if (b.contextPct !== undefined) rows.push({ label: 'ctx', pct: b.contextPct })
  for (const w of b.windows) {
    const row: Row = { label: windowName(w.name), pct: w.pct }
    if (w.resetsAt !== undefined) row.reset = resetText(w.resetsAt, now)
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

// ---------- the Now readout cells and the budget view ----------

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

/** The hotter of the 5-hour and 7-day windows; the one there is when only one is. */
function hotWindow(b: Budget): BudgetWindow | undefined {
  const five = b.windows.find(w => w.name === 'five_hour')
  const seven = b.windows.find(w => w.name === 'seven_day')
  if (five !== undefined && seven !== undefined) return five.pct > seven.pct ? five : seven
  return five ?? seven
}

const none = (text: string): Run[] => [{ text, dim: true }]

/**
 * The CTX and the 7D (or 5H, when it is the hotter window) readout cells of
 * Now. Pressing either label opens the budget view. They drop last-but-one
 * (CTX, rank 3) and first (the window, rank 1).
 */
export function budgetCells($: EngineInterface, t: Timeline): ReadoutCell[] {
  const b = t.budget
  const open = (): void => setBudgetOpen($, true)
  const pct = b?.contextPct
  const win = b !== undefined ? hotWindow(b) : undefined
  return [
    {
      label: 'CTX',
      key: 'readout-ctx',
      onPress: open,
      drop: 3,
      value: pct !== undefined ? percent(pct) : none('–'),
      gfx: barCell(pct ?? 0, 100, pct !== undefined ? rateColor(pct) : undefined),
    },
    {
      label: win !== undefined ? windowName(win.name).toUpperCase() : '7D',
      key: 'readout-window',
      onPress: open,
      drop: 1,
      value: win !== undefined ? percent(win.pct) : none('–'),
      gfx: barCell(win?.pct ?? 0, 100, win !== undefined ? rateColor(win.pct) : undefined),
    },
  ]
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
      gfx: barCell(share, 100, C.model),
      drop: 2 - i,
    }
  })
}

const MAX_LIST = 6

// The runs cut to `n` characters (a bar shortens by its rest).
function shrink(runs: Run[], n: number): Run[] {
  const out: Run[] = []
  let left = n
  for (const r of runs) {
    if (left <= 0) break
    out.push({ ...r, text: r.text.slice(0, left) })
    left -= r.text.length
  }
  return out
}

/**
 * The budget view (spec "Now": one press from the readouts): `b: back`, then
 * every window (CTX first) as label at 2, value at 8, a 10-column bar at 14
 * and its reset at 26 (on its own line at 8 when the width is under 40), the
 * cost when asked for, and one row per model with its tokens and agents.
 */
export function budgetView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { t, cols, now } = ctx
  const b = t.budget
  const out: (RenderElement | null)[] = [
    <Box key="budget-top" flexDirection="row" paddingLeft={GRID.margin}>
      <Button key="budget-back" hotkey="b" plain onPress={() => setBudgetOpen($, false)}>
        back
      </Button>
    </Box>,
    blank(ctx, $, 'budget-gap-0'),
    section(ctx, $, 'BUDGET'),
  ]
  const rows = b !== undefined ? rowsOf(b, now) : []
  if (b === undefined || rows.length === 0) {
    out.push(<Text key="budget-none" dimColor>{'  No reading yet.'}</Text>)
  }
  const room = Math.max(0, Math.min(GRID.content, cols - 14))
  const inline = cols >= 40
  for (const r of rows) {
    const label = fit(r.label.toUpperCase(), 5)
    const bar = barCell(Math.max(0, Math.min(100, r.pct)), 100, rateColor(r.pct))
    const barRuns = shrink(bar, room)
    const segs: Placed[] = [
      { col: GRID.margin, text: label, dim: true },
      { col: 8, text: percent(r.pct), bold: true },
      ...barRuns.map((x, i) => ({ ...x, col: 14 + (i === 0 ? 0 : (barRuns[0]?.text.length ?? 0)) })),
    ]
    if (inline && r.reset !== undefined) segs.push({ col: 26, text: wordFit(r.reset, cols - 26), dim: true })
    out.push(runsLine(ctx.e, $, segs, `budget-${r.label}`))
    if (!inline && r.reset !== undefined) {
      out.push(runsLine(ctx.e, $, [{ col: 8, text: wordFit(r.reset, cols - 8), dim: true }], `budget-${r.label}-reset`))
    }
  }
  if (ctx.showCost === true && b?.costUsd !== undefined) {
    out.push(runsLine(ctx.e, $, [{ col: GRID.margin, text: 'COST', dim: true }, { col: 8, text: dollars(b.costUsd), bold: true }], 'budget-cost'))
  }
  const totals = modelTotals(t)
  if (totals.length > 0) {
    out.push(blank(ctx, $, 'budget-gap-1'), section(ctx, $, 'BY MODEL', 'tokens', 'agents'))
    for (const x of totals.slice(0, MAX_LIST)) {
      out.push(
        row(ctx, $, {
          key: `model-${x.model}`,
          glyph: '·',
          name: x.model,
          metric: tokenText(x.tokens),
          time: `${x.agents} ${x.agents === 1 ? 'agent' : 'agents'}`,
        }),
      )
    }
    if (totals.length > MAX_LIST) out.push(more(ctx, $, totals.length - MAX_LIST))
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
