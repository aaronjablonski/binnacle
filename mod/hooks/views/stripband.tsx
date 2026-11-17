import type { EngineInterface, RenderElement } from 'claude-code'

import { blank, heightOf } from './parts'
import { needsSlot } from './needs'
import {
  agentsSection, cardAgents, dealRows, HEADER_ROWS, isRest, nowHeader, nowState, todoSection, todoWants,
} from './overview'
import type { NowState } from './overview'
import { footerRow } from './tabkit'
import type { ViewCtx } from './shell'
import { TAB_ROWS } from './shell'
import { watchBlock } from './watch'
import { prBlock, prHints } from './prblock'
import type { Press } from './watch'

// The inline strip (R34; unmocked): Now's header on the left, To do and
// Agents on the right, from the same cockpit parts and on the same columns.
// The pane draws it from 96 columns (`stripNow`); the band draws it in place
// of the pane while `/binnacle strip` is on (`stripBandView`), over its compact
// line, with every press opening the pane on what it names.

/** The left column's width: Now's header at its full 62 columns. */
export const STRIP_LEFT = 62

/**
 * What the band's strip is handed: the rows the band may take (its
 * `maxRows`), the band's own compact line to draw under the strip, and
 * what a press does once its own write is done (the pane opens).
 */
export type BandStrip = { maxRows: number; line: RenderElement; after: () => Promise<void> }

/** A press, then `after` once it is done: the band's strip opens the pane after a row's own write. */
export function andThen(press: () => void | Promise<void>, after?: () => Promise<void>): () => void | Promise<void> {
  if (after === undefined) return press
  return async () => {
    await press()
    await after()
  }
}

/** The elements that fit `rows`, whole, in order: the first that does not fit ends the list. */
function upTo(els: RenderElement[], rows: number): RenderElement[] {
  const out: RenderElement[] = []
  let used = 0
  for (const el of els) {
    const tall = heightOf(el)
    if (used + tall > rows) break
    out.push(el)
    used += tall
  }
  return out
}

/** Whether the ask takes the right column's first rows (R3-B I7): a need is up, so its sentence, command and chip must not sit under the header's gauges below the strip's fold. */
const asks = (st: NowState): boolean => st.view.items.length > 0

/** The needs slot as the strip draws it: one need whole (`cap: 1`), the Watch count on its all-clear line. */
function needsRows(ctx: ViewCtx, $: EngineInterface, st: NowState, press?: Press): RenderElement[] {
  return needsSlot(ctx, $, st.view, { watchCount: st.watch.length, cap: 1, ...(press !== undefined ? { press } : {}) })
}

/** The left column: the header, and (when nothing asks) a blank and the all-clear line. An ask is the right column's first block. */
function leftColumn(ctx: ViewCtx, $: EngineInterface, st: NowState, press?: Press): RenderElement[] {
  const head = nowHeader(ctx, $, st.view, st.hs, st.todo, press !== undefined ? { press } : {})
  // R46: the PR and its stack under the header.
  const pr = prBlock(ctx, $, press !== undefined ? { press } : {})
  const prRows = pr.length > 0 ? [blank(ctx, $, 'strip-pr-gap'), ...pr] : []
  return asks(st) ? [head, ...prRows] : [head, blank(ctx, $, 'strip-left-gap'), ...needsRows(ctx, $, st, press), ...prRows]
}

/** The right column in `rows`: To do (floor 3 rows of list, up to 7) and Agents (one card, up to 3), dealt by the height rule. */
function rightColumn(ctx: ViewCtx, $: EngineInterface, st: NowState, rows: number, press?: Press): RenderElement[] {
  const rest = isRest(st.hs)
  const o = press !== undefined ? { press } : {}
  // R3-B I7: the ask (its sentence, command and chip) comes first, then a blank, then To do and Agents in what is left.
  // With nothing asking, the top Watch row stands there instead (R3-B I7: the count alone said "2 things to watch" and never what).
  const ask = asks(st)
    ? [...needsRows(ctx, $, st, press), blank(ctx, $, 'strip-ask-gap')]
    : st.watch.length > 0
      ? [...watchBlock(ctx, $, st.watch, 1, { keys: false, ...o }), blank(ctx, $, 'strip-watch-gap')]
      : []
  const askH = ask.reduce((n, el) => n + heightOf(el), 0)
  const all = rows
  rows = Math.max(0, rows - askH)
  const tw = todoWants(st.todo)
  const cards = cardAgents(ctx.t).length
  const ag = rest || cards === 0 ? { floor: 0, want: 0 } : { floor: 1, want: Math.min(3, cards) }
  const fixed = (st.todo.empty ? 1 : 3) + 1 + (ag.floor > 0 ? 1 : 0)
  const deal = dealRows(rows - fixed - tw.floor - 3 * ag.floor, tw, ag, { floor: 0, want: 0 })
  const todo = todoSection(ctx, $, st.todo, deal.todo, { ...o, ended: isRest(st.hs) })
  const todoH = todo.reduce((n, el) => n + heightOf(el), 0)
  // F M10: fewer cards rather than a cut: the "+ n more working" line is always drawn when a card is left out.
  let cardsShown = Math.max(1, deal.cards)
  let agents = rest ? [] : agentsSection(ctx, $, cardsShown, { view: st.view, watch: st.watch, rest, ...o })
  while (cardsShown > 1 && todoH + 1 + agents.reduce((n, el) => n + heightOf(el), 0) > rows) {
    cardsShown--
    agents = agentsSection(ctx, $, cardsShown, { view: st.view, watch: st.watch, rest, ...o })
  }
  return upTo([...ask, ...todo, ...(agents.length > 0 ? [blank(ctx, $, 'strip-right-gap'), ...agents] : [])], all)
}

/** The two columns side by side: the left at 62, the right taking the rest. */
function columns(ctx: ViewCtx, $: EngineInterface, left: RenderElement[], right: RenderElement[]): RenderElement {
  const { Box } = $.ui.resolve(ctx.e)
  return (
    <Box key="strip" flexDirection="row">
      <Box key="strip-left" flexDirection="column" width={STRIP_LEFT} flexShrink={0}>
        {left}
      </Box>
      <Box key="strip-right" flexDirection="column" width={Math.max(0, ctx.cols - STRIP_LEFT)} flexShrink={0}>
        {right}
      </Box>
    </Box>
  )
}

/**
 * The pane from 96 columns (R34): Now's header and the needs slot in the
 * left 62 columns, To do and Agents in the rest, both to the pane's rows
 * under the tab bar; the footer on the last row when the rows leave it room.
 * Reading order for the focus ring: the left column top to bottom, then the
 * right.
 */
export function stripNow(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const st = nowState(ctx)
  const rows = (ctx.bodyRows ?? 14) - TAB_ROWS
  const leftCtx = { ...ctx, cols: STRIP_LEFT }
  const rightCtx = { ...ctx, cols: ctx.cols - STRIP_LEFT }
  const left = leftColumn(leftCtx, $, st)
  const leftH = left.reduce((n, el) => n + heightOf(el), 0)
  const bar = footerRow(ctx, $, [
    { key: '↵', label: 'open' },
    ...prHints($, ctx),
    { key: 'esc', label: 'prompt' },
  ])
  const withBar = bar !== null && rows - leftH >= 2
  const right = rightColumn(rightCtx, $, st, Math.max(leftH, rows - (withBar ? 2 : 0)))
  const height = Math.max(leftH, right.reduce((n, el) => n + heightOf(el), 0))
  const pad = Math.max(1, rows - 1 - height)
  return (
    <Box flexDirection="column">
      {columns(ctx, $, left, right)}
      {withBar ? Array.from({ length: pad }, (_, i) => <Text key={`strip-pad-${i}`}> </Text>) : null}
      {withBar ? bar : null}
    </Box>
  )
}

/**
 * The band's strip (`/binnacle strip`, R34), over the band's compact line, in at
 * most `maxRows`: from 96 columns the two columns, the right one to the
 * left's height; narrower, the header and the needs slot, then To do and
 * Agents under them, each block whole or not at all. Every row that opens
 * something is a plain Button with no hotkey (a bare digit in an empty
 * prompt can press a band Button); a press opens the pane on what it names.
 */
export function stripBandView(ctx: ViewCtx, $: EngineInterface, opts: BandStrip): RenderElement {
  const { Box } = $.ui.resolve(ctx.e)
  const press: Press = f => andThen(f, opts.after)
  const body = Math.max(0, opts.maxRows - 1)
  const st = nowState(ctx)
  const compact = (
    <Box key="strip-line" flexDirection="column">
      {opts.line}
    </Box>
  )
  if (ctx.cols >= 96 && body >= HEADER_ROWS) {
    const leftCtx = { ...ctx, cols: STRIP_LEFT }
    const left = upTo(leftColumn(leftCtx, $, st, press), body)
    const leftH = left.reduce((n, el) => n + heightOf(el), 0)
    const right = rightColumn({ ...ctx, cols: ctx.cols - STRIP_LEFT }, $, st, asks(st) ? body : leftH, press)
    return (
      <Box flexDirection="column">
        {columns(ctx, $, left, right)}
        {compact}
      </Box>
    )
  }
  const stacked = upTo(
    [
      ...(body >= HEADER_ROWS ? [nowHeader(ctx, $, st.view, st.hs, st.todo, { press }), blank(ctx, $, 'strip-left-gap')] : []),
      ...needsSlot(ctx, $, st.view, { watchCount: st.watch.length, cap: 1, press }),
      // R46: the PR and its stack in the stacked strip too (under 96 columns), counted by upTo like every row.
      ...(prBlock(ctx, $, { press }).length > 0 ? [blank(ctx, $, 'strip-pr-gap'), ...prBlock(ctx, $, { press })] : []),
      blank(ctx, $, 'strip-mid-gap'),
      ...rightColumn(ctx, $, st, Math.max(0, body), press),
    ],
    body,
  )
  return (
    <Box flexDirection="column">
      {stacked}
      {compact}
    </Box>
  )
}
