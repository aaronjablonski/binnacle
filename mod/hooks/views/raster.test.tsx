import { expect, test } from 'claude-code/testing'

import { RING, ring, SPRITE, sprite, encode } from './raster'

// The engine's own check of what raster.ts encodes: a pane drawing one
// Raster from sprite() and one from ring() mounts on the terminal surface,
// whose table validates every cell (one printable width-1 BMP glyph,
// colours 0x00RRGGBB or the default, columns x rows cells). The pane is
// drawn by this test beneath the mod, so the tree checked is raster.ts's
// output alone. A tree the table refuses skips the hook and fails the test
// by itself, naming the cell (checked by hand: U+4E2D, U+0009 and a cells
// string of the wrong length are each refused, the last as "512 characters
// for 8x4", i.e. 12 bytes a cell).

const PROBE = 'raster-probe'

const MOUNT = {
  plugin: 'mission-control',
  component: 'Pane',
  requestId: PROBE,
  surface: 'terminal',
  props: {
    title: 'probe',
    isFocused: true,
    bodyColumns: 62,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('a pane with a Raster from sprite() and one from ring() is not refused on the terminal', async ($, on) => {
  const lead = sprite('lead', 'waiting', 'L')
  const dial = ring('5H', 78)
  on('ui.render', { component: 'Pane', requestId: PROBE }, ($, e) => {
    const { Box, Raster, Text } = $.ui.resolve({ ...e, surface: 'terminal' as const })
    return (
      <Box flexDirection="row" columnGap={1}>
        <Raster key="lead" columns={lead.columns} rows={lead.rows} cells={encode(lead)} />
        <Raster key="ring" columns={dial.columns} rows={dial.rows} cells={encode(dial)} />
        <Text>5H 78%</Text>
      </Box>
    )
  })

  const ui = await $.ui.mount(MOUNT as never)

  const a = await ui.find({ type: 'Raster', key: 'lead' })
  const b = await ui.find({ type: 'Raster', key: 'ring' })
  expect(a?.props.columns).toBe(SPRITE.L.columns)
  expect(a?.props.rows).toBe(SPRITE.L.rows)
  expect(b?.props.columns).toBe(RING.columns)
  expect(b?.props.rows).toBe(RING.rows)
  await ui.unmount()
})

test('every sprite and the ring at 0 and 100 mount in one pane', async ($, on) => {
  const grids = [
    ...(['lead', 'scout', 'build', 'check'] as const).flatMap(role =>
      (['queued', 'working', 'done', 'waiting', 'stalled', 'failed'] as const).flatMap(state => [
        sprite(role, state, 'L'),
        sprite(role, state, 'S', { lamp: 'dim' }),
      ]),
    ),
    ring('CTX', 0),
    ring('7D', 100),
  ]
  on('ui.render', { component: 'Pane', requestId: PROBE }, ($, e) => {
    const { Box, Raster } = $.ui.resolve({ ...e, surface: 'terminal' as const })
    return (
      <Box flexDirection="column">
        {grids.map((g, i) => (
          <Raster key={`g${i}`} columns={g.columns} rows={g.rows} cells={encode(g)} />
        ))}
      </Box>
    )
  })

  const ui = await $.ui.mount(MOUNT as never)
  expect(await ui.findAll({ type: 'Raster' })).toHaveLength(grids.length)
  await ui.unmount()
})
