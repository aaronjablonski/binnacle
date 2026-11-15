import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow, Budget, Timeline } from '../../types'
import { debug, errText, readTimeline, readUi, updateUi } from '../state'
import { blockBar, elapsed, fit } from './fit'
import { sectionHeader } from './parts'
import type { ViewCtx } from './shell'
import { C } from './style'

/** A budget older than this is a restored one: it was toasted (or not) when it arrived. */
const FRESH_MS = 30_000
const CONTEXT_TOAST = 80
const WINDOW_FROM = 70
const WINDOW_STEP = 10
// Under this width, or off the dock, the section is one line.
const COMPACT = 40
const MIN_BAR = 6
const MAX_BAR = 30

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

function fillColor(pct: number): string {
  if (pct >= 90) return C.error
  if (pct >= WINDOW_FROM) return C.running
  return C.done
}

// The compact seat is judged on the pane's placement and width.
function isCompact(ctx: ViewCtx): boolean {
  const props = (ctx.e as { props?: { placement?: string } }).props
  return ctx.cols < COMPACT || (props?.placement !== undefined && props.placement !== 'dock')
}

/**
 * BUDGET: a block bar for the context and one per window, each with its
 * percentage and reset time; one dim line on a narrow or inline seat. Null
 * until the first measure has something to show.
 */
export function budgetSection(ctx: ViewCtx, $: EngineInterface): RenderElement | null {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const { t, cols, now } = ctx
  const b = t.budget
  const showCost = ctx.showCost === true
  if (b === undefined) return null
  const rows = rowsOf(b, now)
  if (rows.length === 0) return null
  if (isCompact(ctx)) {
    return (
      <Text key="budget" dimColor>
        {fit(budgetLine(b, showCost), cols)}
      </Text>
    )
  }
  const width = Math.max(...rows.map(r => r.label.length))
  const meta = showCost && b.costUsd !== undefined ? dollars(b.costUsd) : ''
  return (
    <Box key="budget" flexDirection="column">
      {sectionHeader('BUDGET', meta, cols, ctx.e, $)}
      {rows.map(r => {
        const label = r.label.padEnd(width)
        const pct = percent(r.pct)
        let tail = ` ${pct}${r.reset !== undefined ? ` · ${r.reset}` : ''}`
        let bar = Math.min(MAX_BAR, cols - width - 1 - tail.length)
        if (bar < MIN_BAR) {
          tail = ` ${pct}`
          bar = Math.min(MAX_BAR, cols - width - 1 - tail.length)
        }
        if (bar < MIN_BAR) return <Text key={`budget-${r.label}`}>{fit(`${label} ${pct}`, cols)}</Text>
        const blocks = blockBar(Math.max(0, Math.min(100, r.pct)), 100, bar)
        return (
          <Text key={`budget-${r.label}`}>
            <Text dimColor>{label} </Text>
            <Text color={fillColor(r.pct)}>{blocks.filled}</Text>
            <Text color={C.rule}>{blocks.rest}</Text>
            <Text>{tail}</Text>
          </Text>
        )
      })}
    </Box>
  )
}

/** BY MODEL: one dim totals line per model under the Agents list. Null with no usage yet. */
export function modelsSection(ctx: ViewCtx, $: EngineInterface): RenderElement | null {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const totals = modelTotals(ctx.t)
  if (totals.length === 0) return null
  return (
    <Box key="models" flexDirection="column">
      {sectionHeader('BY MODEL', 'tokens', ctx.cols, ctx.e, $)}
      {totals.map(x => (
        <Text key={`model-${x.model}`} dimColor>
          {fit(`${x.model} ${tokenText(x.tokens)} · ${x.agents} ${x.agents === 1 ? 'agent' : 'agents'}`, ctx.cols)}
        </Text>
      ))}
    </Box>
  )
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
