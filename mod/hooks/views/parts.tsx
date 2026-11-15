import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import { fit, headerParts } from './fit'
import type { ViewCtx } from './shell'
import { C } from './style'

const MIN_SPLIT = 8

/**
 * `LABEL ─── meta` as one Text of three runs (so a Button may hold it): the
 * label in the accent, bold; the rule in `subtle`; the meta dim. The runs sum
 * to `cols`; the meta gives way first, then the rule.
 */
export function sectionHeader(label: string, meta: string, cols: number, e: RenderInput, $: EngineInterface): RenderElement {
  const { Text } = $.ui.resolve(e)
  const p = headerParts(label, meta, cols)
  return (
    <Text>
      <Text color={C.accent} bold>
        {p.label}
      </Text>
      {p.rule !== '' ? <Text color={C.rule}>{p.rule}</Text> : null}
      {p.meta !== '' ? <Text dimColor>{p.meta}</Text> : null}
    </Text>
  )
}

/**
 * A glyph in its status colour (dim when it has none), a space and the text;
 * the whole fits `ctx.cols`. `indent` is plain spaces before the glyph.
 */
export function glyphLine(
  ctx: ViewCtx,
  $: EngineInterface,
  glyph: string,
  color: string | undefined,
  text: string,
  bold = false,
  indent = '',
): RenderElement {
  const { Text } = $.ui.resolve(ctx.e)
  const body = fit(text, Math.max(0, ctx.cols - indent.length - glyph.length - 1))
  return (
    <Text>
      {indent !== '' ? indent : null}
      {color !== undefined ? <Text color={color}>{glyph}</Text> : <Text dimColor>{glyph}</Text>}
      {bold ? <Text bold>{` ${body}`}</Text> : ` ${body}`}
    </Text>
  )
}

/** Left text and a dim right text on one row, or two rows when they do not fit. */
export function splitLine(
  ctx: ViewCtx,
  $: EngineInterface,
  glyph: string,
  color: string | undefined,
  left: string,
  right: string,
  bold = false,
  indent = '',
): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const room = ctx.cols - right.length - 1
  if (right === '') return glyphLine(ctx, $, glyph, color, left, bold, indent)
  if (room < MIN_SPLIT) {
    return (
      <Box flexDirection="column">
        {glyphLine(ctx, $, glyph, color, left, bold, indent)}
        <Text dimColor>{fit(right, ctx.cols)}</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="row" justifyContent="space-between">
      {glyphLine({ ...ctx, cols: room }, $, glyph, color, left, bold, indent)}
      <Text dimColor>{right}</Text>
    </Box>
  )
}

/** A status glyph as a Text: in its colour, or dim when it has none. */
export function glyphText(glyph: string, color: string | undefined, e: RenderInput, $: EngineInterface, key?: string): RenderElement {
  const { Text } = $.ui.resolve(e)
  return color !== undefined ? (
    <Text key={key} color={color}>
      {glyph}
    </Text>
  ) : (
    <Text key={key} dimColor>
      {glyph}
    </Text>
  )
}

/** The dim gap and right text that push `right` to the edge of `cols` after `used` cells; ' right' when it cannot be flush. */
export function flushRight(used: number, right: string, cols: number): string {
  return `${' '.repeat(Math.max(1, cols - used - right.length))}${right}`
}
