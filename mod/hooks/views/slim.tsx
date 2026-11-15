import type { EngineInterface, RenderElement } from 'claude-code'

import { wordFit } from './fit'
import type { ViewCtx } from './shell'
import { C, COL } from './style'

/**
 * The pane under 32 columns (spec "Slim mode"): one stacked summary, no tab
 * bar. The shell calls it whenever `ctx.cols < 32`, whatever the tab.
 *
 * A placeholder until H2 builds the stack: the focus line alone, `▍` in the
 * accent at 0 and the focus bold at 2, cut by word to the width.
 */
export function slimView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const focus = ctx.t.now?.focus ?? 'Idle. Nothing running yet.'
  return (
    <Box flexDirection="column">
      <Text key="slim-focus" wrap="truncate-end">
        <Text color={C.accent}>▍</Text>
        {' '}
        <Text bold>{wordFit(focus, ctx.cols - COL.glyph)}</Text>
      </Text>
    </Box>
  )
}
