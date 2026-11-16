import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Timeline } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { SVG_MAX } from './svg'
import { PALETTE } from './raster'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const NOW = 5_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }

const busy: Timeline = {
  ...empty,
  now: { focus: 'Wiring the limiter', next: 'Run the tests', at: NOW - 60_000 },
  turns: [{ id: 't1', agent: 'main', prompt: 'go', startedAt: NOW - 300_000 }],
  tasks: [
    { id: '1', subject: 'one', status: 'completed', owner: 'main', updatedAt: NOW },
    { id: '2', subject: 'two', status: 'in_progress', owner: 'main', updatedAt: NOW },
  ],
  steps: [{ id: 's1', seq: 1, agent: 'main', tool: 'Edit', label: 'Edit a.ts', status: 'running', startedAt: NOW - 5000 }],
}

function world(on: On): void {
  mock.clock(on, { now: NOW })
  on('ui.log', () => ({ value: undefined }))
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    const v = key === 'timeline' ? busy : key === 'ui' ? initialUi : undefined
    return { value: { value: v === undefined ? undefined : { shape: SHAPES[key], value: v }, version: 0 } }
  })
}

const PANE = {
  plugin: 'binnacle',
  component: 'Pane',
  requestId: 'binnacle',
  props: { title: 'Binnacle', isFocused: false, bodyColumns: 62, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const BAND = {
  plugin: 'binnacle',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('the real Now draws the Svg deck on the desktop only, with an alt, and no button row under it', async ($, on) => {
  world(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const svgs = await ui.findAll({ type: 'Svg' })
    if (surface === 'desktop') {
      expect(svgs.length).toBe(1)
      const p = svgs[0]!.props as { source: string; alt: string }
      expect(p.source.length).toBeLessThan(SVG_MAX)
      expect(p.alt.length).toBeGreaterThan(0)
      // R3-B I4: no button row under the Svg (it repeated the tab bar); the tab bar and the sections below stay Buttons.
      const keys = (await ui.findAll({ type: 'Button' })).map(b => String(b.key))
      expect(keys.filter(k => k.startsWith('deck-'))).toEqual([])
      expect(keys).toEqual(expect.arrayContaining(['tab-tasks']))
    } else {
      expect(svgs.length).toBe(0)
    }
    await ui.unmount()
  }
})

test('the real band draws the Svg band on the desktop only, with an alt', async ($, on) => {
  world(on)
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const svgs = await ui.findAll({ type: 'Svg' })
    if (surface === 'desktop') {
      expect(svgs.length).toBe(1)
      const p = svgs[0]!.props as { source: string; alt: string }
      expect(p.source.length).toBeLessThan(SVG_MAX)
      expect(p.alt.length).toBeGreaterThan(0)
    } else {
      expect(svgs.length).toBe(0)
    }
    await ui.unmount()
  }
})

// C6: every form of the band's Svg stays under the limit with an alt, and says what the terminal band says.
test('the band Svg in every form (working, asked, stopped, idle, a huge session) is under the limit and has an alt', async ($, on) => {
  const forms: [string, Timeline, RegExp][] = [
    ['working', busy, /Working on Wiring the limiter/],
    ['asked', { ...busy, steps: [...busy.steps, { id: 's2', seq: 2, agent: 'main', tool: 'Bash', label: 'Bash rm -rf build', status: 'running', startedAt: NOW - 9000, asking: NOW - 8000 }] }, /Needs you: .*Bash/],
    ['stopped', { ...busy, steps: [], turns: [{ id: 't1', agent: 'main', prompt: 'go', startedAt: NOW - 300_000, endedAt: NOW - 1000, failed: true }] }, /^Stopped: /],
    ['idle', { ...busy, steps: [], tasks: [{ id: '1', subject: 'one', status: 'completed', owner: 'main', updatedAt: NOW }], turns: [{ id: 't1', agent: 'main', prompt: 'go', startedAt: NOW - 300_000, endedAt: NOW - 1000 }] }, /^All 1 done/],
    ['huge', { ...busy, now: { focus: 'y'.repeat(9000), at: NOW }, steps: [{ id: 's9', seq: 1, agent: 'main', tool: 'Bash', label: `Bash ${'z'.repeat(9000)}`, status: 'running', startedAt: NOW - 9000, asking: NOW - 8000 }] }, /Needs you/],
  ]
  let held: Timeline = busy
  mock.clock(on, { now: NOW })
  on('ui.log', () => ({ value: undefined }))
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    const v = key === 'timeline' ? held : key === 'ui' ? initialUi : undefined
    return { value: { value: v === undefined ? undefined : { shape: SHAPES[key], value: v }, version: 0 } }
  })
  for (const [name, t, alt] of forms) {
    held = t
    for (const cols of [60, 120, 300]) {
      const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: cols }, surface: 'desktop' })
      const svgs = await ui.findAll({ type: 'Svg' })
      expect([name, cols, svgs.length]).toEqual([name, cols, 1])
      const p = svgs[0]!.props as { source: string; alt: string }
      expect(p.source.length).toBeLessThan(SVG_MAX)
      expect(p.alt).toMatch(alt)
      expect(p.source).not.toContain('<animate')
      expect(await ui.find({ type: 'Button', key: 'band-mc' })).toBeDefined()
      await ui.unmount()
    }
  }
})

// R32: the desktop's widget placement is the slim view, whatever its width.
test('the Pane in the desktop widget placement draws the slim view: no tab bar, at any width', async ($, on) => {
  world(on)
  const widget = { ...PANE, props: { ...PANE.props, placement: 'widget', bodyColumns: 80 } } as const
  const ui = await $.ui.mount({ ...widget, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'tab-tasks' })).toBe(undefined)
  expect(await ui.find({ type: 'Button', key: 'tab-options' })).toBe(undefined)
  await ui.unmount()
  const dock = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 80 }, surface: 'desktop' })
  expect(await dock.find({ type: 'Button', key: 'tab-tasks' })).toBeDefined()
  await dock.unmount()
})

// FW-A: the band hands its ground to the desktop band Svg, so a day theme (here the `ground` option) draws day hexes.
test('the desktop band Svg takes the ground: day hexes with ground day, night hexes by default', { options: { ground: 'day' } }, async ($, on) => {
  world(on)
  const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const [svg] = await ui.findAll({ type: 'Svg' })
  const source = (svg!.props as { source: string }).source.toLowerCase()
  expect(source).toContain(hex(PALETTE.day.ink))
  expect(source).not.toContain(hex(PALETTE.night.ink))
  await ui.unmount()
})
