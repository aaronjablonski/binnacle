// Where the desktop app's Svg forms are drawn (rich spec "Surfaces and
// fallbacks"): the look a surface takes, and the deck and band as elements.
// The documents themselves are svg.ts's pure functions.

import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { Timeline, UiState } from '../../types'
import type { ViewCtx } from './shell'
import { lookOf } from './style'
import type { Look, LookOptions } from './style'
import { bandAlt, bandSvg, nowDeckAlt, nowDeckSvg } from './svg'

/**
 * The look a draw on `surface` takes: `lookOf`'s, with the Svg kept to the
 * desktop app. VS Code would draw it as a still image and mobile is text
 * only (spec "Surfaces"), so both take the text form.
 */
export function lookFor(table: object, surface: string, options: LookOptions = {}): Look {
  const look = lookOf(table, options)
  return look === 'svg' && surface !== 'desktop' ? 'text' : look
}

/**
 * Now's deck as one interactive Svg when the look is `svg` (the desktop
 * app), else null: the caller draws its own deck. It takes no presses, so
 * every pressable row stays a Button outside it.
 *
 * @example ctx.look === 'svg' ? deckSvg(ctx, $) : richDeck(ctx, $, rows, opts)
 */
export function deckSvg(ctx: ViewCtx, $: EngineInterface): RenderElement | null {
  const table = $.ui.resolve(ctx.e)
  if (ctx.look !== 'svg' || !('Svg' in table)) return null
  const { Box, Svg } = table
  return (
    <Box key="now-svg">
      <Svg source={nowDeckSvg(ctx.t, ctx.u, ctx.now, ctx.cols)} alt={nowDeckAlt(ctx.t, ctx.u, ctx.now)} isInteractive />
    </Box>
  )
}

/** What the band's Svg reads: the band's render input and its look, the state, the clock and its width. */
export type BandSvgArgs = { e: RenderInput; look: Look; t: Timeline; u: UiState; now: number; cols: number }

/**
 * The band as one interactive Svg when the look is `svg`, else null: the
 * band draws its own rows. `/mc` and any press stay outside it.
 *
 * @example const svg = bandSvgOf($, { e, look, t, u, now, cols: e.props.bodyColumns }); if (svg !== null) return svg
 */
export function bandSvgOf($: EngineInterface, a: BandSvgArgs): RenderElement | null {
  const table = $.ui.resolve(a.e)
  if (a.look !== 'svg' || !('Svg' in table)) return null
  const { Box, Svg } = table
  return (
    <Box key="band-svg">
      <Svg source={bandSvg(a.t, a.u, a.now, a.cols)} alt={bandAlt(a.t, a.u, a.now)} isInteractive />
    </Box>
  )
}
