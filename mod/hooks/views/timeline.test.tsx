import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Step, Timeline, TurnRow, UiState } from '../../types'
import { bodyOf } from '../journal'
import { empty } from '../model/reduce'
import { filesOf } from './detail'
import { decode, PALETTE } from './raster'
import { backTo, colOf, keepLog, LOGS, screen } from './screen.testkit'
import { mapBuckets } from './timeline'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }
const HOME = 'C:/Users/test'

type Stored = Map<string, unknown>
let clock: ReturnType<typeof mock.clock> | undefined
let readCostMs = 0
const reads: string[] = []

// The engine's $.state beneath the mod, seeded and remembering every write; the
// disk answers fs.read from `files`.
function world(
  on: On,
  t: Timeline,
  u?: UiState,
  files: Map<string, string> = new Map(),
  shapes: Record<string, string> = SHAPES,
): Stored {
  const stored: Stored = new Map()
  stored.set('timeline', t)
  if (u) stored.set('ui', u)
  const versions = new Map<string, number>()
  clock = mock.clock(on, { now: NOW })
  reads.length = 0
  mock.env(on, { USERPROFILE: HOME, OS: 'Windows_NT' })
  LOGS.length = 0
  on('ui.log', keepLog)
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.read', async (_, e) => {
    reads.push(e.path.replaceAll('\\', '/'))
    if (readCostMs > 0 && e.path.includes('steps')) await clock?.advance(readCostMs)
    const text = files.get(e.path.replace(/\\/g, '/'))
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    const v = stored.get(key)
    return {
      value: {
        value: v === undefined ? undefined : { shape: shapes[key], value: v },
        version: versions.get(key) ?? 0,
      },
    }
  })
  on('state.set', (_, e) => {
    const w = e as unknown as { key: string; value: { value: unknown } }
    const version = (versions.get(w.key) ?? 0) + 1
    versions.set(w.key, version)
    stored.set(w.key, w.value.value)
    return { value: { isSet: true as const, version } }
  })
  return stored
}

function put(stored: Stored, t: Timeline, u: UiState): void {
  stored.clear()
  stored.set('timeline', t)
  stored.set('ui', u)
}

const TL_UI: UiState = {
  tab: 'timeline',
  filter: { kind: 'all' },
  agentsMode: 'list',
  folded: [],
  openTurns: [],
  dismissed: [],
  query: '',
  runningOnly: false,
  notified: [],
  toasted: [], slim: false,
}

const PANE = (columns: number, bodyRows = 40) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    props: {
      title: 'Mission Control',
      isFocused: false,
      bodyColumns: columns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows },
      view: {},
    },
  }) as const

const turn = (id: string, prompt: string, startedAt: number): TurnRow => ({ id, agent: 'main', prompt, startedAt })
const step = (id: string, seq: number, label: string, status: Step['status'], extra: Partial<Step> = {}): Step => ({
  id,
  seq,
  agent: 'main',
  tool: 'Edit',
  label,
  status,
  startedAt: NOW - 5000,
  endedAt: NOW - 4000,
  ...extra,
})
const agent = (id: string, type: string): AgentRow => ({
  id,
  parent: 'main',
  type,
  description: 'x',
  status: 'done',
  startedAt: NOW - 60_000,
  doing: '',
  stepCount: 1,
})
const main: AgentRow = { ...empty.agents.main! }

// An older turn t1 with two steps (one by a subagent) and the newest turn t2 with two.
function twoTurns(): Timeline {
  return {
    ...empty,
    turns: [turn('t1', 'what does the upload endpoint accept today?', NOW - 900_000), turn('t2', 'add rate limiting', NOW - 60_000)],
    agents: { main, a1: agent('a1', 'Explore') },
    steps: [
      step('s1', 1, 'Read upload.ts', 'done', { turnId: 't1', tool: 'Read' }),
      step('s2', 2, 'Grep upload(', 'done', { turnId: 't1', tool: 'Grep', agent: 'a1' }),
      step('s3', 3, 'Edit rateLimit.ts', 'done', { turnId: 't2' }),
      step('s4', 4, 'Bash npm test', 'error', { turnId: 't2', tool: 'Bash' }),
    ],
  }
}

async function mount($: Engine, surface: (typeof SURFACES)[number], columns = 62, bodyRows = 40) {
  return $.ui.mount({ ...PANE(columns, bodyRows), surface })
}

const texts = async (ui: Awaited<ReturnType<typeof mount>>): Promise<string[]> => {
  const found = await ui.findAll({ type: 'Text' })
  return found.map(f => f.text ?? '')
}

test('an agent filter shows its chip and clearing it returns to All', async ($, on) => {
  const agentUi: UiState = { ...TL_UI, filter: { kind: 'agent', id: 'a1' }, openTurns: ['t1'] }
  const stored = world(on, twoTurns(), agentUi)
  for (const surface of SURFACES) {
    put(stored, twoTurns(), agentUi)
    const ui = await mount($, surface)
    expect((await ui.find({ key: 'filter-agent' }))?.text).toContain('Explore ✕')
    expect(await ui.find({ key: 'step-s2' })).toBeDefined()
    expect(await ui.find({ key: 'step-s1' })).toBeUndefined()
    await ui.press({ key: 'filter-agent' })
    expect((stored.get('ui') as UiState).filter).toEqual({ kind: 'all' })
    await ui.unmount()
    const cleared = await mount($, surface)
    expect(await cleared.find({ key: 'filter-agent' })).toBeUndefined()
    expect(await cleared.find({ key: 'step-s1' })).toBeDefined()
    await cleared.unmount()
  }
})

test('a ui value stored as ui-2 is read as the initial value', async ($, on) => {
  world(on, twoTurns(), TL_UI, new Map(), { timeline: 'timeline-4', ui: 'ui-2' })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await ui.find({ key: 'filter-errors' })).toBeUndefined()
    expect((await texts(ui)).join('\n')).toContain('Now')
    await ui.unmount()
  }
})

test('narrow: no Text longer than 32', async ($, on) => {
  const t = twoTurns()
  t.steps.push(
    step('s6', 6, 'Edit src/server/middleware/rateLimit.ts', 'done', { turnId: 't2', pin: 'the limiter itself, a long note' }),
    step('s7', 7, 'Agent general-purpose · write limiter tests', 'running', { turnId: 't2', agent: 'a1' }),
  )
  t.turns[1] = turn('t2', 'add rate limiting to the upload endpoint and write the tests', NOW - 60_000)
  world(on, t, { ...TL_UI, openTurns: ['t1'] })
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 32)
    const found = [...(await ui.findAll({ type: 'Text' })), ...(await ui.findAll({ type: 'Button' }))]
    expect(found.length > 10).toBe(true)
    for (const f of found) {
      for (const line of (f.text ?? '').split('\n')) expect(line.length <= 32).toBe(true)
    }
    await ui.unmount()
  }
})

test('empty state: No steps yet.', async ($, on) => {
  world(on, empty, TL_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect((await texts(ui)).join('\n')).toContain('No steps yet.')
    await ui.unmount()
  }
})

test('a filter that matches nothing says so', async ($, on) => {
  world(on, { ...empty, steps: [step('s1', 1, 'Read a', 'done')] }, { ...TL_UI, filter: { kind: 'errors' } })
  const ui = await mount($, 'terminal')
  expect((await texts(ui)).join('\n')).toContain('No steps match.')
  await ui.unmount()
})

type Mounted = Awaited<ReturnType<typeof mount>>
type Found = Awaited<ReturnType<Mounted['findAll']>>[number]
const propsOf = (f: Found | undefined): { color?: string; backgroundColor?: string; dimColor?: boolean; bold?: boolean; justifyContent?: string } =>
  (f?.props ?? {}) as { color?: string; backgroundColor?: string; dimColor?: boolean; bold?: boolean; justifyContent?: string }

function pinned(): Timeline {
  const t = twoTurns()
  return { ...t, steps: t.steps.map(s => (s.id === 's4' ? { ...s, pin: 'the limiter itself' } : s)) }
}

// ---- find and jump (F4) ---------------------------------------------------

const FIND_KEY = 'timeline-find'
const bodyFile = (id: string, text: string): [string, string] => [
  `${HOME}/.claude/mission-control/sess-1/steps/${id}.json`,
  JSON.stringify({ input: { file_path: 'a.ts' }, text, cut: 0, isError: false }),
]

test('the Timeline has a find Input bound to ui.query; typing filters live', async ($, on) => {
  const stored = world(on, twoTurns(), { ...TL_UI, openTurns: ['t1'] })
  for (const surface of SURFACES) {
    put(stored, twoTurns(), { ...TL_UI, openTurns: ['t1'] })
    const ui = await mount($, surface)
    expect(await ui.find({ key: FIND_KEY })).toBeDefined()
    await $.ui.input({ plugin: 'mission-control', key: FIND_KEY, text: 'rateLimit', kind: 'change', surface })
    expect((stored.get('ui') as UiState).query).toBe('rateLimit')
    await ui.unmount()
    const filtered = await mount($, surface)
    expect(await filtered.find({ key: 'step-s3' })).toBeDefined()
    expect(await filtered.find({ key: 'step-s4' })).toBeUndefined()
    expect(await filtered.find({ key: 'step-s1' })).toBeUndefined()
    const found = (await drawnRows(filtered))
    expect(colOf(found[0], '1 hit')).toBe(38)
    expect(colOf(found[0], 'of 4')).toBe(50)
    await filtered.unmount()
  }
})

test('the query narrows by agent type and pin note too, and combines with a chip', async ($, on) => {
  const t = pinned()
  const stored = world(on, t, { ...TL_UI, openTurns: ['t1'], query: 'explore' })
  const ui = await mount($, 'terminal')
  expect(await ui.find({ key: 'step-s2' })).toBeDefined()
  expect(await ui.find({ key: 'step-s3' })).toBeUndefined()
  await ui.unmount()
  put(stored, t, { ...TL_UI, openTurns: ['t1'], query: 'limiter itself', filter: { kind: 'errors' } })
  const both = await mount($, 'terminal')
  expect(await both.find({ key: 'step-s4' })).toBeDefined()
  await both.unmount()
  put(stored, t, { ...TL_UI, query: 'limiter itself', filter: { kind: 'agent', id: 'a1' } })
  const none = await mount($, 'terminal')
  expect((await texts(none)).join('\n')).toContain('No steps match.')
  expect(await none.find({ key: FIND_KEY })).toBeDefined()
  await none.unmount()
})

test('Enter runs a deep search over stored bodies and marks hits "in result"', async ($, on) => {
  on('ui.toast', () => ({ value: undefined }))
  const files = new Map([
    bodyFile('s1', 'nothing'),
    bodyFile('s2', 'nothing'),
    bodyFile('s3', 'nothing'),
    bodyFile('s4', 'HTTP/1.1 429 Too Many Requests'),
  ])
  const stored = world(on, twoTurns(), { ...TL_UI, openTurns: ['t1'], query: '429' }, files)
  const ui = await mount($, 'terminal')
  await $.ui.input({ plugin: 'mission-control', key: FIND_KEY, text: '429', surface: 'terminal' })
  expect((stored.get('ui') as UiState).hits).toEqual(['s4'])
  await ui.unmount()
  for (const surface of SURFACES) {
    const found = await mount($, surface, 62)
    expect((await found.find({ key: 'step-s4' }))?.text ?? '').toContain('in result')
    expect(await found.find({ key: 'step-s3' })).toBeUndefined()
    await found.unmount()
  }
})

test('typing again clears the deep-search hits', async ($, on) => {
  const stored = world(on, twoTurns(), { ...TL_UI, query: '429', hits: ['s4'] })
  const ui = await mount($, 'terminal')
  await $.ui.input({ plugin: 'mission-control', key: FIND_KEY, text: '4290', kind: 'change', surface: 'terminal' })
  const u = stored.get('ui') as UiState
  expect(u.query).toBe('4290')
  expect(u.hits).toBeUndefined()
  await ui.unmount()
})

test('deep search reads newest first and at most 200 bodies', async ($, on) => {
  on('ui.toast', () => ({ value: undefined }))
  const steps = Array.from({ length: 250 }, (_, i) => step(`d${i}`, i + 1, `Edit f${i}.ts`, 'done', { turnId: 't1' }))
  const files = new Map(steps.map(s => bodyFile(s.id, s.id === 'd249' || s.id === 'd10' ? 'needle' : 'hay')))
  const stored = world(on, { ...empty, turns: [turn('t1', 'big', NOW - 60_000)], steps }, { ...TL_UI, query: 'needle' }, files)
  const ui = await mount($, 'terminal')
  await $.ui.input({ plugin: 'mission-control', key: FIND_KEY, text: 'needle', surface: 'terminal' })
  const bodies = reads.filter(r => r.includes('/steps/'))
  expect(bodies.length).toBe(200)
  expect(bodies[0]?.endsWith('/d249.json')).toBe(true)
  // d10 is the 240th newest: beyond the cap.
  expect((stored.get('ui') as UiState).hits).toEqual(['d249'])
  await ui.unmount()
})

test('deep search stops at 8 seconds', async ($, on) => {
  on('ui.toast', () => ({ value: undefined }))
  const steps = Array.from({ length: 50 }, (_, i) => step(`d${i}`, i + 1, `Edit f${i}.ts`, 'done', { turnId: 't1' }))
  const files = new Map(steps.map(s => bodyFile(s.id, 'needle')))
  const stored = world(on, { ...empty, turns: [turn('t1', 'big', NOW - 60_000)], steps }, { ...TL_UI, query: 'needle' }, files)
  readCostMs = 1000
  try {
    const ui = await mount($, 'terminal')
    await $.ui.input({ plugin: 'mission-control', key: FIND_KEY, text: 'needle', surface: 'terminal' })
    const bodies = reads.filter(r => r.includes('/steps/'))
    expect(bodies.length).toBe(8)
    expect((stored.get('ui') as UiState).hits?.length).toBe(8)
    await ui.unmount()
  } finally {
    readCostMs = 0
  }
})

test('a blank query clears the hits and runs no deep search', async ($, on) => {
  const stored = world(on, twoTurns(), { ...TL_UI, query: '', hits: ['s4'] })
  const ui = await mount($, 'terminal')
  await $.ui.input({ plugin: 'mission-control', key: FIND_KEY, text: '  ', surface: 'terminal' })
  expect(reads.filter(r => r.includes('/steps/')).length).toBe(0)
  expect((stored.get('ui') as UiState).hits).toBeUndefined()
  await ui.unmount()
})

// A press runs the plugin's own $.ui.scroll; the mounted kit has nothing beneath
// it that answers (find.test.tsx drives the call itself), so the refusal toast
// is what shows the press reached it.
test('narrow find results keep every line within 32', async ($, on) => {
  world(on, twoTurns(), { ...TL_UI, query: 'rate', hits: ['s4'] })
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 32)
    const found = [...(await ui.findAll({ type: 'Text' })), ...(await ui.findAll({ type: 'Button' }))]
    expect(found.length > 5).toBe(true)
    for (const f of found) for (const line of (f.text ?? '').split('\n')) expect(line.length <= 32).toBe(true)
    await ui.unmount()
  }
})

// ---- HUD v2 Steps screen ---------------------------------------------------

const fileFor = (id: string, text: string, extra: Record<string, unknown> = {}): [string, string] => [
  `${HOME}/.claude/mission-control/sess-1/steps/${id}.json`,
  JSON.stringify({ input: { command: 'npm test' }, text, cut: 0, isError: false, ...extra }),
]

// The shell's tab bar, track and blank row come first; the Steps screen starts under them.
const TAB_ROWS = 3
const drawnRows = async (ui: { drawn: () => Promise<unknown> }): Promise<string[]> => screen(await ui.drawn()).slice(TAB_ROWS)

// LOOK TEST (rewritten for Neo Rich): replaces "at 62: the FIND and SHOW deck, then the turn section and its rows sit on the grid"
// (the bracket now holds FIND, SHOW and the two-row MAP, so the turn section starts two rows lower).
test('at 62: the FIND, SHOW and MAP deck, then the turn section and its rows sit on the grid', async ($, on) => {
  world(on, twoTurns(), TL_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 62)
    const rows = await drawnRows(ui)
    // FIND (top bracket): label 2, f: type to search at 14, the step count at 38, the errors at 50, the rail on 61.
    expect(rows[0]?.startsWith('┏ FIND')).toBe(true)
    expect(colOf(rows[0], 'f: type to search')).toBe(14)
    expect(colOf(rows[0], '4 steps')).toBe(38)
    expect(colOf(rows[0], '✖ 1 error')).toBe(50)
    expect(rows[0]?.length).toBe(62)
    expect(rows[0]?.endsWith('┓')).toBe(true)
    // SHOW (middle of the bracket): the chips on cells 14, 26 and 38; the chosen one, All, is a pill (one space each side).
    expect(rows[1]?.startsWith('┃ SHOW')).toBe(true)
    expect(colOf(rows[1], ' All 4 ')).toBe(14)
    expect(colOf(rows[1], 'Errors 1')).toBe(26)
    expect(rows[1]).not.toContain('Kept')
    expect(rows[1]).not.toContain('In view')
    expect(rows[1]?.length).toBe(62)
    expect(rows[1]?.endsWith('┃')).toBe(true)
    // MAP: the label on the first of its two rows, the bracket closing under it and at the right edge.
    expect(rows[2]?.startsWith('┃ MAP')).toBe(true)
    expect(rows[2]?.endsWith('┃')).toBe(true)
    expect(rows[3]?.startsWith('┗')).toBe(true)
    expect(rows[3]?.endsWith('┛')).toBe(true)
    expect(rows[2]?.length).toBe(62)
    expect(rows[3]?.length).toBe(62)
    // In the text form the MAP is 44 cells of eighth blocks at 14.
    if (surface !== 'terminal') expect(rows[3]?.slice(14, 58)).toMatch(/^[▁▂▃▄▅▆▇█]{44}$/)
    expect(rows[4]).toBe('')
    expect(rows[5]?.startsWith('┌ ')).toBe(true)
    expect(colOf(rows[5], '“add rate limiting”')).toBe(2)
    expect(colOf(rows[5], 'agent')).toBe(38)
    expect(colOf(rows[5], 'time')).toBe(50)
    // s4 (newest): glyph 2, tool 4, name 10, metric 38, time 50.
    expect(colOf(rows[6], '✖')).toBe(2)
    expect(colOf(rows[6], 'Bash')).toBe(4)
    expect(colOf(rows[6], 'npm test')).toBe(10)
    expect(colOf(rows[6], 'main')).toBe(38)
    expect(colOf(rows[6], '1s')).toBe(50)
    expect(colOf(rows[7], 'rateLimit.ts')).toBe(10)
    for (const r of rows) expect(r.length <= 62).toBe(true)
    await ui.unmount()
  }
})

test('the chosen chip is a pill: backgroundColor in the accent, inverseText, bold; the others are plain dim text', async ($, on) => {
  world(on, twoTurns(), { ...TL_UI, filter: { kind: 'errors' } })
  const ui = await mount($, 'terminal')
  const found = await ui.findAll({ type: 'Text' })
  const pillProps = propsOf(found.find(x => x.text === ' Errors 1 '))
  expect(pillProps.backgroundColor).toBe('suggestion')
  expect(pillProps.color).toBe('inverseText')
  expect(pillProps.bold).toBe(true)
  expect(propsOf(found.find(x => x.text === 'All')).dimColor).toBe(true)
  expect(propsOf(found.find(x => x.text === 'All')).backgroundColor).toBeUndefined()
  await ui.unmount()
})

test('EARLIER TURNS lists each older turn on one row: steps at 38, start time at 50', async ($, on) => {
  world(on, twoTurns(), TL_UI)
  const ui = await mount($, 'terminal', 62)
  const rows = await drawnRows(ui)
  const at = rows.findIndex(r => r.includes('EARLIER TURNS'))
  expect(at > 0).toBe(true)
  expect(rows[at - 1]).toBe('')
  expect(colOf(rows[at], 'EARLIER TURNS')).toBe(2)
  expect(colOf(rows[at], 'steps')).toBe(38)
  expect(colOf(rows[at], 'at')).toBe(50)
  const r = rows[at + 1]
  expect(colOf(r, '›')).toBe(2)
  expect(colOf(r, '“what does the upload')).toBe(4)
  expect(colOf(r, '2')).toBe(38)
  expect(/\d\d:\d\d/.test(r?.slice(50) ?? '')).toBe(true)
  expect(await ui.find({ key: 'step-s1' })).toBeUndefined()
  await ui.unmount()
})

test('pressing an EARLIER TURNS row opens that turn as a section; pressing its label closes it', async ($, on) => {
  const stored = world(on, twoTurns(), TL_UI)
  for (const surface of SURFACES) {
    put(stored, twoTurns(), TL_UI)
    const ui = await mount($, surface)
    await ui.press({ key: 'turn-t1' })
    expect((stored.get('ui') as UiState).openTurns).toEqual(['t1'])
    await ui.unmount()
    const opened = await mount($, surface)
    const rows = await drawnRows(opened)
    expect(rows.some(r => r.includes('EARLIER TURNS'))).toBe(false)
    expect(rows.some(r => r.startsWith('┌ “what does the upload'))).toBe(true)
    expect(await opened.find({ key: 'step-s1' })).toBeDefined()
    await opened.press({ key: 'turn-t1' })
    expect((stored.get('ui') as UiState).openTurns).toEqual([])
    await opened.unmount()
    const closed = await mount($, surface)
    expect(await closed.find({ key: 'step-s1' })).toBeUndefined()
    await closed.unmount()
  }
})

function manySteps(n: number): Timeline {
  const steps = Array.from({ length: n }, (_, i) => step(`m${i}`, i + 1, `Edit file${i}.ts`, 'done', { turnId: 't1' }))
  return { ...empty, turns: [turn('t1', 'big job', NOW - 60_000)], steps }
}

// BEHAVIOUR CHANGE (binding rule 2): a turn was capped at 5 rows; it now grows with the pane's height, never below 5.
test('a turn grows with the height: 5 rows and "+ n more in this turn" on a short pane, more at 24 and 36, every step at 50; pressing it shows them all', async ($, on) => {
  const stored = world(on, manySteps(30), TL_UI)
  for (const surface of SURFACES) {
    const at = async (bodyRows: number): Promise<{ n: number; more: string | undefined }> => {
      put(stored, manySteps(30), TL_UI)
      const ui = await mount($, surface, 62, bodyRows)
      const rows = await drawnRows(ui)
      await ui.unmount()
      return { n: rows.filter(r => r.includes('Edit')).length, more: rows.find(r => r.includes('more in this turn')) }
    }
    const tiny = await at(10)
    expect(tiny).toEqual({ n: 5, more: '  + 25 more in this turn' })
    const short = await at(24)
    const mid = await at(36)
    expect(short.n).toBeGreaterThan(5)
    expect(mid.n).toBeGreaterThan(short.n)
    expect(await at(50)).toEqual({ n: 30, more: undefined })
    put(stored, manySteps(30), TL_UI)
    const ui = await mount($, surface, 62, 10)
    expect(await ui.find({ key: 'step-m29' })).toBeDefined()
    expect(await ui.find({ key: 'step-m2' })).toBeUndefined()
    await ui.press({ key: 'more-t1' })
    expect((stored.get('ui') as UiState).openTurns).toEqual(['all:t1'])
    await ui.unmount()
    const all = await mount($, surface, 62, 10)
    // Unfolded: the next step after the five shows (the 10-row window draws only the rows near it).
    expect(await all.find({ key: 'step-m24' })).toBeDefined()
    expect((await drawnRows(all)).some(r => r.includes('more in this turn'))).toBe(false)
    await all.unmount()
  }
})

// BEHAVIOUR CHANGE (binding rule 2): EARLIER TURNS was capped at 6; it now grows with the pane's height, never below 6.
test('EARLIER TURNS grows with the height: 6 and "+ n more turns" on a short pane, every turn at 50', async ($, on) => {
  const turns = Array.from({ length: 15 }, (_, i) => turn(`t${i}`, `job ${i}`, NOW - (20 - i) * 60_000))
  const steps = turns.map((x, i) => step(`s${i}`, i + 1, `Read f${i}.ts`, 'done', { turnId: x.id, tool: 'Read' }))
  const stored = world(on, { ...empty, turns, steps }, TL_UI)
  const at = async (bodyRows: number): Promise<{ n: number; more: string | undefined }> => {
    put(stored, { ...empty, turns, steps }, TL_UI)
    const ui = await mount($, 'vscode', 62, bodyRows)
    const n = (await ui.findAll({ type: 'Button' })).filter(b => /^turn-/.test(b.key ?? '')).length
    const rows = await drawnRows(ui)
    await ui.unmount()
    return { n, more: rows.find(r => r.includes('more turns')) }
  }
  expect(await at(12)).toEqual({ n: 6, more: '  + 8 more turns' })
  expect((await at(30)).n).toBeGreaterThan(6)
  expect(await at(50)).toEqual({ n: 14, more: undefined })
})

test('2,000 steps in an expanded turn draw fewer than 200 Buttons', async ($, on) => {
  world(on, manySteps(2000), { ...TL_UI, openTurns: ['all:t1'] })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.length < 200).toBe(true)
    expect(await ui.find({ key: 'step-m1999' })).toBeDefined()
    expect(await ui.find({ key: 'step-m0' })).toBeUndefined()
    await ui.unmount()
  }
})

// LOOK TEST (edited for Neo): the chips are now on cells 14, 26, 38 of the SHOW row.
test('the Kept chip counts kept steps (was Pinned) on the second cell; Errors moves to the third', async ($, on) => {
  const kept: Timeline = { ...twoTurns(), steps: twoTurns().steps.map(s => (s.id === 's3' ? { ...s, pin: 'the limiter' } : s)) }
  const stored = world(on, kept, TL_UI)
  const ui = await mount($, 'terminal')
  const rows = await drawnRows(ui)
  expect(colOf(rows[1], 'Kept 1')).toBe(26)
  expect(colOf(rows[1], 'Errors 1')).toBe(38)
  expect(rows.join('\n')).not.toContain('Pinned')
  await ui.press({ key: 'filter-pinned' })
  expect((stored.get('ui') as UiState).filter).toEqual({ kind: 'pinned' })
  await ui.unmount()
  const filtered = await mount($, 'terminal')
  expect(await filtered.find({ key: 'step-s3' })).toBeDefined()
  expect(await filtered.find({ key: 'step-s4' })).toBeUndefined()
  // A kept step draws ★ where its glyph goes.
  expect(colOf((await drawnRows(filtered)).find(r => r.includes('rateLimit.ts')), '★')).toBe(2)
  await filtered.unmount()
})

test('the Errors filter shows only error steps; a chip at zero is hidden unless it is the open filter', async ($, on) => {
  const stored = world(on, twoTurns(), TL_UI)
  for (const surface of SURFACES) {
    put(stored, twoTurns(), TL_UI)
    const ui = await mount($, surface)
    expect(await ui.find({ key: 'filter-pinned' })).toBeUndefined()
    await ui.press({ key: 'filter-errors' })
    expect((stored.get('ui') as UiState).filter).toEqual({ kind: 'errors' })
    await ui.unmount()
    const filtered = await mount($, surface)
    expect(await filtered.find({ key: 'step-s4' })).toBeDefined()
    expect(await filtered.find({ key: 'step-s3' })).toBeUndefined()
    await filtered.press({ key: 'filter-all' })
    expect((stored.get('ui') as UiState).filter).toEqual({ kind: 'all' })
    await filtered.unmount()
  }
  put(stored, twoTurns(), { ...TL_UI, filter: { kind: 'pinned' } })
  const open = await mount($, 'terminal')
  expect(await open.find({ key: 'filter-pinned' })).toBeDefined()
  await open.unmount()
})

// LOOK TEST (rewritten for Neo): replaces "the active chip is accent and bold; the others are dim" (the chosen chip is now a pill).
test('an idle chip is dim with its error count in error; the chosen All is the pill', async ($, on) => {
  world(on, twoTurns(), TL_UI)
  const idle = await mount($, 'terminal')
  const texts_ = await idle.findAll({ type: 'Text' })
  expect(propsOf(texts_.find(x => x.text === ' All 4 ')).backgroundColor).toBe('suggestion')
  expect(propsOf(texts_.find(x => x.text === 'Errors')).dimColor).toBe(true)
  expect(propsOf(texts_.find(x => x.text === '1' && propsOf(x).color === 'error')).color).toBe('error')
  await idle.unmount()
})

test('step glyphs: error in the error colour, running in the accent, done calm (dim)', async ($, on) => {
  const t = twoTurns()
  t.steps.push(step('s5', 5, 'Edit live.ts', 'running', { turnId: 't2' }))
  world(on, t, TL_UI)
  const ui = await mount($, 'terminal')
  const found = await ui.findAll({ type: 'Text' })
  expect(propsOf(found.find(f => f.text === '✖')).color).toBe('error')
  expect(propsOf(found.find(f => f.text === '·')).color).toBe('suggestion')
  const done = propsOf(found.find(f => f.text === '✔'))
  expect(done.color).toBeUndefined()
  expect(done.dimColor).toBe(true)
  await ui.unmount()
})

test('a query underlines its hits in the step names', async ($, on) => {
  world(on, twoTurns(), { ...TL_UI, query: 'rateLimit' })
  const ui = await mount($, 'terminal')
  const hit = (await ui.findAll({ type: 'Text' })).find(f => f.text === 'rateLimit')
  expect((hit?.props as { underline?: boolean } | undefined)?.underline).toBe(true)
  const rows = await drawnRows(ui)
  expect(colOf(rows[0], '/')).toBe(14)
  expect(colOf(rows[0], '1 hit')).toBe(38)
  expect(colOf(rows[0], 'of 4')).toBe(50)
  await ui.unmount()
})

test('f: Find is on the find row as an armed hotkey; pressing it asks for the find field and nothing is asked on mount', async ($, on) => {
  world(on, twoTurns(), TL_UI)
  const ui = await mount($, 'terminal')
  const find = await ui.find({ key: 'find-f' })
  expect(find?.props).toMatchObject({ hotkey: 'f', plain: true })
  // The kit has no pane to move a focus ring in; the call is checked in find.test.tsx.
  await ui.press({ key: 'find-f' })
  await ui.unmount()
})

// ---- inline open and the full step -------------------------------------------

const BODY_S4 = fileFor('s4', 'FAIL mod/hooks/views/timeline.test.tsx\n  x groups steps\nthird line\nfourth', { isError: true })

// BEHAVIOUR CHANGE (rich rule 4): was "a press opens the step in place; a second press opens its page".
test('Enter on a step row opens its page; b returns to the list with the step focused, still marked in place: 3 detail lines, then g: chat  k: keep  c: copy', async ($, on) => {
  const stored = world(on, twoTurns(), TL_UI, new Map([BODY_S4]))
  for (const surface of SURFACES) {
    put(stored, twoTurns(), TL_UI)
    LOGS.length = 0
    const ui = await mount($, surface, 62)
    await ui.press({ key: 'step-s4' })
    const u = stored.get('ui') as UiState & { stepBody?: { stepId: string; body?: { isError: boolean } } }
    expect(u.page).toEqual({ kind: 'step', id: 's4', from: 'step-s4' })
    expect(u.stepOpen).toBe('s4')
    expect(u.detail).toBeUndefined()
    expect(u.stepBody?.body?.isError).toBe(true)
    await ui.redraw()
    expect(await ui.find({ key: 'step-page-keep' })).toBeDefined()
    await ui.press({ key: 'page-back' })
    expect((stored.get('ui') as UiState).page).toBeUndefined()
    expect(backTo()).toEqual(['step-s4'])
    await ui.unmount()
    const open = await mount($, surface, 62)
    const rows = await drawnRows(open)
    const at = rows.findIndex(r => r.includes('npm test'))
    // s4 is first in its section: no blank above it.
    expect(rows[at - 1]?.startsWith('┌')).toBe(true)
    expect(colOf(rows[at + 1], 'status')).toBe(6)
    expect(colOf(rows[at + 1], 'failed after 1s')).toBe(14)
    expect(colOf(rows[at + 2], 'result')).toBe(6)
    expect(colOf(rows[at + 2], 'FAIL mod/hooks')).toBe(14)
    expect(colOf(rows[at + 3], 'x groups steps')).toBe(14)
    expect(colOf(rows[at + 4], 'g: chat   k: keep   c: copy')).toBe(6)
    expect(rows[at + 5]).toBe('')
    expect(rows.filter(r => r.includes('third line')).length).toBe(0)
    for (const r of rows) expect(r.length <= 62).toBe(true)
    // The opened row's name is bold.
    expect(propsOf((await open.findAll({ type: 'Text' })).find(f => f.text === 'npm test')).bold).toBe(true)
    await open.unmount()
  }
})

test('on a step page n and p step to the next and previous step, the body loading each time, and b still returns to the row it came from', async ($, on) => {
  const stored = world(on, twoTurns(), { ...TL_UI, page: { kind: 'step', id: 's3', from: 'step-s3' } } as UiState, new Map([BODY_S4]))
  // The desktop draws the lintel as text (the terminal's Raster lays out blank here).
  const ui = await mount($, 'desktop')
  expect((await drawnRows(ui)).join('\n')).toContain('step 3 of 4')
  await ui.press({ key: 'step-page-next' })
  const next = stored.get('ui') as UiState & { stepBody?: { stepId: string; body?: { isError: boolean } } }
  expect(next.page).toEqual({ kind: 'step', id: 's4', from: 'step-s3' })
  expect(next.stepBody?.body?.isError).toBe(true)
  await ui.unmount()
  const last = await mount($, 'desktop')
  // s4 is the last step: no n, and p goes back to s3.
  expect(await last.find({ key: 'step-page-next' })).toBeUndefined()
  await last.press({ key: 'step-page-prev' })
  expect((stored.get('ui') as UiState).page).toEqual({ kind: 'step', id: 's3', from: 'step-s3' })
  await last.unmount()
  stored.set('ui', { ...TL_UI, page: { kind: 'step', id: 's1' } })
  const first = await mount($, 'terminal')
  expect(await first.find({ key: 'step-page-prev' })).toBeUndefined()
  expect(await first.find({ key: 'step-page-next' })).toBeDefined()
  await first.unmount()
})

test('an opened row that is not first in its section has a blank row above and below', async ($, on) => {
  world(on, twoTurns(), { ...TL_UI, stepOpen: 's3' })
  const ui = await mount($, 'terminal')
  const rows = await drawnRows(ui)
  const at = rows.findIndex(r => r.includes('rateLimit.ts'))
  expect(rows[at - 1]).toBe('')
  expect(rows[at - 2]).toContain('npm test')
  const action = rows.findIndex(r => r.includes('g: chat'))
  expect(rows[action + 1]).toBe('')
  expect(rows[action + 2]).toContain('EARLIER TURNS')
  await ui.unmount()
})

test('pressing a step whose body is not on disk opens it with a missing result', async ($, on) => {
  const stored = world(on, twoTurns(), TL_UI)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'step-s3' })
  expect((stored.get('ui') as UiState).stepOpen).toBe('s3')
  await ui.unmount()
  const open = await mount($, 'terminal')
  const rows = await drawnRows(open)
  expect(rows.some(r => r.includes('not kept on disk'))).toBe(true)
  await open.unmount()
})

test('k keeps the step with a toast; on a kept step the action reads k: unkeep and k unkeeps', async ($, on) => {
  const stored = world(on, twoTurns(), { ...TL_UI, stepOpen: 's3' })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })
  for (const surface of SURFACES) {
    put(stored, twoTurns(), { ...TL_UI, stepOpen: 's3' })
    toasts.length = 0
    const ui = await mount($, surface)
    expect((await drawnRows(ui)).some(r => r.includes('k: keep'))).toBe(true)
    await ui.press({ key: 'keep-s3' })
    expect((stored.get('timeline') as Timeline).steps.find(s => s.id === 's3')?.pin).toBe('')
    expect(toasts).toEqual(['Kept: never trimmed, exported in full'])
    await ui.unmount()
    const again = await mount($, surface)
    expect((await drawnRows(again)).some(r => r.includes('k: unkeep'))).toBe(true)
    await again.press({ key: 'keep-s3' })
    expect((stored.get('timeline') as Timeline).steps.find(s => s.id === 's3')?.pin).toBeUndefined()
    expect(toasts.length).toBe(2)
    await again.unmount()
  }
})

test('the opened row shows a kept note instead of a second result line', async ($, on) => {
  const kept = { ...twoTurns(), steps: twoTurns().steps.map(s => (s.id === 's4' ? { ...s, pin: 'the limiter itself' } : s)) }
  world(on, kept, { ...TL_UI, stepOpen: 's4' })
  const ui = await mount($, 'terminal')
  const rows = await drawnRows(ui)
  const note = rows.find(r => r.includes('the limiter itself'))
  expect(colOf(note, 'kept')).toBe(6)
  expect(colOf(note, 'the limiter itself')).toBe(14)
  await ui.unmount()
})

test('c copies the step as Markdown and g reaches ui.scroll, on a press only', async ($, on) => {
  world(on, twoTurns(), { ...TL_UI, stepOpen: 's3' })
  const copies: string[] = []
  const toasts: string[] = []
  on('ui.copy', (_, e) => {
    copies.push((e as unknown as { text: string }).text)
    return { value: { isCopied: true as const } }
  })
  on('ui.toast', (_, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })
  const ui = await mount($, 'terminal')
  expect(copies.length + toasts.length).toBe(0)
  await ui.press({ key: 'copy-s3' })
  expect(copies.length).toBe(1)
  expect(copies[0]).toContain('Edit rateLimit.ts')
  expect(toasts).toEqual(['Copied.'])
  await ui.press({ key: 'chat-s3' })
  expect(toasts[1]).toContain('Not shown in chat')
  await ui.unmount()
})

test('with a query, Show in chat is on the opened step only; nothing scrolls until pressed', async ($, on) => {
  world(on, twoTurns(), { ...TL_UI, query: 'rateLimit', stepOpen: 's3' })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })
  const ui = await mount($, 'terminal')
  expect(toasts.length).toBe(0)
  expect(await ui.find({ key: 'chat-s4' })).toBeUndefined()
  expect((await drawnRows(ui)).some(r => r.includes('g: chat'))).toBe(true)
  await ui.press({ key: 'chat-s3' })
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('Not shown in chat')
  await ui.unmount()
})

// ---- n / p, and the footer -----------------------------------------------------

const FOCUSED = (columns: number) =>
  ({ ...PANE(columns), props: { ...PANE(columns).props, isFocused: true } }) as const

function twoErrors(): Timeline {
  const t = twoTurns()
  return { ...t, steps: t.steps.map(s => (s.id === 's2' ? { ...s, status: 'error' as const } : s)) }
}

test('the footer shows only while the pane is focused, at most 3 entries', async ($, on) => {
  world(on, twoTurns(), TL_UI)
  const idle = await mount($, 'terminal')
  expect(await idle.find({ key: 'hint-n' })).toBeUndefined()
  await idle.unmount()
  const ui = await $.ui.mount({ ...FOCUSED(62), surface: 'terminal' })
  const rows = await drawnRows(ui)
  const foot = rows[rows.length - 1] ?? ''
  expect(foot).toContain('n: next error')
  expect(foot).toContain('p: prev')
  expect(colOf(foot, 'n: next error')).toBe(2)
  expect((foot.match(/ {3}/g) ?? []).length <= 2).toBe(true)
  await ui.unmount()
})

test('n and p step through the errors when there is no query, opening each in place', async ($, on) => {
  const stored = world(on, twoErrors(), TL_UI)
  on('ui.focus', () => ({}))
  const ui = await $.ui.mount({ ...FOCUSED(62), surface: 'terminal' })
  await ui.press({ key: 'hint-n' })
  expect((stored.get('ui') as UiState).stepOpen).toBe('s4')
  await ui.unmount()
  const second = await $.ui.mount({ ...FOCUSED(62), surface: 'terminal' })
  await second.press({ key: 'hint-n' })
  const u = stored.get('ui') as UiState
  expect(u.stepOpen).toBe('s2')
  expect(u.openTurns).toContain('t1')
  await second.unmount()
  const third = await $.ui.mount({ ...FOCUSED(62), surface: 'terminal' })
  await third.press({ key: 'hint-p' })
  expect((stored.get('ui') as UiState).stepOpen).toBe('s4')
  await third.unmount()
})

test('with a query n and p step through the hits and the footer names them', async ($, on) => {
  const stored = world(on, twoTurns(), { ...TL_UI, query: 'rate', openTurns: ['t1'] })
  on('ui.focus', () => ({}))
  const ui = await $.ui.mount({ ...FOCUSED(62), surface: 'terminal' })
  const rows = await drawnRows(ui)
  expect(rows[rows.length - 1]).toContain('n: next hit')
  await ui.press({ key: 'hint-n' })
  expect((stored.get('ui') as UiState).stepOpen).toBe('s3')
  await ui.unmount()
})

test('with a step open and no errors or query the footer reads ↵ full step, q quote, esc close', async ($, on) => {
  const calm = { ...twoTurns(), steps: twoTurns().steps.map(s => ({ ...s, status: 'done' as const })) }
  world(on, calm, { ...TL_UI, stepOpen: 's3' })
  const ui = await $.ui.mount({ ...FOCUSED(62), surface: 'terminal' })
  const rows = await drawnRows(ui)
  const foot = rows[rows.length - 1] ?? ''
  expect(colOf(foot, '↵ full step')).toBe(2)
  expect(foot).toContain('q: quote')
  expect(foot).toContain('esc close')
  await ui.unmount()
})

test('with a step open and errors to visit the footer keeps n and p beside ↵ full step', async ($, on) => {
  world(on, twoTurns(), { ...TL_UI, stepOpen: 's3' })
  const ui = await $.ui.mount({ ...FOCUSED(62), surface: 'terminal' })
  const foot = (await drawnRows(ui)).at(-1) ?? ''
  expect(foot).toContain('n: next error')
  expect(foot).toContain('p: prev')
  expect(foot).toContain('↵ full step')
  await ui.unmount()
})

// ---- the gutter and the tiers --------------------------------------------------

const SEEN = { first: 0, last: 2, of: 3 }
type SeenOn = { first: number; last: number; of: number } | null
const toolRow = (id: string, tool: string, onScreen: SeenOn) => ({
  tool_use_id: id, tool, input: {}, isRunning: false, isErrored: false, isInterrupted: false, onScreen,
})

async function mountRow($: Engine, surface: (typeof SURFACES)[number], id: string, onScreen: SeenOn) {
  return $.ui.mount({
    plugin: 'mission-control', surface, component: 'ToolUse', requestId: id,
    props: toolRow(id, 'Edit', onScreen),
  } as never)
}

test('a step whose row is in view has ◂ in the gutter and counts in the In view chip, and loses both when it leaves', async ($, on) => {
  world(on, twoTurns(), TL_UI)
  for (const surface of SURFACES) {
    const row = await mountRow($, surface, 's3', SEEN)
    const ui = await mount($, surface)
    let rows = await drawnRows(ui)
    expect(colOf(rows.find(r => r.includes('rateLimit.ts')), '◂')).toBe(0)
    expect(rows.find(r => r.includes('npm test'))?.startsWith('◂')).toBe(false)
    expect(colOf(rows[1], 'In view 1')).toBe(38)
    expect(rows.join('\n')).not.toContain('on screen')

    await row.redraw(toolRow('s3', 'Edit', null))
    await clock?.advance(1000)
    rows = await drawnRows(ui)
    expect(rows.find(r => r.includes('rateLimit.ts'))?.startsWith('◂')).toBe(false)
    expect(rows[1]).not.toContain('In view')
    await ui.unmount()

    // The mark is per surface: what one surface shows says nothing of another's.
    await row.redraw(toolRow('s3', 'Edit', SEEN))
    const other = SURFACES.find(s => s !== surface)!
    const elsewhere = await mount($, other)
    expect((await drawnRows(elsewhere)).find(r => r.includes('rateLimit.ts'))?.startsWith('◂')).toBe(false)
    await elsewhere.unmount()
    await row.redraw(toolRow('s3', 'Edit', null))
    await row.unmount()
  }
})

test('with guide: false nothing is added to the conversation and the gutter mark still shows', { options: { guide: false } }, async ($, on) => {
  world(on, twoTurns(), TL_UI)
  const registered: string[] = []
  on('tool.register', (_, e) => {
    registered.push(e.name)
    return { value: { tool: `mcp__mission-control__${e.name}` } }
  })
  on('command.register', () => ({ value: { command: 'mc' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const sections = [{ id: 'lean_body', text: 'body', scope: 'shared' }] as const
  on('prompt.compose', () => ({ sections }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  const composed = await $.prompt.compose({
    model: 'claude-haiku-5-5', promptModel: 'claude-haiku-5-5', surfaces: [],
    tools: ['mcp__mission-control__update'], outputStyle: null, traits: ['lean', 'print'],
  })
  expect(registered).toEqual([])
  expect(composed.sections).toEqual(sections)

  for (const surface of SURFACES) {
    const row = await mountRow($, surface, 's4', SEEN)
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    expect(rows.find(r => r.includes('npm test'))?.startsWith('◂')).toBe(true)
    expect(rows.find(r => r.includes('rateLimit.ts'))?.startsWith('◂')).toBe(false)
    await ui.unmount()
    await row.redraw(toolRow('s4', 'Bash', null))
    await row.unmount()
  }
})

for (const cols of [62, 50, 40, 32]) {
  test(`at ${cols} columns no row is wider than the pane, with a kept step open and a query`, async ($, on) => {
    const t = pinned()
    t.steps.push(step('s6', 6, 'Edit src/server/middleware/rateLimit.ts', 'done', { turnId: 't2', pin: 'the limiter itself, a long note' }))
    t.turns[1] = turn('t2', 'add rate limiting to the upload endpoint and write the tests', NOW - 60_000)
    const stored = world(on, t, TL_UI, new Map([BODY_S4]))
    for (const ui_ of [{ ...TL_UI, stepOpen: 's6', openTurns: ['t1'] }, { ...TL_UI, query: 'rate', hits: ['s4'], stepOpen: 's4' }]) {
      put(stored, t, ui_)
      for (const surface of SURFACES) {
        const ui = await $.ui.mount({ ...FOCUSED(cols), surface })
        const rows = screen(await ui.drawn())
        expect(rows.length > 8).toBe(true)
        for (const r of rows) expect(r.length <= cols ? '' : r).toBe('')
        await ui.unmount()
      }
    }
  })
}

// LOOK TEST (edited for Neo): at 40 the SHOW row keeps two cells (14 and 26).
test('at 40 columns the time sits at the last cell and the chips stay on cells', async ($, on) => {
  world(on, twoTurns(), TL_UI)
  const ui = await mount($, 'terminal', 40)
  const rows = await drawnRows(ui)
  expect(colOf(rows[1], ' All 4 ')).toBe(14)
  expect(colOf(rows[1], 'Errors 1')).toBe(26)
  expect(rows[1]?.length).toBe(40)
  const row = rows.find(r => r.includes('npm test'))
  expect(colOf(row, '1s')).toBe(26)
  expect(row).not.toContain('main')
  await ui.unmount()
})

test('at 32 columns only the cells that fit are drawn, and the open filter is kept', async ($, on) => {
  const kept = { ...twoTurns(), steps: twoTurns().steps.map(s => (s.id === 's3' ? { ...s, pin: '' } : s)) }
  world(on, kept, { ...TL_UI, filter: { kind: 'errors' } })
  const ui = await mount($, 'terminal', 32)
  const chips = (await drawnRows(ui))[1] ?? ''
  expect(chips).toContain('Errors 1')
  expect(chips).not.toContain('In view')
  expect(chips.length <= 32).toBe(true)
  await ui.unmount()
})

test('focused, every row of Steps, footer included, fits 32 and 40 columns', async ($, on) => {
  world(on, twoErrors(), TL_UI)
  for (const columns of [32, 40]) {
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...FOCUSED(columns), surface })
      const rows = screen(await ui.drawn())
      expect(rows.some(r => r.includes('n: '))).toBe(true)
      for (const r of rows) expect(r.length <= columns).toBe(true)
      await ui.unmount()
    }
  }
})

test('a general-purpose agent shows general in the metric cell at 62, never general-p…', async ($, on) => {
  const t = twoTurns()
  world(
    on,
    { ...t, agents: { ...t.agents, a1: agent('a1', 'general-purpose') }, steps: t.steps.map(x => (x.id === 's4' ? { ...x, agent: 'a1' } : x)) },
    TL_UI,
  )
  const ui = await mount($, 'terminal', 62)
  const row = (await drawnRows(ui)).find(r => r.includes('npm test')) ?? ''
  expect(colOf(row, 'general')).toBe(38)
  expect(row).not.toContain('general-')
  await ui.unmount()
})

// ---- Neo Rich: the step MAP and the step page ------------------------------------

test('mapBuckets counts steps into slices of the session, marks an error and the run in view', () => {
  const mk = (id: string, at: number, status: Step['status'] = 'done'): Step => ({ id, seq: 1, agent: 'main', tool: 'Bash', label: id, status, startedAt: at })
  const steps = [mk('a', 0), mk('b', 10), mk('c', 20, 'error'), mk('d', 90), mk('e', 100)]
  const got = mapBuckets(steps, 100, 4, id => id === 'd' || id === 'e')
  expect(got.map(b => b.count)).toEqual([3, 0, 0, 2])
  expect(got.map(b => b.error)).toEqual([true, false, false, false])
  expect(got.map(b => b.view)).toEqual([false, false, false, true])
  expect(mapBuckets([], 100, 4, () => false).map(b => b.count)).toEqual([0, 0, 0, 0])
})

test('MAP on the terminal: a 44 x 2 Raster, an error bucket red and the rest iris; the text form is the same box', async ($, on) => {
  const spread: Timeline = { ...twoTurns(), steps: twoTurns().steps.map((x, i) => ({ ...x, startedAt: NOW - 400_000 + i * 100_000 })) }
  world(on, spread, TL_UI)
  const ui = await mount($, 'terminal', 62)
  const r = await ui.find({ type: 'Raster', key: 'map' })
  expect([r?.props.columns, r?.props.rows]).toEqual([44, 2])
  const cells = decode(String(r?.props.cells))
  const lit = cells.filter(c => c[0] !== 0x20 && c[0] !== 0x2581)
  expect(lit.some(c => c[1] === PALETTE.night.red)).toBe(true)
  expect(lit.some(c => c[1] === PALETTE.night.iris)).toBe(true)
  await ui.unmount()
  const narrow = await mount($, 'terminal', 32)
  expect(Number((await narrow.find({ type: 'Raster', key: 'map' }))?.props.columns)).toBe(16)
  await narrow.unmount()
})

// ---- the step page -------------------------------------------------------------------

const PAGE_UI = (id: string): UiState => ({ ...TL_UI, stepOpen: id, page: { kind: 'step', id } })
const withBody = (id: string, body: Record<string, unknown>, text = 'ok') =>
  ({ ...TL_UI, stepOpen: id, page: { kind: 'step', id }, stepBody: { stepId: id, body: { input: body, text, cut: 0, isError: false } } }) as UiState

function editorWorld(on: On) {
  const runs: string[][] = []
  const copies: string[] = []
  on('session.root', () => ({ value: 'C:/repo' }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.copy', (_, e) => {
    copies.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('ui.toast', () => ({ value: undefined }))
  return { runs, copies }
}

function oneStep(id: string, tool: string, label: string, status: Step['status'] = 'done'): Timeline {
  return { ...empty, turns: [turn('t1', 'go', NOW - 900_000)], steps: [step(id, 1, label, status, { turnId: 't1', tool })] }
}

test('filesOf names file_path, notebook_path, a path with an extension, and the clear paths of a Bash command, with the line when known', () => {
  expect(filesOf('Read', { file_path: 'src/a.ts', offset: 40 })).toEqual([{ path: 'src/a.ts', line: 40, image: false }])
  expect(filesOf('Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' })).toEqual([{ path: 'src/a.ts', image: false }])
  expect(filesOf('NotebookEdit', { notebook_path: 'n/a.ipynb' })).toEqual([{ path: 'n/a.ipynb', image: false }])
  expect(filesOf('Grep', { pattern: 'x', path: 'src/middleware' })).toEqual([])
  expect(filesOf('Grep', { pattern: 'x', path: 'src/a.ts' })).toEqual([{ path: 'src/a.ts', image: false }])
  expect(
    filesOf('Bash', { command: 'node run.js ./scripts/build.sh --flag https://x.dev/a.html && cat docs/plan.md:12 | wc' }).map(f => [f.path, f.line]),
  ).toEqual([
    ['./scripts/build.sh', undefined],
    ['docs/plan.md', 12],
  ])
  expect(filesOf('Read', { file_path: 'shots/a.PNG' })[0]?.image).toBe(true)
  expect(filesOf('Read', { file_path: 'a.ts', offset: 3 }).concat(filesOf('Read', { file_path: 'a.ts' })).length).toBe(2)
  expect(filesOf('Bash', {})).toEqual([])
})

test('the step page lists FILES with o: open; openInEditor runs on a press only, at the line', async ($, on) => {
  const w = editorWorld(on)
  world(on, oneStep('s1', 'Read', 'Read src/a.ts'), withBody('s1', { file_path: 'src/a.ts', offset: 42 }))
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 62)
    const rows = await drawnRows(ui)
    const at = rows.findIndex(r => r.startsWith('┌ FILES'))
    expect(at).toBeGreaterThan(-1)
    expect(rows[at + 1]).toContain('a.ts')
    // The row is the short form; the whole path is on the page under it.
    expect(rows.slice(at + 2).some(r => r.trim() === 'src/a.ts')).toBe(true)
    expect(colOf(rows[at + 1], 'o: open')).toBe(38)
    expect(colOf(rows[at + 1], 'line 42')).toBe(50)
    expect(rows.some(r => r.includes('o: open') && r.trimStart().startsWith('o: open'))).toBe(true)
    // Drawing opens nothing.
    expect(w.runs).toEqual([])
    await ui.unmount()
  }
  const ui = await mount($, 'terminal', 62)
  await ui.press({ key: 'step-page-open' })
  expect(w.runs).toEqual([['code', '-r', '-g', 'C:/repo/src/a.ts:42']])
  await ui.press({ key: 'step-page-file-0' })
  expect(w.runs).toHaveLength(2)
  expect(w.runs[1]).toEqual(['code', '-r', '-g', 'C:/repo/src/a.ts:42'])
  await ui.unmount()
})

test('the step page has a row and an o: open for every path the step names; the o key opens the first', async ($, on) => {
  const w = editorWorld(on)
  world(on, oneStep('s1', 'Bash', 'Bash cp a b'), withBody('s1', { command: 'cp src/a.ts ./b/c.md' }))
  const ui = await mount($, 'desktop', 62)
  expect(await ui.find({ key: 'step-page-file-0' })).toBeDefined()
  expect(await ui.find({ key: 'step-page-file-1' })).toBeDefined()
  expect((await drawnRows(ui)).join(' ')).not.toContain('image preview')
  await ui.press({ key: 'step-page-file-1' })
  expect(w.runs).toEqual([['code', '-r', '-g', 'C:/repo/b/c.md']])
  await ui.press({ key: 'step-page-open' })
  expect(w.runs[1]).toEqual(['code', '-r', '-g', 'C:/repo/src/a.ts'])
  await ui.unmount()
})

test('an image step says it opens in the editor image preview, and still opens through the editor', async ($, on) => {
  const w = editorWorld(on)
  world(on, oneStep('s1', 'Read', 'Read shots/a.png'), withBody('s1', { file_path: 'shots/a.png' }))
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 62)
    const flat = (await drawnRows(ui)).join('\n')
    expect(flat).toContain("opens in your editor's image preview")
    await ui.unmount()
  }
  const ui = await mount($, 'terminal', 62)
  await ui.press({ key: 'step-page-open' })
  expect(w.runs).toEqual([['code', '-r', '-g', 'C:/repo/shots/a.png']])
  await ui.unmount()
})

test('a step with no file has no FILES and no o: open', async ($, on) => {
  world(on, oneStep('s1', 'Bash', 'Bash ls'), withBody('s1', { command: 'ls' }))
  const ui = await mount($, 'desktop', 62)
  const flat = (await drawnRows(ui)).join('\n')
  expect(flat).not.toContain('FILES')
  expect(flat).not.toContain('o: open')
  expect(await ui.find({ key: 'step-page-open' })).toBeUndefined()
  await ui.unmount()
})

test('the step page: TOOL, AGENT, STATUS, TIME, INPUT, CHANGE as a diff for Edit, RESULT in full, the actions, nothing cut', async ($, on) => {
  const longPath = 'src/some/very/deep/folder/structure/that/goes/on/and/on/forever/rateLimit.ts'
  const result = Array.from({ length: 30 }, (_, i) => `result line ${i}`).join('\n')
  world(
    on,
    oneStep('s1', 'Edit', `Edit ${longPath}`),
    withBody('s1', { file_path: longPath, old_string: 'const a = 1', new_string: 'const a = 2\nconst b = 3' }, result),
  )
  for (const surface of SURFACES) {
    for (const columns of [62, 32]) {
      const ui = await mount($, surface, columns)
      const rows = await drawnRows(ui)
      const flat = rows.join('\n')
      for (const label of ['TOOL', 'AGENT', 'STATUS', 'TIME', 'INPUT', 'CHANGE', 'RESULT', 'FILES']) expect(flat).toContain(label)
      expect(rows.some(r => r.includes('-const a = 1'))).toBe(true)
      expect(rows.some(r => r.includes('+const b = 3'))).toBe(true)
      expect(flat).toContain('result line 29')
      for (const r of rows) {
        expect(r.length <= columns).toBe(true)
        expect(r.trimEnd().endsWith('…')).toBe(false)
      }
      // The long path is on the page whole (the row cuts it, the lines under FILES give it in full).
      expect(flat.replace(/\s+/g, '')).toContain(longPath)
      for (const k of ['o: open', 'g: chat', 'k: keep', 'c: copy as Markdown', 'q: quote', 'b: back']) expect(flat).toContain(k)
      await ui.unmount()
    }
  }
})

test('the step page: g, k, c and q act on a press; c copies the step as Markdown', async ($, on) => {
  const copies: string[] = []
  const fills: string[] = []
  const toasts: string[] = []
  on('ui.copy', (_, e) => {
    copies.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('ui.toast', (_, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })
  on('prompt.fill', (_, e) => {
    fills.push(e.text)
    return { isFilled: true as const }
  })
  const stored = world(on, oneStep('s1', 'Read', 'Read a.ts'), withBody('s1', { file_path: 'a.ts' }, 'file text'))
  const ui = await mount($, 'terminal', 62)
  expect([copies, fills, toasts]).toEqual([[], [], []])
  await ui.press({ key: 'step-page-copy' })
  expect(copies).toHaveLength(1)
  expect(copies[0]).toContain('### Read a.ts')
  expect(copies[0]).toContain('file text')
  await ui.press({ key: 'step-page-quote' })
  expect(fills[0]).toContain('> Read: Read a.ts')
  // Nothing beneath the mounted kit scrolls a transcript, so the press toasts why.
  await ui.press({ key: 'step-page-chat' })
  expect(toasts.some(t => t.startsWith('Not shown in chat'))).toBe(true)
  await ui.press({ key: 'step-page-keep' })
  expect((stored.get('timeline') as Timeline).steps[0]?.pin).toBe('')
  await ui.unmount()
})

test('the step page for a step whose body is not on disk says so', async ($, on) => {
  world(on, oneStep('s1', 'Bash', 'Bash ls'), { ...PAGE_UI('s1'), stepBody: { stepId: 's1', missing: true } } as UiState)
  const a = await mount($, 'desktop', 62)
  expect((await drawnRows(a)).join('\n')).toContain('Result not kept on disk.')
  await a.unmount()
})

test('the step page for a running step says it has no result yet', async ($, on) => {
  world(on, oneStep('s2', 'Bash', 'Bash sleep 9', 'running'), PAGE_UI('s2'))
  const b = await mount($, 'desktop', 62)
  expect((await drawnRows(b)).join('\n')).toContain('No result yet')
  await b.unmount()
})
