import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { colOf, screen } from './screen.testkit'

const SURFACES = ['terminal', 'desktop'] as const
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }

type Sets = { key: string; value: unknown }[]

/**
 * The state as the engine holds it, a config.set beneath the plugin that
 * records each write and answers `answer` (written, or a deny), and toasts.
 */
type Answer = (value: unknown) => { value: unknown } | { deny: string }

function world(on: On, u: UiState = initialUi, answer: Answer = v => ({ value: v })) {
  const stored = new Map<string, unknown>([['timeline', empty as Timeline], ['ui', u]])
  const versions = new Map<string, number>()
  const sets: Sets = []
  const toasts: string[] = []
  mock.clock(on, { now: 1_000_000 })
  on('ui.log', () => ({ value: undefined }))
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
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: string }).text))
    return { value: undefined }
  })
  on('config.set', (_, e) => {
    const w = e as unknown as { key: string; value: unknown }
    sets.push({ key: w.key, value: w.value })
    // A config.set the plugin raised is answered with the event's own result.
    return answer(w.value) as never
  })
  return { stored, sets, toasts }
}

const PANE = (columns: number) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    props: {
      title: 'Mission Control',
      isFocused: true,
      bodyColumns: columns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 60 },
      view: {},
    },
  }) as const

const OPTIONS_UI: UiState = { ...initialUi, page: { kind: 'options', id: '' } }

for (const surface of SURFACES) {
  test(`${surface}: 0 opens Options as a page, and 0 again closes it`, async ($, on) => {
    const { stored } = world(on)
    const ui = await $.ui.mount({ ...PANE(80), surface })
    const button = await ui.find({ type: 'Button', key: 'tab-options' })
    expect(button?.props).toMatchObject({ hotkey: '0', plain: true })

    await ui.press({ key: 'tab-options' })
    expect((stored.get('ui') as UiState).page).toEqual({ kind: 'options', id: '' })
    await ui.unmount()
    // The test's own state.get subscribes nothing: a new mount draws what the press wrote.
    const again = await $.ui.mount({ ...PANE(80), surface })
    const rows = screen(await again.drawn())
    expect(rows.some(r => r.includes('NEVER'))).toBe(true)

    await again.press({ key: 'tab-options' })
    expect((stored.get('ui') as UiState).page).toBe(undefined)
    await again.unmount()
  })
}

test('0 is armed at every tab width: on the tab row when it fits, else at the end of the row under it', async ($, on) => {
  world(on)
  for (const cols of [32, 40, 55, 62, 80]) {
    const ui = await $.ui.mount({ ...PANE(cols), surface: 'terminal' })
    expect(await ui.find({ type: 'Button', key: 'tab-options' })).not.toBe(undefined)
    const rows = screen(await ui.drawn())
    const where = rows.findIndex(r => r.includes('0: options'))
    expect(where === 0 || where === 2).toBe(true)
    expect((rows[where] ?? '').length <= cols).toBe(true)
    await ui.unmount()
  }
})

test('/mc options opens the pane on the Options page', async ($, on) => {
  const { stored } = world(on)
  const got = await $.command.run({ command: 'mc', args: 'options' } as never)
  expect((got as { text?: string }).text).toBe('Mission Control: options.')
  expect((stored.get('ui') as UiState).page).toEqual({ kind: 'options', id: '' })
})

test('the card lists every option with its value and when it applies, and a NEVER section', async ($, on) => {
  world(on, OPTIONS_UI)
  const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  const rows = screen(await ui.drawn())
  const rowOf = (name: string) => rows.find(r => r.trimStart().startsWith(name)) ?? ''
  for (const name of ['Notify', 'Agent time limit', 'Turn time limit', 'Show cost', 'Open at start', 'Guide Claude', 'Editor']) {
    expect(colOf(rowOf(name), name)).toBe(4)
  }
  expect(rowOf('Notify').slice(38)).toMatch(/^waits\s+now$/)
  expect(rowOf('Show cost').slice(38)).toMatch(/^off\s+now$/)
  expect(rowOf('Agent time limit').slice(38, 41)).toBe('20m')
  expect(rowOf('Open at start').slice(50)).toBe('next start')
  expect(rowOf('Accent').slice(50)).toBe('coming')
  const never = rows.findIndex(r => r.includes('NEVER'))
  expect(never > 0).toBe(true)
  const after = rows.slice(never + 1, never + 5).join('\n')
  for (const words of ['model', 'effort', 'crew', 'cache warm']) expect(after).toContain(words)
  await ui.unmount()
})

test('drawing the card writes nothing; Enter on a switch writes it once, on the press', async ($, on) => {
  const { sets, toasts } = world(on, OPTIONS_UI)
  const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  await ui.drawn()
  expect(sets.length).toBe(0)

  await ui.press({ key: 'opt-showCost' })
  expect(sets).toEqual([{ key: 'mission-control.showCost', value: true }])
  expect(toasts.join('|')).toContain('Show cost: on')
  const rows = screen(await ui.drawn())
  expect((rows.find(r => r.trimStart().startsWith('Show cost')) ?? '').slice(38, 40)).toBe('on')
  await ui.unmount()
})

test('a deny leaves the option as it was and says why in a toast', async ($, on) => {
  const { sets, toasts } = world(on, OPTIONS_UI, () => ({ deny: 'managed by policy' }))
  const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  await ui.press({ key: 'opt-guide' })
  expect(sets.length).toBe(1)
  expect(toasts).toEqual(['Guide Claude not changed: managed by policy'])
  const rows = screen(await ui.drawn())
  expect((rows.find(r => r.trimStart().startsWith('Guide Claude')) ?? '').slice(38, 40)).toBe('on')
  await ui.unmount()
})

test('a choice opens to its values with hotkeys; a value is written on its press', async ($, on) => {
  const { stored, sets } = world(on, OPTIONS_UI)
  const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  await ui.press({ key: 'opt-notify' })
  expect(sets.length).toBe(0)
  expect((stored.get('ui') as UiState).page).toEqual({ kind: 'options', id: 'notify' })
  await ui.unmount()
  const opened = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  for (const [v, k] of [['off', 'o'], ['waits', 'w'], ['done', 'd'], ['all', 'a']] as const) {
    expect((await opened.find({ type: 'Button', key: `opt-pick-notify-${v}` }))?.props).toMatchObject({ hotkey: k })
  }
  await opened.press({ key: 'opt-pick-notify-all' })
  expect(sets).toEqual([{ key: 'mission-control.notify', value: 'all' }])
  await opened.unmount()
})

test('a number shows − and +, and writes the stepped value', async ($, on) => {
  const { sets } = world(on, { ...initialUi, page: { kind: 'options', id: 'agentLimitMin' } })
  const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  const rows = screen(await ui.drawn())
  expect(rows.some(r => r.includes('l: −5') && r.includes('m: +5') && r.includes('x: off'))).toBe(true)
  await ui.press({ key: 'opt-more-agentLimitMin' })
  await ui.press({ key: 'opt-less-agentLimitMin' })
  expect(sets.map(s => s.value)).toEqual([25, 20])
  await ui.unmount()
})

test('b closes the card', async ($, on) => {
  const { stored } = world(on, OPTIONS_UI)
  const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  await ui.press({ key: 'opt-back' })
  expect((stored.get('ui') as UiState).page).toBe(undefined)
  await ui.unmount()
})

test('the PREVIEW is a Raster on the terminal and text on the desktop', async ($, on) => {
  world(on, OPTIONS_UI)
  const term = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  expect(await term.find({ type: 'Raster', key: 'opt-preview' })).not.toBe(undefined)
  await term.unmount()
  const desk = await $.ui.mount({ ...PANE(80), surface: 'desktop' })
  expect(await desk.find({ type: 'Raster' })).toBe(undefined)
  const rows = screen(await desk.drawn())
  expect(rows.some(r => r.includes('PREVIEW'))).toBe(true)
  await desk.unmount()
})
