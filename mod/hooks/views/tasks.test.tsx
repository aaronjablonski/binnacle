import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, TaskItem, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { bar10 } from './fit'
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
    x1: { ...agent('x1', 'Explore', 'find callers', 'Grep stepRow'), taskId: 'a1' },
    x2: { ...agent('x2', 'general-purpose', 'write tests', 'Edit a.ts'), taskId: 'a1' },
  },
}

const rowWith = (rows: string[], text: string): string => rows.find(r => r.includes(text)) ?? ''

test('readouts DONE, ACTIVE, QUEUED and ELAPSED sit on cells 2, 14, 26 and 38', async ($, on) => {
  seed(on, BUSY, TASKS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    const labels = rowWith(rows, 'DONE  ')
    expect([colOf(labels, 'DONE'), colOf(labels, 'ACTIVE'), colOf(labels, 'QUEUED'), colOf(labels, 'ELAPSED')]).toEqual([2, 14, 26, 38])
    const at = rows.indexOf(labels)
    const values = rows[at + 1] ?? ''
    expect(values.slice(2, 14).trimEnd()).toBe('5/13')
    expect(values.slice(14, 26).trimEnd()).toBe('1')
    expect(values.slice(26, 38).trimEnd()).toBe('7')
    expect(values.slice(38).trimEnd()).toBe('1h00')
    await ui.unmount()
  }
})

test('every diagram is 10 wide and the three bars share one scale, the task total', async ($, on) => {
  seed(on, BUSY, TASKS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    const at = rows.findIndex(r => r.includes('ACTIVE') && r.includes('DONE'))
    const gfx = rows[at + 2] ?? ''
    const cells = [2, 14, 26, 38].map(c => gfx.slice(c, c + 10))
    for (const c of cells) expect(c.length).toBe(10)
    const fill = (c: string): number => [...c].filter(ch => ch === '━').length
    expect(fill(cells[0] ?? '')).toBe(bar10(5, 13).fill.length)
    expect(fill(cells[1] ?? '')).toBe(bar10(1, 13).fill.length)
    expect(fill(cells[2] ?? '')).toBe(bar10(7, 13).fill.length)
    expect(gfx.slice(12, 14)).toBe('  ')
    await ui.unmount()
  }
})

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
    expect(between(a, q).length).toBe(1)
    const queued = between(q, d)
    expect(queued.length).toBe(6)
    expect(queued.slice(0, 5).map(r => r.slice(2, 3))).toEqual(['○', '○', '○', '○', '○'])
    expect(queued[5]).toBe('  + 2 more')
    const done = rows.slice(d + 1).filter(r => r.trim() !== '')
    expect(done.filter(r => r.startsWith('  ✓')).map(r => r.slice(4, 21).trimEnd())).toEqual(['Read the plan', 'Read the spec', 'Read the handover'])
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
    expect([colOf(done, '✓'), colOf(done, 'Read the plan'), colOf(done, '10m')]).toEqual([2, 4, 50])
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
  expect((withText('○')?.props as { dimColor?: boolean }).dimColor).toBe(true)
  expect((withText('✓')?.props as { dimColor?: boolean }).dimColor).toBe(true)
  expect((withText('Read the plan')?.props as { dimColor?: boolean }).dimColor).toBe(true)
  await ui.unmount()
})

test('pressing the active row opens its agents, one line each; pressing again closes it', async ($, on) => {
  const stored = seed(on, BUSY, TASKS_UI)
  const ui = await mount($, 'terminal')
  expect((await drawnRows(ui)).some(r => r.includes('find callers'))).toBe(false)
  await ui.press({ key: 'task-main:a1' })
  await ui.unmount()
  expect((stored.get('ui') as UiState).taskOpen).toBe('main:a1')
  const again = await mount($, 'terminal')
  const rows = await drawnRows(again)
  const first = rowWith(rows, 'find callers')
  expect([colOf(first, 'agent'), colOf(first, 'Explore · find callers')]).toEqual([6, 14])
  expect(colOf(rowWith(rows, 'write tests'), 'general-purpose · write tests')).toBe(14)
  expect(first).toContain('Grep stepRow')
  await again.press({ key: 'task-main:a1' })
  await again.unmount()
  expect((stored.get('ui') as UiState).taskOpen).toBeUndefined()
  const closed = await mount($, 'terminal')
  expect((await drawnRows(closed)).some(r => r.includes('find callers'))).toBe(false)
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
    return { n: rows.filter(r => r.startsWith('  ✓')).length, hint: rowWith(rows, 'e: export').trim() }
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

test('at 40 columns: 3 readout cells, the time on the last cell (26), no metric; nothing past 40', async ($, on) => {
  seed(on, BUSY, TASKS_UI)
  const ui = await mount($, 'terminal', 40)
  const rows = await drawnRows(ui)
  const labels = rowWith(rows, 'DONE  ')
  expect([colOf(labels, 'DONE'), colOf(labels, 'ACTIVE'), colOf(labels, 'QUEUED'), colOf(labels, 'ELAPSED')]).toEqual([2, 14, 26, -1])
  const active = rowWith(rows, 'Grouping')
  expect(colOf(active, '3m')).toBe(26)
  expect(active).not.toContain('live')
  for (const r of rows) expect(r.length <= 40).toBe(true)
  await ui.unmount()
})

test('at 32 columns: 2 readout cells, name only rows; nothing past 32, no row ends inside a word', async ($, on) => {
  seed(
    on,
    { ...BUSY, tasks: [...BUSY.tasks, task('long', 'A task name that is far longer than a narrow pane can hold', 'pending')] },
    TASKS_UI,
  )
  const ui = await mount($, 'terminal', 32)
  const rows = await drawnRows(ui)
  const labels = rowWith(rows, 'DONE  ')
  expect([colOf(labels, 'DONE'), colOf(labels, 'ACTIVE'), colOf(labels, 'QUEUED')]).toEqual([2, 14, -1])
  for (const r of rows) expect(r.length <= 32).toBe(true)
  expect(rowWith(rows, 'Grouping').trimEnd()).toBe('  ▸ Grouping timeline steps')
  // A cut name ends with a space-free word and an ellipsis: `…` follows a whole word.
  const cut = rows.filter(r => r.startsWith('  ○') && r.endsWith('…'))
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
  expect([colOf(r, '○'), colOf(r, 'Cover burst'), colOf(r, 'general-p')]).toEqual([2, 4, 38])
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
