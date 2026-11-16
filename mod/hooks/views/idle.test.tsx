import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { resetPaint } from './paint'

// Idle is still (plan constraint 5): while the session waits and the prompt
// cache is warm, Now's budget line counts down ("cache stays warm 4:48",
// R29). The cockpit's lintel carries no readout, so nothing is blitted: the
// pane is invalidated at most once every 10 s on every surface, and it all
// stops once the cache is cold.

const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }
// The last main reply ended 60 s ago: the 5-minute cache has about 4 minutes left.
const WARM: Timeline = {
  ...empty,
  turns: [{ id: 't1', agent: 'main', prompt: 'go', startedAt: NOW - 120_000, endedAt: NOW - 60_000 }],
  cache: { at: NOW - 60_000 },
}

type World = { clock: MockClock; invalidated: () => number; blits: string[] }

function world(on: On, u: UiState): World {
  resetPaint()
  const stored = new Map<string, unknown>([['timeline', WARM], ['ui', u]])
  const clock = mock.clock(on, { now: NOW })
  let invalidated = 0
  const blits: string[] = []
  mock.env(on, {})
  on('ui.log', () => ({ value: undefined }))
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    const v = stored.get(key)
    return { value: { value: v === undefined ? undefined : { shape: SHAPES[key], value: v }, version: 0 } }
  })
  on('state.set', (_, e) => {
    const w = e as unknown as { key: string; value: { value: unknown } }
    stored.set(w.key, w.value.value)
    return { value: { isSet: true as const, version: 1 } }
  })
  on('ui.invalidate', () => {
    invalidated += 1
    return { value: undefined }
  })
  on('ui.blit', (_, e) => {
    blits.push((e as { key: string }).key)
    return { value: {} } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }) as never)
  on('command.register', () => ({ value: { command: 'mc' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { clock, invalidated: () => invalidated, blits }
}

const start = ($: Engine) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

const PANE = (surface: 'terminal' | 'vscode') =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    surface,
    props: { title: 'Mission Control', isFocused: false, bodyColumns: 62, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  }) as const

// O I-3 / R40: the words are whole minutes, so the clock redraws when the minute changes (it was every 10 s).
test('warm and idle with the rich Now open: the budget line counts down, the pane redraws only when the minute changes, and no lintel is blitted', async ($, on) => {
  const w = world(on, { ...initialUi, paneOpen: true })
  await start($)
  const ui = await $.ui.mount(PANE('terminal') as never)
  await w.clock.advance(60_000)
  expect(w.invalidated()).toBeGreaterThan(0)
  expect(w.invalidated()).toBeLessThanOrEqual(2)
  expect(w.blits.filter(k => k === 'now-lintel').length).toBe(0)
  await ui.unmount()
})

test('warm and idle without a lintel Raster: one redraw when the minute changes', async ($, on) => {
  const w = world(on, { ...initialUi, paneOpen: true })
  await start($)
  const ui = await $.ui.mount(PANE('vscode') as never)
  await w.clock.advance(60_000)
  expect(w.invalidated()).toBeGreaterThan(0)
  expect(w.invalidated()).toBeLessThanOrEqual(2)
  await ui.unmount()
})

test('once the cache is cold the countdown stops: no redraw after the last one', async ($, on) => {
  const w = world(on, { ...initialUi, paneOpen: true })
  await start($)
  const ui = await $.ui.mount(PANE('terminal') as never)
  // Past the 4 minutes left, and then some.
  await w.clock.advance(250_000)
  const invalidated = w.invalidated()
  // One redraw each minute while warm (4 minutes left: about 5), and the cold redraw that clears the words.
  expect(invalidated).toBeGreaterThanOrEqual(4)
  expect(invalidated).toBeLessThanOrEqual(6)
  await w.clock.advance(60_000)
  expect(w.invalidated()).toBe(invalidated)
  await ui.unmount()
})
