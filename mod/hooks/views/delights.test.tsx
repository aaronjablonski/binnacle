import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Timeline, UiState } from '../../types'
import { initialUi } from '../state'
import { SWEEP_FRAMES, SWEEP_STEP_MS, SWEEP_WIDTH, resetSweep, sweepCells } from './delights'
import { asked, idle, NOW, step, tasksOf } from './now.fixtures.testkit'
import { resetPaint } from './paint'
import { screen } from './screen.testkit'

// R36 (the delights) and R35 (the accent). The sweep and the toasts run from
// the clock's tick; a draw only reads the sweep's frame. The hooks run in
// their own module copy, so the sweep is read from what the pane draws.

const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }
type Stored = Map<string, unknown>
type World = { stored: Stored; clock: MockClock; toasts: string[] }

function world(on: On, t: Timeline, u: UiState): World {
  resetPaint()
  resetSweep()
  const stored: Stored = new Map<string, unknown>([['timeline', t], ['ui', u]])
  const clock = mock.clock(on, { now: NOW })
  const toasts: string[] = []
  mock.env(on, {})
  on('ui.log', () => ({ value: undefined }))
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    const v = stored.get(key)
    return { value: { value: v === undefined ? undefined : { shape: SHAPES[key], value: v }, version: 0 } }
  })
  on('state.set', (_, e) => {
    const w = e as unknown as { key: string; value: { value: unknown } }
    stored.set(w.key, w.value.value)
    return { value: { isSet: true as const, version: 1 } }
  })
  on('ui.toast', (_, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true as const, channel: 'terminal' } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true as const } }) as never)
  // The engine's record of the pane: up and placed when the test says the pane is open.
  on('ui.panes', () => ({ value: u.paneOpen === true ? [{ id: 'mission-control', title: 'Mission Control', isShown: true, isFocused: false, isPlaced: true }] : [] }) as never)
  on('command.register', () => ({ value: { command: 'mc' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { stored, clock, toasts }
}

const start = ($: Engine) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const OPEN: UiState = { ...initialUi, paneOpen: true }
const toasted = (w: World): string[] => (w.stored.get('ui') as UiState).toasted
const SWEPT = (w: World): boolean => toasted(w).includes('swept:t1')

/** A request that ended cleanly 2 s ago with its whole list done (the tasks finished long before, so no to-do toast). */
function clean(): Timeline {
  const t = idle()
  return { ...t, turns: [{ id: 't1', agent: 'main', prompt: 'go', startedAt: NOW - 80 * 60_000, endedAt: NOW - 2000 }] }
}

type Mounted = Awaited<ReturnType<Engine['ui']['mount']>>

const PANE = (columns: number) =>
  ({
    plugin: 'mission-control', component: 'Pane', requestId: 'mission-control', surface: 'terminal' as const,
    props: { title: 'Mission Control', isFocused: false, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 46 }, view: {} },
  }) as const

const BAND = (columns: number) =>
  ({
    plugin: 'mission-control', component: 'AbovePrompt', surface: 'terminal' as const,
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: columns, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  }) as const

/** The lit window of the header rule in drawn rows: its first column, or undefined when the rule is plain. */
function litFrom(rows: string[]): number | undefined {
  for (const r of rows) {
    const m = /^┏━━(─*)━{6}─*$/.exec(r.trimEnd())
    if (m && r.trimEnd().length === 62) return 3 + m[1]!.length
  }
  return undefined
}

/** Runs the clock `ms` on in 100 ms steps, drawing the pane after each; returns the first column of the lit window each time it moved. */
async function lit(ui: Mounted, clock: MockClock, ms: number, step = 100): Promise<number[]> {
  const seen: number[] = []
  for (let left = 0; left < ms; left += step) {
    await clock.advance(step)
    await ui.redraw()
    const f = litFrom(screen(await ui.drawn()))
    if (f !== undefined && seen[seen.length - 1] !== f) seen.push(f)
  }
  return seen
}

const STEPS = [0, 1, 2, 3, 4].map(i => sweepCells(i, 62)[0])

test('a clean finish sweeps the pane once: SWEEP_FRAMES frames in order, then it ends and never comes back', { options: { look: 'text' } }, async ($, on) => {
  const w = world(on, clean(), OPEN)
  await start($)
  const ui = await $.ui.mount(PANE(62) as never)
  expect(await lit(ui, w.clock, 3000)).toEqual(STEPS)
  expect(SWEEP_FRAMES).toBe(5)
  expect(SWEPT(w)).toBe(true)
  // It ended: nothing sweeps on later ticks (a new pass would show for 800 ms, longer than the 400 ms step), and the rule is plain.
  expect(await lit(ui, w.clock, 20_000, 400)).toEqual([])
  expect(litFrom(screen(await ui.drawn()))).toBeUndefined()
  await ui.unmount()
})

test('the sweep lights a 6-cell window of the 62-column header rule, and the whole pass is under a second', { options: { look: 'text' } }, async ($, on) => {
  const w = world(on, clean(), OPEN)
  await start($)
  const ui = await $.ui.mount(PANE(62) as never)
  await w.clock.advance(1000)
  await ui.redraw()
  expect(litFrom(screen(await ui.drawn()))).toBe(3)
  expect(SWEEP_WIDTH).toBe(6)
  expect(SWEEP_STEP_MS * SWEEP_FRAMES).toBeLessThan(1000)
  await w.clock.advance(SWEEP_STEP_MS * SWEEP_FRAMES + 100)
  await ui.redraw()
  expect(litFrom(screen(await ui.drawn()))).toBeUndefined()
  await ui.unmount()
})

test('the sweep moves from the clamp to the right edge and is empty when there is none', async () => {
  const [a, b] = [sweepCells(0, 62), sweepCells(SWEEP_FRAMES - 1, 62)]
  expect(a[0]).toBe(3)
  expect(b[1]).toBe(62)
  expect(sweepCells(undefined, 62)).toEqual([0, 0])
})

test('no sweep while Needs you has rows', { options: { look: 'text' } }, async ($, on) => {
  const t = { ...clean(), steps: [...clean().steps, step('q1', 90, 'main', 'AskUserQuestion', 'AskUserQuestion pick one', 'running', NOW - 1000, { turnId: 't1' })] }
  const w = world(on, t, OPEN)
  await start($)
  const ui = await $.ui.mount(PANE(62) as never)
  expect(await lit(ui, w.clock, 6000)).toEqual([])
  expect(SWEPT(w)).toBe(false)
  await ui.unmount()
})

test('no sweep with the motion option off', { options: { look: 'text', motion: 'off' } }, async ($, on) => {
  const w = world(on, clean(), OPEN)
  await start($)
  const ui = await $.ui.mount(PANE(62) as never)
  expect(await lit(ui, w.clock, 6000)).toEqual([])
  expect(SWEPT(w)).toBe(false)
  await ui.unmount()
})

test('no sweep for a request that failed', { options: { look: 'text' } }, async ($, on) => {
  const w = world(on, { ...clean(), turns: [{ ...clean().turns[0]!, failed: true }] }, OPEN)
  await start($)
  const ui = await $.ui.mount(PANE(62) as never)
  expect(await lit(ui, w.clock, 4000)).toEqual([])
  expect(SWEPT(w)).toBe(false)
  await ui.unmount()
})

test('no sweep for a request that ended with to-dos still open', { options: { look: 'text' } }, async ($, on) => {
  const w = world(on, { ...clean(), tasks: tasksOf(10) }, OPEN)
  await start($)
  const ui = await $.ui.mount(PANE(62) as never)
  expect(await lit(ui, w.clock, 4000)).toEqual([])
  expect(SWEPT(w)).toBe(false)
  await ui.unmount()
})

test('no sweep with the pane closed', { options: { look: 'text' } }, async ($, on) => {
  const w = world(on, clean(), initialUi)
  await start($)
  await w.clock.advance(4000)
  expect(SWEPT(w)).toBe(false)
})

test('a finish long ago (a restore) sweeps nothing', { options: { look: 'text' } }, async ($, on) => {
  const old: Timeline = { ...clean(), turns: [{ ...clean().turns[0]!, endedAt: NOW - 120_000 }] }
  const w = world(on, old, OPEN)
  await start($)
  const ui = await $.ui.mount(PANE(62) as never)
  expect(await lit(ui, w.clock, 4000)).toEqual([])
  expect(SWEPT(w)).toBe(false)
  await ui.unmount()
})

test('the band never sweeps: its rows are the same on every frame of a sweep', { options: { look: 'text' } }, async ($, on) => {
  const w = world(on, clean(), OPEN)
  await start($)
  const band = await $.ui.mount(BAND(62) as never)
  await w.clock.advance(1000)
  expect(SWEPT(w)).toBe(true)
  const before = screen(await band.drawn())
  for (let i = 0; i < 6; i++) {
    await w.clock.advance(SWEEP_STEP_MS)
    await band.redraw()
    const rows = screen(await band.drawn())
    expect(rows).toEqual(before)
    expect(litFrom(rows)).toBeUndefined()
  }
  await band.unmount()
})

test('all to-dos done toasts once for the request, at the round number, and never again', async ($, on) => {
  const done = tasksOf(14).map(x => ({ ...x, updatedAt: NOW - 1000 }))
  const w = world(on, { ...clean(), tasks: done }, OPEN)
  await start($)
  await w.clock.advance(1000)
  await w.clock.advance(10_000)
  expect(w.toasts).toEqual(['All 14 to-dos done'])
  expect(toasted(w)).toContain('todos-done:t1')
  await w.clock.advance(30_000)
  expect(w.toasts).toEqual(['All 14 to-dos done'])
})

test('no to-do toast for a list still open', async ($, on) => {
  const w = world(on, { ...clean(), tasks: tasksOf(10) }, OPEN)
  await start($)
  await w.clock.advance(5000)
  expect(w.toasts).toEqual([])
})

test('no to-do toast for a list that finished before a restore', async ($, on) => {
  const w = world(on, clean(), OPEN)
  await start($)
  await w.clock.advance(5000)
  expect(w.toasts).toEqual([])
})

const budgetT = (pct: number): Timeline => ({ ...idle(), budget: { contextTokens: 1, contextPct: pct, windows: [], at: NOW } })

test('context at 79 % toasts nothing', async ($, on) => {
  const w = world(on, budgetT(79), OPEN)
  await start($)
  await w.clock.advance(5000)
  expect(w.toasts.filter(x => x.startsWith('Context'))).toEqual([])
})

test('context at 80 % toasts once and never again', async ($, on) => {
  const w = world(on, budgetT(81), OPEN)
  await start($)
  await w.clock.advance(5000)
  await w.clock.advance(20_000)
  expect(w.toasts.filter(x => x.startsWith('Context'))).toEqual(['Context at 81%'])
})

test('agents that finish together fold into one toast: "3 agents finished"', async ($, on) => {
  const t = idle()
  const agents = { ...t.agents }
  for (const id of ['x1', 'x2', 'x3']) agents[id] = { ...agents.e1!, id, status: 'done', endedAt: NOW - 500, doing: `work ${id}` }
  const w = world(on, { ...t, agents }, OPEN)
  await start($)
  await w.clock.advance(5000)
  expect(w.toasts.filter(x => x.includes('finished'))).toEqual(['3 agents finished'])
  await w.clock.advance(10_000)
  expect(w.toasts.filter(x => x.includes('finished'))).toHaveLength(1)
  expect(toasted(w)).toEqual(expect.arrayContaining(['agent-done:x1', 'agent-done:x2', 'agent-done:x3']))
})

test('a lone agent finish keeps its own words', async ($, on) => {
  const t = idle()
  const agents = { ...t.agents, x1: { ...t.agents.e1!, id: 'x1', status: 'done' as const, endedAt: NOW - 500, doing: 'Grep upload' } }
  const w = world(on, { ...t, agents }, OPEN)
  await start($)
  await w.clock.advance(5000)
  expect(w.toasts.filter(x => x.includes('finished'))).toEqual(['Explore finished: Grep upload'])
})

test('a finish while another agent still runs waits a moment for the rest, then toasts once', async ($, on) => {
  const t = idle()
  const run = { ...t.agents.e1!, id: 'r1', status: 'running' as const }
  delete (run as { endedAt?: number }).endedAt
  const agents = { ...t.agents, r1: run, x1: { ...t.agents.e1!, id: 'x1', status: 'done' as const, endedAt: NOW + 500, doing: 'a' } }
  const w = world(on, { ...t, agents }, OPEN)
  await start($)
  await w.clock.advance(1000)
  expect(w.toasts.filter(x => x.includes('finished'))).toEqual([])
  await w.clock.advance(4000)
  expect(w.toasts.filter(x => x.includes('finished')).length).toBe(1)
})

// ---------- the accent (R35) ----------

type Node = { type?: unknown; props?: Record<string, unknown>; children?: unknown }
function colours(n: unknown, out: string[] = []): string[] {
  if (n === null || n === undefined || typeof n !== 'object') return out
  if (Array.isArray(n)) {
    n.forEach(k => colours(k, out))
    return out
  }
  const el = n as Node
  for (const k of ['color', 'backgroundColor', 'borderColor'] as const) {
    const v = el.props?.[k]
    if (typeof v === 'string') out.push(v)
  }
  colours(el.children ?? el.props?.children, out)
  return out
}

async function drawnColours($: Engine, on: On, t: Timeline): Promise<string[]> {
  world(on, t, OPEN)
  await start($)
  const ui = await $.ui.mount(PANE(62) as never)
  const got = colours(await ui.drawn())
  await ui.unmount()
  return got
}

// The default drawing, kept for the two accent tests after it (they run in this order).
const baseline: { colours?: string[] } = {}

test('the accent defaults to iris, which is the theme key suggestion', async ($, on) => {
  const got = await drawnColours($, on, asked())
  baseline.colours = got
  expect(got).toContain('suggestion')
  expect(got).not.toContain('ide')
  expect(got).not.toContain('promptBorder')
})

for (const [name, key] of [['sky', 'ide'], ['slate', 'promptBorder']] as const) {
  test(`accent ${name} draws the structural colour in ${key} and changes nothing else`, { options: { accent: name } }, async ($, on) => {
    const got = await drawnColours($, on, asked())
    const base = baseline.colours ?? []
    expect(base.length).toBeGreaterThan(10)
    expect(got).toContain(key)
    expect(got).not.toContain('suggestion')
    // The same drawing as the default one, colour for colour, with the accent's key where iris was.
    expect(got).toEqual(base.map(c => (c === 'suggestion' ? key : c)))
    for (const state of ['warning', 'error']) expect(got.includes(state) || !base.includes(state)).toBe(true)
  })
}

test('an unknown accent is iris', { options: { accent: 'chartreuse' } }, async ($, on) => {
  const got = await drawnColours($, on, asked())
  expect(got).toContain('suggestion')
})

test('with the rich look the sweep redraws the lintel Raster at the same size on every frame and the pane never fails', async ($, on) => {
  const w = world(on, clean(), OPEN)
  await start($)
  const ui = await $.ui.mount(PANE(62) as never)
  for (let i = 0; i < 12; i++) {
    await w.clock.advance(200)
    await ui.redraw()
    expect(screen(await ui.drawn()).join('\n')).not.toContain('failed')
  }
  expect(SWEPT(w)).toBe(true)
  await ui.unmount()
})
