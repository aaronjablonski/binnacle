import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Step, TaskItem, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { encode, critterBox } from './raster'
import { asked as askedFixture, endedOpen, idle, NOW as FX_NOW, stopped, watching, busy } from './now.fixtures.testkit'
import { screen } from './screen.testkit'

// AbovePrompt is raised on terminal, desktop and mobile only; the desktop draws an Svg (svgwire.test.tsx), so these tests use mobile for the text form.
const SURFACES = ['terminal', 'mobile'] as const
// The surfaces with no Raster draw the Neo text form of the band.
const TEXT = ['mobile'] as const
const NOW = 1_000_000

// What the state holds: seed() registers the answer once; a test may change it between mounts with reseed().
let current: Timeline = empty
let currentUi: Partial<UiState> | undefined
const reseed = (t: Timeline, ui?: Partial<UiState>): void => {
  current = t
  currentUi = ui
}

function seed(on: On, t: Timeline, ui?: Partial<UiState>, at = NOW): void {
  current = t
  currentUi = ui
  mock.clock(on, { now: at })
  on('ui.log', () => ({ value: undefined }))
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    return {
      value: {
        value:
          key === 'timeline'
            ? { shape: 'timeline-4', value: current }
            : key === 'ui' && currentUi !== undefined
              ? { shape: 'ui-4', value: { ...initialUi, ...currentUi } }
              : undefined,
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
const agent = (id: string, type = 'Explore', status: AgentRow['status'] = 'running'): AgentRow => ({
  id,
  parent: 'main',
  type,
  description: 'd',
  status,
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
  now: { focus: FOCUS, at: NOW - 20_000, next: 'Humanise step labels' },
  tasks: [task('1', 'completed'), task('2', 'completed'), task('3', 'in_progress'), task('4', 'pending')],
  agents: { main: { ...empty.agents.main! }, a1: agent('a1'), a2: agent('a2') },
  budget: { contextPct: 9, windows: [{ name: 'seven_day', pct: 22 }], at: NOW },
}
const WAITING: Timeline = { ...BUSY, seq: 4, steps: [error, asked('w1', 3), asked('w2', 4)] }



// A running subagent quiet for 11 minutes is stalled (R6: ten minutes); a failed one is outlined with `!`.
const MIXED: Timeline = {
  ...WAITING,
  agents: {
    main: { ...empty.agents.main! },
    a1: agent('a1'),
    a2: { ...agent('a2', 'general-purpose'), startedAt: NOW - 660_000, lastStepAt: NOW - 660_000 },
    a3: { ...agent('a3', 'code-reviewer', 'error'), startedAt: NOW - 100 },
    a4: { ...agent('a4', 'Explore', 'done'), startedAt: NOW - 50 },
  },
}
const DONE: Timeline = {
  ...empty,
  steps: [{ ...error, status: 'done' }],
  tasks: [task('1', 'completed'), task('2', 'completed'), task('3', 'completed')],
  agents: { main: { ...empty.agents.main! }, a1: agent('a1', 'Explore', 'done') },
  artifacts: [1, 2, 3].map(n => ({ id: `a${n}`, kind: 'link' as const, title: `L${n}`, agent: 'main', count: 1, updatedAt: NOW })),
}

async function bandRows($: Engine, cols: number, surface: (typeof SURFACES)[number] = 'terminal'): Promise<string[]> {
  const ui = await $.ui.mount({ ...BAND({ bodyColumns: cols }), surface })
  const out = screen(await ui.drawn())
  await ui.unmount()
  return out
}
type Props = { color?: string; dimColor?: boolean; bold?: boolean; backgroundColor?: string }
async function textsAt($: Engine, cols: number, surface: (typeof SURFACES)[number] = 'terminal'): Promise<{ text?: string; props: Props }[]> {
  const ui = await $.ui.mount({ ...BAND({ bodyColumns: cols }), surface })
  const found = (await ui.findAll({ type: 'Text' })) as { text?: string; props: Props }[]
  await ui.unmount()
  return found
}


test('the band holds no Button in any form', async ($, on) => {
  const cases: [Timeline, Partial<UiState> | undefined, number][] = [
    [BUSY, undefined, 110],
    [WAITING, undefined, 110],
    [DONE, undefined, 110],
    [BUSY, { paneOpen: true }, 110],
    [WAITING, { paneOpen: true }, 62],
  ]
  seed(on, empty)
  for (const [t, ui, cols] of cases) {
    reseed(t, ui)
    const mounted = await $.ui.mount({ ...BAND({ bodyColumns: cols }), surface: 'terminal' })
    expect(await mounted.findAll({ type: 'Button' })).toEqual([])
    await mounted.unmount()
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

test('no row is ever wider than bodyColumns, in every form, down to 2 columns', async ($, on) => {
  const cases = [[BUSY, undefined], [WAITING, undefined], [MIXED, undefined], [DONE, undefined], [BUSY, { paneOpen: true }], [WAITING, { paneOpen: true }]] as [Timeline, Partial<UiState> | undefined][]
  seed(on, empty)
  for (const [t, ui] of cases) {
    reseed(t, ui)
    for (const cols of [140, 110, 98, 86, 85, 62, 50, 40, 32, 24, 20, 14, 10, 4, 2]) {
      for (const surface of SURFACES) {
        const rows = await bandRows($, cols, surface)
        expect([cols, rows.length > 0, rows.every(r => r.length <= cols)]).toEqual([cols, true, true])
      }
    }
  }
})

// ---- Neo Rich: the three rows with Rasters, the beads, long runs, THIS TURN ------------------

const METERED: Timeline = { ...BUSY, budget: { contextPct: 9, windows: [{ name: 'five_hour', pct: 37 }, { name: 'seven_day', pct: 22 }], at: NOW } }

async function rasterKeys($: Engine, cols: number, surface: (typeof SURFACES)[number] = 'terminal'): Promise<Record<string, unknown>> {
  const ui = await $.ui.mount({ ...BAND({ bodyColumns: cols }), surface })
  const found = await ui.findAll({ type: 'Raster' })
  await ui.unmount()
  return Object.fromEntries(found.map(r => [String(r.key), r.props]))
}

test('rich: no Raster draws where the surface has none: the same rows are the text form', async ($, on) => {
  seed(on, METERED)
  for (const surface of TEXT) expect(await rasterKeys($, 110, surface)).toEqual({})
})

test('rich: the band holds no Button', async ($, on) => {
  seed(on, METERED)
  const ui = await $.ui.mount({ ...BAND({ bodyColumns: 110 }), surface: 'terminal' })
  expect(await ui.findAll({ type: 'Button' })).toEqual([])
  await ui.unmount()
})

const LONG_AGENT: Timeline = { ...BUSY, agents: { main: { ...empty.agents.main! }, a1: { ...agent('a1'), startedAt: NOW - 65 * 60_000, lastStepAt: NOW - 1000, description: 'Index the repository' } } }

// Changed meaning (C2, owner ruling 4): a long run is a Watch row, and Watch never leads or colours the band.
test('a long run never leads the band in any form: no long run, no looping, no WAITING', async ($, on) => {
  seed(on, LONG_AGENT)
  for (const surface of SURFACES) {
    const rows = await bandRows($, 110, surface)
    const all = rows.join('\n')
    expect(all).not.toContain('long run')
    expect(all).not.toContain('looping')
    expect(all).not.toContain('WAITING')
  }
  reseed(LONG_AGENT, { paneOpen: true })
  expect((await bandRows($, 100))[0]).not.toContain('long run')
})

// LOOK TEST (new for Rich): all done carries THIS TURN: how long the turn took, the agents it finished, its errors and its files.
test('the band fits 24 columns in every form and on every surface', async ($, on) => {
  const cases = [[METERED, undefined], [WAITING, undefined], [MIXED, undefined], [DONE, undefined], [LONG_AGENT, undefined], [BUSY, { paneOpen: true }], [WAITING, { paneOpen: true }]] as [Timeline, Partial<UiState> | undefined][]
  seed(on, empty)
  for (const [t, ui] of cases) {
    reseed(t, ui)
    for (const surface of SURFACES) {
      const rows = await bandRows($, 24, surface)
      expect([surface, rows.length > 0, rows.every(r => r.length <= 24)]).toEqual([surface, true, true])
    }
  }
})

test('desktop: the band is an Svg with /mc as a Button beside it; a press opens the pane', async ($, on) => {
  seed(on, BUSY)
  const opened: unknown[] = []
  on('ui.open', (_, e) => {
    opened.push(e)
    return { value: { isPlaced: true as const } } as never
  })
  on('state.set', () => ({ value: { isSet: true as const, version: 1 } }))
  const ui = await $.ui.mount({ ...BAND({ bodyColumns: 110 }), surface: 'desktop' })
  expect((await ui.findAll({ type: 'Svg' })).length).toBe(1)
  const mc = await ui.find({ type: 'Button', key: 'band-mc' })
  expect(mc).toBeDefined()
  await ui.press({ key: 'band-mc' })
  expect(opened).toEqual([expect.objectContaining({ id: 'mission-control' })])
  await ui.unmount()
})

// ---- C6: the cockpit band (CockpitBand; band.fidelity.test.tsx compares the rows with the mock) -------------------------
// LOOK TEST (rewritten for the cockpit): the Neo three rows, the bracket, the pill, the crew row and the bead meters are gone; these tests hold the band's
// behaviour (what it says when, how many rows, what colours, no Button) and the fidelity test holds its look.

const CHILD_ASK: Timeline = {
  ...BUSY,
  steps: [{ id: 'x1', seq: 3, agent: 'a1', tool: 'Bash', label: 'Bash npm run deploy -- --env staging', status: 'running', startedAt: NOW - 60_000, asking: NOW - 30_000 }],
}
const LEAD_ASK: Timeline = { ...BUSY, steps: [asked('w1', 3)] }
const GLYPHS = /[┃┏┛┓┗▮▯]/

test('working: two rows at 80 columns and up, pane closed; the goal and the gauges on row 1, the bar and its words on row 2', async ($, on) => {
  seed(on, { ...BUSY, budget: { contextPct: 62, windows: [{ name: 'seven_day', pct: 34 }], at: NOW } })
  const rows = await bandRows($, 104, 'mobile')
  expect(rows.length).toBe(2)
  expect(rows[0]).toContain(`Working on   ${FOCUS}`)
  expect(rows[0]!.endsWith('context 62%   week 34%')).toBe(true)
  expect(rows[1]).toContain('━')
  expect(rows[1]).toContain('2 of 4 done   ·   2 agents working   ·   nothing needs you')
  expect(rows[1]!.endsWith('/mc')).toBe(true)
  expect(rows.every(r => r.length <= 104)).toBe(true)
})

test('the two rows begin at 80 columns and not before; the pane open is one row at any width', async ($, on) => {
  seed(on, BUSY)
  expect((await bandRows($, 80, 'mobile')).length).toBe(2)
  expect((await bandRows($, 79, 'mobile')).length).toBe(1)
  expect((await bandRows($, 64, 'mobile')).length).toBe(1)
  expect((await bandRows($, 40, 'mobile')).length).toBe(1)
  reseed(BUSY, { paneOpen: true })
  expect((await bandRows($, 140, 'mobile')).length).toBe(1)
  reseed(BUSY, undefined)
  const short = await $.ui.mount({ ...BAND({ bodyColumns: 120, maxRows: 1 }), surface: 'mobile' })
  expect(screen(await short.drawn()).length).toBe(1)
  await short.unmount()
})

test('one row at 64 and 40 columns: the count, the agents, the focus cut at a word, the context; /mc at the right', async ($, on) => {
  seed(on, { ...BUSY, budget: { contextPct: 62, windows: [], at: NOW } })
  const [r64] = await bandRows($, 64, 'mobile')
  expect(r64).toBe('2 of 4  ·  2 agents  ·  Grouping timeline  ·  context 62%    /mc')
  expect(r64!.length).toBe(64)
  const [r40] = await bandRows($, 40, 'mobile')
  expect(r40!.length).toBeLessThanOrEqual(40)
  expect(r40).toContain('2 of 4  ·  2 agents')
  expect(r40!.endsWith('/mc')).toBe(true)
  expect(r40).not.toContain('Grouping')
})

test('asked: the amber row names who asks and what, "answer below", and the asker is the one critter', async ($, on) => {
  seed(on, CHILD_ASK)
  const rows = await bandRows($, 104, 'mobile')
  expect(rows[0]).toContain('Needs you   ')
  expect(rows[0]).toContain('asks to run a command  Bash  npm run deploy -- --env staging')
  expect(rows[0]!.endsWith('answer below ↓')).toBe(true)
  expect(rows[1]).toContain('1 agent working, 1 waiting')
  // The critter is the asker's (an Explore agent is the scout), waiting: `?` in its badge column.
  expect(rows[0]!.startsWith('●')).toBe(true)
  expect(rows[0]!.slice(0, 6)).toContain('?')
  expect(rows[1]!.startsWith('scout')).toBe(true)
  const texts = await textsAt($, 104, 'mobile')
  expect(texts.find(x => x.text === 'Needs you')?.props).toMatchObject({ color: 'warning', bold: true })
  expect(texts.find(x => x.text === 'answer below ↓')?.props).toMatchObject({ color: 'warning' })
  expect(texts.find(x => x.text === '1 waiting')?.props).toMatchObject({ color: 'warning' })
  // The lead asking draws the lead.
  reseed(LEAD_ASK)
  const lead = await bandRows($, 104, 'mobile')
  expect(lead[1]!.startsWith('lead')).toBe(true)
})

test('asked, narrow: one row that still names the tool, down to 24 columns; nothing wider than the band', async ($, on) => {
  seed(on, CHILD_ASK)
  const r40 = (await bandRows($, 40, 'mobile'))[0]!
  expect(r40).toBe('▲ 1 needs you  ·  Bash  ·  2 of 4    /mc')
  expect(r40.length).toBe(40)
  const r30 = (await bandRows($, 30, 'mobile'))[0]!
  expect(r30).toContain('Bash')
  expect(r30.length).toBeLessThanOrEqual(30)
  const r24 = (await bandRows($, 24, 'mobile'))[0]!
  expect(r24).toContain('Bash')
  expect(r24.length).toBeLessThanOrEqual(24)
  expect(r24).toContain('▲')
  // Two asks: the count says so.
  reseed(WAITING)
  expect((await bandRows($, 60, 'mobile'))[0]).toContain('▲ 2 need you')
})

test('Watch adds "n to watch", dim and uncoloured: the band is not amber and still reads Working on', async ($, on) => {
  seed(on, { ...watching(), budget: busy().budget }, undefined, FX_NOW)
  const rows = await bandRows($, 104, 'mobile')
  expect(rows[0]).toContain('Working on')
  expect(rows[1]).toContain('2 agents working   ·   2 to watch')
  const texts = await textsAt($, 104, 'mobile')
  expect(texts.find(x => x.text === '2 to watch')?.props).toMatchObject({ dimColor: true })
  expect(texts.some(x => x.props.color === 'warning')).toBe(false)
  // One row too: the count joins the row while there is room.
  expect((await bandRows($, 70, 'mobile'))[0]).toContain('2 to watch')
})

test('idle is one dim line at every width and in either pane state: the tick, the totals, /mc; the facts give way from the right', async ($, on) => {
  seed(on, idle(), undefined, FX_NOW)
  for (const open of [false, true]) {
    reseed(idle(), open ? { paneOpen: true } : undefined)
    for (const cols of [140, 104, 64, 40]) {
      const rows = await bandRows($, cols, 'mobile')
      expect([cols, rows.length]).toEqual([cols, 1])
      expect(rows[0]!.startsWith('✓ All 14 done')).toBe(true)
      expect(rows[0]!.endsWith('/mc')).toBe(true)
      expect(rows[0]!.length).toBeLessThanOrEqual(cols)
    }
  }
  const at64 = (await bandRows($, 64, 'mobile'))[0]!
  expect(at64).toContain('1 h 18 min')
  expect(at64).not.toContain('cache warm')
  const texts = await textsAt($, 104, 'mobile')
  expect(texts.find(x => x.text === '✓ ')?.props).toMatchObject({ color: 'success' })
  expect(texts.filter(x => x.props.color === 'warning' || x.props.color === 'error')).toEqual([])
})

test('a turn that ended with tasks open says so, dim, with no tick; a finished turn with no list says Finished', async ($, on) => {
  seed(on, endedOpen(), undefined, FX_NOW)
  const open = (await bandRows($, 104, 'mobile'))[0]!
  expect(open).toContain('Stopped with 5 to do open')
  expect(open.startsWith('✓')).toBe(false)
  reseed({ ...idle(), tasks: [] })
  expect((await bandRows($, 104, 'mobile'))[0]).toContain('Finished')
})

test('no clamp, no pill, no beads, no hotkey and no Button in any form', async ($, on) => {
  const cases: [Timeline, Partial<UiState> | undefined, number][] = [
    [busy(), undefined, 104], [askedFixture(), undefined, 104], [idle(), undefined, 104], [stopped(), undefined, 104],
    [busy(), undefined, 64], [askedFixture(), undefined, 40], [busy(), { paneOpen: true }, 100],
  ]
  seed(on, empty, undefined, FX_NOW)
  for (const [t, ui, cols] of cases) {
    reseed(t, ui)
    for (const surface of ['mobile', 'terminal'] as const) {
      const mounted = await $.ui.mount({ ...BAND({ bodyColumns: cols }), surface })
      expect(await mounted.findAll({ type: 'Button' })).toEqual([])
      expect(await mounted.findAll({ type: 'Text', text: /^(WORKING|WAITING|IDLE|ALL DONE|STOPPED|NEEDS YOU)/ })).toEqual([])
      const rows = screen(await mounted.drawn())
      expect(rows.some(r => GLYPHS.test(r))).toBe(false)
      await mounted.unmount()
    }
  }
})

test('rich: the band draws one micro critter as a still Raster of 5 by 2 cells, never blinking, even with motion on', async ($, on) => {
  seed(on, BUSY)
  const ui = await $.ui.mount({ ...BAND({ bodyColumns: 104 }), surface: 'terminal' })
  const rasters = await ui.findAll({ type: 'Raster' })
  expect(rasters.length).toBe(1)
  const p = rasters[0]!.props as { columns: number; rows: number; cells: string }
  expect([p.columns, p.rows]).toEqual([5, 2])
  expect(p.cells).toBe(encode(critterBox('lead', 'working', 'micro')))
  await ui.unmount()
  // The idle line has no critter.
  reseed(idle())
  const quiet = await $.ui.mount({ ...BAND({ bodyColumns: 104 }), surface: 'terminal' })
  expect(await quiet.findAll({ type: 'Raster' })).toEqual([])
  await quiet.unmount()
})

test('rich: the asker is the critter, waiting, in amber', async ($, on) => {
  seed(on, CHILD_ASK)
  const ui = await $.ui.mount({ ...BAND({ bodyColumns: 104 }), surface: 'terminal' })
  const p = (await ui.find({ type: 'Raster' }))?.props as { cells: string }
  expect(p.cells).toBe(encode(critterBox('scout', 'waiting', 'micro')))
  await ui.unmount()
})
