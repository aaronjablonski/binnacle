import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Timeline } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { SVG_MAX } from './svg'

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
  plugin: 'mission-control',
  component: 'Pane',
  requestId: 'mission-control',
  props: { title: 'Mission Control', isFocused: false, bodyColumns: 62, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const BAND = {
  plugin: 'mission-control',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('the real Now draws the Svg deck on the desktop only, with an alt, and its rows stay Buttons', async ($, on) => {
  world(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const svgs = await ui.findAll({ type: 'Svg' })
    if (surface === 'desktop') {
      expect(svgs.length).toBe(1)
      const p = svgs[0]!.props as { source: string; alt: string }
      expect(p.source.length).toBeLessThan(SVG_MAX)
      expect(p.alt.length).toBeGreaterThan(0)
      // The deck's rows that take a press stay Buttons, outside the Svg.
      const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key)
      expect(keys).toEqual(expect.arrayContaining(['deck-crew', 'deck-tasks', 'deck-steps']))
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
