import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Step, TaskItem, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { colOf, screen } from './screen.testkit'

// `/binnacle strip`: the strip layout drawn in the band in place of the pane.
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

const run = ($: Engine, args: string) => $.command.run({ command: 'binnacle', args } as never)
const uiOf = (w: World): UiState => w.stored.get('ui') as UiState

const BAND = (cols: number, maxRows: number) =>
  ({
    plugin: 'binnacle',
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

const rowAt = (rows: string[], text: string): number => rows.findIndex(r => r.includes(text))

// ---------- the toggle ----------

// LOOK TEST (edited for Rich): the Neo text form, drawn where there is no Raster and with the look option on text; the rich form is tested in rich2.test.tsx.
// LOOK TEST (C6): the band's compact line under the strip is the cockpit's one row (`1 of 3  ·  2 agents  ·  …  /mc`); it was the Neo bracket row (`┃  WORKING …`). The strip's own rows are unchanged.
test('text form: /binnacle strip closes the pane, writes ui.strip and the band draws the strip rows with the compact line under them', { options: { look: 'text' } }, async ($, on) => {
  const w = world(on, BUSY)
  await run($, '')
  expect(uiOf(w).paneOpen).toBe(true)

  const got = await run($, 'strip')

  expect(got.text).toBe('Binnacle: strip, above the prompt.')
  expect(w.closed).toEqual(['binnacle'])
  expect(uiOf(w).strip).toBe(true)
  expect(uiOf(w).paneOpen).toBe(false)
  for (const surface of SURFACES) {
    const rows = await bandRows($, 110, 20, surface)
    // Now's header (9 rows), a blank and the needs slot in the left 62 columns, To do and Agents beside them, a blank (R57), then the band's one compact row.
    expect(rows.length).toBe(13)
    expect(rows[0]!.startsWith('┏━━')).toBe(true)
    expect(rows[1]!.startsWith('   WORKING')).toBe(true)
    expect(rows.some(r => colOf(r, FOCUS.split(' ')[0]!) === 9)).toBe(true)
    expect(colOf(rows[0], 'To do')).toBe(64)
    expect(rows[11]!.trim()).toBe('')
    const line = rows[12]!
    expect(line.startsWith('1 of 3  ·  2 agents')).toBe(true)
    expect(line.length).toBe(110)
  }
})

test('a second /binnacle strip restores the band and re-opens the pane the way /binnacle does', async ($, on) => {
  const w = world(on, BUSY)
  await run($, 'strip')

  const got = await run($, 'strip')

  expect(got.text).toBe('Binnacle opened.')
  expect(uiOf(w).strip).toBe(false)
  expect(uiOf(w).paneOpen).toBe(true)
  expect(w.opened.length).toBe(1)
  expect(w.opened[0]).toMatchObject({ id: 'binnacle', columns: 62, focus: true })
  // The pane is open: the band is its one compact row again.
  const rows = await bandRows($, 110)
  expect(rows.length).toBe(1)
  expect(rowAt(rows, 'FOCUS')).toBe(-1)
})

test('plain /binnacle and /binnacle 1-5 turn the strip off and open the pane', async ($, on) => {
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

// LOOK TEST (edited for Rich): the Neo text form, drawn where there is no Raster and with the look option on text; the rich form is tested in rich2.test.tsx.
// LOOK TEST (C6): the band's compact line under the strip is the cockpit's one row (`1 of 3  ·  2 agents  ·  …  /mc`); it was the Neo bracket row (`┃  WORKING …`). The strip's own rows are unchanged.
test('text form: /binnacle slim and /binnacle strip do not fight: the last one wins', { options: { look: 'text' } }, async ($, on) => {
  const w = world(on, BUSY)
  await run($, 'slim')
  expect(w.opened[0]).toMatchObject({ columns: 28 })

  // strip after slim: the strip shows, the pane is closed.
  await run($, 'strip')
  expect(uiOf(w).strip).toBe(true)
  expect(w.closed).toEqual(['binnacle'])
  expect((await bandRows($, 110))[0]!.startsWith('┏━━')).toBe(true)

  // slim after strip: the slim pane shows (slim is not toggled away), the strip is off.
  const said = await run($, 'slim')
  expect(said.text).toBe('Binnacle: slim, 28 columns.')
  expect(uiOf(w).strip).toBe(false)
  expect(uiOf(w).slim).toBe(true)
  expect(w.opened[1]).toMatchObject({ columns: 28 })
  expect((await bandRows($, 110)).length).toBe(1)

  // strip again, then off: the pane comes back at the slim width it had.
  await run($, 'strip')
  await run($, 'strip')
  expect(w.opened[2]).toMatchObject({ columns: 28 })
})

test('/binnacle close while the strip is on leaves the strip on: close is about the pane', async ($, on) => {
  const w = world(on, BUSY)
  await run($, 'strip')
  await run($, 'close')
  expect(uiOf(w).strip).toBe(true)
})

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


// ---------- fitting (R34: Now's header left, To do and Agents right) ----------

for (const cols of [150, 110, 96, 80, 62, 40]) {
  // LOOK TEST (rewritten for the cockpit): the strip is built from Now's parts.
  test(`text form: every strip row fits bodyColumns at ${cols}, the header first and To do under or beside it`, { options: { look: 'text' } }, async ($, on) => {
    world(on, BUSY, { ...initialUi, strip: true })
    for (const surface of SURFACES) {
      const rows = await bandRows($, cols, 20, surface)
      expect(rows[0]!.startsWith('┏━━')).toBe(true)
      expect(rows[1]!.startsWith('   WORKING')).toBe(true)
      expect(rowAt(rows, 'To do')).toBeGreaterThanOrEqual(0)
      for (const r of rows) expect([cols, r.length <= cols]).toEqual([cols, true])
      expect(rows.length <= 20).toBe(true)
      expect(rows[rows.length - 1]!.startsWith('1 of 3  ·  2 agents')).toBe(true)
      expect(midWordCuts(rows)).toEqual([])
    }
  })
}

test('from 96 columns the two columns sit side by side: the header in the left 62, To do and Agents from 62 + 2', { options: { look: 'text' } }, async ($, on) => {
  world(on, BUSY, { ...initialUi, strip: true })
  const rows = await bandRows($, 110, 20)
  expect(colOf(rows[0], 'To do')).toBe(64)
  expect(rows.some(r => colOf(r, 'Agents') === 64)).toBe(true)
  expect(rows.some(r => colOf(r, 'Explorer') === 71)).toBe(true)
  // Header 9 rows, a blank, the all-clear line: the right column trimmed to that height, then a blank (R57) and the compact line.
  expect(rows.length).toBe(13)
  expect(rows[10]).toContain('✓ Nothing needs you')
})

test('under 96 the strip stacks: the header, the needs slot, then To do, then the compact line', { options: { look: 'text' } }, async ($, on) => {
  world(on, BUSY, { ...initialUi, strip: true })
  const rows = await bandRows($, 80, 20)
  expect(rows[0]!.startsWith('┏━━')).toBe(true)
  expect(rows[10]).toContain('✓ Nothing needs you')
  expect(rows[12]!.startsWith('  To do')).toBe(true)
  expect(rows[rows.length - 1]!.startsWith('1 of 3  ·  2 agents')).toBe(true)
})

test('a band shorter than the strip drops whole blocks from the bottom, never past maxRows; the compact line stays', { options: { look: 'text' } }, async ($, on) => {
  world(on, BUSY, { ...initialUi, strip: true })
  for (const maxRows of [19, 13, 11, 10, 9, 8, 7, 4, 2, 1]) {
    for (const cols of [80, 110]) {
      const rows = await bandRows($, cols, maxRows)
      expect([maxRows, cols, rows.length <= maxRows]).toEqual([maxRows, cols, true])
      expect(rows[rows.length - 1]!.startsWith('1 of 3  ·  2 agents')).toBe(true)
    }
  }
  // Ten rows: the header whole, nothing cut inside it.
  const ten = await bandRows($, 80, 10)
  expect(ten[0]!.startsWith('┏━━')).toBe(true)
  expect(ten[8]!.endsWith('━━┛')).toBe(true)
  // Seven rows: no room for the header; the needs slot and To do.
  const seven = await bandRows($, 80, 7)
  expect(seven[0]).toContain('✓ Nothing needs you')
  expect(rowAt(seven, 'To do')).toBeGreaterThan(0)
})

// ---------- presses ----------

test('strip rows in the band are plain Buttons with no hotkey: a bare digit presses nothing', async ($, on) => {
  world(on, BUSY, { ...initialUi, strip: true })
  for (const surface of SURFACES) {
    for (const cols of [110, 80]) {
      const ui = await $.ui.mount({ ...BAND(cols, 20), surface })
      const buttons = await ui.findAll({ type: 'Button' })
      expect(buttons.length).toBeGreaterThan(0)
      for (const b of buttons) expect((b.props as { hotkey?: string }).hotkey).toBe(undefined)
      await ui.unmount()
    }
  }
})

test('pressing Agents in the band strip turns the strip off and opens the pane on Agents', async ($, on) => {
  const w = world(on, BUSY, { ...initialUi, strip: true })
  const ui = await $.ui.mount({ ...BAND(110, 20), surface: 'terminal' })
  await ui.press({ key: 'sec-agents' })
  await ui.unmount()
  expect(uiOf(w).tab).toBe('agents')
  expect(uiOf(w).strip).toBe(false)
  expect(w.opened.length).toBe(1)
  expect(w.opened[0]).toMatchObject({ id: 'binnacle', focus: true })
})

// BEHAVIOUR CHANGE (R34): the strip holds no step rows (Now holds no log); a task row opens its page instead.
test('pressing a task in the band strip opens its page in the pane', async ($, on) => {
  const w = world(on, BUSY, { ...initialUi, strip: true })
  const ui = await $.ui.mount({ ...BAND(110, 20), surface: 'terminal' })
  await ui.press({ key: 'task-main-2' })
  await ui.unmount()
  expect(uiOf(w).page).toEqual({ kind: 'task', id: 'main:2', from: 'task-main-2' })
  expect(uiOf(w).strip).toBe(false)
  expect(w.opened.length).toBe(1)
})

// ---------- the stored value ----------

test('a ui-4 value without strip reads false: no shape bump, the band is the normal band', async ($, on) => {
  const old = { ...initialUi, tab: 'tasks' } as Partial<UiState>
  delete old.strip
  const w = world(on, BUSY, old)
  // Pane closed, 110 columns: the normal band, which is two rows now (C6: it was three; the strip's rows would be 12).
  const rows = await bandRows($, 110)
  expect(rows.length).toBe(2)
  await run($, 'strip')
  expect(uiOf(w)).toMatchObject({ tab: 'tasks', strip: true })
})

test('the initial ui has strip false', () => {
  expect(initialUi.strip).toBe(false)
})

// LOOK TEST (edited for Rich): the Neo text form, drawn where there is no Raster and with the look option on text; the rich form is tested in rich2.test.tsx.
// LOOK TEST (C6): the band's compact line under the strip is the cockpit's one row (`1 of 3  ·  2 agents  ·  …  /mc`); it was the Neo bracket row (`┃  WORKING …`). The strip's own rows are unchanged.
test('text form: the strip draws even with nothing to say, where the normal band passes', { options: { look: 'text' } }, async ($, on) => {
  world(on, empty, { ...initialUi, strip: true })
  const rows = await bandRows($, 110)
  expect(rows[0]!.startsWith('┏━━')).toBe(true)
})

test('session.start with autoOpen opens no pane while the strip is on', { options: { autoOpen: true } }, async ($, on) => {
  const w = world(on, BUSY, { ...initialUi, strip: true })
  mock.env(on, {})
  on('command.register', () => ({ value: { command: 'binnacle' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(w.opened.length).toBe(0)
})

