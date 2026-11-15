import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Step, Timeline, TurnRow, UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const BAND_SURFACES = ['terminal', 'desktop', 'mobile'] as const
const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-3', ui: 'ui-3' }

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

test('an ask under 20 s draws no NEEDS YOU and no band alert; at 20 s it does', async ($, on) => {
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

test('NEEDS YOU is the first section, with the label, agent and age', async ($, on) => {
  world(on, {
    ...asked(30),
    now: { focus: 'Wiring the limiter', at: NOW },
    agents: { main, a1: sub('a1') },
    steps: [step('s1', 'Bash rm -rf build', { asking: NOW - 30_000, agent: 'a1' })],
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE(62), surface })
    const all = await texts(ui)
    const at = (s: string): number => all.findIndex(x => x.includes(s))
    expect(at('NEEDS YOU')).toBeGreaterThanOrEqual(0)
    expect(at('NEEDS YOU')).toBeLessThan(at('NOW'))
    expect(at('Bash rm -rf build')).toBeGreaterThan(at('NEEDS YOU'))
    expect(all.some(x => x.includes('Explore · asked 30s ago'))).toBe(true)
    const glyph = (await ui.findAll({ type: 'Text' })).find(f => f.text === '!')
    expect((glyph?.props as { color?: string }).color).toBe('error')
    await ui.unmount()
  }
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
    expect(u.detail?.stepId).toBe('s1')
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

test('at bodyColumns 24 and 40 nothing in NEEDS YOU is wider than the body', async ($, on) => {
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
  for (const columns of [24, 40]) {
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

test('the band leads with "! n need you" in error, and still fits at 24 columns', async ($, on) => {
  world(on, {
    ...asked(30),
    tasks: [{ id: '1', subject: 'x', status: 'in_progress', owner: 'main', updatedAt: NOW }],
    agents: { main, a1: sub('a1') },
  })
  for (const surface of BAND_SURFACES) {
    const ui = await $.ui.mount({ ...BAND(80), surface })
    const row = (await ui.find({ type: 'Text' }))?.text
    expect(row?.startsWith('! 1 need you │ ▣ 0/1 tasks')).toBe(true)
    const bang = (await ui.findAll({ type: 'Text' })).find(f => f.text === '!')
    expect((bang?.props as { color?: string }).color).toBe('error')
    await ui.unmount()
    const narrow = await $.ui.mount({ ...BAND(24), surface })
    const small = (await narrow.find({ type: 'Text' }))?.text ?? ''
    expect(small.length <= 24).toBe(true)
    expect(small.startsWith('! 1 need you')).toBe(true)
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

test('a wait reaching 20 s notifies once, and records the step id', async ($, on) => {
  const { stored, clock, notes } = await ticking($, on, asked(5))
  await clock.advance(10_000)
  expect(notes).toEqual([])
  await clock.advance(10_000)
  expect(notes).toEqual(['Waiting on you: Bash rm -rf build'])
  await clock.advance(30_000)
  expect(notes.length).toBe(1)
  expect((stored.get('ui') as UiState).notified).toEqual(['s1'])
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
