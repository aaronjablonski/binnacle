import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, TaskItem, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { decode, PALETTE } from './raster'
import { backTo, colOf, keepLog, LOGS, screen } from './screen.testkit'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }

type Stored = Map<string, unknown>

// The engine's $.state beneath the mod: seeded with a timeline, remembering
// every write so a press can be read back.
function world(on: On, t: Timeline, u?: UiState): { stored: Stored; clock: MockClock } {
  const stored: Stored = new Map()
  stored.set('timeline', t)
  if (u) stored.set('ui', u)
  const versions = new Map<string, number>()
  const clock = mock.clock(on, { now: NOW })
  LOGS.length = 0
  on('ui.log', keepLog)
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
  return { stored, clock }
}

const seed = (on: On, t: Timeline, u?: UiState): Stored => world(on, t, u).stored

const PANE = (columns: number, isFocused = false, bodyRows = 40) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    props: {
      title: 'Mission Control',
      isFocused,
      bodyColumns: columns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows },
      view: {},
    },
  }) as const

const task = (id: string, subject: string, status: TaskItem['status'], extra: Partial<TaskItem> = {}): TaskItem => ({
  id,
  subject,
  status,
  owner: 'main',
  updatedAt: NOW - 120_000,
  ...extra,
})
const agent = (
  id: string,
  type: string,
  description: string,
  doing: string,
  status: AgentRow['status'] = 'running',
): AgentRow => ({
  id,
  parent: 'main',
  type,
  description,
  status,
  startedAt: NOW - 60_000,
  doing,
  stepCount: 1,
})

const main: AgentRow = { ...empty.agents.main! }

async function mount($: Engine, surface: (typeof SURFACES)[number], columns = 62, isFocused = false, bodyRows = 40) {
  return $.ui.mount({ ...PANE(columns, isFocused, bodyRows), surface })
}

const drawnRows = async (ui: Awaited<ReturnType<typeof mount>>): Promise<string[]> => screen(await ui.drawn())

const TASKS_UI: UiState = {
  tab: 'tasks', filter: { kind: 'all' }, agentsMode: 'list', folded: [], openTurns: [],
  dismissed: [], query: '', runningOnly: false, notified: [], toasted: [], slim: false,
}

// 1 active (with 2 live agents), 7 queued, 5 done: every cap is crossed.
const BUSY: Timeline = {
  ...empty,
  steps: [{ id: 's1', seq: 1, agent: 'main', tool: 'Bash', label: 'Bash ls', status: 'done', startedAt: NOW - 3_600_000 }],
  tasks: [
    task('d1', 'Count the ts files', 'completed', { updatedAt: NOW - 1_000_000 }),
    task('d2', 'List the headings', 'completed', { updatedAt: NOW - 900_000 }),
    task('d3', 'Read the handover', 'completed', { updatedAt: NOW - 800_000 }),
    task('d4', 'Read the spec', 'completed', { updatedAt: NOW - 700_000 }),
    task('d5', 'Read the plan', 'completed', { updatedAt: NOW - 600_000 }),
    task('a1', 'Group timeline steps by agent', 'in_progress', { activeForm: 'Grouping timeline steps', updatedAt: NOW - 180_000 }),
    ...[1, 2, 3, 4, 5, 6, 7].map(n => task(`q${n}`, `Queued task ${n}`, 'pending')),
  ],
  agents: {
    main,
    x1: { ...agent('x1', 'Explore', 'find callers', 'Grep stepRow'), taskId: 'a1', tokensIn: 70_000, tokensOut: 2_000 },
    x2: { ...agent('x2', 'general-purpose', 'write tests', 'Edit a.ts'), taskId: 'a1', tokensIn: 88_000 },
  },
}

const rowWith = (rows: string[], text: string): string => rows.find(r => r.includes(text)) ?? ''

const TEXT_SURFACES = ['desktop', 'vscode', 'mobile'] as const

// LOOK TEST (rewritten for Neo Rich): replaces "the TASKS and PACE deck: rails on 0 and 61, label at 2, gauge at 14, value at 38, aside at 50".
// The text form (every surface but the terminal) is TASKS, PLAN and PACE between the rails.
test('the text deck is TASKS, PLAN and PACE: rails on 0 and 61, label at 2, gauge at 14, value at 38, aside at 50', async ($, on) => {
  seed(on, BUSY, TASKS_UI)
  for (const surface of TEXT_SURFACES) {
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    const tasks = rowWith(rows, 'TASKS')
    const plan = rowWith(rows, 'PLAN')
    const pace = rowWith(rows, 'PACE')
    expect(tasks.startsWith('┏ ')).toBe(true)
    expect(plan.startsWith('┃ ')).toBe(true)
    expect(pace.startsWith('┗ ')).toBe(true)
    expect(tasks.length).toBe(62)
    expect(tasks.endsWith('┓')).toBe(true)
    expect(pace.endsWith('┛')).toBe(true)
    expect([colOf(tasks, 'TASKS'), colOf(tasks, '▪'), colOf(tasks, '5/13'), colOf(tasks, '1h00')]).toEqual([2, 14, 38, 50])
    expect([colOf(plan, 'PLAN'), colOf(plan, '160k all'), colOf(plan, 'peak 160k')]).toEqual([2, 38, 50])
    expect(plan.slice(14, 36)).toMatch(/^[▁▂▃▄▅▆▇█]{22}$/)
    expect([colOf(pace, 'PACE'), colOf(pace, '12m each'), colOf(pace, '7 queued')]).toEqual([2, 38, 50])
    expect(pace.slice(14, 36)).toMatch(/^[▁▂▃▄▅▆▇█]{22}$/)
    // the deck is the first block: tab content starts with it, one blank row, then ACTIVE
    expect([rows.indexOf(plan) - rows.indexOf(tasks), rows.indexOf(pace) - rows.indexOf(plan)]).toEqual([1, 1])
    expect(rows[rows.indexOf(pace) + 1]).toBe('')
    await ui.unmount()
  }
})

// LOOK TEST (rewritten for Neo): replaces "every diagram is 10 wide and the three bars share one scale".
test('the TASKS gauge is one pip per task: ▪ done, ▸ current, ▫ queued', async ($, on) => {
  seed(on, BUSY, TASKS_UI)
  const ui = await mount($, 'desktop')
  const row = rowWith(await drawnRows(ui), 'TASKS')
  expect(row.slice(14, 27)).toBe('▪▪▪▪▪▸▫▫▫▫▫▫▫')
  await ui.unmount()
})

test('over 22 tasks the TASKS gauge is a 22-cell ▮▯ bar', async ($, on) => {
  const many: Timeline = {
    ...BUSY,
    tasks: [...BUSY.tasks, ...Array.from({ length: 12 }, (_, i) => task(`z${i}`, `Extra ${i}`, 'pending'))],
  }
  seed(on, many, TASKS_UI)
  const wide = await mount($, 'desktop')
  const bar = rowWith(await drawnRows(wide), 'TASKS').slice(14, 36)
  expect(bar).toHaveLength(22)
  expect(bar).toMatch(/^▮+▯+$/)
  await wide.unmount()
})

// LOOK TEST (edited for Neo): the active block now holds its tethered agents, and the glyphs are ▫ and ▪.
// BEHAVIOUR CHANGE (binding rule 2): QUEUED and DONE were capped at 5 and 3; they now grow with the pane's height, never below those caps.
test('sections run ACTIVE, QUEUED, DONE; QUEUED and DONE grow with the height: their old caps on a short pane, more at 24 and 36, every task at 50', async ($, on) => {
  // 12 queued and 9 done: more than a 24-row pane holds, all of them in 50.
  const LONG: Timeline = {
    ...BUSY,
    tasks: [
      ...BUSY.tasks,
      ...[8, 9, 10, 11, 12].map(n => task(`q${n}`, `Queued ${n}`, 'pending')),
      ...[6, 7, 8, 9].map(n => task(`d${n}`, `Old ${n}`, 'completed', { updatedAt: NOW - 2_000_000 - n })),
    ],
  }
  seed(on, LONG, TASKS_UI)
  const shownAt = async (surface: (typeof SURFACES)[number], bodyRows: number) => {
    const ui = await mount($, surface, 62, false, bodyRows)
    const rows = await drawnRows(ui)
    await ui.unmount()
    const [a, q, d] = ['┌ ACTIVE', '┌ QUEUED', '┌ DONE'].map(h => rows.findIndex(r => r.startsWith(h))) as [number, number, number]
    expect(a).toBeGreaterThan(-1)
    expect(q).toBeGreaterThan(a)
    expect(d).toBeGreaterThan(q)
    const between = (from: number, to: number): string[] => rows.slice(from + 1, to).filter(r => r.trim() !== '')
    expect(between(a, q).length).toBe(3)
    const queued = between(q, d)
    const done = rows.slice(d + 1).filter(r => r.trim() !== '')
    // no blank row twice in a row anywhere
    // (On the terminal the testkit draws the lintel and sill Rasters as blank rows, so only the text form is held to this.)
    if (surface !== 'terminal') for (let i = 1; i < rows.length; i++) expect(rows[i] === '' && rows[i - 1] === '').toBe(false)
    return {
      queued: queued.filter(r => r.startsWith('  ▫')).length,
      queuedMore: queued.find(r => r.startsWith('  + ')),
      done: done.filter(r => r.startsWith('  ▪')).map(r => r.slice(4, 21).trimEnd()),
      doneMore: done.find(r => r.startsWith('  + ')),
      rows: rows.length,
    }
  }
  for (const surface of SURFACES) {
    // A pane shorter than the lists keeps the old caps exactly: 5 queued and 3 done, each with its more line.
    const tiny = await shownAt(surface, 16)
    expect([tiny.queued, tiny.queuedMore]).toEqual([5, '  + 7 more'])
    expect([tiny.done, tiny.doneMore]).toEqual([['Read the plan', 'Read the spec', 'Read the handover'], '  + 6 more'])
    // 24 rows: at least the caps, the spare rows dealt, both still with a more line.
    const short = await shownAt(surface, 24)
    expect(short.queued).toBeGreaterThanOrEqual(5)
    expect(short.done.slice(0, 3)).toEqual(['Read the plan', 'Read the spec', 'Read the handover'])
    expect(short.queuedMore !== undefined && short.doneMore !== undefined).toBe(true)
    // 36 rows: room for more, and the pane is filled no further than its height.
    const mid = await shownAt(surface, 36)
    expect(mid.queued + mid.done.length).toBeGreaterThan(short.queued + short.done.length)
    expect(mid.queued).toBeGreaterThanOrEqual(short.queued)
    expect(mid.done.length).toBeGreaterThanOrEqual(short.done.length)
    // 50 rows: every task, and no more line.
    const tall = await shownAt(surface, 50)
    expect([tall.queued, tall.queuedMore, tall.done.length, tall.doneMore]).toEqual([12, undefined, 9, undefined])
  }
})

test('rows put glyph at 2, name at 4, the metric at 38 and the time at 50 at 62 columns', async ($, on) => {
  seed(on, BUSY, TASKS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    const active = rowWith(rows, 'Grouping timeline steps')
    expect([colOf(active, '▸'), colOf(active, 'Grouping'), colOf(active, '160k'), colOf(active, '3m')]).toEqual([2, 4, 38, 50])
    const done = rowWith(rows, 'Read the plan')
    expect([colOf(done, '▪'), colOf(done, 'Read the plan'), colOf(done, '10m')]).toEqual([2, 4, 50])
    const heads = rowWith(rows, '┌ ACTIVE')
    expect([colOf(heads, 'tokens'), colOf(heads, 'time')]).toEqual([38, 50])
    await ui.unmount()
  }
})

test('the active row is bold in the accent, pending is dim, done is dim throughout', async ($, on) => {
  seed(on, BUSY, TASKS_UI)
  const ui = await mount($, 'terminal')
  const found = await ui.findAll({ type: 'Text' })
  const withText = (text: string) => found.find(f => f.text === text)
  expect((withText('▸')?.props as { color?: string }).color).toBe('suggestion')
  expect((withText('Grouping timeline steps')?.props as { bold?: boolean }).bold).toBe(true)
  expect((withText('▫')?.props as { dimColor?: boolean }).dimColor).toBe(true)
  expect((withText('▪')?.props as { dimColor?: boolean }).dimColor).toBe(true)
  expect((withText('Read the plan')?.props as { dimColor?: boolean }).dimColor).toBe(true)
  await ui.unmount()
})

// LOOK TEST (rewritten for Neo): replaces "pressing the active row opens its agents": the agents are now tethered under the active task.
test('the active task has its agents tethered under it: ├╌ and ╰╌, hull at 4, name at 6, tokens at 38, time at 50', async ($, on) => {
  seed(on, BUSY, TASKS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    const first = rowWith(rows, 'find callers')
    const second = rowWith(rows, 'write tests')
    expect([colOf(first, '├╌'), colOf(first, '◉'), colOf(first, 'find callers'), colOf(first, '72k'), colOf(first, '1m')]).toEqual([2, 4, 6, 38, 50])
    expect([colOf(second, '╰╌'), colOf(second, '▣'), colOf(second, 'write tests'), colOf(second, '88k'), colOf(second, '1m')]).toEqual([2, 4, 6, 38, 50])
    // both sit directly under the active row
    const at = rows.findIndex(r => r.includes('Grouping timeline steps'))
    expect([rows[at + 1], rows[at + 2]]).toEqual([first, second])
    await ui.unmount()
  }
})

test('the tethered agents have the hull colour of their pod; a fifth agent folds into a more line', async ($, on) => {
  const crowd: Timeline = {
    ...BUSY,
    agents: {
      ...BUSY.agents,
      ...Object.fromEntries(
        [3, 4, 5, 6].map(n => [`x${n}`, { ...agent(`x${n}`, 'general-purpose', `job ${n}`, 'Edit b.ts'), taskId: 'a1' }]),
      ),
    },
  }
  seed(on, crowd, TASKS_UI)
  const ui = await mount($, 'terminal')
  const rows = await drawnRows(ui)
  expect(rows.filter(r => /^ {2}[├╰]╌/.test(r)).length).toBe(4)
  expect(rows.filter(r => r.startsWith('  ├╌')).length).toBe(4)
  expect(rows.some(r => r.startsWith('  ╰╌'))).toBe(false)
  expect(rows.some(r => r.includes('2 more agents'))).toBe(true)
  const found = await ui.findAll({ type: 'Text' })
  expect((found.find(f => f.text === '◉')?.props as { color?: string }).color).toBe('suggestion')
  await ui.unmount()
})

// BEHAVIOUR CHANGE (rich rule 4): was "press again closes"
test('Enter on the active task opens its page; b returns to the list with the task focused', async ($, on) => {
  const stored = seed(on, BUSY, TASKS_UI)
  for (const surface of SURFACES) {
    stored.set('ui', TASKS_UI)
    LOGS.length = 0
    const ui = await mount($, surface)
    await ui.press({ key: 'task-main:a1' })
    expect((stored.get('ui') as UiState).page).toEqual({ kind: 'task', id: 'main:a1', from: 'task-main:a1' })
    await ui.redraw()
    await ui.press({ key: 'page-back' })
    expect((stored.get('ui') as UiState).page).toBeUndefined()
    expect(backTo()).toEqual(['task-main:a1'])
    await ui.unmount()
  }
})

// BEHAVIOUR CHANGE (rich rule 4): the in-place block is gone; its "none working on it" line is the page's AGENTS line.
test('the page of a task no agent worked on says so', async ($, on) => {
  seed(on, { ...empty, tasks: [task('1', 'Solo job', 'in_progress')] }, { ...TASKS_UI, page: { kind: 'task', id: 'main:1' } })
  const ui = await mount($, 'terminal')
  expect((await drawnRows(ui)).some(r => r.includes('No agent worked on it.'))).toBe(true)
  await ui.unmount()
})

// BEHAVIOUR CHANGE (binding rule 2): `d` shows where the height rule leaves done tasks out, so this runs at 24 rows.
test('d unfolds every done task and folds them again', async ($, on) => {
  const stored = seed(on, BUSY, TASKS_UI)
  // The mounted pane does not redraw under a mocked state: each press is read from a fresh mount.
  const doneRows = async (): Promise<{ n: number; hint: string }> => {
    const ui = await mount($, 'terminal', 62, true, 24)
    const rows = await drawnRows(ui)
    await ui.unmount()
    return { n: rows.filter(r => r.startsWith('  ▪')).length, hint: rowWith(rows, 'e: export').trim() }
  }
  expect(await doneRows()).toEqual({ n: 3, hint: '↵ open   d: all done   e: export' })
  const first = await mount($, 'terminal', 62, true, 24)
  await first.press({ key: 'hint-d' })
  await first.unmount()
  expect((stored.get('ui') as UiState).doneAll).toBe(true)
  expect(await doneRows()).toEqual({ n: 5, hint: '↵ open   d: newest 3   e: export' })
  const second = await mount($, 'terminal', 62, true, 24)
  await second.press({ key: 'hint-d' })
  await second.unmount()
  expect((stored.get('ui') as UiState).doneAll).toBeUndefined()
  expect((await doneRows()).n).toBe(3)
})

// BEHAVIOUR CHANGE (binding rule 2): at 24 rows, where DONE is held to its old cap and `d` shows.
test('the footer shows at most 3 hints, only while focused: ↵ open, d all done, e export', async ($, on) => {
  seed(on, BUSY, TASKS_UI)
  const quiet = await mount($, 'terminal', 62, false, 24)
  expect((await drawnRows(quiet)).some(r => r.includes('e: export'))).toBe(false)
  await quiet.unmount()
  const ui = await mount($, 'terminal', 62, true, 24)
  const hint = rowWith(await drawnRows(ui), 'e: export')
  expect(hint.trim()).toBe('↵ open   d: all done   e: export')
  expect(colOf(hint, '↵')).toBe(2)
  await ui.unmount()
})

test('e exports the digest from the Tasks tab', async ($, on) => {
  seed(on, { ...BUSY, journal: 'sess1' }, TASKS_UI)
  mock.env(on, { USERPROFILE: 'C:/Users/x', OS: 'Windows_NT' })
  const writes: string[] = []
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('fs.write', (_, e) => {
    writes.push(e.path.split(String.fromCharCode(92)).join('/'))
    return { value: undefined }
  })
  on('ui.copy', () => ({ value: { isCopied: true as const } }))
  on('ui.toast', () => ({ value: undefined }))
  const ui = await mount($, 'terminal', 62, true)
  await ui.press({ key: 'hint-e' })
  expect(writes.length).toBe(1)
  expect(writes[0]).toMatch(/\/sess1\/export-.*\.md$/)
  await ui.unmount()
})

// LOOK TEST (rewritten for Neo): at 40 the deck drops the aside and the value; the gauge stays.
test('at 40 columns: the deck keeps label and gauge only; the time on the last cell (26), no metric; nothing past 40', async ($, on) => {
  seed(on, BUSY, TASKS_UI)
  const ui = await mount($, 'desktop', 40)
  const rows = await drawnRows(ui)
  const tasks = rowWith(rows, 'TASKS')
  expect(tasks.length).toBe(40)
  expect(tasks.endsWith('┓')).toBe(true)
  expect(tasks).not.toContain('5/13')
  expect(tasks).not.toContain('1h00')
  expect(rowWith(rows, 'PACE')).not.toContain('queued')
  const active = rowWith(rows, 'Grouping')
  expect(colOf(active, '3m')).toBe(26)
  expect(active).not.toContain('160k')
  for (const r of rows) expect(r.length <= 40).toBe(true)
  await ui.unmount()
})

// LOOK TEST (rewritten for Neo): at 32 the trace narrows to 10 cells; the 14 pips still fit.
test('at 32 columns: the deck keeps its pips and a 10-cell trace, name only rows; nothing past 32, no row ends inside a word', async ($, on) => {
  seed(
    on,
    { ...BUSY, tasks: [...BUSY.tasks, task('long', 'A task name that is far longer than a narrow pane can hold', 'pending')] },
    TASKS_UI,
  )
  const ui = await mount($, 'desktop', 32)
  const rows = await drawnRows(ui)
  const tasks = rowWith(rows, 'TASKS')
  expect(tasks.length).toBe(32)
  expect(rowWith(rows, 'PLAN').slice(14, 24)).toMatch(/^[▁▂▃▄▅▆▇█]{10}$/)
  expect(tasks.slice(14, 28)).toBe('▪▪▪▪▪▸▫▫▫▫▫▫▫▫')
  expect(rowWith(rows, 'PACE').slice(14, 24)).toMatch(/^[▁▂▃▄▅▆▇█]{10}$/)
  for (const r of rows) expect(r.length <= 32).toBe(true)
  expect(rowWith(rows, 'Grouping').trimEnd()).toBe('  ▸ Grouping timeline steps')
  // A cut name ends with a space-free word and an ellipsis: `…` follows a whole word.
  const cut = rows.filter(r => r.startsWith('  ▫') && r.endsWith('…'))
  for (const r of cut) expect(/\S…$/.test(r)).toBe(true)
  await ui.unmount()
})

test('a task owned by an agent is listed flat with the agent type as its metric', async ($, on) => {
  seed(
    on,
    {
      ...empty,
      tasks: [task('t1', 'Cover burst', 'pending', { owner: 'a1' })],
      agents: { main, a1: { ...agent('a1', 'general-purpose', 'write tests', 'Edit a.ts'), taskId: '2' } },
    },
    TASKS_UI,
  )
  const ui = await mount($, 'terminal')
  const r = rowWith(await drawnRows(ui), 'Cover burst')
  expect([colOf(r, '▫'), colOf(r, 'Cover burst'), colOf(r, 'general')]).toEqual([2, 4, 38])
  expect(r).not.toContain('general-')
  await ui.unmount()
})

test('empty state text', async ($, on) => {
  seed(on, empty, TASKS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect((await drawnRows(ui)).join('\n')).toContain('No tasks yet. They appear when Claude writes a task list.')
    await ui.unmount()
  }
})

test('no row longer than the pane on any surface at 62, 40 and 32', async ($, on) => {
  seed(on, BUSY, { ...TASKS_UI, taskOpen: 'main:a1', doneAll: true })
  for (const surface of SURFACES) {
    for (const columns of [62, 40, 32]) {
      const ui = await mount($, surface, columns, true)
      for (const r of await drawnRows(ui)) expect([surface, columns, r, r.length <= columns]).toEqual([surface, columns, r, true])
      await ui.unmount()
    }
  }
})

// BEHAVIOUR CHANGE (binding rule 2): at 24 rows, where `d` shows.
test('focused, every row of Tasks, footer included, fits 32 and 40 columns', async ($, on) => {
  seed(on, BUSY, TASKS_UI)
  for (const columns of [32, 40]) {
    for (const surface of SURFACES) {
      const ui = await mount($, surface, columns, true, 24)
      const rows = await drawnRows(ui)
      expect(rows.some(r => r.includes('d: '))).toBe(true)
      for (const r of rows) expect(r.length <= columns).toBe(true)
      await ui.unmount()
    }
  }
})

// ---- Neo Rich: the PLAN strip, pace, pages ------------------------------------

const PLANNED: Timeline = {
  ...empty,
  steps: [{ id: 's1', seq: 1, agent: 'main', tool: 'Bash', label: 'Bash ls', status: 'done', startedAt: NOW - 3_600_000 }],
  tasks: [
    task('t1', 'Sketch the bucket', 'completed', { tokens: 40_000, ms: 300_000 }),
    task('t2', 'Map the middleware', 'completed', { tokens: 120_000, ms: 360_000 }),
    task('t3', 'Wire the limiter', 'in_progress', { tokens: 60_000, ms: 120_000, updatedAt: NOW - 120_000 }),
    task('t4', 'Run it on staging', 'pending'),
  ],
  agents: { main },
}

test('PLAN on the terminal: one Raster column per task, its height the tokens it took, its colour its state, the heaviest in ember', async ($, on) => {
  seed(on, PLANNED, TASKS_UI)
  const ui = await mount($, 'terminal')
  const r = await ui.find({ type: 'Raster', key: 'plan' })
  expect(r?.props.columns).toBe(8)
  expect(r?.props.rows).toBe(3)
  const cells = decode(String(r?.props.cells))
  const at = (row: number, n: number) => cells[row * 8 + n * 2]!
  const FULL = 0x2588
  // Heights: t2 (120k) fills all three rows, t3 (60k) half, t1 (40k) one row, t4 (queued) only a rest tick.
  expect([at(0, 1)[0], at(1, 1)[0], at(2, 1)[0]]).toEqual([FULL, FULL, FULL])
  expect(at(0, 2)[0]).not.toBe(FULL)
  expect(at(1, 2)[0]).toBe(0x2584)
  expect(at(1, 0)[0]).not.toBe(FULL)
  expect(at(2, 0)[0]).toBe(FULL)
  expect(at(2, 3)[0]).toBe(0x2581)
  // Colours: done mute, the heaviest ember, the current one iris, queued rest.
  expect(at(2, 0)[1]).toBe(PALETTE.night.mute)
  expect(at(2, 1)[1]).toBe(PALETTE.night.ember)
  expect(at(2, 2)[1]).toBe(PALETTE.night.iris)
  expect(at(2, 3)[1]).toBe(PALETTE.night.rest)
  // The strip names its heaviest and current column, and the deck has no TASKS row (the lintel says 2 of 4).
  const rows = await drawnRows(ui)
  expect(rows.some(x => x.includes('▴2 heaviest') && x.includes('▴3 now'))).toBe(true)
  expect(rows.some(x => x.includes('TASKS'))).toBe(false)
  await ui.unmount()
})

test('PLAN in the text form: per-task tokens in eighth blocks, the total and the peak beside it', async ($, on) => {
  seed(on, PLANNED, TASKS_UI)
  for (const surface of TEXT_SURFACES) {
    const ui = await mount($, surface)
    const plan = rowWith(await drawnRows(ui), 'PLAN')
    expect([colOf(plan, '220k all'), colOf(plan, 'peak 120k')]).toEqual([38, 50])
    expect(plan.slice(14, 22)).toMatch(/^[▁▂▃▄▅▆▇█]{8}$/)
    await ui.unmount()
  }
})

test('over 34 tasks the PLAN strip buckets them so it stays 34 columns wide', async ($, on) => {
  const many: Timeline = { ...PLANNED, tasks: [...PLANNED.tasks, ...Array.from({ length: 40 }, (_, i) => task(`z${i}`, `Extra ${i}`, 'pending'))] }
  seed(on, many, TASKS_UI)
  const ui = await mount($, 'terminal')
  const r = await ui.find({ type: 'Raster', key: 'plan' })
  expect(Number(r?.props.columns)).toBeLessThanOrEqual(34)
  await ui.unmount()
})

test('Enter on a queued or done task opens its page; b returns to the list with the task focused', async ($, on) => {
  const stored = seed(on, BUSY, TASKS_UI)
  for (const key of ['main:q1', 'main:d5']) {
    stored.set('ui', TASKS_UI)
    LOGS.length = 0
    const ui = await mount($, 'desktop')
    await ui.press({ key: `task-${key}` })
    expect((stored.get('ui') as UiState).page).toEqual({ kind: 'task', id: key, from: `task-${key}` })
    await ui.redraw()
    await ui.press({ key: 'page-back' })
    expect((stored.get('ui') as UiState).page).toBeUndefined()
    expect(backTo()).toEqual([`task-${key}`])
    await ui.unmount()
  }
  // The active task has no p: page any more: Enter on its row is the way in.
  const open = await mount($, 'desktop')
  expect((await drawnRows(open)).some(r => r.includes('p: page'))).toBe(false)
  await open.unmount()
})

const LONG_SUBJECT =
  'Wire the rate limiter into the middleware chain ahead of the auth check and make every response carry the limit headers so callers can back off'
const LONG_FORM = 'Wiring the rate limiter into the middleware chain ahead of the auth check'
const LONG_DESC = 'Find every caller of the upload function across the whole repository and report each file and line'
const PAGE_TL: Timeline = {
  ...PLANNED,
  tasks: [...PLANNED.tasks, task('p1', LONG_SUBJECT, 'in_progress', { activeForm: LONG_FORM, tokens: 30_000, ms: 90_000, updatedAt: NOW - 90_000 })],
  agents: {
    main,
    x1: { ...agent('x1', 'Explore', LONG_DESC, 'Grep rateLimit'), taskId: 'p1', tokensIn: 50_000, tokensOut: 2_000 },
  },
  steps: [
    { id: 's1', seq: 1, agent: 'main', tool: 'Bash', label: 'Bash ls', status: 'done', startedAt: NOW - 3_600_000 },
    { id: 's2', seq: 2, agent: 'x1', tool: 'Grep', label: 'Grep rateLimit in src/middleware/limits/upload/handlers.ts', status: 'done', startedAt: NOW - 80_000 },
  ],
}

test('the task page shows the whole subject, the active form, status, time and tokens, its agents in full and its steps, and no line ends in …', async ($, on) => {
  seed(on, PAGE_TL, { ...TASKS_UI, page: { kind: 'task', id: 'main:p1' } })
  for (const surface of SURFACES) {
    for (const columns of [62, 40, 32]) {
      const ui = await mount($, surface, columns)
      const rows = await drawnRows(ui)
      for (const r of rows) {
        expect([surface, columns, r.length <= columns]).toEqual([surface, columns, true])
        expect([surface, columns, r.trimEnd().endsWith('…')]).toEqual([surface, columns, false])
      }
      // Every word of the long texts is on the page: nothing was cut.
      const flat = rows.join(' ').replace(/\s+/g, ' ')
      for (const text of [LONG_SUBJECT, LONG_FORM, LONG_DESC]) {
        for (const w of text.split(' ')) expect([surface, columns, w, flat.includes(w)]).toEqual([surface, columns, w, true])
      }
      expect(flat).toContain('in progress')
      expect(flat).toContain('Explore')
      expect(flat).toContain('52k')
      expect(flat).toContain('STEPS')
      expect(flat).toContain('b: back')
      await ui.unmount()
    }
  }
})

test('the task page stacks the tokens by agent and sets the time against the usual', async ($, on) => {
  seed(on, PAGE_TL, { ...TASKS_UI, page: { kind: 'task', id: 'main:p1' } })
  const ui = await mount($, 'desktop')
  const flat = (await drawnRows(ui)).join('\n')
  expect(flat).toContain('TOKENS BY AGENT')
  expect(flat).toMatch(/main 30k · 37%/)
  expect(flat).toMatch(/Explore 52k · 63%/)
  // The usual is the median of the done tasks (5m and 6m).
  expect(flat).toMatch(/usually 5m/)
  await ui.unmount()
})

test('a task page for a task that is gone says so', async ($, on) => {
  seed(on, PLANNED, { ...TASKS_UI, page: { kind: 'task', id: 'main:nope' } })
  const ui = await mount($, 'desktop')
  expect((await drawnRows(ui)).join('\n')).toContain('This task is gone.')
  await ui.unmount()
})
