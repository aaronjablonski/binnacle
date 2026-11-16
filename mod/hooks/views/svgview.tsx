// Where the desktop app's Svg forms are drawn (rich spec "Surfaces and
// fallbacks"): the look a surface takes, and the deck and band as elements.
// The documents themselves are svg.ts's pure functions.

import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { Timeline, UiState } from '../../types'
import { headerState, needs } from '../model/alerts'
import { todoBlock } from '../model/todo'
import type { BandModel } from './bandmodel'
import { budgetWords, nowGauges } from './budget'
import { headline } from './lay'
import { headWords, isRest } from './overview'
import type { Ground } from './raster'
import type { ViewCtx } from './shell'
import { lookOf } from './style'
import type { Look, LookOptions } from './style'
import { bandAlt, bandSvg, nowDeckAlt, nowDeckSvg } from './svg'
import type { DeckHead } from './svg'

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
 * The words of Now's header for the Svg: the terminal header's own functions
 * (`headWords`, `headline`, `budgetWords`, `nowGauges`) over the same needs
 * read (`covered` is the pane's `isPromptCovered`), so the two surfaces say the
 * same thing. `svg.ts` draws them and stays free of these modules.
 *
 * @example nowDeckSvg(t, u, now, cols, deckHead(ctx), ground, covered)
 */
export function deckHead(ctx: Pick<ViewCtx, 't' | 'u' | 'now' | 'isPromptCovered'>): DeckHead {
  const { t, now } = ctx
  const view = needs(t, now, { covered: ctx.isPromptCovered === true })
  const hs = headerState(t, now, view)
  const todo = todoBlock(t, view.items.map(n => n.agent))
  const w = headWords({ ...ctx, cols: 62 } as unknown as ViewCtx, view, hs, todo)
  return {
    pill: w.pill,
    tone: w.pillColor !== undefined ? 'mute' : (w.tone as DeckHead['tone']),
    meta: w.meta,
    kicker: w.kicker,
    lead: w.lead,
    goal: headline(t),
    budget: budgetWords(t, now, { idle: isRest(hs) }),
    gauges: nowGauges(t),
  }
}

/** A press the Svg cannot take, drawn as a plain Button beside it: its key (as the text and rich forms key it), label and handler. */
export type SvgPress = { key: string; label: string; onPress: () => void | Promise<void> }

/** The presses as one row of plain label Buttons, three cells apart, under an Svg. */
function pressRow($: EngineInterface, e: RenderInput, key: string, presses: SvgPress[]): RenderElement | null {
  if (presses.length === 0) return null
  const { Box, Button } = $.ui.resolve(e)
  return (
    <Box key={key} flexDirection="row" columnGap={3} paddingLeft={2}>
      {presses.map(p => (
        <Button key={p.key} plain onPress={p.onPress}>
          {p.label}
        </Button>
      ))}
    </Box>
  )
}

/**
 * Now's deck as one interactive Svg when the look is `svg` (the desktop
 * app), else null: the caller draws its own deck. The Svg takes no presses,
 * so the deck's pressable rows (`presses`: CREW, TASKS, STEPS, BUDGET, keyed
 * as the other forms key them) are a row of label Buttons under it.
 *
 * @example ctx.look === 'svg' ? deckSvg(ctx, $, presses) : richDeck(ctx, $, rows, opts)
 */
export function deckSvg(ctx: ViewCtx, $: EngineInterface, presses: SvgPress[] = []): RenderElement | null {
  const table = $.ui.resolve(ctx.e)
  if (ctx.look !== 'svg' || !('Svg' in table)) return null
  const { Box, Svg } = table
  const head = deckHead(ctx)
  return (
    <Box key="now-svg" flexDirection="column">
      <Svg source={nowDeckSvg(ctx.t, ctx.u, ctx.now, ctx.cols, head, ctx.ground ?? 'night', ctx.isPromptCovered === true)} alt={nowDeckAlt(ctx.t, ctx.u, ctx.now, head, ctx.isPromptCovered === true)} isInteractive />
      {pressRow($, ctx.e, 'now-svg-presses', presses)}
    </Box>
  )
}

/** What the band's Svg reads: the band's render input and its look, the state, the clock and its width; `presses` go beside it. */
export type BandSvgArgs = { e: RenderInput; look: Look; t: Timeline; u: UiState; now: number; cols: number; model?: BandModel; ground?: Ground; presses?: SvgPress[] }

/**
 * The band as one interactive Svg when the look is `svg`, else null: the
 * band draws its own rows. `/mc` and any press stay outside it, as Buttons
 * beside it (`presses`).
 *
 * @example const svg = bandSvgOf($, { e, look, t, u, now, cols: e.props.bodyColumns }); if (svg !== null) return svg
 */
export function bandSvgOf($: EngineInterface, a: BandSvgArgs): RenderElement | null {
  const table = $.ui.resolve(a.e)
  if (a.look !== 'svg' || !('Svg' in table)) return null
  const { Box, Svg } = table
  return (
    <Box key="band-svg" flexDirection="row" columnGap={1}>
      <Svg source={bandSvg(a.t, a.u, a.now, a.cols, a.model, a.ground ?? 'night')} alt={bandAlt(a.t, a.u, a.now, a.model)} isInteractive />
      {pressRow($, a.e, 'band-svg-presses', a.presses ?? [])}
    </Box>
  )
}
