import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Step, TaskItem, Timeline } from '../../types'
import { empty } from '../model/reduce'

// AbovePrompt is raised on terminal, desktop and mobile only.
const SURFACES = ['terminal', 'desktop', 'mobile'] as const
const NOW = 1_000_000

// What the state holds: seed() registers the answer once; a test may change it between mounts with reseed().
let current: Timeline = empty
const reseed = (t: Timeline): void => {
  current = t
}

function seed(on: On, t: Timeline): void {
  current = t
  mock.clock(on, { now: NOW })
  on('ui.log', () => ({ value: undefined }))
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    return {
      value: {
        value: key === 'timeline' ? { shape: 'timeline-4', value: current } : undefined,
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

const error: Step = { id: 'e1', seq: 2, agent: 'main', tool: 'Bash', label: 'Bash npm test', status: 'error', startedAt: NOW - 90_000 }
const asked = (id: string, seq: number): Step => ({ id, seq, agent: 'main', tool: 'Bash', label: 'Bash rm -rf build', status: 'running', startedAt: NOW - 60_000, asking: NOW - 30_000 })
const FOCUS = 'Grouping timeline steps by agent'

// 2 of 4 tasks done, a focus, 2 live agents, 1 error, ctx 9% and the 7d window at 22%.
const BUSY: Timeline = {
  ...empty,
  seq: 2,
  steps: [error],
  now: { focus: FOCUS, at: NOW },
  tasks: [task('1', 'completed'), task('2', 'completed'), task('3', 'in_progress'), task('4', 'pending')],
  agents: { main: { ...empty.agents.main! }, a1: agent('a1'), a2: agent('a2') },
  budget: { contextPct: 9, windows: [{ name: 'seven_day', pct: 22 }], at: NOW },
}
const WAITING: Timeline = { ...BUSY, seq: 4, steps: [error, asked('w1', 3), asked('w2', 4)] }

async function bandAt($: Engine, cols: number, surface: (typeof SURFACES)[number] = 'terminal'): Promise<string> {
  const ui = await $.ui.mount({ ...BAND({ bodyColumns: cols }), surface })
  const row = (await ui.find({ type: 'Text' }))?.text ?? ''
  await ui.unmount()
  return row
}
const edge = (left: string, cols: number): string => left.padEnd(cols - 3) + '/mc'

test('at 110 the band is the focus row with every part and /mc at the right edge', async ($, on) => {
  seed(on, BUSY)
  for (const surface of SURFACES) {
    const row = await bandAt($, 110, surface)
    expect(row).toBe(edge(`▍ 2/4   ${FOCUS}   ▸ 2 live   ✖ 1 error   ctx 9%   7d 22%`, 110))
    expect(row.length).toBe(110)
  }
})

test('parts carry their colours: the bar and live glyphs in the accent, the error glyph in error, the counts and /mc dim', async ($, on) => {
  seed(on, BUSY)
  const ui = await $.ui.mount({ ...BAND({ bodyColumns: 110 }), surface: 'terminal' })
  const found = await ui.findAll({ type: 'Text' })
  const props = (text: string) => (found.find(f => f.text === text)?.props ?? {}) as { color?: string; dimColor?: boolean; bold?: boolean }
  expect(props('▍').color).toBe('suggestion')
  expect(props('▸').color).toBe('suggestion')
  expect(props('✖').color).toBe('error')
  expect(props('/4').dimColor).toBe(true)
  expect(props('ctx 9%   7d 22%').dimColor).toBe(true)
  expect(props('/mc').dimColor).toBe(true)
  await ui.unmount()
})

test('at 62 the budget goes first, then the words live and error; the focus stays whole', async ($, on) => {
  seed(on, BUSY)
  for (const surface of SURFACES) {
    const row = await bandAt($, 62, surface)
    expect(row).toBe(edge(`▍ 2/4   ${FOCUS}   ▸ 2   ✖ 1`, 62))
    expect(row.length).toBe(62)
  }
})

test('at 40 /mc goes too and the focus is cut at a word', async ($, on) => {
  seed(on, BUSY)
  for (const surface of SURFACES) {
    expect(await bandAt($, 40, surface)).toBe('▍ 2/4   Grouping timeline…   ▸ 2   ✖ 1')
  }
})

test('at 24 the error count gives way before the focus is cut below its worth', async ($, on) => {
  seed(on, BUSY)
  for (const surface of SURFACES) {
    expect(await bandAt($, 24, surface)).toBe('▍ 2/4   Grouping…   ▸ 2')
  }
})

test('waiting on you: a bold warning lead comes first and the rest drops in the same order', async ($, on) => {
  seed(on, WAITING)
  for (const surface of SURFACES) {
    expect(await bandAt($, 110, surface)).toBe(edge(`▲ 2 need you   ▍ 2/4   ${FOCUS}   ▸ 2 live   ✖ 1 error   ctx 9%   7d 22%`, 110))
    expect(await bandAt($, 62, surface)).toBe('▲ 2 need you   ▍ 2/4   Grouping timeline steps by…   ▸ 2   ✖ 1')
    expect(await bandAt($, 24, surface)).toBe('▲ 2 need you   ▍ 2/4')
  }
  const ui = await $.ui.mount({ ...BAND({ bodyColumns: 62 }), surface: 'terminal' })
  const lead = (await ui.findAll({ type: 'Text' })).find(f => f.text === '▲ 2 need you')
  expect(lead?.props).toMatchObject({ bold: true, color: 'warning' })
  await ui.unmount()
})

test('all done is one dim row: the count, the artifacts, and /mc', async ($, on) => {
  seed(on, {
    ...empty,
    tasks: [task('1', 'completed'), task('2', 'completed'), task('3', 'completed')],
    artifacts: [1, 2, 3].map(n => ({ id: `a${n}`, kind: 'link' as const, title: `L${n}`, agent: 'main', count: 1, updatedAt: NOW })),
  })
  for (const surface of SURFACES) {
    expect(await bandAt($, 62, surface)).toBe(edge('▍ 3/3 done   3 artifacts', 62))
    expect(await bandAt($, 20, surface)).toBe(edge('▍ 3/3 done', 20))
    expect(await bandAt($, 14, surface)).toBe('▍ 3/3 done')
  }
  const ui = await $.ui.mount({ ...BAND({ bodyColumns: 62 }), surface: 'terminal' })
  const inner = (await ui.findAll({ type: 'Text' })).filter(f => !(f.text ?? '').includes('done   3'))
  expect(inner.length).toBeGreaterThan(0)
  for (const f of inner) expect((f.props as { dimColor?: boolean }).dimColor).toBe(true)
  await ui.unmount()
})

test('with no tasks the focus follows the bar after one space', async ($, on) => {
  seed(on, { ...empty, now: { focus: 'Wiring the limiter', at: NOW } })
  expect(await bandAt($, 40)).toBe(edge('▍ Wiring the limiter', 40))
  expect(await bandAt($, 22)).toBe('▍ Wiring the limiter')
  expect(await bandAt($, 62)).toBe(edge('▍ Wiring the limiter', 62))
})

test('the budget is the context and the hotter of the 5h and 7d windows', async ($, on) => {
  seed(on, {
    ...BUSY,
    budget: {
      contextPct: 9.4,
      windows: [{ name: 'five_hour', pct: 78 }, { name: 'seven_day', pct: 22 }],
      at: NOW,
    },
  })
  expect(await bandAt($, 110)).toContain('ctx 9%   5h 78%')
  reseed({ ...BUSY, budget: undefined })
  expect(await bandAt($, 110)).toBe(edge(`▍ 2/4   ${FOCUS}   ▸ 2 live   ✖ 1 error`, 110))
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

test('the row is never wider than bodyColumns, with and without a lead, down to 2 columns', async ($, on) => {
  seed(on, BUSY)
  for (const timeline of [BUSY, WAITING]) {
    reseed(timeline)
    for (const cols of [110, 62, 50, 40, 32, 24, 20, 14, 10, 4, 2]) {
      for (const surface of SURFACES) {
        const row = await bandAt($, cols, surface)
        expect([cols, row.length <= cols, row.length > 0]).toEqual([cols, true, true])
      }
    }
  }
})
