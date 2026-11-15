import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Budget, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { modelCells, modelName, resetText, tokenText, windowName } from './budget'
import { colOf, screen } from './screen.testkit'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }
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
    for (const cols of [34, 62, 110]) {
      const m = await view($, surface, cols)
      const all = (await lines(m)).join('\n')
      expect(all).not.toContain('BUDGET')
      expect(all).not.toContain('ctx')
      await m.unmount()
    }
  }
})

const focused = (columns: number, placement: 'dock' | 'inline' = 'dock') => ({
  ...PANE(columns, placement),
  props: { ...PANE(columns, placement).props, isFocused: true },
})

// The budget view is one press away: the CTX label, or `b` from the footer.
async function openBudget($: Engine, surface: (typeof SURFACES)[number], columns: number, placement: 'dock' | 'inline' = 'dock') {
  const m = await $.ui.mount({ ...focused(columns, placement), surface })
  await m.press({ key: 'hint-budget' })
  return m
}

test('the budget view shows CTX and each window: label 2, value 8, bar 14, reset 26', async ($, on) => {
  world(on, withBudget(budget({ windows: [{ name: 'five_hour', pct: 71, resetsAt: NOW + 2 * HOUR }, { name: 'seven_day', pct: 32 }] })))
  for (const surface of SURFACES) {
    const m = await openBudget($, surface, 62)
    const rows = screen(await m.drawn())
    expect(rows.some(r => r.startsWith('┌ BUDGET'))).toBe(true)
    const ctx = rows.find(r => r.startsWith('  CTX'))!
    expect(colOf(ctx, '62%')).toBe(8)
    expect(ctx.slice(14, 24)).toMatch(/^[━─]{10}$/)
    const five = rows.find(r => r.startsWith('  5H'))!
    expect(colOf(five, '71%')).toBe(8)
    expect(colOf(five, 'resets in 2h00')).toBe(26)
    const seven = rows.find(r => r.startsWith('  7D'))!
    expect(colOf(seven, '32%')).toBe(8)
    expect(seven).not.toContain('resets')
    await m.press({ key: 'budget-back' })
    await m.unmount()
  }
})

test('the budget view lists a model row with its tokens and agents', async ($, on) => {
  world(on, withBudget(budget(), { agents: { main, a1: agent('a1', { model: 'claude-sonnet-5-5', tokensIn: 40_000, tokensOut: 1200 }) } }))
  const m = await openBudget($, 'terminal', 62)
  const rows = screen(await m.drawn())
  expect(rows.some(r => r.startsWith('┌ BY MODEL'))).toBe(true)
  const sonnet = rows.find(r => r.includes('sonnet'))!
  expect(colOf(sonnet, 'sonnet')).toBe(4)
  expect(colOf(sonnet, '41k')).toBe(38)
  expect(colOf(sonnet, '1 agent')).toBe(50)
  await m.press({ key: 'budget-back' })
  await m.unmount()
})

test('with no budget the budget view says so', async ($, on) => {
  world(on, withBudget(undefined))
  const m = await openBudget($, 'terminal', 62)
  expect(screen(await m.drawn()).some(r => r.includes('No reading yet.'))).toBe(true)
  await m.press({ key: 'budget-back' })
  await m.unmount()
})

test('every budget row fits the width, down to 32, and the reset drops under the bar below 40', async ($, on) => {
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
    for (const cols of [32, 34, 40, 62, 110]) {
      const m = await openBudget($, surface, cols)
      const rows = screen(await m.drawn())
      expect(rows.some(r => r.startsWith('┌ BUDGET'))).toBe(true)
      for (const l of rows) expect(l.length).toBeLessThanOrEqual(cols)
      if (cols < 40) expect(rows.some(r => colOf(r, 'resets in') === 8)).toBe(true)
      await m.press({ key: 'budget-back' })
      await m.unmount()
    }
  }
})

test('cost is hidden by default', async ($, on) => {
  world(on, withBudget(budget({ costUsd: 0.5 })))
  const a = await openBudget($, 'terminal', 62)
  expect(screen(await a.drawn()).join('\n')).not.toContain('$')
  await a.press({ key: 'budget-back' })
  await a.unmount()
})

test('showCost adds a COST row to the budget view', { options: { showCost: true } }, async ($, on) => {
  world(on, withBudget(budget({ costUsd: 0.5 })))
  const a = await openBudget($, 'terminal', 62)
  const cost = screen(await a.drawn()).find(r => r.startsWith('  COST'))!
  expect(colOf(cost, '$0.50')).toBe(8)
  await a.press({ key: 'budget-back' })
  await a.unmount()
})

test('modelCells gives the two heaviest models as their share of all tokens', () => {
  const t = {
    ...empty,
    agents: {
      main,
      a1: agent('a1', { model: 'claude-opus-5-5', tokensIn: 60_000, tokensOut: 0 }),
      a2: agent('a2', { model: 'claude-sonnet-5-5', tokensIn: 30_000, tokensOut: 0 }),
      a3: agent('a3', { model: 'claude-haiku-5-5', tokensIn: 10_000, tokensOut: 0 }),
    },
  }
  const cells = modelCells(t)
  expect(cells.map(c => c.label)).toEqual(['OPUS', 'SONNET'])
  expect(cells.map(c => c.value)).toEqual(['60%', '30%'])
  expect(cells.every(c => c.gfx.reduce((n, r) => n + r.text.length, 0) === 10)).toBe(true)
  expect(modelCells(empty)).toEqual([])
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

// A first reading: `$.session.usage()` answers what session.measure would have pushed.
const USAGE = {
  startedAt: 0,
  context: { window: 1_000_000, percent: 85 },
  rateLimits: [{ kind: 'five_hour', percentUsed: 75, resetsAt: '2026-11-15T09:00:00.000Z' }],
  cost: { usd: 1.5 },
}

type Reads = { n: number }
function usageWorld(on: On, t: Timeline, reply: () => unknown): { stored: Stored; clock: MockClock; toasts: string[]; reads: Reads } {
  const { stored, clock } = world(on, t)
  const toasts: string[] = []
  const reads: Reads = { n: 0 }
  on('session.usage', () => {
    reads.n++
    return { value: reply() } as never
  })
  on('ui.toast', (_, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })
  on('ui.notify', () => ({ value: { isSent: true as const, channel: 'terminal' } }) as never)
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }) as never)
  on('command.register', () => ({ value: { command: 'mc' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { stored, clock, toasts, reads }
}

test('session.start seeds a budget from $.session.usage, and the seed replays no toast', async ($, on) => {
  const { stored, clock, toasts } = usageWorld(on, empty, () => USAGE)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((stored.get('timeline') as Timeline).budget).toEqual({
    contextPct: 85,
    windows: [{ name: 'five_hour', pct: 75, resetsAt: Date.parse('2026-11-15T09:00:00.000Z') }],
    costUsd: 1.5,
    at: NOW,
  })
  await clock.advance(3000)
  expect(toasts).toEqual([])
  expect((stored.get('ui') as UiState).toasted).toEqual(
    expect.arrayContaining(['budget:ctx:80', 'budget:five_hour:70']),
  )
})

test('session.start with a usage that has no figures seeds nothing', async ($, on) => {
  const { stored } = usageWorld(on, empty, () => ({ startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((stored.get('timeline') as Timeline).budget).toBeUndefined()
})

test('a throwing $.session.usage breaks neither session.start nor /mc', async ($, on) => {
  const { stored } = usageWorld(on, empty, () => {
    throw new Error('no usage')
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const got = await $.command.run({ command: 'mc', args: '' } as never)
  expect(got).toEqual({ text: 'Mission Control opened.' })
  expect((stored.get('timeline') as Timeline).budget).toBeUndefined()
})

test('/mc seeds a budget when none exists', async ($, on) => {
  const { stored, reads } = usageWorld(on, empty, () => USAGE)
  const got = await $.command.run({ command: 'mc', args: '' } as never)
  expect(got).toEqual({ text: 'Mission Control opened.' })
  expect(reads.n).toBe(1)
  expect((stored.get('timeline') as Timeline).budget).toMatchObject({ contextPct: 85, at: NOW })
})

test('/mc does not re-read when the budget is under 60 s old', async ($, on) => {
  const { reads } = usageWorld(on, withBudget(budget({ at: NOW - 59_000 })), () => USAGE)
  await $.command.run({ command: 'mc', args: '' } as never)
  expect(reads.n).toBe(0)
})

test('/mc re-reads a budget older than 60 s', async ($, on) => {
  const { stored, reads } = usageWorld(on, withBudget(budget({ at: NOW - 61_000, contextPct: 1 })), () => USAGE)
  await $.command.run({ command: 'mc', args: '' } as never)
  expect(reads.n).toBe(1)
  expect((stored.get('timeline') as Timeline).budget?.contextPct).toBe(85)
})
