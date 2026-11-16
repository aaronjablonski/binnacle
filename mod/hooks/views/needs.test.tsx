import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Step, Timeline, TurnRow, UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'

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
// Asked in auto mode, where the 20 s threshold applies (R2: outside auto an ask shows at once).
const asked = (seconds: number): Timeline => ({
  ...empty,
  autoAsk: true,
  seq: 1,
  steps: [step('s1', 'Bash rm -rf build', { asking: NOW - seconds * 1000 })],
  agents: { main },
})

const texts = async (ui: { findAll: (q: { type: string }) => Promise<{ text?: string }[]> }): Promise<string[]> =>
  (await ui.findAll({ type: 'Text' })).map(f => f.text ?? '')

// LOOK TEST (edited for Rich): the Neo text form, drawn where there is no Raster and with the look option on text; the rich form is tested in rich2.test.tsx.
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

