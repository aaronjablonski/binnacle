import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'raster-spike',
  component: 'Pane',
  requestId: 'raster-spike',
  props: {
    title: 'Raster spike',
    isFocused: true,
    bodyColumns: 62,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const RASTERS = ['sprites', 'bar', 'ring', 'pill', 'meter', 'anim', 'braille', 'quads']

test('/spike opens the pane, 62 columns, with focus', async ($, on) => {
  const opened: Record<string, unknown>[] = []
  on('command.register', () => ({ value: { command: 'spike' } }))
  on('ui.open', (_, e) => {
    opened.push(e as unknown as Record<string, unknown>)
    return { value: { isPlaced: true as const } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const got = await $.command.run({ command: 'spike', args: '' } as never)

  expect(got.text).toContain('open')
  expect(opened[0]).toMatchObject({ id: 'raster-spike', title: 'Raster spike', columns: 62, focus: true })
})

test('/spike close closes the pane', async ($, on) => {
  const closed: unknown[] = []
  on('ui.close', (_, e) => {
    closed.push(e)
    return { value: undefined }
  })

  const got = await $.command.run({ command: 'spike', args: 'close' } as never)

  expect(got.text).toContain('closed')
  expect(closed).toHaveLength(1)
})

test('the terminal draws every Raster, the Image and a fallback line each', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  for (const key of RASTERS) {
    const raster = await ui.find({ type: 'Raster', key })
    expect(raster?.key).toBe(key)
    expect(typeof raster?.props.cells).toBe('string')
  }
  expect((await ui.find({ type: 'Image', key: 'image' }))?.props.columns).toBe(16)
  expect(await ui.findAll({ type: 'Text', text: /fallback:/ })).toHaveLength(RASTERS.length)
  await ui.unmount()
})

test('other surfaces get a line, not a refused tree', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /terminal-only/ }))?.text).toContain('desktop')
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  await ui.unmount()
})
