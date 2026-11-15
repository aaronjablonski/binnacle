import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Step, TaskItem, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { colOf, screen } from './screen.testkit'

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

function seed(on: On, t: Timeline, ui?: Partial<UiState>): void {
  current = t
  currentUi = ui
  mock.clock(on, { now: NOW })
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



// A running subagent that started no step for 4 minutes is stalled; a failed one is outlined with `!`.
const MIXED: Timeline = {
  ...WAITING,
  agents: {
    main: { ...empty.agents.main! },
    a1: agent('a1'),
    a2: { ...agent('a2', 'general-purpose'), startedAt: NOW - 240_000, lastStepAt: NOW - 240_000 },
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

// ---- the three-row form -----------------------------------------------------------

// LOOK TEST (edited for Rich): the Neo bracket form is what the surfaces without a Raster draw; the terminal's is the rich band below.
test('text form: pane closed at 110: three rows, each rail to rail, the cells on the grid', async ($, on) => {
  seed(on, BUSY)
  for (const surface of TEXT) {
    const rows = await bandRows($, 110, surface)
    expect(rows.length).toBe(3)
    expect(rows.map(r => r.length)).toEqual([110, 110, 110])
    expect(rows.map(r => r[0])).toEqual(['┏', '┃', '┗'])
    expect(rows.map(r => r[109])).toEqual(['┓', '┃', '┛'])
    // row 1: pill at 2, focus at 14, age at 50, the dials on the last three cells
    expect([colOf(rows[0], ' WORKING '), colOf(rows[0], FOCUS), colOf(rows[0], '20s')]).toEqual([2, 14, 50])
    expect([colOf(rows[0], 'CTX ◔ 9%'), colOf(rows[0], '7D ◔ 22%')]).toEqual([74, 98])
    // row 2: CREW, the pods at 14 (hull, signal, gap), the counts from 50
    expect([colOf(rows[1], 'CREW'), colOf(rows[1], '◈  ◉  ◉'), colOf(rows[1], '2 live')]).toEqual([2, 14, 50])
    // row 3: TASKS, pips at 14, done/total at 38, next and the task from 50, /mc on the last cell
    expect([colOf(rows[2], 'TASKS'), colOf(rows[2], '▪▪▸▫'), colOf(rows[2], '2/4')]).toEqual([2, 14, 38])
    expect([colOf(rows[2], 'next'), colOf(rows[2], 'Humanise step labels'), colOf(rows[2], '/mc')]).toEqual([50, 62, 98])
  }
})

test('the three rows begin at 86 columns and not before; below, the band is one row', async ($, on) => {
  seed(on, BUSY)
  expect((await bandRows($, 86)).length).toBe(3)
  expect((await bandRows($, 85)).length).toBe(1)
  expect((await bandRows($, 62)).length).toBe(1)
})

// LOOK TEST (edited for Rich): the text form's dials; the rich meters are tested below.
test('text form: at 98 and 86 the dials drop from the right and nothing is wider than the band', async ($, on) => {
  seed(on, { ...BUSY, budget: { contextPct: 9, windows: [{ name: 'five_hour', pct: 18 }, { name: 'seven_day', pct: 22 }], at: NOW } })
  const at110 = (await bandRows($, 110, 'mobile'))[0]!
  expect([colOf(at110, 'CTX'), colOf(at110, '5H'), colOf(at110, '7D')]).toEqual([74, 86, 98])
  const at98 = (await bandRows($, 98, 'mobile'))[0]!
  expect(at98.length).toBe(98)
  expect(colOf(at98, 'CTX')).toBe(74)
  expect(colOf(at98, '7D')).toBe(-1)
  const at86 = (await bandRows($, 86, 'mobile'))[0]!
  expect(at86.length).toBe(86)
  expect(colOf(at86, '5H')).toBe(-1)
  expect(colOf(at86, '7D')).toBe(-1)
  for (const cols of [110, 100, 98, 92, 86]) {
    for (const row of await bandRows($, cols, 'mobile')) expect([cols, row.length]).toEqual([cols, cols])
  }
})

// LOOK TEST (edited for Rich): the bracket is the text form's.
test('text form: the bracket takes the accent on its corners and subtle on the rail between', async ($, on) => {
  seed(on, BUSY)
  const found = await textsAt($, 110, 'mobile')
  const colourOf = (glyph: string): (string | undefined)[] => found.filter(f => f.text?.startsWith(glyph)).map(f => f.props.color)
  expect(colourOf('┏')).toEqual(['suggestion'])
  expect(colourOf('┃')).toEqual(['subtle', 'subtle'])
  expect(colourOf('┗')).toEqual(['suggestion'])
  const pill = found.find(f => f.text === ' WORKING ')
  expect(pill?.props).toMatchObject({ backgroundColor: 'suggestion', color: 'inverseText', bold: true })
})

// LOOK TEST (edited for Rich): hull glyphs are the text form's crew.
test('text form: the crew follows the lead, then the subagents in the order they started, one hull per role', async ($, on) => {
  seed(on, { ...BUSY, agents: { main: { ...empty.agents.main! }, a1: agent('a1', 'Plan'), a2: agent('a2', 'general-purpose'), a3: agent('a3', 'code-reviewer') } })
  const rows = await bandRows($, 110, 'mobile')
  // the lead ◈, Plan is a lead hull too, general-purpose builds ▣, the reviewer checks ◬
  expect(rows[1]).toContain('◈  ◈  ▣  ◬')
})

// LOOK TEST (edited for Rich): hull glyphs are the text form's crew.
test('text form: pods come from problems(): an ask is the waiting ? beside the lead, a stalled agent z, a failed one !', async ($, on) => {
  seed(on, MIXED)
  const rows = await bandRows($, 110, 'mobile')
  // by start: the stalled builder, the failed reviewer, the finished scout, the live scout
  expect(rows[2]).toContain('◈? ▣z △! ●  ◉')
})

// LOOK TEST (edited for Rich): the Neo waiting band; the terminal's is tested below.
test('text form: waiting: the bracket and pill turn warning, ASKS shows the first ask with why, how long and + n more, the crew sits on row 3', async ($, on) => {
  seed(on, WAITING)
  for (const surface of TEXT) {
    const rows = await bandRows($, 110, surface)
    expect(rows.length).toBe(3)
    expect(colOf(rows[0], ' WAITING ')).toBe(2)
    expect(colOf(rows[1], 'ASKS')).toBe(2)
    expect([colOf(rows[1], '? Bash  rm -rf build'), colOf(rows[1], 'permission'), colOf(rows[1], '30s'), colOf(rows[1], '+ 1 more')]).toEqual([14, 50, 62, 74])
    expect(colOf(rows[2], 'CREW')).toBe(2)
    expect(colOf(rows[2], '/mc')).toBe(98)
  }
  const found = await textsAt($, 110, 'mobile')
  expect(found.find(f => f.text === ' WAITING ')?.props).toMatchObject({ backgroundColor: 'warning', color: 'inverseText' })
  const rails = found.filter(f => /^[┏┓┃┗┛]/.test(f.text ?? ''))
  expect(rails.length).toBe(6)
  expect(rails.map(f => f.props.color)).toEqual(Array(6).fill('warning'))
})

// LOOK TEST (edited for Rich): the tallies are the text form's.
test('text form: waiting with a stalled and a failed agent: the crew row tallies live, stalled, failed and done', async ($, on) => {
  seed(on, MIXED)
  const row = (await bandRows($, 110, 'mobile'))[2]!
  expect([colOf(row, '1 live'), colOf(row, '1 stalled'), colOf(row, '1 failed'), colOf(row, '1 done')]).toEqual([50, 62, 74, 86])
})

// ---- the compact row ----------------------------------------------------------------

// LOOK TEST (edited for Rich): the terminal's compact row swaps the CTX dial for beads; the exact text form is the other surfaces'.
test('pane open: one row at any width, the bracket folded to its two rails', async ($, on) => {
  seed(on, BUSY, { paneOpen: true })
  for (const surface of SURFACES) {
    for (const cols of [140, 110, 86]) {
      const rows = await bandRows($, cols, surface)
      expect(rows.length).toBe(1)
      expect([rows[0]!.length, rows[0]![0], rows[0]![cols - 1]]).toEqual([cols, '┃', '┃'])
    }
  }
  const row = (await bandRows($, 110, 'mobile'))[0]!
  expect(row).toContain(`WORKING   ${FOCUS}`)
  expect(row).toContain('◈◉◉   2/4   CTX ◔ 9%   /mc ┃')
  // the terminal: hulls, the count, CTX with eight cells of beads and 9%
  const rich = (await bandRows($, 110))[0]!
  expect(rich).toContain(`WORKING   ${FOCUS}`)
  expect(rich).toMatch(/◈◉◉ {3}2\/4 {3}CTX {10}9% {3}\/mc ┃/)
})

test('a ui value stored before paneOpen existed reads as closed: three rows', async ($, on) => {
  const old: Partial<UiState> = { ...initialUi }
  delete old.paneOpen
  seed(on, BUSY, old)
  expect((await bandRows($, 110)).length).toBe(3)
})

test('compact waiting: the pill, "n need you" bold in warning, the ask, the tight crew with its ?', async ($, on) => {
  seed(on, WAITING, { paneOpen: true })
  const row = (await bandRows($, 84))[0]!
  expect(row.startsWith('┃  WAITING   2 need you  Bash rm -rf build')).toBe(true)
  expect(row).toContain('◈?◉◉')
  const lead = (await textsAt($, 84)).find(f => f.text === '2 need you')
  expect(lead?.props).toMatchObject({ bold: true, color: 'warning' })
})

// LOOK TEST (edited for Rich): the drop order is the text form's here, and the terminal's beads follow it in the next test.
test('text form: compact drops the CTX dial, then /mc, then cuts the focus at a word', async ($, on) => {
  seed(on, BUSY, { paneOpen: true })
  const dialAt = (await bandRows($, 80, 'mobile'))[0]!
  expect(dialAt).toContain('CTX ◔ 9%   /mc ┃')
  const noDial = (await bandRows($, 66, 'mobile'))[0]!
  expect(noDial).not.toContain('CTX')
  expect(noDial.endsWith('2/4   /mc ┃')).toBe(true)
  expect(noDial).toContain(FOCUS)
  const noMc = (await bandRows($, 62, 'mobile'))[0]!
  expect(noMc).not.toContain('/mc')
  expect(noMc).toContain(FOCUS)
  expect(noMc.endsWith('2/4 ┃')).toBe(true)
  const cut = (await bandRows($, 40, 'mobile'))[0]!
  // the crew and the count keep their place: the focus takes what is left
  expect(cut).toContain('Grouping…')
  expect(cut).not.toContain('Grouping timeline')
  expect(cut).toContain('◈◉◉   2/4 ┃')
  expect(cut.length).toBe(40)
})

test('at 24 the needs lead survives, cut at a word when the room is short', async ($, on) => {
  seed(on, WAITING)
  const row = (await bandRows($, 24))[0]!
  expect(row.length).toBeLessThanOrEqual(24)
  expect(row.startsWith('┃  WAITING')).toBe(true)
  expect(row).toContain('2 need')
})

test('the compact row without tasks: the focus follows the pill, no count; IDLE with nothing live, WORKING while a turn runs', async ($, on) => {
  seed(on, { ...empty, now: { focus: 'Wiring the limiter', at: NOW } })
  const row = (await bandRows($, 62))[0]!
  expect(row).toContain('IDLE   Wiring the limiter')
  expect(row).not.toMatch(/\d+\/\d+/)
  const ui = await $.ui.mount({ ...BAND({ bodyColumns: 62, isWorking: true }), surface: 'terminal' })
  expect(screen(await ui.drawn())[0]).toContain('WORKING   Wiring the limiter')
  await ui.unmount()
})

// ---- all done ---------------------------------------------------------------------------

test('all done is one dim row at any width and either pane state: pill, totals, solid hulls, /mc', async ($, on) => {
  seed(on, DONE)
  for (const paneOpen of [false, true]) {
    reseed(DONE, { paneOpen })
    for (const surface of SURFACES) {
      for (const cols of [110, 86, 62]) {
        const rows = await bandRows($, cols, surface)
        expect(rows.length).toBe(1)
        expect(rows[0]!.length).toBe(cols)
      }
    }
  }
  reseed(DONE)
  const row = (await bandRows($, 110))[0]!
  expect(row.startsWith('┃  ALL DONE   3/3 tasks   1 step   3 artifacts')).toBe(true)
  expect(row).toContain('◆●')
  expect(row.endsWith('/mc ┃')).toBe(true)
  const found = await textsAt($, 110)
  expect(found.find(f => f.text === ' ALL DONE ')?.props).toMatchObject({ backgroundColor: 'subtle', color: 'inverseText' })
  const facts = found.find(f => (f.text ?? '').startsWith('3/3 tasks'))
  expect(facts?.props.dimColor).toBe(true)
  expect(found.filter(f => f.text === '┃').map(f => f.props.color)).toEqual(['subtle', 'subtle'])
})

test('all done gives up its facts from the right, then /mc, as the band narrows', async ($, on) => {
  seed(on, DONE)
  expect((await bandRows($, 50))[0]).toContain('3/3 tasks   1 step')
  const narrow = (await bandRows($, 36))[0]!
  expect(narrow).toContain('3/3 tasks')
  expect(narrow).not.toContain('artifacts')
  expect(narrow.length).toBeLessThanOrEqual(36)
})

// ---- the whole -----------------------------------------------------------------------------

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

test('rich: pane closed at 110: the pill and focus, the crew two rows tall beside next and TASKS, a bead meter a window', async ($, on) => {
  seed(on, METERED)
  const rows = await bandRows($, 110)
  expect(rows.length).toBe(3)
  expect(rows.every(r => r.length <= 110)).toBe(true)
  // row 1: the pill at 3, the focus at 14, its age, CTX at 77 with its figure after ten cells of beads
  expect([colOf(rows[0], ' WORKING '), colOf(rows[0], FOCUS), colOf(rows[0], '20s'), colOf(rows[0], 'CTX'), colOf(rows[0], '9%')]).toEqual([3, 14, 71, 77, 93])
  // row 2: next beside the crew; 5H. Row 3: TASKS, the count after the plan strip, 7D and /mc
  expect([colOf(rows[1], 'next'), colOf(rows[1], 'Humanise step labels'), colOf(rows[1], '5H'), colOf(rows[1], '37%')]).toEqual([43, 49, 77, 93])
  expect([colOf(rows[2], 'TASKS'), colOf(rows[2], '2/4'), colOf(rows[2], '7D'), colOf(rows[2], '22%'), colOf(rows[2], '/mc')]).toEqual([43, 54, 77, 93, 104])
  const r = await rasterKeys($, 110)
  expect(r['band-crew']).toMatchObject({ columns: 35, rows: 2 })
  expect(r['band-plan']).toMatchObject({ columns: 4, rows: 1 })
  for (const k of ['band-ctx-beads', 'band-5h-beads', 'band-7d-beads']) expect(r[k]).toMatchObject({ columns: 10, rows: 1 })
  expect(r['band-clamp']).toMatchObject({ columns: 2, rows: 1 })
  expect(r['band-end']).toMatchObject({ columns: 2, rows: 1 })
})

test('rich: the crew has a slot for each of the first six, and fewer as the band narrows; the rest are a +n', async ($, on) => {
  const many = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map(n => [`a${n}`, { ...agent(`a${n}`), startedAt: NOW + n }]))
  seed(on, { ...METERED, agents: { main: { ...empty.agents.main! }, ...many } })
  expect((await rasterKeys($, 110))['band-crew']).toMatchObject({ columns: 35, rows: 2 })
  expect((await bandRows($, 110))[1]).toContain('+2')
  expect((await rasterKeys($, 86))['band-crew']).toMatchObject({ columns: 17, rows: 2 })
  for (const cols of [110, 100, 92, 86]) for (const row of await bandRows($, cols)) expect([cols, row.length <= cols]).toEqual([cols, true])
})

test('rich: no Raster draws where the surface has none: the same rows are the text form', async ($, on) => {
  seed(on, METERED)
  for (const surface of TEXT) expect(await rasterKeys($, 110, surface)).toEqual({})
})

test('rich: the beads and plan have text forms of their own width', async ($, on) => {
  seed(on, METERED)
  // the text form of the band is the Neo band; the rich form's fallbacks are exercised through `look: text`
  const ui = await $.ui.mount({ ...BAND({ bodyColumns: 110 }), surface: 'terminal' })
  const beadsBox = await ui.find({ type: 'Box', key: 'inst-band-ctx-beads' })
  expect(beadsBox?.props).toMatchObject({ width: 10, height: 1 })
  await ui.unmount()
})

test('rich: waiting: NEEDS YOU in an amber pill, the first ask and how long, the others by kind', async ($, on) => {
  seed(on, WAITING)
  const rows = await bandRows($, 110)
  expect(rows.length).toBe(3)
  expect(colOf(rows[0], ' NEEDS YOU 2 ')).toBe(3)
  expect([colOf(rows[0], '? Bash  rm -rf build'), colOf(rows[0], '30s')]).toEqual([18, 40])
  expect(rows[1]).toContain('+1 permission 30s')
  const found = await textsAt($, 110)
  expect(found.find(f => f.text === ' NEEDS YOU 2 ' && f.props.backgroundColor !== undefined)?.props).toMatchObject({ backgroundColor: 'warning', color: 'inverseText', bold: true })
})

test('rich: the band holds no Button', async ($, on) => {
  seed(on, METERED)
  const ui = await $.ui.mount({ ...BAND({ bodyColumns: 110 }), surface: 'terminal' })
  expect(await ui.findAll({ type: 'Button' })).toEqual([])
  await ui.unmount()
})

const LONG_AGENT: Timeline = { ...BUSY, agents: { main: { ...empty.agents.main! }, a1: { ...agent('a1'), startedAt: NOW - 25 * 60_000, lastStepAt: NOW - 1000, description: 'Index the repository' } } }

test('a long run is labelled long run in every form, never looping', async ($, on) => {
  seed(on, LONG_AGENT)
  for (const surface of SURFACES) {
    const rows = await bandRows($, 110, surface)
    const all = rows.join('\n')
    expect(all).toContain('long run')
    expect(all).not.toContain('looping')
  }
  // the text form's second row names the kind in its own column; the terminal's first row is the ask
  expect((await bandRows($, 110, 'mobile'))[1]!.lastIndexOf('long run')).toBe(50)
  reseed(LONG_AGENT, { paneOpen: true })
  expect((await bandRows($, 100))[0]).toContain('long run')
})

test('a long run beside another need reads +1 long run in the rich band', async ($, on) => {
  seed(on, { ...LONG_AGENT, steps: [error, asked('w1', 3)] })
  const rows = (await bandRows($, 110)).join('\n')
  expect(rows).toContain('NEEDS YOU 2')
  expect(rows).toMatch(/\+1 long run \d+[ms]|permission/)
  expect(rows).not.toContain('looping')
})

test('rich: 5H shows ▲ and when it will fill, when it fills before it resets', async ($, on) => {
  const t: Timeline = {
    ...METERED,
    budget: { contextPct: 9, windows: [{ name: 'five_hour', pct: 70, resetsAt: NOW + 3_600_000 }, { name: 'seven_day', pct: 22 }], at: NOW },
    samples: {
      names: ['five_hour'],
      list: [
        { at: NOW - 1_200_000, w: [40] },
        { at: NOW - 600_000, w: [55] },
        { at: NOW, w: [70] },
      ],
    },
  }
  seed(on, t)
  const rows = await bandRows($, 110)
  expect(colOf(rows[1], '▲ 20m')).toBe(99)
  reseed(METERED)
  expect((await bandRows($, 110))[1]).not.toContain('▲')
})

// LOOK TEST (new for Rich): all done carries THIS TURN: how long the turn took, the agents it finished, its errors and its files.
test('all done shows THIS TURN: done in, agents, errors and files', async ($, on) => {
  const turn = { id: 't1', agent: 'main', prompt: 'p', startedAt: NOW - 372_000, endedAt: NOW }
  const finished = { ...agent('a1', 'Explore', 'done'), startedAt: NOW - 200_000, endedAt: NOW - 1000 }
  const wrote: Step = { id: 'w1', seq: 3, agent: 'main', tool: 'Edit', label: 'Edit src/a.ts', status: 'done', startedAt: NOW - 60_000 }
  seed(on, { ...DONE, turns: [turn], agents: { main: { ...empty.agents.main! }, a1: finished }, steps: [{ ...error, status: 'done' }, wrote] })
  for (const surface of SURFACES) {
    const rows = await bandRows($, 110, surface)
    expect(rows.length).toBe(1)
    expect(rows[0]).toContain('ALL DONE   3/3 tasks   done in 6m   1 agent   0 errors   1 file')
  }
})

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

test('the look option text draws the Neo band on the terminal: no Raster, the bracket rows', { options: { look: 'text' } }, async ($, on) => {
  seed(on, METERED)
  expect(await rasterKeys($, 110)).toEqual({})
  const rows = await bandRows($, 110)
  expect(rows.map(r => r[0])).toEqual(['┏', '┃', '┗'])
})
