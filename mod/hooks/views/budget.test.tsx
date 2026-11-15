import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Budget, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { modelName, resetText, tokenText, windowName } from './budget'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-3', ui: 'ui-3' }
const HOUR = 3_600_000

type Stored = Map<string, unknown>

function world(on: On, t: Timeline, u?: UiState): { stored: Stored; clock: MockClock } {
  const stored: Stored = new Map()
  stored.set('timeline', t)
  stored.set('ui', u ?? initialUi)
  const versions = new Map<string, number>()
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, {})
  on('ui.log', () => ({ value: undefined }))
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    const v = stored.get(key)
    return { value: { value: v === undefined ? undefined : { shape: SHAPES[key], value: v }, version: versions.get(key) ?? 0 } }
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

const PANE = (columns: number, placement: 'dock' | 'inline' = 'dock') =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    props: {
      title: 'Mission Control',
      isFocused: false,
      bodyColumns: columns,
      placement,
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

const budget = (extra: Partial<Budget> = {}): Budget => ({
  contextPct: 62,
  windows: [{ name: 'five_hour', pct: 71, resetsAt: NOW + 2 * HOUR }],
  at: NOW,
  ...extra,
})
const withBudget = (b: Budget | undefined, extra: Partial<Timeline> = {}): Timeline => ({
  ...empty,
  budget: b,
  ...extra,
})
const agent = (id: string, extra: Partial<AgentRow> = {}): AgentRow => ({
  id,
  parent: 'main',
  type: 'Explore',
  description: 'find callers',
  status: 'done',
  startedAt: NOW - 60_000,
  endedAt: NOW - 10_000,
  doing: '',
  stepCount: 3,
  ...extra,
})
const main: AgentRow = { ...empty.agents.main! }
const ui = (tab: UiState['tab']): UiState => ({ ...initialUi, tab })

async function lines(m: Awaited<ReturnType<typeof view>>): Promise<string[]> {
  const found = await m.findAll({ type: 'Text' })
  return found.flatMap(f => (f.text ?? '').split('\n'))
}
async function view($: Engine, surface: (typeof SURFACES)[number], columns: number, placement: 'dock' | 'inline' = 'dock') {
  return $.ui.mount({ ...PANE(columns, placement), surface })
}

test('helpers: model, tokens, window names and reset text', () => {
  expect(modelName('claude-sonnet-5-5')).toBe('sonnet')
  expect(modelName('claude-opus-5-5')).toBe('opus')
  expect(modelName('claude-haiku-5-5')).toBe('haiku')
  expect(modelName('claude-foo-1')).toBe('foo-1')
  expect(tokenText(0)).toBe('0')
  expect(tokenText(950)).toBe('950')
  expect(tokenText(1234)).toBe('1.2k')
  expect(tokenText(41_200)).toBe('41k')
  expect(tokenText(1_250_000)).toBe('1.3M')
  expect(windowName('five_hour')).toBe('5h')
  expect(windowName('seven_day')).toBe('7d')
  expect(windowName('weekly_extra')).toBe('weekly extra')
  expect(resetText(NOW + 2 * HOUR, NOW)).toBe('resets in 2h00')
  expect(resetText(NOW - 5, NOW)).toBe('resets now')
})

test('no budget yet: no BUDGET section and no one-line summary', async ($, on) => {
  world(on, withBudget(undefined))
  for (const surface of SURFACES) {
    for (const cols of [24, 62, 110]) {
      const m = await view($, surface, cols)
      const all = (await lines(m)).join('\n')
      expect(all).not.toContain('BUDGET')
      expect(all).not.toContain('ctx')
      await m.unmount()
    }
  }
})

test('BUDGET shows the context bar and each window with its reset', async ($, on) => {
  world(on, withBudget(budget({ windows: [{ name: 'five_hour', pct: 71, resetsAt: NOW + 2 * HOUR }, { name: 'seven_day', pct: 32 }] })))
  for (const surface of SURFACES) {
    const m = await view($, surface, 62)
    const all = await lines(m)
    expect(all.some(l => l.includes('BUDGET'))).toBe(true)
    const ctx = all.find(l => l.includes('62%')) ?? ''
    expect(ctx).toContain('ctx')
    expect(ctx).toContain('█')
    const five = all.find(l => l.includes('71%')) ?? ''
    expect(five).toContain('5h')
    expect(five).toContain('resets in 2h00')
    const seven = all.find(l => l.includes('32%')) ?? ''
    expect(seven).toContain('7d')
    expect(seven).not.toContain('resets')
    await m.unmount()
  }
})

test('wide seats put BUDGET in the two-column Overview', async ($, on) => {
  world(on, withBudget(budget()))
  const m = await view($, 'terminal', 110)
  const all = (await lines(m)).join('\n')
  expect(all).toContain('BUDGET')
  expect(all).toContain('5h')
  await m.unmount()
})

test('narrow and inline seats show the one line', async ($, on) => {
  world(on, withBudget(budget()))
  for (const surface of SURFACES) {
    for (const [cols, placement] of [[30, 'dock'], [62, 'inline']] as const) {
      const m = await view($, surface, cols, placement)
      const all = await lines(m)
      expect(all).toContain('ctx 62% · 5h 71%')
      expect(all.join('\n')).not.toContain('BUDGET')
      await m.unmount()
    }
  }
})

test('every budget line fits the width, down to 24', async ($, on) => {
  world(
    on,
    withBudget(
      budget({
        costUsd: 12.345,
        windows: [
          { name: 'five_hour', pct: 100, resetsAt: NOW + 30 * HOUR },
          { name: 'seven_day_sonnet', pct: 5, resetsAt: NOW + HOUR },
        ],
      }),
    ),
  )
  for (const surface of SURFACES) {
    for (const cols of [24, 30, 40, 62, 110]) {
      const m = await view($, surface, cols)
      for (const l of await lines(m)) expect(l.length).toBeLessThanOrEqual(cols)
      await m.unmount()
    }
  }
})

test('cost is hidden by default', async ($, on) => {
  world(on, withBudget(budget({ costUsd: 0.5 })))
  const a = await view($, 'terminal', 62)
  expect((await lines(a)).join('\n')).not.toContain('$')
  await a.unmount()
})

test('showCost adds the dollar figure to the section and the one line', { options: { showCost: true } }, async ($, on) => {
  world(on, withBudget(budget({ costUsd: 0.5 })))
  const a = await view($, 'terminal', 62)
  expect((await lines(a)).join('\n')).toContain('$0.50')
  await a.unmount()
  const b = await view($, 'terminal', 30)
  expect(await lines(b)).toContain('ctx 62% · 5h 71% · $0.50')
  await b.unmount()
})

test('agent rows carry model and tokens; a running agent with none shows …', async ($, on) => {
  world(
    on,
    withBudget(undefined, {
      agents: {
        main: { ...main, model: 'claude-opus-5-5', tokensIn: 100_000, tokensOut: 18_000 },
        a1: agent('a1', { model: 'claude-sonnet-5-5', tokensIn: 40_000, tokensOut: 1_200 }),
        a2: agent('a2', { status: 'running', endedAt: undefined }),
        a3: agent('a3'),
      },
    }),
    ui('agents'),
  )
  for (const surface of SURFACES) {
    const m = await view($, surface, 62)
    expect((await m.find({ key: 'agent-main' }))?.text ?? '').toContain('opus 118k')
    expect((await m.find({ key: 'agent-a1' }))?.text ?? '').toContain('sonnet 41k')
    const running = (await m.find({ key: 'agent-a2' }))?.text ?? ''
    expect(running).toContain('…')
    expect(running).not.toContain(' 0')
    expect((await m.find({ key: 'agent-a3' }))?.text ?? '').not.toContain('…')
    await m.unmount()
  }
})

test('a totals line per model sits under the list', async ($, on) => {
  world(
    on,
    withBudget(undefined, {
      agents: {
        main: { ...main, model: 'claude-opus-5-5', tokensIn: 100_000, tokensOut: 12_000 },
        a1: agent('a1', { model: 'claude-sonnet-5-5', tokensIn: 40_000, tokensOut: 2_000 }),
        a2: agent('a2', { model: 'claude-sonnet-5-5', tokensIn: 10_000, tokensOut: 500 }),
      },
    }),
    ui('agents'),
  )
  for (const surface of SURFACES) {
    const m = await view($, surface, 62)
    const all = await lines(m)
    expect(all.some(l => l.includes('BY MODEL'))).toBe(true)
    expect(all).toContain('opus 112k · 1 agent')
    expect(all).toContain('sonnet 53k · 2 agents')
    await m.unmount()
  }
})

test('no usage anywhere: no totals section', async ($, on) => {
  world(on, withBudget(undefined, { agents: { main, a1: agent('a1') } }), ui('agents'))
  const m = await view($, 'terminal', 62)
  expect((await lines(m)).join('\n')).not.toContain('BY MODEL')
  await m.unmount()
})

test('agent rows and totals fit 24 columns', async ($, on) => {
  world(
    on,
    withBudget(undefined, {
      agents: {
        main: { ...main, model: 'claude-opus-5-5', tokensIn: 100_000, tokensOut: 12_000 },
        a1: agent('a1', { model: 'claude-sonnet-5-5', tokensIn: 40_000, tokensOut: 2_000, description: 'a long description here' }),
      },
    }),
    ui('agents'),
  )
  for (const surface of SURFACES) {
    const m = await view($, surface, 24)
    for (const l of await lines(m)) expect(l.length).toBeLessThanOrEqual(24)
    await m.unmount()
  }
})

test('a subagent has a View button; main has none; pressing views that agent', async ($, on) => {
  world(on, withBudget(undefined, { agents: { main, a1: agent('a1') } }), ui('agents'))
  const views: unknown[] = []
  on('ui.view', (_, e) => {
    views.push(e)
    return { value: {} }
  })
  for (const surface of SURFACES) {
    const m = await view($, surface, 62)
    expect(await m.find({ key: 'view-main' })).toBe(undefined)
    expect(await m.find({ key: 'view-a1' })).not.toBe(undefined)
    expect(views.length).toBe(0)
    await m.press({ key: 'view-a1' })
    expect(views.pop()).toEqual({ agentId: 'a1' })
    await m.unmount()
  }
})

test('a refused view toasts the reason', async ($, on) => {
  world(on, withBudget(undefined, { agents: { main, a1: agent('a1') } }), ui('agents'))
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })
  on('ui.view', () => ({ value: { deny: 'No such agent.' } }))
  const m = await view($, 'terminal', 62)
  await m.press({ key: 'view-a1' })
  expect(toasts).toEqual(['No such agent.'])
  await m.unmount()
})

// A clock-driven world: the session has started, the ticker runs.
async function ticking($: Engine, on: On, t: Timeline, u?: UiState): Promise<{ stored: Stored; clock: MockClock; toasts: string[] }> {
  const { stored, clock } = world(on, t, u)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })
  on('ui.notify', () => ({ value: { isSent: true as const, channel: 'terminal' } }) as never)
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: false as const, reason: 'narrow' } }))
  on('command.register', () => ({ value: { command: 'mc' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  return { stored, clock, toasts }
}

test('context at 80% toasts once, and records it', async ($, on) => {
  const { stored, clock, toasts } = await ticking($, on, withBudget(budget({ contextPct: 82, windows: [] })))
  await clock.advance(2000)
  await clock.advance(5000)
  expect(toasts).toEqual(['Context at 82%'])
  expect((stored.get('ui') as UiState).toasted).toContain('budget:ctx:80')
})

test('context under 80% raises nothing', async ($, on) => {
  const { clock, toasts } = await ticking($, on, withBudget(budget({ contextPct: 79, windows: [] })))
  await clock.advance(3000)
  expect(toasts).toEqual([])
})

test('a window toasts at 70 and again at each 10 points, once each', async ($, on) => {
  const { stored, clock, toasts } = await ticking(
    $,
    on,
    withBudget(budget({ contextPct: 10, windows: [{ name: 'five_hour', pct: 71, resetsAt: NOW + HOUR }] })),
  )
  await clock.advance(2000)
  expect(toasts).toEqual(['5h window at 71% · resets in 59m'])
  await clock.advance(3000)
  expect(toasts.length).toBe(1)
  const t = stored.get('timeline') as Timeline
  const at = (pct: number, when: number): Timeline => ({
    ...t,
    budget: { ...t.budget!, windows: [{ name: 'five_hour', pct, resetsAt: NOW + HOUR }], at: when },
  })
  stored.set('timeline', at(89, NOW + 5000))
  await clock.advance(1000)
  expect(toasts.length).toBe(2)
  expect(toasts[1]).toContain('5h window at 89%')
  await clock.advance(5000)
  expect(toasts.length).toBe(2)
  stored.set('timeline', at(90, NOW + 11_000))
  await clock.advance(1000)
  expect(toasts.length).toBe(3)
})

test('a window under 70 raises nothing', async ($, on) => {
  const { clock, toasts } = await ticking($, on, withBudget(budget({ contextPct: 10, windows: [{ name: 'five_hour', pct: 69 }] })))
  await clock.advance(3000)
  expect(toasts).toEqual([])
})

test('markers already in ui.toasted do not toast again', async ($, on) => {
  const { clock, toasts } = await ticking(
    $,
    on,
    withBudget(budget({ contextPct: 85, windows: [{ name: 'five_hour', pct: 75 }] })),
    { ...initialUi, toasted: ['budget:ctx:80', 'budget:five_hour:70'] },
  )
  await clock.advance(3000)
  expect(toasts).toEqual([])
})

test('a stale budget from a restored session does not toast', async ($, on) => {
  const { clock, toasts } = await ticking($, on, withBudget(budget({ contextPct: 95, windows: [], at: NOW - 10 * HOUR })))
  await clock.advance(3000)
  expect(toasts).toEqual([])
})
