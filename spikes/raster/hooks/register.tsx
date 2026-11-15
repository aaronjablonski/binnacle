import type { EngineInterface, Register, Timer } from 'claude-code'

import { bar, barText, imageRgba, meter, pill, ring, SEGMENTS, sprites } from './card'

// Throwaway spike: does the terminal (VS Code's, on Windows) draw Raster cells?

export const PANE = 'raster-spike'
const OPEN = { id: PANE, title: 'Raster spike', columns: 62, focus: true } as const

// The animated bar's state lives in the module: a reload starts it over.
let frame = 0
let timer: Timer | undefined
let blits = 0
let denied = 0
let warned = false

const animFill = () => (frame * 3) % (SEGMENTS + 1)

/**
 * One tick a second: the bar's fill moves and the new cells are blitted. A
 * denied blit (the surface took no cells) falls back to a redraw, and the
 * first denial is toasted so the person sees why.
 */
function startAnimation($: EngineInterface): void {
  if (timer !== undefined) return
  timer = $.clock.every(1000, () => {
    frame++
    void $.ui
      .blit({ requestId: PANE, key: 'anim', cells: bar(animFill()).cells })
      .then(got => {
        if (got.deny === undefined) {
          blits++
          return
        }
        denied++
        if (!warned) {
          warned = true
          $.ui.toast(`raster-spike: blit denied (${got.deny}); redrawing instead`)
        }
        $.ui.invalidate('ui.render')
      })
      .catch(err => {
        denied++
        $.ui.log(`raster-spike: blit threw: ${String(err)}`, { to: 'debug' })
        $.ui.invalidate('ui.render')
      })
    $.ui.status(`raster-spike frame ${frame} (blits ${blits}, denied ${denied})`)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'spike',
      description: 'Open the Raster test card (/spike close closes it)',
    })
    return next(e)
  })

  on('command.run', { command: 'spike' }, async ($, e) => {
    if (e.args.trim() === 'close') {
      timer?.cancel()
      timer = undefined
      await $.ui.close({ id: PANE })
      return { text: 'Raster spike closed.' }
    }
    const opened = await $.ui.open(OPEN)
    if (!opened.isPlaced) return { text: `Raster spike not placed: ${opened.reason}` }
    startAnimation($)
    return { text: 'Raster spike open. /spike close closes it.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const settled = await next(e)
    timer?.cancel()
    timer = undefined
    $.ui.status(undefined)
    return settled
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text>Raster is terminal-only; this surface is {e.surface}.</Text>
        </Box>
      )
    }
    const { Box, Text, Raster, Image } = $.ui.resolve({ ...e, surface: 'terminal' as const })
    const g1 = sprites()
    const g2 = bar(24)
    const g3 = ring(42)
    const g4 = pill(' WORKING ')
    const g5 = meter(17)
    const g7 = bar(animFill())
    const img = imageRgba()
    const label = (s: string) => <Text dimColor>{s}</Text>
    const fallback = (s: string) => <Text dimColor>  fallback: {s}</Text>
    return (
      <Box flexDirection="column">
        {label('1. Pixel sprites (half-blocks, 2 px per cell)')}
        <Raster key="sprites" columns={g1.columns} rows={g1.rows} cells={g1.cells} />
        {fallback('diamond / round / square / triangle crew')}
        {label('2. Segmented progress bar (24/40, amber to yellow)')}
        <Raster key="bar" columns={g2.columns} rows={g2.rows} cells={g2.cells} />
        {fallback(barText(24))}
        {label('3. Ring gauge (quadrant blocks, 42%)')}
        <Raster key="ring" columns={g3.columns} rows={g3.rows} cells={g3.cells} />
        {fallback('ring 42%')}
        {label('4. Pill')}
        <Raster key="pill" columns={g4.columns} rows={g4.rows} cells={g4.cells} />
        {fallback('( WORKING )')}
        {label('5. Thin usage meter (17/40)')}
        <Raster key="meter" columns={g5.columns} rows={g5.rows} cells={g5.cells} />
        {fallback('usage 17/40')}
        {label('6. Image (needs terminal image support)')}
        <Image
          key="image"
          source={img}
          columns={16}
          rows={4}
          alt="[image: gradient with a circle; this terminal draws no images]"
        />
        {label('7. Animated bar ($.clock.every 1s + $.ui.blit)')}
        <Raster key="anim" columns={g7.columns} rows={g7.rows} cells={g7.cells} />
        {fallback('the bar above should grow by 3 segments a second')}
      </Box>
    )
  })
}
