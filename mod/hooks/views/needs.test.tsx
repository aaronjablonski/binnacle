import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Step, Timeline, TurnRow, UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { colOf, screen } from './screen.testkit'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const BAND_SURFACES = ['terminal', 'desktop', 'mobile'] as const
const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }

type Stored = Map<string, unknown>

function world(on: On, t: Timeline, u?: UiState): { stored: Stored; clock: MockClock } {
  const stored: Stored = new Map()
  stored.set('timeline', t)
  if (u) stored.set('ui', u)
  const versions = new Map<string, number>()
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, {})
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

const BAND = (columns: number) =>
  ({
    plugin: 'mission-control',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isCollapsed: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: columns,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  }) as const

const step = (id: string, label: string, extra: Partial<Step> = {}): Step => ({
  id,
  seq: Number(id.replace(/\D/g, '') || 1),
  agent: 'main',
  tool: 'Bash',
  label,
  status: 'running',
  startedAt: NOW - 60_000,
  ...extra,
})
const sub = (id: string, extra: Partial<AgentRow> = {}): AgentRow => ({
  id,
  parent: 'main',
  type: 'Explore',
  description: 'find callers',
  status: 'running',
  startedAt: NOW - 60_000,
  doing: '',
  stepCount: 0,
  ...extra,
})
const main: AgentRow = { ...empty.agents.main! }
const asked = (seconds: number): Timeline => ({
  ...empty,
  seq: 1,
  steps: [step('s1', 'Bash rm -rf build', { asking: NOW - seconds * 1000 })],
  agents: { main },
})

const texts = async (ui: { findAll: (q: { type: string }) => Promise<{ text?: string }[]> }): Promise<string[]> =>
  (await ui.findAll({ type: 'Text' })).map(f => f.text ?? '')

// LOOK TEST (edited for Rich): the Neo text form, drawn where there is no Raster and with the look option on text; the rich form is tested in rich2.test.tsx.
test('text form: an ask under 20 s draws no NEEDS YOU and no band alert; at 20 s it does', { options: { look: 'text' } }, async ($, on) => {
  const { stored } = world(on, asked(19))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE(62), surface })
    expect((await texts(ui)).join('\n')).not.toContain('NEEDS YOU')
    await ui.unmount()
  }
  for (const surface of BAND_SURFACES) {
    const ui = await $.ui.mount({ ...BAND(80), surface })
    expect(await ui.find({ type: 'Text' })).toBe(undefined)
    await ui.unmount()
  }
  stored.set('timeline', asked(20))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE(62), surface })
    expect((await texts(ui)).join('\n')).toContain('NEEDS YOU')
    await ui.unmount()
  }
})

// An ask first, then a repeated failure: two things need the person.
const waiting = (): Timeline => ({
  ...empty,
  seq: 3,
  now: { focus: 'Wiring the limiter', at: NOW - 20_000 },
  steps: [
    step('s1', 'Bash rm -rf build', { asking: NOW - 30_000 }),
    step('s2', 'Bash npm test', { status: 'error', endedAt: NOW - 100_000, startedAt: NOW - 105_000 }),
    step('s3', 'Bash npm test', { status: 'error', endedAt: NOW - 90_000, startedAt: NOW - 95_000 }),
  ],
  agents: { main },
})

const FOCUSED = (columns: number) => ({ ...PANE(columns), props: { ...PANE(columns).props, isFocused: true } })

const rowsOf = async (ui: { drawn: () => Promise<unknown> }): Promise<string[]> => screen(await ui.drawn())

// LOOK TEST (edited for Rich): the Neo text form, drawn where there is no Raster and with the look option on text; the rich form is tested in rich2.test.tsx.
test('text form: NEEDS YOU is a warning bracket first on Now: the pill, the count and the why and waiting heads, the first item opened inside it', { options: { look: 'text' } }, async ($, on) => {
  world(on, waiting())
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE(62), surface })
    const rows = await rowsOf(ui)
    const head = rows.findIndex(r => r.includes(' NEEDS YOU '))
    // Right under the tab bar, its track and one blank row.
    expect(head).toBe(3)
    expect(rows[head]!.startsWith('┏ ')).toBe(true)
    expect(rows[head]![61]).toBe('┓')
    expect(colOf(rows[head], ' NEEDS YOU ')).toBe(2)
    expect(colOf(rows[head], '2')).toBe(14)
    expect(colOf(rows[head], 'why')).toBe(38)
    expect(colOf(rows[head], 'waiting')).toBe(50)
    const found = await ui.findAll({ type: 'Text' })
    const pill = found.find(f => f.text === ' NEEDS YOU ')
    expect(pill?.props).toMatchObject({ backgroundColor: 'warning', color: 'inverseText', bold: true })
    expect((found.find(f => f.text === '┏ ')?.props as { color?: string }).color).toBe('warning')
    expect((found.find(f => f.text === '┃ ')?.props as { color?: string }).color).toBe('warning')
    // The first row: ? at 2, tool at 4, the command at 10, why at 38, waiting at 50, bold.
    const first = rows[head + 1]!
    expect(first.startsWith('┃ ')).toBe(true)
    expect(colOf(first, '?')).toBe(2)
    expect(colOf(first, 'Bash')).toBe(4)
    expect(colOf(first, 'rm -rf build')).toBe(10)
    expect(colOf(first, 'asking')).toBe(38)
    expect(colOf(first, '30s')).toBe(50)
    expect((found.find(f => f.text === 'rm -rf build')?.props as { bold?: boolean }).bold).toBe(true)
    // Opened: asks at 6, its value at 14, the agent, then the three actions from 6, all inside the rails.
    expect(colOf(rows[head + 2], 'asks')).toBe(6)
    expect(colOf(rows[head + 2], 'to run Bash rm -rf build')).toBe(14)
    expect(colOf(rows[head + 3], 'agent')).toBe(6)
    const actions = rows[head + 4]!
    expect(colOf(actions, 'g: chat')).toBe(6)
    expect(colOf(actions, 'x: dismiss')).toBe(16)
    expect(colOf(actions, 'n: next')).toBe(29)
    // A blank rail row follows the action line, then the second row, which is not opened.
    expect(rows[head + 5]!.replace(/[┃ ]/g, '')).toBe('')
    const second = rows[head + 6]!
    expect(second.startsWith('┗ ')).toBe(true)
    expect(second[61]).toBe('┛')
    expect(colOf(second, '✖')).toBe(2)
    expect(colOf(second, 'npm test')).toBe(10)
    expect(colOf(second, 'failed 2×')).toBe(38)
    expect(colOf(second, '1m')).toBe(50)
    expect((found.find(f => f.text === 'npm test')?.props as { bold?: boolean }).bold).not.toBe(true)
    // Every row of the bracket is the full width, with a rail on the last column.
    for (const r of rows.slice(head, head + 7)) expect(r.length).toBe(62)
    expect((await ui.find({ key: 'open-asking:s1' }))?.props).toMatchObject({ autoFocus: true })
    // The deck follows after one blank row.
    expect(rows[head + 7]).toBe('')
    expect(rows[head + 8]!.startsWith('┏ FOCUS')).toBe(true)
    await ui.unmount()
  }
})

// LOOK TEST (edited for Rich): the Neo text form, drawn where there is no Raster and with the look option on text; the rich form is tested in rich2.test.tsx.
test('text form: the NEEDS YOU bracket closes on the last row at 50, 40 and 32 columns, and a long ask is cut by word inside the rails', { options: { look: 'text' } }, async ($, on) => {
  world(on, waiting())
  for (const cols of [50, 40, 32]) {
    const ui = await $.ui.mount({ ...PANE(cols), surface: 'terminal' })
    const rows = await rowsOf(ui)
    const head = rows.findIndex(r => r.includes(' NEEDS YOU '))
    expect(head).toBeGreaterThanOrEqual(0)
    const end = rows.findIndex((r, i) => i > head && r.startsWith('┗ '))
    expect(end).toBeGreaterThan(head)
    for (const r of rows.slice(head, end + 1)) {
      expect(r.length).toBe(cols)
      expect('┓┃┛'.includes(r[cols - 1]!)).toBe(true)
    }
    expect(rows[end]![cols - 1]).toBe('┛')
    await ui.unmount()
  }
})

// LOOK TEST (edited for Rich): the Neo text form, drawn where there is no Raster and with the look option on text; the rich form is tested in rich2.test.tsx.
test('text form: the crew shows who asks (?) and who stalled (z): lit hulls in warning with their signals', { options: { look: 'text' } }, async ($, on) => {
  world(on, {
    ...asked(30),
    agents: { main, a1: sub('a1', { lastStepAt: NOW - 400_000, startedAt: NOW - 500_000 }) },
  })
  const ui = await $.ui.mount({ ...PANE(62), surface: 'terminal' })
  const rows = await rowsOf(ui)
  const crew = rows.find(r => r.startsWith('┃ CREW'))!
  expect(crew.slice(14, 19)).toBe('◈? ◉z')
  const found = await ui.findAll({ type: 'Text' })
  expect(found.find(f => f.text === '?' && (f.props as { bold?: boolean }).bold === true)?.props).toMatchObject({ color: 'warning' })
  expect(found.find(f => f.text === 'z')?.props).toMatchObject({ color: 'warning' })
  expect(found.find(f => f.text === '◈')?.props).toMatchObject({ color: 'warning', bold: true })
  await ui.unmount()
})


// LOOK TEST (edited for Rich): the Neo text form, drawn where there is no Raster and with the look option on text; the rich form is tested in rich2.test.tsx.
test('text form: n opens the next item and p the previous; the opened row is bold and shows its why line', { options: { look: 'text' } }, async ($, on) => {
  world(on, waiting())
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...FOCUSED(62), surface })
    await ui.press({ key: 'need-next' })
    const rows = await rowsOf(ui)
    const head = rows.findIndex(r => r.includes('NEEDS YOU'))
    expect(colOf(rows[head + 1], 'rm -rf build')).toBe(10)
    expect(rows.some(r => colOf(r, 'why') === 6 && r.includes('Bash npm test failed ×2'))).toBe(true)
    expect(rows.filter(r => colOf(r, 'asks') === 6)).toEqual([])
    const found = await ui.findAll({ type: 'Text' })
    expect((found.find(f => f.text === 'npm test')?.props as { bold?: boolean }).bold).toBe(true)
    // The footer's p moves back (and wraps the other way).
    await ui.press({ key: 'hint-prev' })
    expect((await rowsOf(ui)).some(r => r.includes('asks'))).toBe(true)
    await ui.unmount()
  }
})

test('g: chat reaches $.ui.scroll on a press only', async ($, on) => {
  world(on, waiting())
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })
  const ui = await $.ui.mount({ ...PANE(62), surface: 'terminal' })
  expect(toasts.length).toBe(0)
  // The mounted kit has nothing beneath $.ui.scroll (find.test.tsx drives the call): the toast shows the press reached it.
  await ui.press({ key: 'chat-asking:s1' })
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('Not shown in chat')
  await ui.unmount()
})

test('the footer is at most 3 entries, drawn only while the pane has the focus', async ($, on) => {
  world(on, waiting())
  const plain = await $.ui.mount({ ...PANE(62), surface: 'terminal' })
  expect((await rowsOf(plain)).some(r => r.includes('esc prompt'))).toBe(false)
  await plain.unmount()
  const ui = await $.ui.mount({ ...FOCUSED(62), surface: 'terminal' })
  const rows = await rowsOf(ui)
  const foot = rows[rows.length - 1]!
  expect(foot.trim().split(/ {3,}/).length <= 3).toBe(true)
  expect(foot).toContain('p: prev')
  expect(foot).toContain('b: budget')
  expect(foot).toContain('esc prompt')
  expect(colOf(foot, 'p: prev')).toBe(2)
  await ui.unmount()
})

// LOOK TEST (edited for Rich): the Neo text form, drawn where there is no Raster and with the look option on text; the rich form is tested in rich2.test.tsx.
test('text form: a stalled agent is a ▲ in warning named by its description, and g opens its transcript', { options: { look: 'text' } }, async ($, on) => {
  world(on, {
    ...empty,
    agents: { main, a1: sub('a1', { lastStepAt: NOW - 400_000, startedAt: NOW - 500_000 }) },
  })
  const ui = await $.ui.mount({ ...PANE(62), surface: 'terminal' })
  const rows = await rowsOf(ui)
  const row = rows.find(r => r.includes('find callers'))!
  expect(colOf(row, '▲')).toBe(2)
  expect(colOf(row, 'find callers')).toBe(4)
  expect(colOf(row, 'stalled')).toBe(38)
  const glyph = (await ui.findAll({ type: 'Text' })).find(f => f.text === '▲')
  expect((glyph?.props as { color?: string }).color).toBe('warning')
  expect(await ui.find({ key: 'chat-stalled:a1' })).toBeDefined()
  await ui.unmount()
})

test('pressing an asking row opens its step; pressing an agent-only problem filters the Timeline', async ($, on) => {
  const { stored } = world(on, {
    ...empty,
    steps: [step('s1', 'Bash rm -rf build', { asking: NOW - 30_000 })],
    agents: { main, a1: sub('a1', { lastStepAt: NOW - 400_000, startedAt: NOW - 500_000 }) },
  })
  // The row's Button is found by its label.
  for (const surface of SURFACES) {
    stored.delete('ui')
    const ui = await $.ui.mount({ ...PANE(62), surface })
    const buttons = await ui.findAll({ type: 'Button' })
    const row = buttons.find(b => (b.key ?? '') === 'open-asking:s1')
    expect(row === undefined).toBe(false)
    await ui.press({ key: row!.key! })
    let u = stored.get('ui') as UiState
    expect(u.tab).toBe('timeline')
    expect(u.stepOpen).toBe('s1')
    expect(u.detail).toBeUndefined()
    await ui.unmount()
    stored.delete('ui')
    const again = await $.ui.mount({ ...PANE(62), surface })
    const stalled = (await again.findAll({ type: 'Button' })).find(b => (b.key ?? '') === 'open-stalled:a1')
    expect(stalled === undefined).toBe(false)
    await again.press({ key: stalled!.key! })
    u = stored.get('ui') as UiState
    expect(u.tab).toBe('timeline')
    expect(u.filter).toEqual({ kind: 'agent', id: 'a1' })
    expect(u.detail).toBe(undefined)
    await again.unmount()
  }
})

test('dismiss writes ui.dismissed and the row goes away', async ($, on) => {
  const { stored } = world(on, asked(30))
  for (const surface of SURFACES) {
    stored.delete('ui')
    const ui = await $.ui.mount({ ...PANE(62), surface })
    await ui.press({ key: 'dismiss-asking:s1' })
    expect((stored.get('ui') as UiState).dismissed).toEqual(['asking:s1'])
    await ui.unmount()
    const again = await $.ui.mount({ ...PANE(62), surface })
    expect((await texts(again)).join('\n')).not.toContain('NEEDS YOU')
    await again.unmount()
  }
})

// LOOK TEST (edited for Rich): the Neo text form, drawn where there is no Raster and with the look option on text; the rich form is tested in rich2.test.tsx.
test('text form: at bodyColumns 32 and 40 nothing in NEEDS YOU is wider than the body', { options: { look: 'text' } }, async ($, on) => {
  world(on, {
    ...empty,
    seq: 3,
    turns: [{ id: 't1', agent: 'main', prompt: 'a very long prompt that fails at the end of it', startedAt: NOW - 9000, endedAt: NOW - 1000, failed: true } as TurnRow],
    steps: [
      step('s1', 'Bash a really long command line goes here', { asking: NOW - 30_000 }),
      step('s2', 'Bash npm run build --workspaces', { status: 'error', turnId: 't1', endedAt: NOW - 9000 }),
      step('s3', 'Bash npm run build --workspaces', { status: 'error', turnId: 't1', endedAt: NOW - 8000 }),
    ],
    agents: { main },
  })
  for (const columns of [32, 40]) {
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE(columns), surface })
      const found = [...(await ui.findAll({ type: 'Text' })), ...(await ui.findAll({ type: 'Button' }))]
      for (const f of found) {
        expect((f.text ?? '').length <= columns).toBe(true)
      }
      expect((await texts(ui)).join('\n')).toContain('NEEDS YOU')
      await ui.unmount()
    }
  }
})

test('the band leads with the WAITING pill and the need count in bold warning, and still fits at 24 columns', async ($, on) => {
  world(on, {
    ...asked(30),
    tasks: [{ id: '1', subject: 'x', status: 'in_progress', owner: 'main', updatedAt: NOW }],
    agents: { main, a1: sub('a1') },
  })
  // The desktop draws the band as an Svg, which has no Text rows.
  for (const surface of BAND_SURFACES.filter(x => x !== 'desktop')) {
    const ui = await $.ui.mount({ ...BAND(80), surface })
    const found = await ui.findAll({ type: 'Text' })
    const row = found.map(f => f.text ?? '').find(t => t.includes('WAITING')) ?? ''
    expect(row).toContain(' WAITING ')
    expect(row).toContain('1 need you')
    expect(found.find(f => f.text === ' WAITING ' && (f.props as { backgroundColor?: string }).backgroundColor !== undefined)?.props).toMatchObject({ backgroundColor: 'warning', color: 'inverseText' })
    expect(found.find(f => f.text === '1 need you')?.props).toMatchObject({ bold: true, color: 'warning' })
    await ui.unmount()
    const narrow = await $.ui.mount({ ...BAND(24), surface })
    const small = (await narrow.findAll({ type: 'Text' })).map(f => f.text ?? '').find(t => t.includes('WAITING')) ?? ''
    expect(small.length <= 24).toBe(true)
    expect(small).toContain('WAITING')
    await narrow.unmount()
  }
})

// A clock-driven world: the session has started, the ticker runs.
async function ticking($: Engine, on: On, t: Timeline, u?: UiState): Promise<{ stored: Stored; clock: MockClock; notes: string[]; toasts: string[] }> {
  const { stored, clock } = world(on, t, u)
  const notes: string[] = []
  const toasts: string[] = []
  on('ui.notify', (_, e) => {
    notes.push((e as unknown as { text: string }).text)
    return { value: { isSent: true as const, channel: 'terminal' } } as never
  })
  on('ui.toast', (_, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: false as const, reason: 'narrow' } }))
  on('command.register', () => ({ value: { command: 'mc' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  return { stored, clock, notes, toasts }
}

// Ruled (I1): a Bash ask is a row from 20 s but notifies only from 60 s,
// as Claude Code raises its own notification for a real dialog.
test('a Bash wait notifies once at 60 s, not at 20 s, and records the step id', async ($, on) => {
  const { stored, clock, notes } = await ticking($, on, asked(5))
  await clock.advance(20_000)
  expect(notes).toEqual([])
  await clock.advance(30_000)
  expect(notes).toEqual([])
  await clock.advance(10_000)
  expect(notes).toEqual(['Waiting on you: Bash rm -rf build'])
  await clock.advance(30_000)
  expect(notes.length).toBe(1)
  expect((stored.get('ui') as UiState).notified).toEqual(['s1'])
})

const askedAgent = (seconds: number): Timeline => ({
  ...empty,
  seq: 1,
  steps: [step('s1', 'Agent Explore · find callers', { tool: 'Agent', asking: NOW - seconds * 1000 })],
  agents: { main },
})

test('an asked Agent call still waiting at 20 s notifies', async ($, on) => {
  const { clock, notes } = await ticking($, on, askedAgent(5))
  await clock.advance(16_000)
  expect(notes).toEqual(['Waiting on you: Agent Explore · find callers'])
})

test('an asked Agent call whose agent spawned raises no notify and no row after 30 s', async ($, on) => {
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  const { stored, clock, notes } = await ticking($, on, askedAgent(2))
  await $.agent.spawn({
    tool_use_id: 's1', prompt: 'p', description: 'find callers', subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'haiku', background: false, fork: false,
  })
  await clock.advance(30_000)
  expect(notes).toEqual([])
  const t = stored.get('timeline') as Timeline
  expect(t.steps[0]!.status).toBe('running')
  expect(t.steps[0]!.asking).toBe(undefined)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE(62), surface })
    expect((await texts(ui)).join('\n')).not.toContain('NEEDS YOU')
    await ui.unmount()
  }
})

test('a step already notified is not raised again', async ($, on) => {
  const { clock, notes } = await ticking($, on, asked(60), { ...initialUi, notified: ['s1'] })
  await clock.advance(5000)
  expect(notes).toEqual([])
})

test('notify: off raises nothing', { options: { notify: 'off' } }, async ($, on) => {
  const { clock, notes } = await ticking($, on, asked(60))
  await clock.advance(5000)
  expect(notes).toEqual([])
})

const FAILED: Timeline = {
  ...empty,
  turns: [{ id: 't1', agent: 'main', prompt: 'build it', startedAt: NOW - 9000, endedAt: NOW - 1000, failed: true } as TurnRow],
  agents: { main },
}

test('notify: waits leaves a failed turn alone', async ($, on) => {
  const { clock, notes } = await ticking($, on, FAILED)
  await clock.advance(5000)
  expect(notes).toEqual([])
})

test('notify: all notifies a failed turn once', { options: { notify: 'all' } }, async ($, on) => {
  const { stored, clock, notes } = await ticking($, on, FAILED)
  await clock.advance(5000)
  await clock.advance(5000)
  expect(notes).toEqual(['Turn failed: build it'])
  expect((stored.get('ui') as UiState).notified).toEqual(['failed-turn:t1'])
})

test('notify: all leaves alone a failed turn that ended before the freshness window', { options: { notify: 'all' } }, async ($, on) => {
  const stale: Timeline = { ...FAILED, turns: [{ ...FAILED.turns[0]!, endedAt: NOW - 60_000 }] }
  const { clock, notes } = await ticking($, on, stale)
  await clock.advance(5000)
  expect(notes).toEqual([])
})

test('a dismissed ask is not notified', async ($, on) => {
  const { clock, notes } = await ticking($, on, asked(60), { ...initialUi, dismissed: ['asking:s1'] })
  await clock.advance(5000)
  expect(notes).toEqual([])
})

test('a subagent that just finished toasts the first line of its doing, once', async ($, on) => {
  const done = sub('a1', { status: 'done', endedAt: NOW - 500, doing: 'Grep upload\nsecond line' })
  const { stored, clock, toasts } = await ticking($, on, { ...empty, agents: { main, a1: done } })
  await clock.advance(3000)
  expect(toasts).toEqual(['Explore finished: Grep upload'])
  await clock.advance(3000)
  expect(toasts.length).toBe(1)
  expect((stored.get('ui') as UiState).toasted).toEqual(['agent-done:a1'])
})

test('a subagent that finished long ago is not toasted on a restore', async ($, on) => {
  const old = sub('a1', { status: 'done', endedAt: NOW - 600_000, doing: 'Grep upload' })
  const { clock, toasts } = await ticking($, on, { ...empty, agents: { main, a1: old } })
  await clock.advance(3000)
  expect(toasts).toEqual([])
})

test("a workflow agent's finish toasts its result, not its last step", async ($, on) => {
  const done = sub('w1', {
    type: 'workflow-subagent', runId: 'r1', agentIndex: 1, status: 'done', endedAt: NOW - 500,
    doing: 'StructuredOutput verdict: ok', result: 'verdict: ok · files: 3',
  })
  const { clock, toasts } = await ticking($, on, { ...empty, agents: { main, w1: done } })
  await clock.advance(3000)
  expect(toasts).toEqual(['workflow-subagent finished: verdict: ok · files: 3'])
})

// LOOK TEST (edited for Rich): the Neo text form, drawn where there is no Raster and with the look option on text; the rich form is tested in rich2.test.tsx.
test('text form: focused, every row of Now with NEEDS YOU, footer included, fits 32 and 40 columns', { options: { look: 'text' } }, async ($, on) => {
  world(on, waiting())
  for (const columns of [32, 40]) {
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...FOCUSED(columns), surface })
      const rows = await rowsOf(ui)
      expect(rows.some(r => r.includes('NEEDS YOU'))).toBe(true)
      expect(rows.some(r => r.includes('esc') || r.includes('b: budget') || r.includes('p: prev'))).toBe(true)
      for (const r of rows) expect(r.length <= columns).toBe(true)
      await ui.unmount()
    }
  }
})
