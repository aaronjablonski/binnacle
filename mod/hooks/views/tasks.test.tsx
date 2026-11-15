import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, TaskItem, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { colOf, screen } from './screen.testkit'

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
  return { stored, clock }
}

const seed = (on: On, t: Timeline, u?: UiState): Stored => world(on, t, u).stored

const PANE = (columns: number, isFocused = false) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    props: {
      title: 'Mission Control',
      isFocused,
      bodyColumns: columns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
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

async function mount($: Engine, surface: (typeof SURFACES)[number], columns = 62, isFocused = false) {
  return $.ui.mount({ ...PANE(columns, isFocused), surface })
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

// LOOK TEST (rewritten for Neo): replaces "readouts DONE, ACTIVE, QUEUED and ELAPSED sit on cells 2, 14, 26 and 38".
test('the TASKS and PACE deck: rails on 0 and 61, label at 2, gauge at 14, value at 38, aside at 50', async ($, on) => {
  seed(on, BUSY, TASKS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    const tasks = rowWith(rows, 'TASKS')
    const pace = rowWith(rows, 'PACE')
    expect(tasks.startsWith('┏ ')).toBe(true)
    expect(pace.startsWith('┗ ')).toBe(true)
    expect(tasks.length).toBe(62)
    expect(tasks.endsWith('┓')).toBe(true)
    expect(pace.endsWith('┛')).toBe(true)
    expect([colOf(tasks, 'TASKS'), colOf(tasks, '▪'), colOf(tasks, '5/13'), colOf(tasks, '1h00')]).toEqual([2, 14, 38, 50])
    expect([colOf(pace, 'PACE'), colOf(pace, '12m each'), colOf(pace, '7 queued')]).toEqual([2, 38, 50])
    expect(pace.slice(14, 36)).toMatch(/^[▁▂▃▄▅▆▇█]{22}$/)
    // the deck is the first block: tab content starts with it, one blank row, then ACTIVE
    expect(rows.indexOf(pace) - rows.indexOf(tasks)).toBe(1)
    expect(rows[rows.indexOf(pace) + 1]).toBe('')
    await ui.unmount()
  }
})

// LOOK TEST (rewritten for Neo): replaces "every diagram is 10 wide and the three bars share one scale".
test('the TASKS gauge is one pip per task: ▪ done, ▸ current, ▫ queued', async ($, on) => {
  seed(on, BUSY, TASKS_UI)
  const ui = await mount($, 'terminal')
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
  const wide = await mount($, 'terminal')
  const bar = rowWith(await drawnRows(wide), 'TASKS').slice(14, 36)
  expect(bar).toHaveLength(22)
  expect(bar).toMatch(/^▮+▯+$/)
  await wide.unmount()
})

// LOOK TEST (edited for Neo): the active block now holds its tethered agents, and the glyphs are ▫ and ▪.
test('sections run ACTIVE, QUEUED, DONE and are capped at 1, 5 and 3 with a more line', async ($, on) => {
  seed(on, BUSY, TASKS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    const order = ['┌ ACTIVE', '┌ QUEUED', '┌ DONE'].map(h => rows.findIndex(r => r.startsWith(h)))
    const [a, q, d] = order as [number, number, number]
    expect(a).toBeGreaterThan(-1)
    expect(q).toBeGreaterThan(a)
    expect(d).toBeGreaterThan(q)
    const between = (from: number, to: number): string[] => rows.slice(from + 1, to).filter(r => r.trim() !== '')
    expect(between(a, q).length).toBe(3)
    const queued = between(q, d)
    expect(queued.length).toBe(6)
    expect(queued.slice(0, 5).map(r => r.slice(2, 3))).toEqual(['▫', '▫', '▫', '▫', '▫'])
    expect(queued[5]).toBe('  + 2 more')
    const done = rows.slice(d + 1).filter(r => r.trim() !== '')
    expect(done.filter(r => r.startsWith('  ▪')).map(r => r.slice(4, 21).trimEnd())).toEqual(['Read the plan', 'Read the spec', 'Read the handover'])
    expect(done).toContain('  + 2 more')
    // no blank row twice in a row anywhere
    for (let i = 1; i < rows.length; i++) expect(rows[i] === '' && rows[i - 1] === '').toBe(false)
    await ui.unmount()
  }
})

test('rows put glyph at 2, name at 4, the metric at 38 and the time at 50 at 62 columns', async ($, on) => {
  seed(on, BUSY, TASKS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    const active = rowWith(rows, 'Grouping timeline steps')
    expect([colOf(active, '▸'), colOf(active, 'Grouping'), colOf(active, '2 live'), colOf(active, '3m')]).toEqual([2, 4, 38, 50])
    const done = rowWith(rows, 'Read the plan')
    expect([colOf(done, '▪'), colOf(done, 'Read the plan'), colOf(done, '10m')]).toEqual([2, 4, 50])
    const heads = rowWith(rows, '┌ ACTIVE')
    expect([colOf(heads, 'agents'), colOf(heads, 'time')]).toEqual([38, 50])
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

test('pressing the active row opens its agents with type and doing; pressing again closes it', async ($, on) => {
  const stored = seed(on, BUSY, TASKS_UI)
  const ui = await mount($, 'terminal')
  expect((await drawnRows(ui)).some(r => r.includes('Explore · find callers'))).toBe(false)
  await ui.press({ key: 'task-main:a1' })
  await ui.unmount()
  expect((stored.get('ui') as UiState).taskOpen).toBe('main:a1')
  const again = await mount($, 'terminal')
  const rows = await drawnRows(again)
  const first = rowWith(rows, 'Explore · find callers')
  expect([colOf(first, 'agent'), colOf(first, 'Explore · find callers')]).toEqual([6, 14])
  expect(colOf(rowWith(rows, 'general-purpose · write tests'), 'general-purpose · write tests')).toBe(14)
  expect(first).toContain('Grep stepRow')
  await again.press({ key: 'task-main:a1' })
  await again.unmount()
  expect((stored.get('ui') as UiState).taskOpen).toBeUndefined()
  const closed = await mount($, 'terminal')
  expect((await drawnRows(closed)).some(r => r.includes('Explore · find callers'))).toBe(false)
  await closed.unmount()
})

test('an opened task with no agent says so', async ($, on) => {
  seed(on, { ...empty, tasks: [task('1', 'Solo job', 'in_progress')] }, { ...TASKS_UI, taskOpen: 'main:1' })
  const ui = await mount($, 'terminal')
  expect((await drawnRows(ui)).some(r => r.includes('none working on it'))).toBe(true)
  await ui.unmount()
})

test('d unfolds every done task and folds them again', async ($, on) => {
  const stored = seed(on, BUSY, TASKS_UI)
  // The mounted pane does not redraw under a mocked state: each press is read from a fresh mount.
  const doneRows = async (): Promise<{ n: number; hint: string }> => {
    const ui = await mount($, 'terminal', 62, true)
    const rows = await drawnRows(ui)
    await ui.unmount()
    return { n: rows.filter(r => r.startsWith('  ▪')).length, hint: rowWith(rows, 'e: export').trim() }
  }
  expect(await doneRows()).toEqual({ n: 3, hint: '↵ open   d: all done   e: export' })
  const first = await mount($, 'terminal', 62, true)
  await first.press({ key: 'hint-d' })
  await first.unmount()
  expect((stored.get('ui') as UiState).doneAll).toBe(true)
  expect(await doneRows()).toEqual({ n: 5, hint: '↵ open   d: newest 3   e: export' })
  const second = await mount($, 'terminal', 62, true)
  await second.press({ key: 'hint-d' })
  await second.unmount()
  expect((stored.get('ui') as UiState).doneAll).toBeUndefined()
  expect((await doneRows()).n).toBe(3)
})

test('the footer shows at most 3 hints, only while focused: ↵ open, d all done, e export', async ($, on) => {
  seed(on, BUSY, TASKS_UI)
  const quiet = await mount($, 'terminal', 62, false)
  expect((await drawnRows(quiet)).some(r => r.includes('e: export'))).toBe(false)
  await quiet.unmount()
  const ui = await mount($, 'terminal', 62, true)
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
  const ui = await mount($, 'terminal', 40)
  const rows = await drawnRows(ui)
  const tasks = rowWith(rows, 'TASKS')
  expect(tasks.length).toBe(40)
  expect(tasks.endsWith('┓')).toBe(true)
  expect(tasks).not.toContain('5/13')
  expect(tasks).not.toContain('1h00')
  expect(rowWith(rows, 'PACE')).not.toContain('queued')
  const active = rowWith(rows, 'Grouping')
  expect(colOf(active, '3m')).toBe(26)
  expect(active).not.toContain('live')
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
  const ui = await mount($, 'terminal', 32)
  const rows = await drawnRows(ui)
  const tasks = rowWith(rows, 'TASKS')
  expect(tasks.length).toBe(32)
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

test('focused, every row of Tasks, footer included, fits 32 and 40 columns', async ($, on) => {
  seed(on, BUSY, TASKS_UI)
  for (const columns of [32, 40]) {
    for (const surface of SURFACES) {
      const ui = await mount($, surface, columns, true)
      const rows = await drawnRows(ui)
      expect(rows.some(r => r.includes('d: '))).toBe(true)
      for (const r of rows) expect(r.length <= columns).toBe(true)
      await ui.unmount()
    }
  }
})
