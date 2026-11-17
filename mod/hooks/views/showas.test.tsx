import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Timeline, UiState } from '../../types'
import { initialUi } from '../state'
import { busy, NOW } from './now.fixtures.testkit'
import { screen } from './screen.testkit'

// R55: Show as switches at once, and the band or the strip carries the Show as row while the person tries the styles.

const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }

function world(on: On, t: Timeline, u: UiState) {
  const stored = new Map<string, unknown>([['timeline', t], ['ui', u]])
  const versions = new Map<string, number>()
  const sets: { key: string; value: unknown }[] = []
  const closed: string[] = []
  mock.clock(on, { now: NOW })
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    const v = stored.get(key)
    return { value: { value: v === undefined ? undefined : { shape: SHAPES[key], value: v }, version: versions.get(key) ?? 0 } }
  })
  on('state.set', (_, e) => {
    const w = e as unknown as { key: string; value: { value: unknown } }
    const version = (versions.get(w.key) ?? 0) + 1
    versions.set(w.key, version)
    stored.set(w.key, w.value.value)
    return { value: { isSet: true as const, version } }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', (_, e) => {
    closed.push(String((e as { id?: string }).id))
    return { value: {} } as never
  })
  on('config.set', (_, e) => {
    const w = e as unknown as { key: string; value: unknown }
    sets.push({ key: w.key, value: w.value })
    return { value: w.value } as never
  })
  return { stored, sets, closed }
}

const PANE = {
  plugin: 'binnacle', component: 'Pane', requestId: 'binnacle',
  props: { title: 'Binnacle', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 46 }, view: {} },
} as const
const BAND = {
  plugin: 'binnacle', component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const uiOf = (s: Map<string, unknown>): UiState => s.get('ui') as UiState

test('R55: Enter on Show as switches to band at once: the option is written, the pane closes, Options is left and the try row is on', async ($, on) => {
  const { stored, sets, closed } = world(on, busy(), { ...initialUi, paneOpen: true, page: { kind: 'options', id: '' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'opt-showAs' })
  expect(sets).toEqual([{ key: 'binnacle.showAs', value: 'band' }])
  expect(closed).toContain('binnacle')
  expect(uiOf(stored).page).toBe(undefined)
  expect(uiOf(stored).showAsTry).toBe(true)
  expect(uiOf(stored).strip).toBe(false)
  await ui.unmount()
})

test('R55: the band carries the Show as row with 1 2 3 and 0; 3 switches to the strip, 0 keeps it and the row goes', async ($, on) => {
  const { stored, sets } = world(on, busy(), { ...initialUi, showAsTry: true })
  const band = await $.ui.mount({ ...BAND, surface: 'mobile' })
  for (const [key, hotkey] of [['band-show-pane', '1'], ['band-show-band', '2'], ['band-show-strip', '3'], ['band-show-keep', '0']] as const) {
    expect((await band.find({ type: 'Button', key }))?.props).toMatchObject({ hotkey })
  }
  expect(screen(await band.drawn()).join('\n')).toContain('Show as')
  await band.press({ key: 'band-show-strip' })
  expect(sets.at(-1)).toEqual({ key: 'binnacle.showAs', value: 'strip' })
  expect(uiOf(stored).strip).toBe(true)
  await band.press({ key: 'band-show-keep' })
  expect(uiOf(stored).showAsTry).toBe(undefined)
  await band.redraw()
  expect(await band.find({ type: 'Button', key: 'band-show-pane' })).toBe(undefined)
  await band.unmount()
})

test('R55: 1 on the band goes back to the pane, opened on Options; the try row ends', async ($, on) => {
  const { stored, sets } = world(on, busy(), { ...initialUi, showAsTry: true, strip: true })
  const band = await $.ui.mount({ ...BAND, surface: 'mobile' })
  await band.press({ key: 'band-show-pane' })
  expect(sets.at(-1)).toEqual({ key: 'binnacle.showAs', value: 'pane' })
  expect(uiOf(stored).page).toEqual({ kind: 'options', id: '' })
  expect(uiOf(stored).strip).toBe(false)
  expect(uiOf(stored).showAsTry).toBe(undefined)
  await band.unmount()
})
