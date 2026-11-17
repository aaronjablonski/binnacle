import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Timeline, UiState } from '../../types'
import { initialUi } from '../state'
import { SWEEP_FRAMES, SWEEP_STEP_MS, SWEEP_WIDTH, resetSweep, sweepCells } from './delights'
import { asked, busy, idle, NOW, step, tasksOf } from './now.fixtures.testkit'
import { resetPaint } from './paint'
import { ACCENT_HUES, decode, DOT_BITS, PALETTE } from './raster'
import { screen } from './screen.testkit'
import { configureOptions } from './options'

// R36 (the delights) and R35 (the accent). The sweep and the toasts run from
// the clock's tick; a draw only reads the sweep's frame. The hooks run in
// their own module copy, so the sweep is read from what the pane draws.

const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }
type Stored = Map<string, unknown>
type World = { stored: Stored; clock: MockClock; toasts: string[] }

function world(on: On, t: Timeline, u: UiState, env: Record<string, string> = {}): World {
  resetPaint()
  resetSweep()
  const stored: Stored = new Map<string, unknown>([['timeline', t], ['ui', u]])
  const clock = mock.clock(on, { now: NOW })
  const toasts: string[] = []
  mock.env(on, env)
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
  on('ui.panes', () => ({ value: u.paneOpen === true ? [{ id: 'binnacle', title: 'Binnacle', isShown: true, isFocused: false, isPlaced: true }] : [] }) as never)
  on('command.register', () => ({ value: { command: 'binnacle' } }))
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
    plugin: 'binnacle', component: 'Pane', requestId: 'binnacle', surface: 'terminal' as const,
    props: { title: 'Binnacle', isFocused: false, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 46 }, view: {} },
  }) as const

const BAND = (columns: number) =>
  ({
    plugin: 'binnacle', component: 'AbovePrompt', surface: 'terminal' as const,
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

test('a clean finish sweeps the pane once: SWEEP_FRAMES frames in order, then it ends and never comes back', { options: { look: 'text', header: 'full' }, timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on, clean(), OPEN)
  await start($)
  const ui = await $.ui.mount(PANE(62) as never)
  // The mock clock runs the sweep's clock.after chain exactly (FX4): sample once per step, in the middle of each frame, not every 100 ms.
  const seen: (number | undefined)[] = []
  await w.clock.advance(1000 + SWEEP_STEP_MS / 2)
  for (let i = 0; i < SWEEP_FRAMES; i++) {
    if (i > 0) await w.clock.advance(SWEEP_STEP_MS)
    await ui.redraw()
    seen.push(litFrom(screen(await ui.drawn())))
  }
  expect(seen).toEqual(STEPS)
  expect(SWEEP_FRAMES).toBe(5)
  expect(SWEPT(w)).toBe(true)
  // It ended: nothing sweeps on later ticks, and the rule is plain. M12: sampled every SWEEP_STEP_MS over 20 s on the
  // mock clock, so a restarted pass (it shows for SWEEP_FRAMES steps) cannot slip between two samples.
  for (let ms = 0; ms < 20_000; ms += SWEEP_STEP_MS) {
    await w.clock.advance(SWEEP_STEP_MS)
    await ui.redraw()
    expect(litFrom(screen(await ui.drawn()))).toBeUndefined()
  }
  await ui.unmount()
})

test('the sweep lights a 6-cell window of the 62-column header rule, and the whole pass is under a second', { options: { look: 'text', header: 'full' } }, async ($, on) => {
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

// M5: the toast says what the views say ("All 14 done").
test('all to-dos done toasts once for the request, at the round number, and never again', async ($, on) => {
  const done = tasksOf(14).map(x => ({ ...x, updatedAt: NOW - 1000 }))
  const w = world(on, { ...clean(), tasks: done }, OPEN)
  await start($)
  await w.clock.advance(1000)
  await w.clock.advance(10_000)
  expect(w.toasts).toEqual(['All 14 done'])
  expect(toasted(w)).toContain('todos-done:t1')
  await w.clock.advance(30_000)
  expect(w.toasts).toEqual(['All 14 done'])
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
  expect(w.toasts.filter(x => x.includes('finished'))).toEqual(['Explorer finished: Grep upload'])
})

// R3-B (M13): meaning changed. A finish while another agent still runs now waits up to 30 s for the rest (it waited 2 s, then 5 s here), so the clock goes past 30 s before the one toast.
test('a finish while another agent still runs waits up to 30 s for the rest, then toasts once', async ($, on) => {
  const t = idle()
  const run = { ...t.agents.e1!, id: 'r1', status: 'running' as const }
  delete (run as { endedAt?: number }).endedAt
  const agents = { ...t.agents, r1: run, x1: { ...t.agents.e1!, id: 'x1', status: 'done' as const, endedAt: NOW + 500, doing: 'a' } }
  const w = world(on, { ...t, agents }, OPEN)
  await start($)
  await w.clock.advance(1000)
  expect(w.toasts.filter(x => x.includes('finished'))).toEqual([])
  await w.clock.advance(30_000)
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

/** The colours of one drawing of the pane; the world must already be set and started. */
async function drawnColoursNow($: Engine): Promise<string[]> {
  const ui = await $.ui.mount(PANE(62) as never)
  const got = colours(await ui.drawn())
  await ui.unmount()
  return got
}

async function drawnColours($: Engine, on: On, t: Timeline): Promise<string[]> {
  world(on, t, OPEN)
  await start($)
  return drawnColoursNow($)
}

// R3-B M12: each accent test draws its own default (iris) drawing first, in the same test, so none depends on another having run.
test('the accent defaults to iris, which is the theme key suggestion', async ($, on) => {
  const got = await drawnColours($, on, asked())
  expect(got).toContain('suggestion')
  expect(got).not.toContain('ide')
  expect(got).not.toContain('promptBorder')
})

for (const [name, key] of [['sky', 'ide'], ['slate', 'promptBorder']] as const) {
  test(`accent ${name} draws the structural colour in ${key} and changes nothing else`, { options: { accent: name } }, async ($, on) => {
    world(on, asked(), OPEN)
    await start($)
    configureOptions({ accent: 'iris' })
    resetPaint()
    const base = await drawnColoursNow($)
    configureOptions({ accent: name })
    resetPaint()
    const got = await drawnColoursNow($)
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

// ---------- the accent in the rich look (R35, FX3 item 7) ----------

/** Every Raster of the rich pane: its key and the colours of its cells (foreground and background, as hex numbers). */
async function drawnRastersNow($: Engine): Promise<Map<string, { cells: string; colours: Set<number> }>> {
  const ui = await $.ui.mount(PANE(62) as never)
  const out = new Map<string, { cells: string; colours: Set<number> }>()
  for (const r of await ui.findAll({ type: 'Raster' })) {
    const cells = (r.props as { cells: string }).cells
    const colours = new Set<number>()
    for (const [, fg, bg] of decode(cells)) {
      colours.add(fg)
      colours.add(bg)
    }
    out.set(String(r.key), { cells, colours })
  }
  await ui.unmount()
  return out
}

const rasterBase: { drawn?: Map<string, { cells: string; colours: Set<number> }> } = {}

async function drawnRasters($: Engine, on: On, t: Timeline): Promise<Map<string, { cells: string; colours: Set<number> }>> {
  world(on, t, OPEN)
  await start($)
  return drawnRastersNow($)
}

/** The Rasters that hold a critter (`now-who`, `agent-<id>-who`, the rest row); the others are structural. */
const isCritter = (key: string): boolean => /-who$|^rest$|^tether/.test(key)

test('rich: the default accent draws the palette iris in the structural Rasters', { options: { header: 'full' } }, async ($, on) => {
  const drawn = await drawnRasters($, on, busy())
  rasterBase.drawn = drawn
  const structural = [...drawn].filter(([k]) => !isCritter(k))
  expect(structural.map(([k]) => k)).toEqual(expect.arrayContaining([expect.stringMatching(/lintel/)]))
  const hex = new Set(structural.flatMap(([, v]) => [...v.colours]))
  expect(hex.has(PALETTE.night.iris)).toBe(true)
  expect(hex.has(ACCENT_HUES.sky.night.iris)).toBe(false)
  expect([...drawn.keys()].filter(isCritter)).toEqual(['now-who', 'agent-e1-who', 'agent-b1-who'])
})

for (const name of ['sky', 'slate'] as const) {
  test(`rich: accent ${name} draws no iris hex in the lintel, sill and gauges, and the critter cells are unchanged`, { options: { accent: name, header: 'full' } }, async ($, on) => {
    // The default drawing is the previous test's (a draw reads the accent from the register options, so one engine cannot draw both); a run of this test alone reads none and fails loudly, naming it.
    const base = rasterBase.drawn
    if (base === undefined) throw new Error('needs the default-accent drawing from "rich: the default accent draws the palette iris in the structural Rasters", which runs before it')
    const drawn = await drawnRasters($, on, busy())
    expect([...drawn.keys()]).toEqual([...base.keys()])
    const iris = [PALETTE.night.iris, PALETTE.night.irisSoft, PALETTE.night.irisDeep]
    let sawAccent = false
    for (const [key, v] of drawn) {
      if (isCritter(key)) {
        // role hues inside a critter never change: the same cells, byte for byte
        expect([key, v.cells]).toEqual([key, base.get(key)!.cells])
        continue
      }
      for (const c of iris) expect([key, v.colours.has(c)]).toEqual([key, false])
      if (v.colours.has(ACCENT_HUES[name].night.iris)) sawAccent = true
    }
    expect(sawAccent).toBe(true)
    // the lintel (working: the accent's own tone) differs from the default's and carries the accent's hex
    const lintel = [...drawn].find(([k]) => /lintel/.test(k))
    expect(lintel).toBeDefined()
    expect(lintel![1].colours.has(ACCENT_HUES[name].night.iris)).toBe(true)
    expect(lintel![1].cells).not.toBe(base.get(lintel![0])!.cells)
  })
}

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

// ---------- the gauge ring is round (FX4) ----------

/** Width / height in pixels of the dots of the first gauge (cells 0 to 8) of the drawn header, for a cell `a` times taller than wide. */
async function gaugeRatio($: Engine, on: On, env: Record<string, string>, a: number): Promise<number> {
  world(on, busy(), OPEN, env)
  await start($)
  const ui = await $.ui.mount(PANE(62) as never)
  const r = await ui.find({ type: 'Raster', key: 'now-gauges' })
  await ui.unmount()
  expect(r).toBeDefined()
  const { columns, cells } = r!.props as { columns: number; cells: string }
  const dots: [number, number][] = []
  decode(cells).forEach(([cp], i) => {
    const cx = i % columns
    if (cx > 8 || cp < 0x2800 || cp > 0x28ff) return
    for (let c = 0; c < 2; c++) for (let q = 0; q < 4; q++) if ((cp - 0x2800) & DOT_BITS[c]![q]!) dots.push([cx * 2 + c, Math.floor(i / columns) * 4 + q])
  })
  const xs = dots.map(d => d[0])
  const ys = dots.map(d => d[1])
  return ((Math.max(...xs) - Math.min(...xs) + 1) * 0.5) / ((Math.max(...ys) - Math.min(...ys) + 1) * 0.25 * a)
}

test('FX4: in Windows Terminal (WT_SESSION) the header gauge is round within 5 % at aspect 2.35', { options: { header: 'full' } }, async ($, on) => {
  const r = await gaugeRatio($, on, { WT_SESSION: 'x' }, 2.35)
  expect(Math.abs(r - 1)).toBeLessThan(0.05)
})

test('FX4: in VS Code (TERM_PROGRAM=vscode) the header gauge is round within 5 % at aspect 2.4', { options: { header: 'full' } }, async ($, on) => {
  const r = await gaugeRatio($, on, { TERM_PROGRAM: 'vscode' }, 2.4)
  expect(Math.abs(r - 1)).toBeLessThan(0.05)
})

test('FX4: with no terminal named the header gauge is round within 5 % at aspect 2.2', { options: { header: 'full' } }, async ($, on) => {
  const r = await gaugeRatio($, on, {}, 2.2)
  expect(Math.abs(r - 1)).toBeLessThan(0.05)
})
