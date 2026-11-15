import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Step, TaskItem, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { colOf, screen } from './screen.testkit'

// `/mc strip`: the strip layout drawn in the band in place of the pane.
// AbovePrompt is raised on terminal, desktop and mobile only.
const SURFACES = ['terminal', 'desktop', 'mobile'] as const
const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }

type Stored = Map<string, unknown>
type World = { stored: Stored; opened: Record<string, unknown>[]; closed: string[] }

function world(on: On, t: Timeline, u?: Partial<UiState>): World {
  const stored: Stored = new Map()
  stored.set('timeline', t)
  if (u) stored.set('ui', u)
  const versions = new Map<string, number>()
  const opened: Record<string, unknown>[] = []
  const closed: string[] = []
  mock.clock(on, { now: NOW })
  on('ui.log', () => ({ value: undefined }))
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    const v = stored.get(key)
    return {
      value: {
        value: v === undefined ? undefined : { shape: SHAPES[key], value: v },
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
  on('ui.open', (_, e) => {
    opened.push(e as unknown as Record<string, unknown>)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_, e) => {
    closed.push((e as unknown as { id: string }).id)
    return { value: undefined }
  })
  return { stored, opened, closed }
}

const run = ($: Engine, args: string) => $.command.run({ command: 'mc', args } as never)
const uiOf = (w: World): UiState => w.stored.get('ui') as UiState

const BAND = (cols: number, maxRows: number) =>
  ({
    plugin: 'mission-control',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isCollapsed: false,
      isWorking: true,
      maxRows,
      bodyColumns: cols,
      scroll: { offset: 0, bodyRows: Math.max(0, maxRows - 1) },
      view: {},
    },
  }) as const

async function bandRows($: Engine, cols: number, maxRows = 20, surface: (typeof SURFACES)[number] = 'terminal'): Promise<string[]> {
  const ui = await $.ui.mount({ ...BAND(cols, maxRows), surface })
  const out = screen(await ui.drawn())
  await ui.unmount()
  return out
}

const task = (id: string, subject: string, status: TaskItem['status']): TaskItem => ({ id, subject, status, owner: 'main', updatedAt: NOW - 120_000 })
const agent = (id: string, type: string, description: string, startedAt: number): AgentRow => ({
  id,
  parent: 'main',
  type,
  description,
  status: 'running',
  startedAt,
  doing: '',
  stepCount: 1,
})
const step = (id: string, seq: number, label: string, status: Step['status'], extra: Partial<Step> = {}): Step => ({
  id,
  seq,
  agent: 'main',
  tool: 'Edit',
  label,
  status,
  startedAt: NOW - 5000,
  ...extra,
})

const FOCUS = 'Grouping timeline steps by agent'
const BUSY: Timeline = {
  ...empty,
  now: { focus: FOCUS, next: 'Humanise step labels', at: NOW - 20_000 },
  tasks: [task('1', 'Map', 'completed'), task('2', 'Group', 'in_progress'), task('3', 'Humanise step labels', 'pending')],
  agents: {
    main: { ...empty.agents.main! },
    a1: { ...agent('a1', 'Explore', 'find every caller of stepRow', NOW - 60_000), tokensIn: 50_000, tokensOut: 22_000 },
    a2: { ...agent('a2', 'general-purpose', 'write timeline tests', NOW - 40_000), tokensIn: 80_000, tokensOut: 8000 },
  },
  steps: [
    step('s1', 1, 'Bash npm test -- timeline', 'error', { tool: 'Bash', agent: 'a2', endedAt: NOW - 4000, startedAt: NOW - 9000 }),
    step('s3', 3, 'Edit mod/hooks/views/timeline.tsx', 'running', { startedAt: NOW - 2000 }),
  ],
  budget: { contextPct: 9, windows: [{ name: 'seven_day', pct: 22 }], at: NOW },
}

const DECK_LABELS = ['┏ FOCUS', '┃ NEXT', '┃ CREW', '┃ TASKS', '┃ STEPS', '┗ BUDGET']
const rowAt = (rows: string[], text: string): number => rows.findIndex(r => r.includes(text))

// ---------- the toggle ----------

test('/mc strip closes the pane, writes ui.strip and the band draws the strip rows with the compact line under them', async ($, on) => {
  const w = world(on, BUSY)
  await run($, '')
  expect(uiOf(w).paneOpen).toBe(true)

  const got = await run($, 'strip')

  expect(got.text).toBe('Mission Control: strip, above the prompt.')
  expect(w.closed).toEqual(['mission-control'])
  expect(uiOf(w).strip).toBe(true)
  expect(uiOf(w).paneOpen).toBe(false)
  for (const surface of SURFACES) {
    const rows = await bandRows($, 110, 20, surface)
    // The deck's six rows beside AGENTS and LATEST (NOW 50 wide, a gap of 3, AGENTS and LATEST taking the rest), then the band's one compact row.
    expect(rows.length).toBe(7)
    expect(rows.slice(0, 6).map(r => r.slice(0, 8).trim())).toEqual(DECK_LABELS)
    expect(colOf(rows[0], FOCUS)).toBe(14)
    expect(colOf(rows[0], '┌ AGENTS')).toBe(53)
    expect(rowAt(rows, '┌ LATEST')).toBeGreaterThan(0)
    expect(colOf(rows[rowAt(rows, '┌ LATEST')], '┌ LATEST')).toBe(53)
    const line = rows[6]!
    expect(line.startsWith('┃  WORKING ')).toBe(true)
    expect(line.length).toBe(110)
  }
})

test('a second /mc strip restores the band and re-opens the pane the way /mc does', async ($, on) => {
  const w = world(on, BUSY)
  await run($, 'strip')

  const got = await run($, 'strip')

  expect(got.text).toBe('Mission Control opened.')
  expect(uiOf(w).strip).toBe(false)
  expect(uiOf(w).paneOpen).toBe(true)
  expect(w.opened.length).toBe(1)
  expect(w.opened[0]).toMatchObject({ id: 'mission-control', columns: 62, focus: true })
  // The pane is open: the band is its one compact row again.
  const rows = await bandRows($, 110)
  expect(rows.length).toBe(1)
  expect(rowAt(rows, 'FOCUS')).toBe(-1)
})

test('plain /mc and /mc 1-5 turn the strip off and open the pane', async ($, on) => {
  const w = world(on, BUSY)
  await run($, 'strip')
  await run($, '')
  expect(uiOf(w).strip).toBe(false)
  expect(w.opened.length).toBe(1)

  await run($, 'strip')
  await run($, '3')
  expect(uiOf(w).strip).toBe(false)
  expect(uiOf(w).tab).toBe('agents')
  expect(w.opened.length).toBe(2)
  expect((await bandRows($, 110)).length).toBe(1)
})

test('/mc slim and /mc strip do not fight: the last one wins', async ($, on) => {
  const w = world(on, BUSY)
  await run($, 'slim')
  expect(w.opened[0]).toMatchObject({ columns: 28 })

  // strip after slim: the strip shows, the pane is closed.
  await run($, 'strip')
  expect(uiOf(w).strip).toBe(true)
  expect(w.closed).toEqual(['mission-control'])
  expect(rowAt(await bandRows($, 110), '┏ FOCUS')).toBe(0)

  // slim after strip: the slim pane shows (slim is not toggled away), the strip is off.
  const said = await run($, 'slim')
  expect(said.text).toBe('Mission Control: slim, 28 columns.')
  expect(uiOf(w).strip).toBe(false)
  expect(uiOf(w).slim).toBe(true)
  expect(w.opened[1]).toMatchObject({ columns: 28 })
  expect((await bandRows($, 110)).length).toBe(1)

  // strip again, then off: the pane comes back at the slim width it had.
  await run($, 'strip')
  await run($, 'strip')
  expect(w.opened[2]).toMatchObject({ columns: 28 })
})

test('/mc close while the strip is on leaves the strip on: close is about the pane', async ($, on) => {
  const w = world(on, BUSY)
  await run($, 'strip')
  await run($, 'close')
  expect(uiOf(w).strip).toBe(true)
})

// ---------- fitting ----------

for (const cols of [96, 80, 62]) {
  test(`every strip row fits bodyColumns at ${cols}`, async ($, on) => {
    world(on, BUSY, { ...initialUi, strip: true })
    for (const surface of SURFACES) {
      const rows = await bandRows($, cols, 20, surface)
      expect(rowAt(rows, '┏ FOCUS')).toBe(0)
      expect(rowAt(rows, '┌ AGENTS')).toBeGreaterThanOrEqual(0)
      expect(rowAt(rows, '┌ LATEST')).toBeGreaterThanOrEqual(0)
      for (const r of rows) expect([cols, r.length <= cols]).toEqual([cols, true])
      expect(rows.length <= 20).toBe(true)
    }
  })
}

test('under 96 the halves stack: the deck, a blank, AGENTS and LATEST, then the compact line; 14 rows', async ($, on) => {
  world(on, BUSY, { ...initialUi, strip: true })
  const rows = await bandRows($, 80, 20)
  expect(rows.length).toBe(14)
  expect(rows.slice(0, 6).map(r => r.slice(0, 8).trim())).toEqual(DECK_LABELS)
  expect(rows[6]).toBe('')
  expect(colOf(rows[7], '┌ AGENTS')).toBe(0)
  expect(colOf(rows[rowAt(rows, '┌ LATEST')], '┌ LATEST')).toBe(0)
  expect(rows[13]!.startsWith('┃  WORKING ')).toBe(true)
})

test('a band shorter than the strip keeps the frame and trims AGENTS and LATEST, never past maxRows', async ($, on) => {
  world(on, BUSY, { ...initialUi, strip: true })
  // 80 columns: 14 rows wanted.
  for (const maxRows of [13, 11, 10, 9, 8, 7, 4, 2, 1]) {
    const rows = await bandRows($, 80, maxRows)
    expect([maxRows, rows.length <= maxRows]).toEqual([maxRows, true])
    // The compact line is always the last row.
    expect(rows[rows.length - 1]!.startsWith('┃  WORKING ')).toBe(true)
  }
  // 10 rows: the whole deck, a blank and AGENTS cut to its head and first agent.
  const ten = await bandRows($, 80, 10)
  expect(ten.slice(0, 6).map(r => r.slice(0, 8).trim())).toEqual(DECK_LABELS)
  expect(rowAt(ten, '┌ AGENTS')).toBe(7)
  expect(rowAt(ten, 'find every caller')).toBe(8)
  // 7 rows: the deck alone, AGENTS and LATEST trimmed away.
  const seven = await bandRows($, 80, 7)
  expect(seven.slice(0, 6).map(r => r.slice(0, 8).trim())).toEqual(DECK_LABELS)
  expect(rowAt(seven, '┌ AGENTS')).toBe(-1)
  // 4 rows: the deck gives up BUDGET and STEPS (and NEXT) from its bottom, FOCUS stays.
  const four = await bandRows($, 80, 4)
  expect(four[0]!.startsWith('┏ FOCUS')).toBe(true)
  expect(rowAt(four, 'BUDGET')).toBe(-1)
  // Beside each other at 110, 5 rows trim the right half to fit the deck's 4.
  const wide = await bandRows($, 110, 5)
  expect(wide.length).toBe(5)
  for (const r of wide) expect(r.length <= 110).toBe(true)
})

// ---------- presses ----------

test('strip rows in the band are plain Buttons with no hotkey: a bare digit presses nothing', async ($, on) => {
  world(on, BUSY, { ...initialUi, strip: true })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND(110, 20), surface })
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.length).toBeGreaterThan(0)
    for (const b of buttons) expect((b.props as { hotkey?: string }).hotkey).toBe(undefined)
    await ui.unmount()
  }
})

test('pressing CREW in the band strip turns the strip off and opens the pane on Agents', async ($, on) => {
  const w = world(on, BUSY, { ...initialUi, strip: true })
  const ui = await $.ui.mount({ ...BAND(110, 20), surface: 'terminal' })
  await ui.press({ key: 'deck-crew' })
  await ui.unmount()
  expect(uiOf(w).tab).toBe('agents')
  expect(uiOf(w).strip).toBe(false)
  expect(w.opened.length).toBe(1)
  expect(w.opened[0]).toMatchObject({ id: 'mission-control', focus: true })
})

test('pressing a step in the band strip opens it on Steps in the pane', async ($, on) => {
  const w = world(on, BUSY, { ...initialUi, strip: true })
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  const ui = await $.ui.mount({ ...BAND(110, 20), surface: 'terminal' })
  await ui.press({ key: 'step-s1' })
  await ui.unmount()
  expect(uiOf(w).tab).toBe('timeline')
  expect(uiOf(w).stepOpen).toBe('s1')
  expect(uiOf(w).strip).toBe(false)
  expect(w.opened.length).toBe(1)
})

// ---------- the stored value ----------

test('a ui-4 value without strip reads false: no shape bump, the band is the normal band', async ($, on) => {
  const old = { ...initialUi, tab: 'tasks' } as Partial<UiState>
  delete old.strip
  const w = world(on, BUSY, old)
  // Pane closed, 110 columns: the normal three-row band.
  const rows = await bandRows($, 110)
  expect(rows.length).toBe(3)
  await run($, 'strip')
  expect(uiOf(w)).toMatchObject({ tab: 'tasks', strip: true })
})

test('the initial ui has strip false', () => {
  expect(initialUi.strip).toBe(false)
})

test('the strip draws even with nothing to say, where the normal band passes', async ($, on) => {
  world(on, empty, { ...initialUi, strip: true })
  const rows = await bandRows($, 110)
  expect(rows[0]!.startsWith('┏ FOCUS')).toBe(true)
})

test('session.start with autoOpen opens no pane while the strip is on', { options: { autoOpen: true } }, async ($, on) => {
  const w = world(on, BUSY, { ...initialUi, strip: true })
  mock.env(on, {})
  on('command.register', () => ({ value: { command: 'mc' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(w.opened.length).toBe(0)
})

// ---------- compartments: the strip takes the band's whole width ----------

const WIDE: Timeline = {
  ...BUSY,
  budget: {
    contextPct: 9,
    windows: [
      { name: 'five_hour', pct: 18, resetsAt: NOW + 2 * 3_600_000 },
      { name: 'seven_day', pct: 22, resetsAt: NOW + 3 * 86_400_000 },
    ],
    at: NOW,
  },
}

/** Every word the fixture can put on a row: a cut must end on one of them. */
const WORDS = [
  FOCUS, 'Humanise step labels', 'Map', 'Group', 'find every caller of stepRow', 'write timeline tests',
  'Bash npm test -- timeline', 'Edit mod/hooks/views/timeline.tsx', 'Explore', 'general-purpose', 'general',
].flatMap(x => x.split(/\s+/))

/** Each `word…` on the rows: a cut at a word leaves a whole word (or a path's last parts) before the `…`. */
function midWordCuts(rows: string[]): string[] {
  const bad: string[] = []
  for (const r of rows) {
    for (const m of r.matchAll(/(\S+)…/g)) {
      const tok = m[1]!
      if (!WORDS.some(w => w === tok || w.endsWith(`/${tok}`))) bad.push(tok)
    }
  }
  return bad
}

/** The columns where the compartments of the strip's first row start: `┏` (NOW) and each `┌`. */
function starts(row: string): number[] {
  const out: number[] = []
  for (let i = 0; i < row.length; i++) if (row[i] === '┏' || row[i] === '┌') out.push(i)
  return out
}

const COMPARTMENTS: [number, number[], string[]][] = [
  // NOW keeps 50; AGENTS and LATEST take the other 47 after a gap of 3.
  [100, [0, 53], ['FOCUS', 'AGENTS']],
  // NOW 50 | AGENTS 47 | LATEST 47: the spare split evenly between the lists.
  [150, [0, 53, 103], ['FOCUS', 'AGENTS', 'LATEST']],
  // 50 + 22 + 42 + 42 + 24 = 180: gaps of 3 would not fit, so 2; TASKS takes the 2 spare.
  [190, [0, 52, 78, 122, 166], ['FOCUS', 'TASKS', 'AGENTS', 'LATEST', 'BUDGET']],
]

for (const [cols, at, labels] of COMPARTMENTS) {
  test(`at ${cols} columns the strip is ${at.length} compartments starting at ${at.join(', ')}, none wider than the band, no cut inside a word`, async ($, on) => {
    world(on, WIDE, { ...initialUi, strip: true })
    for (const surface of SURFACES) {
      const rows = await bandRows($, cols, 20, surface)
      expect(starts(rows[0]!)).toEqual(at)
      labels.forEach((label, i) => expect([label, colOf(rows[0], label)]).toEqual([label, at[i]! + 2]))
      for (const r of rows) expect([cols, r.length <= cols]).toEqual([cols, true])
      expect(midWordCuts(rows)).toEqual([])
      // The compact line stays under the strip, the band's whole width.
      expect(rows[rows.length - 1]!.startsWith('┃  WORKING ')).toBe(true)
      expect(rows.length <= 7).toBe(true)
    }
  })
}

test('at 150 the text takes the room it has: names and arguments are not cut', async ($, on) => {
  world(on, WIDE, { ...initialUi, strip: true })
  const rows = await bandRows($, 150)
  expect(rows.some(r => r.includes('find every caller of stepRow'))).toBe(true)
  expect(rows.some(r => r.includes('write timeline tests'))).toBe(true)
  expect(rows.some(r => r.includes('npm test -- timeline'))).toBe(true)
  // LATEST fills its rows: the error, the running step.
  const latest = colOf(rows[0], '┌ LATEST')
  expect(rows.filter(r => r.slice(latest).match(/^ {2}[✖▸✓]/)).length).toBe(2)
})

test('at 190 BUDGET shows each window with its reset time, and NOW gives up its own BUDGET row', async ($, on) => {
  world(on, WIDE, { ...initialUi, strip: true })
  const rows = await bandRows($, 190)
  const budget = colOf(rows[0], '┌ BUDGET')
  expect(rows.some(r => r.slice(budget).startsWith('  CTX ◔ 9%'))).toBe(true)
  const five = rows.find(r => r.slice(budget).startsWith('  5H'))!
  expect(five.slice(budget + 14).trim()).toMatch(/^\d{2}:\d{2}$/)
  const seven = rows.find(r => r.slice(budget).startsWith('  7D'))!
  expect(seven.slice(budget + 14).trim()).toMatch(/^[A-Z][a-z]{2} \d{2}:\d{2}$/)
  expect(rows.some(r => r.startsWith('┗ BUDGET') || r.startsWith('┃ BUDGET'))).toBe(false)
})

test('at 190 with something waiting, NEEDS YOU takes the second compartment in place of TASKS', async ($, on) => {
  const asked: Step = step('w1', 4, 'Bash rm -rf build', 'running', { tool: 'Bash', startedAt: NOW - 60_000, asking: NOW - 30_000 })
  world(on, { ...WIDE, steps: [...WIDE.steps, asked] }, { ...initialUi, strip: true })
  const rows = await bandRows($, 190)
  expect(colOf(rows[0], '┌ NEEDS YOU')).toBe(52)
  expect(colOf(rows[0], 'TASKS')).toBe(-1)
  for (const r of rows) expect(r.length <= 190).toBe(true)
})

test('compartments drop from the right where the width runs out: at 180 BUDGET goes and NOW keeps its own BUDGET row', async ($, on) => {
  world(on, WIDE, { ...initialUi, strip: true })
  const at180 = await bandRows($, 180)
  // Five need 180 and four gaps of 2: 188. Four: NOW 50 | TASKS 27 | AGENTS 47 | LATEST 47, gaps of 3.
  expect(starts(at180[0]!)).toEqual([0, 53, 83, 133])
  expect(colOf(at180[0], 'BUDGET')).toBe(-1)
  expect(at180.some(r => r.startsWith('┗ BUDGET'))).toBe(true)
  for (const r of at180) expect(r.length <= 180).toBe(true)
  expect(midWordCuts(at180)).toEqual([])
})
