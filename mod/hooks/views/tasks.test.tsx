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
    plugin: 'binnacle',
    component: 'Pane',
    requestId: 'binnacle',
    props: {
      title: 'Binnacle',
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

test('a task page for a task that is gone says so', async ($, on) => {
  seed(on, PLANNED, { ...TASKS_UI, page: { kind: 'task', id: 'main:nope' } })
  const ui = await mount($, 'desktop')
  expect((await drawnRows(ui)).join('\n')).toContain('This task is gone.')
  await ui.unmount()
})

// ---------- the cockpit Tasks tab (task C5) ----------
// Each test below replaces a Neo or Rich look test of the same subject; the old one is gone, its behaviour kept.

const PACED: Timeline = { ...PLANNED, turns: [{ id: 't1', agent: 'main', prompt: 'add rate limiting', startedAt: NOW - 1_200_000 }] }

// LOOK TEST (rewritten for the cockpit): replaces "the text deck is TASKS, PLAN and PACE": the header is a lintel, "2 of 4 done" with the pace sentence flush right, the bar, Effort so far and the heaviest, a sill.
test('the header: "2 of 4 done", the pace sentence at the right edge, the to-do bar, Effort so far, the heaviest, between a lintel and a sill', async ($, on) => {
  seed(on, PACED, TASKS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    const count = rowWith(rows, '2 of 4 done')
    const at = rows.indexOf(count)
    expect([colOf(count, '2 of 4 done'), count.trimEnd().endsWith('about 20 min left at this pace'), count.trimEnd().length]).toEqual([2, true, 60])
    // the lintel above it (a Raster row on the terminal, ┏━━ in the text form), a blank, the bar, a blank
    if (surface !== 'terminal') expect(rows[at - 1]?.startsWith('┏━━')).toBe(true)
    expect(rows[at + 1]).toBe('')
    expect(rows[at + 2]).toMatch(/^ {2}━+ ━+ ━+ ━+$/)
    expect(rows[at + 3]).toBe('')
    expect([colOf(rows[at + 4] ?? '', 'Effort so far'), colOf(rows[at + 5] ?? '', 'one bar a task')]).toEqual([2, 2])
    const heaviest = rows[at + 6] ?? ''
    expect([colOf(heaviest, 'Heaviest: '), colOf(heaviest, 'Map the middleware'), heaviest.trimEnd().endsWith(', 120k')]).toEqual([2, 12, true])
    if (surface !== 'terminal') expect(rows[at + 7]?.endsWith('━━┛')).toBe(true)
    expect(rows.join('\n')).not.toMatch(/WORKING|IDLE|TASKS|PLAN|PACE|┌|┃/)
    await ui.unmount()
  }
})

test('the pace sentence is left out until a task is done, and when every task is: "All 4 done"', async ($, on) => {
  const none: Timeline = { ...PACED, tasks: PACED.tasks.map(x => ({ ...x, status: 'pending' as const })) }
  const stored = seed(on, none, TASKS_UI)
  const ui = await mount($, 'desktop')
  expect(rowWith(await drawnRows(ui), '0 of 4 done').trimEnd()).toBe('  0 of 4 done')
  await ui.unmount()
  stored.set('timeline', { ...PACED, tasks: PACED.tasks.map(x => ({ ...x, status: 'completed' as const })) })
  const all = await mount($, 'desktop')
  const rows = await drawnRows(all)
  expect(rowWith(rows, 'All 4 done').trimEnd()).toBe('  All 4 done')
  expect(rows.join('\n')).not.toContain('left at this pace')
  await all.unmount()
})

// LOOK TEST (rewritten for the cockpit): replaces "the TASKS gauge is one pip per task" and "over 22 tasks the TASKS gauge is a 22-cell bar": the bar is one segment a task while each gets two cells, and proportional runs past that (R13).
test('the to-do bar is one segment a task, one cell a task up to the width, and runs proportional to done, current and open past it (R13, F I3)', async ($, on) => {
  const stored = seed(on, BUSY, TASKS_UI)
  const ui = await mount($, 'desktop')
  const bar = (await drawnRows(ui)).find(r => /^ {2}━/.test(r)) ?? ''
  expect(bar.trim().split(' ').length).toBe(13)
  expect(bar.trim().length).toBe(58)
  await ui.unmount()
  // 53 tasks in 58 cells: no segment keeps a cell and a gap, so a task is one cell (F I3: never one solid line while a gap fits).
  const cells: Timeline = { ...BUSY, tasks: [...BUSY.tasks, ...Array.from({ length: 40 }, (_, i) => task(`y${i}`, `Extra ${i}`, 'pending'))] }
  stored.set('timeline', cells)
  const some = await mount($, 'desktop')
  const dashes = (await drawnRows(some)).find(r => /^ {2}━/.test(r)) ?? ''
  expect(dashes.trim().length).toBeLessThanOrEqual(58)
  expect([...dashes.trim()].filter(ch => ch === '━').length).toBe(53)
  await some.unmount()
  // Past the width (more tasks than cells) tasks share cells: done, current and open runs with no gaps.
  const many: Timeline = { ...BUSY, tasks: [...BUSY.tasks, ...Array.from({ length: 80 }, (_, i) => task(`z${i}`, `Extra ${i}`, 'pending'))] }
  stored.set('timeline', many)
  const wide = await mount($, 'desktop')
  const runs = (await drawnRows(wide)).find(r => /^ {2}━/.test(r)) ?? ''
  expect(runs.trim()).toMatch(/^━{58}$/)
  await wide.unmount()
})

// LOOK TEST (rewritten for the cockpit): replaces "the PLAN strip" tests: Effort so far is a Raster of two rows, one bar a task (two cells and a gap), its text form the same box in eighth blocks.
test('Effort so far on the terminal: one Raster bar a task, its height the tokens it took, its colour its state', async ($, on) => {
  seed(on, PLANNED, TASKS_UI)
  const ui = await mount($, 'terminal')
  const r = await ui.find({ type: 'Raster', key: 'effort' })
  expect(r?.props.columns).toBe(12)
  expect(r?.props.rows).toBe(2)
  const cells = decode(String(r?.props.cells))
  const at = (row: number, n: number) => cells[row * 12 + n * 3]!
  const FULL = 0x2588
  // Heights: t2 (120k) fills both rows, t3 (60k) half, t1 (40k) five eighths, t4 (queued) only a rest tick.
  expect([at(0, 1)[0], at(1, 1)[0]]).toEqual([FULL, FULL])
  expect(at(1, 2)[0]).toBe(FULL)
  expect(at(0, 2)[0]).not.toBe(FULL)
  expect(at(1, 0)[0]).toBe(0x2585)
  expect(at(1, 3)[0]).toBe(0x2581)
  // The second cell of a bar is the first's twin, and the gap cell between bars is empty.
  expect(cells[1 * 12 + 1]![0]).toBe(0x2585)
  expect(cells[1 * 12 + 2]![0]).not.toBe(0x2585)
  // Colours: done soft, the current one iris, queued rest.
  expect(at(1, 0)[1]).toBe(PALETTE.night.irisSoft)
  expect(at(1, 1)[1]).toBe(PALETTE.night.irisSoft)
  expect(at(1, 2)[1]).toBe(PALETTE.night.iris)
  expect(at(1, 3)[1]).toBe(PALETTE.night.rest)
  await ui.unmount()
})

test('Effort so far in the text form: per-task tokens in eighth blocks, two cells a task, at column 18 beside its words', async ($, on) => {
  seed(on, PLANNED, TASKS_UI)
  for (const surface of TEXT_SURFACES) {
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    const first = rowWith(rows, 'Effort so far')
    const second = rowWith(rows, 'one bar a task')
    expect(colOf(first, 'Effort so far')).toBe(2)
    expect(first.padEnd(30).slice(18, 30)).toBe('   ██       ')
    expect(second.padEnd(30).slice(18, 30)).toBe('▅▅ ██ ██ ▁▁ ')
    await ui.unmount()
  }
})

test('over 14 tasks the effort bars shrink to two cells then one, and past the width tasks share a bar, so the chart stays in the 42 columns', async ($, on) => {
  const many: Timeline = { ...PLANNED, tasks: [...PLANNED.tasks, ...Array.from({ length: 40 }, (_, i) => task(`z${i}`, `Extra ${i}`, 'pending'))] }
  const stored = seed(on, many, TASKS_UI)
  const ui = await mount($, 'terminal')
  const r = await ui.find({ type: 'Raster', key: 'effort' })
  expect(Number(r?.props.columns)).toBeLessThanOrEqual(42)
  await ui.unmount()
  const some: Timeline = { ...PLANNED, tasks: [...PLANNED.tasks, ...Array.from({ length: 12 }, (_, i) => task(`y${i}`, `More ${i}`, 'pending'))] }
  stored.set('timeline', some)
  const two = await mount($, 'terminal')
  expect((await two.find({ type: 'Raster', key: 'effort' }))?.props.columns).toBe(32)
  await two.unmount()
})

// LOOK TEST (rewritten for the cockpit): replaces "sections run ACTIVE, QUEUED, DONE" and its binding-rule-2 growth: the sections are Doing now, Up next and Done in plain words, and each holds its cap at any height (Up next 5, Done 3), the rest behind `+ n more` (the cockpit keeps spare rows empty).
// MEANING CHANGED (R37, FX3): this test now covers only the panes with no free rows (16 and 24): there the caps (5 up next, 3 done) are the floor behind `+ n more`. It used to run to 46 rows; at 46 the lists grow into every free row (the tests after this one).
test('sections run Doing now, Up next, Done; where the pane has no free rows each holds its cap: 5 up next and 3 done, the rest behind a more line', async ($, on) => {
  const LONG: Timeline = {
    ...BUSY,
    tasks: [
      ...BUSY.tasks,
      ...[8, 9, 10, 11, 12].map(n => task(`q${n}`, `Queued ${n}`, 'pending')),
      ...[6, 7, 8, 9].map(n => task(`d${n}`, `Old ${n}`, 'completed', { updatedAt: NOW - 2_000_000 - n })),
    ],
  }
  seed(on, LONG, TASKS_UI)
  for (const surface of SURFACES) {
    for (const bodyRows of [16, 24]) {
      const ui = await mount($, surface, 62, false, bodyRows)
      const rows = await drawnRows(ui)
      await ui.unmount()
      const [a, q, d] = ['  Doing now', '  Up next', '  Done'].map(h => rows.findIndex(r => r.startsWith(h))) as [number, number, number]
      expect([a > -1, q > a, d > q]).toEqual([true, true, true])
      expect(rows.join('\n')).not.toMatch(/ACTIVE|QUEUED|DONE|┌/)
      const between = (from: number, to: number): string[] => rows.slice(from + 1, to).filter(r => r.trim() !== '')
      const queued = between(q, d)
      const done = rows.slice(d + 1).filter(r => r.trim() !== '')
      expect(queued.filter(r => r.startsWith('  ○')).length).toBe(5)
      expect(queued.find(r => r.startsWith('    + '))).toBe('    + 7 more to do')
      expect(done.filter(r => r.startsWith('  ✓')).map(r => r.slice(4, 21).trimEnd())).toEqual(['Read the plan', 'Read the spec', 'Read the handover'])
      expect(done.find(r => r.startsWith('    + '))?.startsWith('    + 6 more')).toBe(true)
      // the sums: the count, and the heads over the figures of Done
      expect(rows[a]!.trimEnd().endsWith(' 1')).toBe(true)
      expect(rows[q]!.trimEnd().endsWith(' 12')).toBe(true)
      expect(rows[d]!.includes('9  ·  tokens')).toBe(true)
      // never three blank rows together in the content (a tethered agent's third row and the gap make two, as in the mock); the blank rows that pad down to the kept footer row are not content (M12)
      const content = rows.slice(0, rows.reduce((last, r, i) => (r.trim() !== '' ? i : last), 0) + 1)
      if (surface !== 'terminal') for (let i = 2; i < content.length; i++) expect(content[i] === '' && content[i - 1] === '' && content[i - 2] === '').toBe(false)
    }
  }
})

/** The blank rows between the last row of content and the footer row (the last non-blank row). */
function slackAboveFooter(rows: string[]): number {
  const foot = rows.reduce((last, r, i) => (r.trim() !== '' ? i : last), -1)
  let c = foot - 1
  while (c >= 0 && rows[c]!.trim() === '') c--
  return foot - c - 1
}

// R37 (FX3 ruling): the lists grow into every free row at every height, 46 included. A `+ n more` shows only when the list is longer than the rows left, so it never sits over blank rows: the one blank row above the footer is all that is left under it. Up next is dealt first, then Done.
test('Up next and Done fill every free row at 46, 50, 60 and 80 rows; a more line never sits over blank rows (R37)', async ($, on) => {
  const LONG: Timeline = {
    ...BUSY,
    tasks: [
      ...BUSY.tasks,
      ...[8, 9, 10, 11, 12].map(n => task(`q${n}`, `Queued ${n}`, 'pending')),
      ...[6, 7, 8, 9].map(n => task(`d${n}`, `Old ${n}`, 'completed', { updatedAt: NOW - 2_000_000 - n })),
    ],
  }
  seed(on, LONG, TASKS_UI)
  const count = async (bodyRows: number): Promise<{ queued: number; done: number; more: string[]; slack: number }> => {
    const ui = await mount($, 'desktop', 62, true, bodyRows)
    const rows = await drawnRows(ui)
    await ui.unmount()
    return { queued: rows.filter(r => r.startsWith('  ○')).length, done: rows.filter(r => r.startsWith('  ✓')).length, more: rows.filter(r => r.startsWith('    + ')), slack: slackAboveFooter(rows) }
  }
  const at: Record<number, Awaited<ReturnType<typeof count>>> = {}
  for (const h of [24, 46, 50, 56, 60, 70, 80, 90]) {
    at[h] = await count(h)
    // a more line only with nothing free under it: exactly the one blank row above the footer, the focused footer being drawn (a pane too short for even that, 24, has none)
    if (at[h]!.more.length > 0 && h >= 46) expect([h, at[h]!.slack]).toEqual([h, 1])
  }
  // growth is beyond the caps at 46 (the old reading started at 47) and never shrinks as the pane grows
  expect(at[46]!.queued).toBeGreaterThan(5)
  const order = [24, 46, 50, 56, 60, 70, 80, 90]
  for (let i = 1; i < order.length; i++) {
    expect(at[order[i]!]!.queued).toBeGreaterThanOrEqual(at[order[i - 1]!]!.queued)
    expect(at[order[i]!]!.done).toBeGreaterThanOrEqual(at[order[i - 1]!]!.done)
  }
  // Up next is dealt first: Done stays at its 3 until Up next is whole.
  for (const h of order) if (at[h]!.queued < 12) expect(at[h]!.done).toBe(3)
  expect(at[90]!.queued).toBe(12)
  expect(at[90]!.more.some(r => r.includes('to do'))).toBe(false)
})

// LOOK TEST (rewritten for the cockpit): replaces "rows put glyph at 2, name at 4, the metric at 38 and the time at 50": figures are flush right, the tokens ending at 49 and the time at 59.
test('rows put glyph at 2, name at 4, the tokens ending at 49 and the time ending at 59 at 62 columns', async ($, on) => {
  seed(on, BUSY, TASKS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    const active = rowWith(rows, 'Grouping timeline steps')
    expect([active.startsWith('▍ '), colOf(active, '▸'), colOf(active, 'Grouping'), active.slice(0, 50).trimEnd().endsWith('160k'), active.trimEnd().endsWith('3 min'), active.trimEnd().length]).toEqual([true, 2, 4, true, true, 60])
    const done = rowWith(rows, 'Read the plan')
    expect([colOf(done, '✓'), colOf(done, 'Read the plan'), done.trimEnd().endsWith('10 min'), done.trimEnd().length]).toEqual([2, 4, true, 60])
    const heads = rowWith(rows, 'Done ─')
    expect([heads.indexOf('tokens') + 6, heads.trimEnd().length, heads.trimEnd().endsWith('time')]).toEqual([50, 60, true])
    const next = rowWith(rows, 'Queued task 1')
    expect([colOf(next, '○'), colOf(next, 'Queued task 1'), next.trimEnd().endsWith('next')]).toEqual([2, 4, true])
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
  expect((withText('○')?.props as { color?: string }).color).toBe('subtle')
  expect((withText('✓')?.props as { dimColor?: boolean }).dimColor).toBe(true)
  expect((withText('Read the plan')?.props as { dimColor?: boolean }).dimColor).toBe(true)
  await ui.unmount()
})

// LOOK TEST (rewritten for the cockpit): replaces "the active task has its agents tethered under it: ├╌ and ╰╌, hull at 4": each agent is a micro critter at 4 (its badge column kept), the type bold at 10 with what it does, the time at 59, three rows an agent.
test('the active task has its agents tethered under it as micro critters: the type at 10, what it does, the time at 59, three rows each', async ($, on) => {
  seed(on, BUSY, TASKS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    const at = rows.findIndex(r => r.includes('Grouping timeline steps'))
    const first = rows[at + 1] ?? ''
    const second = rows[at + 4] ?? ''
    expect([colOf(first, 'Explorer'), first.slice(10).startsWith('Explorer  Thinking')]).toEqual([10, true])
    expect([colOf(second, 'General'), second.slice(10).startsWith('General  Thinking')]).toEqual([10, true])
    expect([first.trimEnd().endsWith('1 min'), first.trimEnd().length, second.trimEnd().length]).toEqual([true, 60, 60])
    expect(rows[at + 3]).toBe('')
    // the text form of a critter is the state glyph at 4 and nothing under it: the name stands beside it, so no role word (R43, F M8)
    if (surface !== 'terminal') {
      expect([colOf(first, '●'), colOf(rows[at + 2] ?? '', 'scout'), colOf(rows[at + 5] ?? '', 'build')]).toEqual([4, -1, -1])
    }
    await ui.unmount()
  }
})

test('the tethered micro critters are 5 x 2 Rasters (the badge column kept) on the terminal; a fifth agent folds into a more line', async ($, on) => {
  const crowd: Timeline = {
    ...BUSY,
    agents: {
      ...BUSY.agents,
      ...Object.fromEntries([3, 4, 5, 6].map(n => [`x${n}`, { ...agent(`x${n}`, 'general-purpose', `job ${n}`, 'Edit b.ts'), taskId: 'a1' }])),
    },
  }
  seed(on, crowd, TASKS_UI)
  const ui = await mount($, 'terminal')
  const tether = await ui.find({ type: 'Raster', key: 'task-agent-x1-who' })
  expect(tether?.props).toMatchObject({ columns: 5, rows: 2 })
  const rasters = (await ui.findAll({ type: 'Raster' })).filter(r => String(r.key).startsWith('task-agent-'))
  expect(rasters.length).toBe(4)
  expect((await drawnRows(ui)).some(r => r === '    + 2 more agents')).toBe(true)
  await ui.unmount()
  // pages and the text look hold no Raster for a critter
  const text = await mount($, 'vscode')
  expect((await text.findAll({ type: 'Raster' })).length).toBe(0)
  await text.unmount()
})

// BEHAVIOUR CHANGE (binding rule 2, then the cockpit): `d` shows where the Done cap leaves tasks out. The body Button `d: show all` and the footer's `d all done` are one key.
test('d unfolds every done task and folds them again', async ($, on) => {
  const stored = seed(on, BUSY, TASKS_UI)
  // The mounted pane does not redraw under a mocked state: each press is read from a fresh mount.
  const doneRows = async (): Promise<{ n: number; button: string; foot: string }> => {
    const ui = await mount($, 'terminal', 62, true, 24)
    const rows = await drawnRows(ui)
    await ui.unmount()
    return { n: rows.filter(r => r.startsWith('  ✓')).length, button: rowWith(rows, 'd: ').trim(), foot: rowWith(rows, '↵ open task').trim().replace(/ +0 options$/, '') }
  }
  expect(await doneRows()).toEqual({ n: 3, button: '+ 2 more   d: show all', foot: '↵ open task   d all done   esc prompt' })
  const first = await mount($, 'terminal', 62, true, 24)
  // `d show all` is a Button that arms the d key (the engine draws its colon), on the Done row.
  const dButton = await first.find({ type: 'Button', key: 'hint-d' })
  expect(dButton?.props).toMatchObject({ hotkey: 'd', plain: true })
  expect(dButton?.text).toBe('show all')
  await first.press({ key: 'hint-d' })
  await first.unmount()
  expect((stored.get('ui') as UiState).doneAll).toBe(true)
  const open = await doneRows()
  expect(open.n).toBe(5)
  expect(open.button).toBe('d: newest 3')
  expect(open.foot).toBe('↵ open task   d newest 3   esc prompt')
  const second = await mount($, 'terminal', 62, true, 24)
  await second.press({ key: 'hint-d' })
  await second.unmount()
  expect((stored.get('ui') as UiState).doneAll).toBeUndefined()
  expect((await doneRows()).n).toBe(3)
})

// LOOK TEST (rewritten for the cockpit): replaces "the footer shows at most 3 hints, only while focused: ↵ open, d all done, e export". The mock's footer is ↵ open task, d all done, esc prompt (R28: keys in the accent, no colon); `d` is armed by the Done row's Button.
test('the footer reads ↵ open task, d all done, esc prompt, on the last row, only while focused', async ($, on) => {
  seed(on, BUSY, TASKS_UI)
  const quiet = await mount($, 'terminal', 62, false, 24)
  expect((await drawnRows(quiet)).some(r => r.includes('↵ open task'))).toBe(false)
  await quiet.unmount()
  const ui = await mount($, 'terminal', 62, true, 24)
  const rows = await drawnRows(ui)
  const hint = rowWith(rows, '↵ open task')
  expect(hint).toContain('↵ open task   d all done   esc prompt')
  expect(colOf(hint, '↵')).toBe(2)
  // the footer is the last row of the content
  expect(rows.indexOf(hint)).toBe(rows.length - 1)
  // the key is in the accent as text (R28), and `e export` is gone from the tab: the mock's Tasks footer has no export
  const found = await ui.findAll({ type: 'Text' })
  expect((found.find(f => f.text === '↵')?.props as { color?: string }).color).toBe('suggestion')
  expect(rows.join('\n')).not.toContain('e: export')
  await ui.unmount()
})

// REMOVED (cockpit): "e exports the digest from the Tasks tab". The mock's Tasks footer is ↵ open task, d all done, esc prompt; export is the Artifacts tab's one action (its filled button) and /binnacle export.

// LOOK TEST (rewritten for the cockpit): replaces the 40 and 32 column deck tests: at 40 the heads drop the tokens, the time stays at the right edge, and nothing passes the width.
test('at 40 columns the tokens go and the time stays at the right edge; nothing past 40, no tether text past its room', async ($, on) => {
  seed(on, BUSY, TASKS_UI)
  const ui = await mount($, 'desktop', 40)
  const rows = await drawnRows(ui)
  const active = rowWith(rows, 'Grouping')
  expect(active.trimEnd().endsWith('3 min')).toBe(true)
  expect(active.trimEnd().length).toBe(38)
  expect(active).not.toContain('160k')
  expect(rowWith(rows, 'Done ─')).not.toContain('tokens')
  for (const r of rows) expect(r.length <= 40).toBe(true)
  await ui.unmount()
})

test('at 32 columns names are cut at a word and nothing passes 32; the effort chart is left out for the heaviest line', async ($, on) => {
  seed(on, { ...BUSY, tasks: [...BUSY.tasks, task('long', 'A task name that is far longer than a narrow pane can hold', 'pending')] }, TASKS_UI)
  const ui = await mount($, 'desktop', 32)
  const rows = await drawnRows(ui)
  for (const r of rows) expect(r.length <= 32).toBe(true)
  expect(rows.some(r => r.includes('Effort so far') && r.includes('▁'))).toBe(false)
  for (const r of rows.filter(r => r.startsWith('  ○') && r.endsWith('…'))) expect(/\S…$/.test(r)).toBe(true)
  await ui.unmount()
})

test('a task owned by an agent is listed flat with the agent type ending at 49', async ($, on) => {
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
  expect([colOf(r, '○'), colOf(r, 'Cover burst'), r.slice(0, 50).trimEnd().endsWith('general')]).toEqual([2, 4, true])
  expect(r).not.toContain('general-')
  await ui.unmount()
})

// LOOK TEST (rewritten for the cockpit): replaces "empty state text" ("No tasks yet. They appear when Claude writes a task list."): R12, the To do head and one dim row.
/** A request has been made (R3-B M7): "no list" is only a thing to say after one. */
const ASKED_TURN: Timeline['turns'][number] = { id: 't1', agent: 'main', prompt: 'do it', startedAt: NOW - 400_000 }

// R3-B M7: the seeded session now has made a request (before one, the words are "Nothing yet", see the test after this); the assertions are unchanged.
test('no list: the To do head and one dim row, "No to-do list for this request" (R12)', async ($, on) => {
  seed(on, { ...empty, turns: [ASKED_TURN] }, TASKS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    expect(rows.some(r => r.startsWith('  To do ─'))).toBe(true)
    const note = rowWith(rows, 'No to-do list for this request')
    expect(colOf(note, 'No to-do list')).toBe(2)
    expect(rows.join('\n')).not.toMatch(/No tasks yet|Doing now|Up next|Done|Earlier/)
    await ui.unmount()
  }
  const found = await (await mount($, 'terminal')).findAll({ type: 'Text' })
  expect(found.some(f => f.text?.includes('No to-do list for this request') && (f.props as { dimColor?: boolean }).dimColor === true)).toBe(true)
})

test('M7: before any request the Tasks tab says "Nothing yet" and never that a list is missing', async ($, on) => {
  seed(on, empty, TASKS_UI)
  const ui = await mount($, 'terminal')
  const text = (await drawnRows(ui)).join(' ')
  expect(text).toContain('Nothing yet. Ask Claude for something.')
  expect(text).not.toContain('No to-do list')
  await ui.unmount()
})

test('a finished list folds away when a new request starts: Earlier holds it, the To do head says there is no list (R12)', async ($, on) => {
  const old = [1, 2, 3, 4].map(n => task(`d${n}`, `Old task ${n}`, 'completed', { updatedAt: NOW - 600_000 - n * 1000 }))
  seed(on, { ...empty, turns: [ASKED_TURN], tasks: old, listFrom: NOW - 300_000 }, TASKS_UI)
  for (const surface of SURFACES) {
    // MEANING CHANGED (R37, FX3): in a roomy pane (this suite's default, 40 rows) Earlier now shows all four (the pane has the rows); a short pane keeps the cap of 3 and `+ 1 more`.
    const tall = await mount($, surface)
    const tallRows = await drawnRows(tall)
    await tall.unmount()
    expect(tallRows.slice(tallRows.findIndex(r => r.startsWith('  Earlier ─')) + 1).filter(r => r.startsWith('  ✓')).length).toBe(4)
    expect(tallRows.some(r => r.startsWith('    + '))).toBe(false)
    const ui = await mount($, surface, 62, false, 12)
    const rows = await drawnRows(ui)
    const to = rows.findIndex(r => r.startsWith('  To do ─'))
    expect(rows[to + 1]?.trim()).toBe('No to-do list for this request')
    expect(rows[to + 2]).toBe('')
    const earlier = rows.findIndex(r => r.startsWith('  Earlier ─'))
    expect(earlier).toBe(to + 3)
    expect(rows[earlier]!.trimEnd().endsWith(' 4')).toBe(true)
    expect(rows.slice(earlier + 1).filter(r => r.startsWith('  ✓')).length).toBe(3)
    expect(rows.some(r => r === '    + 1 more')).toBe(true)
    // the header counts only this request's list: none, so no "of" sentence
    expect(rows.join('\n')).not.toMatch(/ of \d+ done|Effort so far/)
    await ui.unmount()
  }
})

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
      expect(flat).toContain('Explorer')
      expect(flat).toContain('52k')
      expect(flat).toContain('Steps')
      expect(flat).toContain('b: back')
      expect(flat).not.toMatch(/STEPS|STATUS|TOKENS|AGENTS|ACTIVE/)
      await ui.unmount()
    }
  }
})

test('the task page stacks the tokens by agent and sets the time against the usual', async ($, on) => {
  seed(on, PAGE_TL, { ...TASKS_UI, page: { kind: 'task', id: 'main:p1' } })
  const ui = await mount($, 'desktop')
  const rows = await drawnRows(ui)
  const flat = rows.join('\n')
  expect(flat).toContain('Tokens by agent')
  expect(flat).toMatch(/Main 30k · 37%/)
  expect(flat).toMatch(/Explorer 52k · 63%/)
  // The usual is the median of the done tasks (5 min and 6 min).
  expect(flat).toMatch(/usually 5 min/)
  // the page: a lintel, the state in plain words with the readout, then the title; a critter shows as its state glyph
  expect(rowWith(rows, 'task 5 of 5')).toMatch(/^ {2}Active {2,}task 5 of 5$/)
  expect(rows.find(r => r.startsWith('    ● Explorer'))).toBeDefined()
  await ui.unmount()
})
