import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, TaskItem, Timeline } from '../../types'
import { empty } from '../model/reduce'

// AbovePrompt is raised on terminal, desktop and mobile only.
const SURFACES = ['terminal', 'desktop', 'mobile'] as const
const NOW = 1_000_000

function seed(on: On, t: Timeline): void {
  mock.clock(on, { now: NOW })
  on('ui.log', () => ({ value: undefined }))
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    return {
      value: {
        value: key === 'timeline' ? { shape: 'timeline-3', value: t } : undefined,
        version: 0,
      },
    }
  })
}

const BAND = (extra: Record<string, unknown> = {}) =>
  ({
    plugin: 'mission-control',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isCollapsed: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
      ...extra,
    },
  }) as const

const task = (id: string, status: TaskItem['status']): TaskItem => ({
  id,
  subject: `task ${id}`,
  status,
  owner: 'main',
  updatedAt: NOW,
})
const agent = (id: string): AgentRow => ({
  id,
  parent: 'main',
  type: 'Explore',
  description: 'd',
  status: 'running',
  startedAt: NOW,
  doing: '',
  stepCount: 0,
})

test('summarises tasks, focus and running agents', async ($, on) => {
  seed(on, {
    ...empty,
    now: { focus: 'Wiring the limiter', at: NOW },
    tasks: [task('1', 'completed'), task('2', 'completed'), task('3', 'in_progress'), task('4', 'pending')],
    agents: { main: { ...empty.agents.main! }, a1: agent('a1'), a2: agent('a2') },
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND(), surface })
    const row = (await ui.find({ type: 'Text' }))?.text
    expect(row).toBe('▣ 2/4 tasks │ ▶ Wiring the limiter │ ● 2 agents │ /mc')
    const parts = await ui.findAll({ type: 'Text' })
    const bars = parts.filter(f => f.text === '│')
    expect(bars.length).toBe(3)
    for (const b of bars) expect((b.props as { dimColor?: boolean }).dimColor).toBe(true)
    const color = (glyph: string): string | undefined => (parts.find(f => f.text === glyph)?.props as { color?: string }).color
    expect(color('▣')).toBe('suggestion')
    expect(color('▶')).toBe('warning')
    expect(color('●')).toBe('warning')
    await ui.unmount()
  }
})

test('draws no row for an empty session', async ($, on) => {
  seed(on, empty)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND(), surface })
    expect(await ui.find({ type: 'Text', text: /mc/ })).toBe(undefined)
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
    await ui.unmount()
  }
})

test('main alone, running forever, is not a running agent', async ($, on) => {
  seed(on, empty)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('a survey holds the band: the mod yields', async ($, on) => {
  seed(on, { ...empty, now: { focus: 'Working', at: NOW } })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...BAND({ hasSurvey: true }), surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('the row is cut to bodyColumns', async ($, on) => {
  seed(on, { ...empty, now: { focus: 'A focus that is much too long for a narrow band to hold', at: NOW } })
  const ui = await $.ui.mount({ ...BAND({ bodyColumns: 24 }), surface: 'terminal' })
  const row = (await ui.find({ type: 'Text' }))?.text ?? ''
  expect(row.length <= 24).toBe(true)
  expect(row.length > 0).toBe(true)
  await ui.unmount()
})

test('narrow: tasks, agents and a focus together stay within 24, with and without a focus', async ($, on) => {
  const base: Timeline = {
    ...empty,
    tasks: [task('1', 'completed'), task('2', 'completed'), task('3', 'in_progress'), task('4', 'pending')],
    agents: { main: { ...empty.agents.main! }, a1: agent('a1'), a2: agent('a2') },
  }
  seed(on, { ...base, now: { focus: 'A focus that is much too long for a narrow band to hold', at: NOW } })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND({ bodyColumns: 24 }), surface })
    const row = (await ui.find({ type: 'Text' }))?.text ?? ''
    expect(row.length <= 24).toBe(true)
    expect(row).toContain('/mc')
    expect(row).not.toContain('agents')
    await ui.unmount()
  }
})

test('narrow: with no focus the row is still within 24, and a tiny width drops tasks then the hint', async ($, on) => {
  seed(on, {
    ...empty,
    tasks: [task('1', 'completed'), task('2', 'pending')],
    agents: { main: { ...empty.agents.main! }, a1: agent('a1'), a2: agent('a2') },
  })
  for (const [cols, expected] of [
    [24, '▣ 1/2 tasks │ /mc'],
    [14, '/mc'],
    [2, '/…'],
  ] as const) {
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND({ bodyColumns: cols }), surface })
      const row = (await ui.find({ type: 'Text' }))?.text ?? ''
      expect(row.length <= cols).toBe(true)
      expect(row).toBe(expected)
      await ui.unmount()
    }
  }
})
