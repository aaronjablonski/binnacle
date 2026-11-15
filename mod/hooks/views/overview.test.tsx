import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Budget, Step, TaskItem, Timeline, UiState } from '../../types'
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

// A new world for the next surface: the hooks stay, what they hold changes.
function reset(stored: Stored, t: Timeline): void {
  stored.clear()
  stored.set('timeline', t)
}

const PANE = (columns: number) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    props: {
      title: 'Mission Control',
      isFocused: false,
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

async function mount($: Engine, surface: (typeof SURFACES)[number], columns = 62) {
  return $.ui.mount({ ...PANE(columns), surface })
}

const texts = async (ui: Awaited<ReturnType<typeof mount>>): Promise<string[]> => {
  const found = await ui.findAll({ type: 'Text' })
  return found.map(f => f.text ?? '')
}

// ---------- HUD v2: the Now screen ----------

const KEPT = (id: string, seq: number, note: string, extra: Partial<Step> = {}): Step =>
  step(id, seq, `Edit ${note}.ts`, 'done', { pin: note, startedAt: NOW - 600_000, ...extra })

const BUDGET: Budget = {
  contextPct: 9,
  windows: [
    { name: 'five_hour', pct: 18, resetsAt: NOW + 3_600_000 },
    { name: 'seven_day', pct: 22, resetsAt: NOW + 86_400_000 },
  ],
  at: NOW,
}

// A busy session: focus and next, tasks, two live agents, a running step, a
// failed one, a kept step, notes, a budget.
const busy = (extra: Partial<Timeline> = {}): Timeline => ({
  ...empty,
  now: { focus: 'Grouping timeline steps by agent', next: 'Humanise step labels', at: NOW - 20_000 },
  tasks: [
    task('1', 'Map', 'completed'),
    task('2', 'Group', 'in_progress', { activeForm: 'Grouping timeline steps by agent' }),
    task('3', 'Humanise step labels', 'pending'),
  ],
  agents: {
    main,
    a1: { ...agent('a1', 'Explore', 'find every caller of stepRow', 'x'), tokensIn: 50_000, tokensOut: 22_000 },
    a2: { ...agent('a2', 'general-purpose', 'write timeline tests', 'y'), startedAt: NOW - 40_000, tokensIn: 80_000, tokensOut: 8000 },
  },
  steps: [
    step('s1', 1, 'Bash npm test -- timeline', 'error', { tool: 'Bash', agent: 'a2', endedAt: NOW - 4000, startedAt: NOW - 9000 }),
    KEPT('s2', 2, 'the label helper'),
    step('s3', 3, 'Edit mod/hooks/views/timeline.tsx', 'running', { startedAt: NOW - 2000 }),
  ],
  notes: [
    { text: 'an older note that is not shown', agent: 'main', at: NOW - 3000 },
    { text: 'stepRow is called from timeline and overview only', agent: 'main', at: NOW - 2000 },
    { text: 'Handback steps carry raw JSON; label them by agent', agent: 'main', at: NOW - 1000 },
  ],
  budget: BUDGET,
  ...extra,
})

const rowsOf = async (ui: Awaited<ReturnType<typeof mount>>): Promise<string[]> => screen(await ui.drawn())
const rowAt = (rows: string[], text: string): number => rows.findIndex(r => r.includes(text))
const GFX = /^[━─▁▂▃▄▅▆▇█]{10}$/

test('Now at 62: the sections come in the spec order, each label on a ┌ at column 0', async ($, on) => {
  seed(on, busy())
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await rowsOf(ui)
    const at = [
      rows.findIndex(r => r.startsWith('▍')),
      rows.findIndex(r => r.startsWith('  next')),
      rows.findIndex(r => r.startsWith('  TASKS')),
      rows.findIndex(r => r.startsWith('┌ AGENTS')),
      rows.findIndex(r => r.startsWith('┌ LATEST')),
      rows.findIndex(r => r.startsWith('┌ KEPT')),
      rows.findIndex(r => r.startsWith('┌ NOTES')),
    ]
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(rows.some(r => r.includes('NEEDS YOU'))).toBe(false)
    expect(rows.some(r => r.includes('ARTIFACTS'))).toBe(false)
    // One blank row between sections, never two.
    expect(rows.join('\n')).not.toMatch(/\n\n\n/)
    await ui.unmount()
  }
})

test('Now at 62: the headline is bold at 2 with the age at 50, and next sits at 2 with its text at 8', async ($, on) => {
  seed(on, busy())
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await rowsOf(ui)
    const head = rows[rows.findIndex(r => r.startsWith('▍'))]!
    expect(colOf(head, 'Grouping timeline steps by agent')).toBe(2)
    expect(colOf(head, '20s')).toBe(50)
    const next = rows[rows.findIndex(r => r.startsWith('  next'))]!
    expect(colOf(next, 'next')).toBe(2)
    expect(colOf(next, 'Humanise step labels')).toBe(8)
    const found = await ui.findAll({ type: 'Text' })
    expect((found.find(f => f.text === '▍')?.props as { color?: string }).color).toBe('suggestion')
    expect((found.find(f => f.text === 'Grouping timeline steps by agent')?.props as { bold?: boolean }).bold).toBe(true)
    await ui.unmount()
  }
})

test('the readout at 62: five cells on 2, 14, 26, 38 and 50, every diagram 10 wide', async ($, on) => {
  seed(on, busy())
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await rowsOf(ui)
    const i = rows.findIndex(r => r.startsWith('  TASKS'))
    const [labels, values, gfx] = [rows[i]!, rows[i + 1]!, rows[i + 2]!]
    expect(['TASKS', 'AGENTS', 'STEPS', 'CTX', '7D'].map(l => colOf(labels, l))).toEqual([2, 14, 26, 38, 50])
    expect(colOf(values, '1/3')).toBe(2)
    expect(colOf(values, '2 live')).toBe(14)
    expect(colOf(values, '3 ✖ 1')).toBe(26)
    expect(colOf(values, '9%')).toBe(38)
    expect(colOf(values, '22%')).toBe(50)
    for (const c of [2, 14, 26, 38, 50]) expect(gfx.slice(c, c + 10)).toMatch(GFX)
    expect(gfx.length).toBe(60)
    expect(gfx.slice(2, 12).startsWith('━')).toBe(true)
    await ui.unmount()
  }
})

test('the readout drops cells by priority: 7D, then STEPS, then CTX', async ($, on) => {
  seed(on, busy())
  const expected: [number, string[]][] = [
    [50, ['TASKS', 'AGENTS', 'STEPS', 'CTX']],
    [40, ['TASKS', 'AGENTS', 'CTX']],
    [32, ['TASKS', 'AGENTS']],
  ]
  for (const surface of SURFACES) {
    for (const [cols, cells] of expected) {
      const ui = await mount($, surface, cols)
      const rows = await rowsOf(ui)
      const labels = rows[rows.findIndex(r => r.startsWith('  TASKS'))]!
      const found = ['TASKS', 'AGENTS', 'STEPS', 'CTX', '7D', '5H'].filter(l => labels.includes(l))
      expect(found).toEqual(cells)
      cells.forEach((l, k) => expect(colOf(labels, l)).toBe(2 + 12 * k))
      for (const r of rows) expect(r.length <= cols).toBe(true)
      await ui.unmount()
    }
  }
})

test('5H replaces 7D when it is the hotter window, and goes warning at 78 %', async ($, on) => {
  seed(on, busy({ budget: { ...BUDGET, windows: [{ name: 'five_hour', pct: 78 }, { name: 'seven_day', pct: 22 }] } }))
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await rowsOf(ui)
    const i = rows.findIndex(r => r.startsWith('  TASKS'))
    expect(colOf(rows[i], '5H')).toBe(50)
    expect(rows[i]).not.toContain('7D')
    expect(colOf(rows[i + 1], '78%')).toBe(50)
    const fill = (await ui.findAll({ type: 'Text' })).find(f => /^━+$/.test(f.text ?? '') && (f.props as { color?: string }).color === 'warning')
    expect(fill?.text?.length).toBe(8)
    await ui.unmount()
  }
})

test('AGENTS lists the live agents only, with tokens at 38 and time at 50, and a row opens the agent', async ($, on) => {
  const stored = seed(on, empty)
  for (const surface of SURFACES) {
    reset(stored, busy({ agents: { ...busy().agents, a3: agent('a3', 'Explore', 'finished long ago', '', 'done') } }))
    const ui = await mount($, surface)
    const rows = await rowsOf(ui)
    const head = rows[rowAt(rows, '┌ AGENTS')]!
    expect(colOf(head, 'tokens')).toBe(38)
    expect(colOf(head, 'time')).toBe(50)
    const a1 = rows[rowAt(rows, 'find every caller of stepRow')]!
    expect(colOf(a1, '▸')).toBe(2)
    expect(colOf(a1, 'find every caller of stepRow')).toBe(4)
    expect(colOf(a1, '72k')).toBe(38)
    expect(colOf(a1, '1m')).toBe(50)
    expect(rows.some(r => r.includes('finished long ago'))).toBe(false)
    await ui.press({ key: 'agent-a1' })
    const u = stored.get('ui') as UiState
    expect(u.tab).toBe('agents')
    expect(u.agentOpen).toBe('a1')
    await ui.unmount()
  }
})

test('LATEST is the running step and the newest error, with agent at 38 and time at 50', async ($, on) => {
  seed(on, busy())
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await rowsOf(ui)
    const head = rowAt(rows, '┌ LATEST')
    expect(colOf(rows[head], 'agent')).toBe(38)
    expect(colOf(rows[head], 'time')).toBe(50)
    const run = rows[head + 1]!
    expect(colOf(run, '▸')).toBe(2)
    expect(colOf(run, 'Edit')).toBe(4)
    expect(colOf(run, '…/timeline.tsx')).toBe(10)
    expect(colOf(run, 'main')).toBe(38)
    expect(colOf(run, 'now')).toBe(50)
    const err = rows[head + 2]!
    expect(colOf(err, '✖')).toBe(2)
    expect(colOf(err, 'Bash')).toBe(4)
    expect(colOf(err, 'npm test -- timeline')).toBe(10)
    expect(colOf(err, 'general-p…')).toBe(38)
    expect(colOf(err, '4s')).toBe(50)
    expect(rows[head + 3]).toBe('')
    const glyph = (await ui.findAll({ type: 'Text' })).find(f => f.text === '✖')
    expect((glyph?.props as { color?: string }).color).toBe('error')
    await ui.unmount()
  }
})

test('KEPT shows the note as the name, the tool and the time, and under 3 rows its one-line explanation', async ($, on) => {
  seed(on, busy())
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await rowsOf(ui)
    const head = rowAt(rows, '┌ KEPT')
    expect(colOf(rows[head], 'step')).toBe(38)
    expect(colOf(rows[head], 'at')).toBe(50)
    const kept = rows[head + 1]!
    expect(colOf(kept, '★')).toBe(2)
    expect(colOf(kept, 'the label helper')).toBe(4)
    expect(colOf(kept, 'Edit')).toBe(38)
    expect(colOf(rows[head + 2], 'kept steps are never trimmed and export in full')).toBe(4)
    await ui.unmount()
  }
})

test('with 3 kept steps the explanation line is gone', async ($, on) => {
  seed(on, busy({ steps: [KEPT('k1', 1, 'one'), KEPT('k2', 2, 'two'), KEPT('k3', 3, 'three')] }))
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await rowsOf(ui)
    expect(rows.filter(r => r.includes('★')).length).toBe(3)
    expect(rows.some(r => r.includes('never trimmed'))).toBe(false)
    await ui.unmount()
  }
})

test('NOTES shows two lines, the newest first, from column 4 behind a dim ·', async ($, on) => {
  seed(on, busy())
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await rowsOf(ui)
    const head = rowAt(rows, '┌ NOTES')
    expect(colOf(rows[head + 1], '·')).toBe(2)
    expect(colOf(rows[head + 1], 'Handback steps carry raw JSON; label them by agent')).toBe(4)
    expect(colOf(rows[head + 2], 'stepRow is called from timeline and overview only')).toBe(4)
    expect(rows.some(r => r.includes('an older note'))).toBe(false)
    await ui.unmount()
  }
})

test('an empty session says Idle and draws the readout but no list section', async ($, on) => {
  seed(on, empty)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await rowsOf(ui)
    expect(rows.some(r => r.startsWith('▍') && r.includes('Idle. Nothing running yet.'))).toBe(true)
    for (const label of ['AGENTS', 'LATEST', 'KEPT', 'NOTES', 'NEEDS YOU']) expect(rows.some(r => r.startsWith(`┌ ${label}`))).toBe(false)
    expect(rows.some(r => r.startsWith('  TASKS'))).toBe(true)
    await ui.unmount()
  }
})

test('with no update, the headline is the in-progress task, and with no task the step in flight', async ($, on) => {
  const stored = seed(on, empty)
  for (const surface of SURFACES) {
    reset(stored, { ...empty, tasks: [task('1', 'Add limiter', 'in_progress', { activeForm: 'Adding the limiter' })] })
    const ui = await mount($, surface)
    expect((await rowsOf(ui)).some(r => r.startsWith('▍') && colOf(r, 'Adding the limiter') === 2)).toBe(true)
    await ui.unmount()
    reset(stored, { ...empty, steps: [step('s1', 1, 'Read a.ts', 'done'), step('s0', 0, 'Bash ls', 'running')] })
    const again = await mount($, surface)
    expect((await rowsOf(again)).some(r => r.startsWith('▍') && colOf(r, 'Bash ls') === 2)).toBe(true)
    await again.unmount()
  }
})

test('pressing a kept row opens its step; pressing a readout label opens its tab', async ($, on) => {
  const stored = seed(on, empty)
  for (const surface of SURFACES) {
    reset(stored, busy())
    const ui = await mount($, surface)
    await ui.press({ key: 'kept-s2' })
    expect((stored.get('ui') as UiState).stepOpen).toBe('s2')
    await ui.unmount()
    stored.delete('ui')
    const again = await mount($, surface)
    await again.press({ key: 'readout-tasks' })
    expect((stored.get('ui') as UiState).tab).toBe('tasks')
    await again.unmount()
  }
})

// The budget view is ephemeral pane state (like onscreen.ts), not ui state.
test('pressing the CTX label opens the budget view in place; b: back returns', async ($, on) => {
  const modelled = (id: string): AgentRow => ({ ...agent(id, 'Explore', 'x', 'y'), model: 'claude-sonnet-5-5', tokensIn: 10_000, tokensOut: 0 })
  seed(on, busy({ agents: { main, a1: modelled('a1') } }))
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    await ui.press({ key: 'readout-ctx' })
    const rows = await rowsOf(ui)
    const head = rowAt(rows, '┌ BUDGET')
    expect(head).toBeGreaterThanOrEqual(0)
    const lines = rows.slice(head)
    const ctxRow = lines.find(r => r.startsWith('  CTX'))!
    expect(colOf(ctxRow, '9%')).toBe(8)
    expect(ctxRow.slice(14, 24)).toMatch(GFX)
    const five = lines.find(r => r.startsWith('  5H'))!
    expect(colOf(five, '18%')).toBe(8)
    expect(colOf(five, 'resets in 1h00')).toBe(26)
    const seven = lines.find(r => r.startsWith('  7D'))!
    expect(colOf(seven, 'resets in 24h00')).toBe(26)
    expect(rows.some(r => r.startsWith('┌ BY MODEL'))).toBe(true)
    expect(rows.some(r => r.startsWith('┌ LATEST'))).toBe(false)
    expect(rows.some(r => r.includes('b: back'))).toBe(true)
    for (const r of rows) expect(r.length <= 62).toBe(true)
    await ui.press({ key: 'budget-back' })
    expect((await rowsOf(ui)).some(r => r.startsWith('┌ LATEST'))).toBe(true)
    await ui.unmount()
  }
})

test('every row of Now fits bodyColumns at 62, 50, 40 and 32, with a long focus', async ($, on) => {
  seed(on, busy({
    now: { focus: 'Wiring the limiter into the chain with a very long sentence indeed', next: 'Return 429 with Retry-After and more', at: NOW - 20_000 },
    notes: [{ text: 'upload() is reached from three routes today and one of them is odd', agent: 'a1', at: NOW }],
  }))
  for (const surface of SURFACES) {
    for (const cols of [62, 50, 40, 32]) {
      const ui = await mount($, surface, cols)
      const rows = await rowsOf(ui)
      expect(rows.length > 10).toBe(true)
      for (const r of rows) expect(r.length <= cols).toBe(true)
      await ui.unmount()
    }
  }
})

test('pressing a latest step opens its detail in the timeline', async ($, on) => {
  const stored = seed(on, empty)
  for (const surface of SURFACES) {
    reset(stored, { ...empty, steps: [step('s1', 1, 'Edit a.ts', 'done')] })
    const ui = await mount($, surface)
    await ui.press({ key: 'step-s1' })
    const u = stored.get('ui') as UiState
    expect(u.tab).toBe('timeline')
    expect(u.stepOpen).toBe('s1')
    await ui.unmount()
  }
})

test('pressing tab-tasks writes ui.tab', async ($, on) => {
  const stored = seed(on, empty)
  for (const surface of SURFACES) {
    reset(stored, empty)
    const ui = await mount($, surface)
    await ui.press({ key: 'tab-tasks' })
    expect((stored.get('ui') as UiState).tab).toBe('tasks')
    await ui.unmount()
  }
})

test('the Artifacts tab keeps the tab row', async ($, on) => {
  seed(on, empty, {
    tab: 'artifacts', filter: { kind: 'all' }, agentsMode: 'list', folded: [], openTurns: [],
    dismissed: [], query: '', runningOnly: false, notified: [], toasted: [], slim: false,
  })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect((await texts(ui)).join('\n')).toContain('No artifacts yet.')
    expect(await ui.find({ key: 'tab-overview' })).toBeDefined()
    expect(await ui.find({ key: 'tab-artifacts' })).toBeDefined()
    await ui.unmount()
  }
})

test('the tab labels shorten below 62 columns and turn to icons below 38', async ($, on) => {
  seed(on, empty)
  for (const surface of SURFACES) {
    const wide = await mount($, surface, 62)
    expect((await wide.find({ key: 'tab-tasks' }))?.text).toBe('Tasks')
    await wide.unmount()
    const mid = await mount($, surface, 40)
    expect((await mid.find({ key: 'tab-tasks' }))?.text).toBe('Tsk')
    await mid.unmount()
    const icon = await mount($, surface, 34)
    expect((await icon.find({ key: 'tab-tasks' }))?.text).toBe('▣')
    await icon.unmount()
  }
})


test('/mc opens the pane with focus', async ($, on) => {
  seed(on, empty)
  const opened: Record<string, unknown>[] = []
  on('ui.open', (_, e) => {
    opened.push(e as unknown as Record<string, unknown>)
    return { value: { isPlaced: true as const } }
  })

  const got = await $.command.run({ command: 'mc', args: '' } as never)

  expect(got.text).toBe('Mission Control opened.')
  expect(opened.length).toBe(1)
  expect(opened[0]).toMatchObject({ id: 'mission-control', title: 'Mission Control', focus: true, columns: 62, rows: 14 })
})

test('/mc close closes the pane', async ($, on) => {
  seed(on, empty)
  const closed: unknown[] = []
  on('ui.close', (_, e) => {
    closed.push(e)
    return { value: undefined }
  })

  const got = await $.command.run({ command: 'mc', args: 'close' } as never)

  expect(closed.length).toBe(1)
  expect(closed[0]).toMatchObject({ id: 'mission-control' })
  expect(typeof got.text).toBe('string')
})

// What the engine and the world beneath a session.start need.
function sessionWorld(on: On, t: Timeline): {
  stored: Stored
  clock: MockClock
  opened: Record<string, unknown>[]
  registered: Record<string, unknown>[]
} {
  const { stored, clock } = world(on, t)
  const opened: Record<string, unknown>[] = []
  const registered: Record<string, unknown>[] = []
  mock.env(on, {})
  on('ui.open', (_, e) => {
    opened.push(e as unknown as Record<string, unknown>)
    return { value: { isPlaced: false as const, reason: 'narrow' } }
  })
  on('command.register', (_, e) => {
    registered.push(e as unknown as Record<string, unknown>)
    return { value: { command: 'mc' } }
  })
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { stored, clock, opened, registered }
}

const start = ($: Engine) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

test('session.start with autoOpen opens the pane without focus; not being placed is no error', { options: { autoOpen: true } }, async ($, on) => {
  const { opened } = sessionWorld(on, empty)

  await start($)

  expect(opened.length).toBe(1)
  expect(opened[0]).toMatchObject({ id: 'mission-control', title: 'Mission Control', columns: 62, rows: 14 })
  expect('focus' in (opened[0] ?? {})).toBe(false)
})

test('session.start without autoOpen opens nothing, and registers /mc as immediate', async ($, on) => {
  const { opened, registered } = sessionWorld(on, empty)

  await start($)

  expect(opened.length).toBe(0)
  expect(registered[0]).toMatchObject({ name: 'mc', immediate: true, argumentHint: '[1-5 | keep <note> | export | close | slim]' })
})

test('the clock invalidates only while a subagent or step runs, and main never counts', async ($, on) => {
  const { stored, clock } = sessionWorld(on, empty)
  let invalidated = 0
  on('ui.invalidate', () => {
    invalidated += 1
    return { value: undefined }
  })

  await start($)
  await clock.advance(3000)
  expect(invalidated).toBe(0)

  stored.set('timeline', { ...empty, steps: [step('s1', 1, 'Bash ls', 'running')] })
  await clock.advance(3000)
  expect(invalidated > 0).toBe(true)

  invalidated = 0
  stored.set('timeline', { ...empty, agents: { main, a1: agent('a1', 'Explore', 'x', 'y', 'done') } })
  await clock.advance(3000)
  expect(invalidated).toBe(0)

  stored.set('timeline', { ...empty, agents: { main, a1: agent('a1', 'Explore', 'x', 'y') } })
  await clock.advance(3000)
  expect(invalidated > 0).toBe(true)
})

type Mounted = Awaited<ReturnType<typeof mount>>
type Found = Awaited<ReturnType<Mounted['findAll']>>[number]

const propsOf = (f: Found | undefined): { color?: string; dimColor?: boolean; backgroundColor?: string } =>
  (f?.props ?? {}) as { color?: string; dimColor?: boolean; backgroundColor?: string }

test('the tab bar has no separators and draws the open tab bold in the accent, the others dim', async ($, on) => {
  seed(on, empty, {
    tab: 'tasks', filter: { kind: 'all' }, agentsMode: 'list', folded: [], openTurns: [],
    dismissed: [], query: '', runningOnly: false, notified: [], toasted: [], slim: false,
  })
  for (const surface of SURFACES) {
    for (const columns of [62, 32]) {
      const ui = await mount($, surface, columns)
      const found = await ui.findAll({ type: 'Text' })
      expect(found.filter(f => f.text === '│').length).toBe(0)
      expect(found.filter(f => propsOf(f).backgroundColor !== undefined).length).toBe(0)
      const open = found.filter(f => f.text === (columns === 62 ? 'Tasks' : '▣') && propsOf(f).color === 'suggestion')
      expect(open.length).toBe(1)
      const tab = await ui.find({ key: 'tab-tasks' })
      expect(tab?.props).toMatchObject({ hotkey: '2', plain: true })
      expect((await ui.find({ key: 'tab-overview' }))?.props).toMatchObject({ dimColor: true })
      await ui.unmount()
    }
  }
})

// ---------- the inline strip ----------

const mountInline = ($: Engine, surface: (typeof SURFACES)[number], columns: number, isFocused: boolean) =>
  $.ui.mount({ ...PANE(columns), props: { ...PANE(columns).props, isFocused, placement: 'inline' }, surface })

test('the strip at 96: two halves on the same cells in 11 rows or fewer', async ($, on) => {
  seed(on, busy())
  for (const surface of SURFACES) {
    const ui = await mountInline($, surface, 96, true)
    const rows = screen(await ui.drawn())
    expect(rows.length <= 11).toBe(true)
    for (const r of rows) expect(r.length <= 96).toBe(true)
    const head = rows[rows.findIndex(r => r.startsWith('▍'))]!
    expect(colOf(head, 'Grouping timeline steps by agent')).toBe(2)
    expect(colOf(head, '20s')).toBe(38)
    expect(colOf(head, '┌ AGENTS')).toBe(50)
    expect(colOf(head, 'tokens')).toBe(74)
    expect(colOf(head.slice(50), 'time') + 50).toBe(86)
    const a1 = rows[rowAt(rows, 'find every caller')]!
    expect(colOf(a1, '▸')).toBe(52)
    expect(colOf(a1, 'find every caller')).toBe(54)
    expect(colOf(a1, '72k')).toBe(74)
    expect(colOf(a1, '1m')).toBe(86)
    const labels = rows[rows.findIndex(r => r.startsWith('  TASKS'))]!
    expect(['TASKS', 'AGENTS', 'STEPS', 'CTX'].map(l => colOf(labels, l))).toEqual([2, 14, 26, 38])
    const latest = rows[rowAt(rows, '┌ LATEST')]!
    expect(colOf(latest, '┌ LATEST')).toBe(50)
    expect(colOf(latest, 'agent')).toBe(74)
    expect(colOf(latest.slice(50), 'time') + 50).toBe(86)
    expect(rows.some(r => r.includes('b: budget'))).toBe(true)
    await ui.unmount()
  }
})

test('the strip with more than two live agents folds the rest into + n more', async ($, on) => {
  const agents = { ...busy().agents, a3: agent('a3', 'Explore', 'third one', '') }
  seed(on, busy({ agents }))
  for (const surface of SURFACES) {
    const ui = await mountInline($, surface, 96, false)
    const rows = screen(await ui.drawn())
    expect(rows.length <= 11).toBe(true)
    expect(rows.some(r => colOf(r, '+') === 52 && r.includes('more'))).toBe(true)
    await ui.unmount()
  }
})


test('focused, every row of Now, footer included, fits 32 and 40 columns', async ($, on) => {
  seed(on, busy({
    steps: [
      step('s1', 1, 'Bash npm test -- timeline', 'error', { tool: 'Bash', agent: 'a2', endedAt: NOW - 4000, startedAt: NOW - 9000 }),
      step('s3', 3, 'Edit mod/hooks/views/timeline.tsx', 'running', { startedAt: NOW - 2000, asking: NOW - 30_000 }),
    ],
  }))
  for (const cols of [32, 40]) {
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE(cols), props: { ...PANE(cols).props, isFocused: true }, surface })
      const rows = await rowsOf(ui)
      expect(rows.some(r => r.includes('b: budget'))).toBe(true)
      for (const r of rows) expect(r.length <= cols).toBe(true)
      await ui.unmount()
    }
  }
})
