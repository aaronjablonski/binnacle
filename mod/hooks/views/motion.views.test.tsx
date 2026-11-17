import { expect, mock, test } from 'claude-code/testing'
import type { ElementQuery, FoundElement, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Step, Timeline, UiState } from '../../types'
import { initialUi } from '../state'
import { resetSweep, SWEEP_FRAMES, SWEEP_STEP_MS } from './delights'
import { agent, asked, busy, idle, NOW, step, tasksOf } from './now.fixtures.testkit'
import { resetPaint } from './paint'
import { critterBox, critterFrames, critterPoseBox, encode, GAUGE_FILL, GAUGE_FILL_MS, MOVE_MS, moveFrames, sweepPose } from './raster'
import type { Ground, Move } from './raster'
import { screen } from './screen.testkit'

// The ten motion sketches in the real views: a mounted pane (and band) on
// the engine's test kit, its clock mocked, its blits and redraws counted.
// The hooks run in their own module copy, so what moved is read from the
// drawn Rasters and the blits the engine was asked for.

const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }
type Stored = Map<string, unknown>
type Blit = { key: string; cells: string; at: number }
type World = { stored: Stored; clock: MockClock; blits: Blit[]; redraws: number[]; toasts: string[] }

function world(on: On, t: Timeline, u: UiState = initialUi): World {
  resetPaint()
  resetSweep()
  const stored: Stored = new Map<string, unknown>([['timeline', t], ['ui', u]])
  const clock = mock.clock(on, { now: NOW })
  const w: World = { stored, clock, blits: [], redraws: [], toasts: [] }
  mock.env(on, {})
  on('ui.log', () => ({ value: undefined }))
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    const v = stored.get(key)
    return { value: { value: v === undefined ? undefined : { shape: SHAPES[key], value: v }, version: 0 } }
  })
  on('state.set', (_, e) => {
    const x = e as unknown as { key: string; value: { value: unknown } }
    stored.set(x.key, x.value.value)
    return { value: { isSet: true as const, version: 1 } }
  })
  on('ui.invalidate', () => {
    w.redraws.push(clock.now() - NOW)
    return { value: undefined }
  })
  on('ui.blit', (_, e) => {
    const b = e as unknown as { key: string; cells: string }
    w.blits.push({ key: b.key, cells: b.cells, at: clock.now() - NOW })
    return { value: {} } as never
  })
  on('ui.toast', (_, e) => {
    w.toasts.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })
  on('ui.notify', () => ({ value: { isSent: true as const, channel: 'terminal' } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true as const } }) as never)
  on('ui.panes', () => ({ value: u.paneOpen === true ? [{ id: 'binnacle', title: 'Binnacle', isShown: true, isFocused: false, isPlaced: true }] : [] }) as never)
  on('command.register', () => ({ value: { command: 'binnacle' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return w
}

const PANE = (o: { covered?: boolean } = {}) =>
  ({
    plugin: 'binnacle', component: 'Pane', requestId: 'binnacle', surface: 'terminal' as const,
    props: {
      title: 'Binnacle', isFocused: true, bodyColumns: 62, placement: 'dock', scroll: { offset: 0, bodyRows: 46 }, view: {},
      ...(o.covered === true ? { isPromptCovered: true as const } : {}),
    },
  }) as const

const BAND = {
  plugin: 'binnacle', component: 'AbovePrompt', surface: 'terminal' as const,
  props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

/** What these tests use of a mounted pane or band. */
type Mounted = {
  find: (q: ElementQuery) => Promise<FoundElement | undefined>
  findAll: (q: ElementQuery) => Promise<FoundElement[]>
  drawn: () => Promise<unknown>
  redraw: () => Promise<void>
  press: (t: { key: string }) => Promise<unknown>
}
const cellsOf = async (ui: Mounted, key: string): Promise<string | undefined> => {
  const r = await ui.find({ type: 'Raster', key })
  return (r?.props as { cells?: string } | undefined)?.cells
}
const timeline = (w: World): Timeline => w.stored.get('timeline') as Timeline
const blitsOf = (w: World, key: string): Blit[] => w.blits.filter(b => b.key === key)
const GROUNDS: Ground[] = ['night', 'day']

/** The ground a mounted critter was drawn for, read off its first frame. */
function groundOf(mounted: string | undefined, frame: (g: Ground) => string): Ground {
  const g = GROUNDS.find(x => frame(x) === mounted)
  if (g === undefined) throw new Error('the mounted cells match no frame on either ground')
  return g
}

/** Checks a move in a mounted pane: the first frame mounted, each later frame blitted after its time, then the end state; nothing after. */
async function playsMove(w: World, ui: Mounted, key: string, role: 'general' | 'scout' | 'lead', move: Move, end: Parameters<typeof critterFrames>[1], from: number): Promise<void> {
  const frames = (g: Ground) => moveFrames(move).map(f => encode(critterPoseBox(role, 'small', f, g)))
  const g = groundOf(await cellsOf(ui, key), x => frames(x)[0]!)
  const ms = MOVE_MS[move]
  for (let i = 1; i <= ms.length; i++) {
    await w.clock.advance(ms[i - 1]! - 1)
    const before = blitsOf(w, key).length
    await w.clock.advance(1)
    const got = blitsOf(w, key)
    const want = i < ms.length ? frames(g)[i]! : encode(critterFrames(role, end, 'small', { ground: g, motion: true })[0]!)
    const same = i === ms.length && want === frames(g)[ms.length - 1]
    if (same) expect(got.length).toBe(before)
    else {
      expect(got.length).toBe(before + 1)
      expect(got[got.length - 1]!.at - from).toBe(ms.slice(0, i).reduce((n, x) => n + x, 0))
    }
  }
}

// ---------- 2: an agent starts ----------

function started(): Timeline {
  const t = busy()
  return { ...t, agents: { ...t.agents, b1: agent('b1', 'general-purpose', 'write the rate limit tests', NOW - 200) } }
}

test('motion 2: a card that just started squashes and hops on Now (2 x 120 ms blits), then holds; no redraw', async ($, on) => {
  const w = world(on, started())
  const ui = await $.ui.mount(PANE())
  await playsMove(w, ui, 'agent-b1-who', 'general', 'wake', 'working', 0)
  const n = blitsOf(w, 'agent-b1-who').length
  await w.clock.advance(5000)
  expect(blitsOf(w, 'agent-b1-who').length).toBe(n)
  expect(w.redraws).toHaveLength(0)
  await ui.unmount()
})

test('motion 2, motion off: the card is drawn working at once and nothing is blitted', { options: { motion: 'off' } }, async ($, on) => {
  const w = world(on, started())
  const ui = await $.ui.mount(PANE())
  const cells = await cellsOf(ui, 'agent-b1-who')
  expect(GROUNDS.some(g => encode(critterBox('general', 'working', 'small', { ground: g })) === cells)).toBe(true)
  await w.clock.advance(2000)
  expect(w.blits).toHaveLength(0)
  await ui.unmount()
})

test('motion 2, text look: no Raster, the card is its end state, and nothing changes as the burst\'s time passes', { options: { look: 'text' } }, async ($, on) => {
  const w = world(on, started())
  const ui = await $.ui.mount(PANE())
  expect(await cellsOf(ui, 'agent-b1-who')).toBeUndefined()
  const rows = screen(await ui.drawn())
  await w.clock.advance(500)
  await ui.redraw()
  expect(screen(await ui.drawn())).toEqual(rows)
  expect(w.blits).toHaveLength(0)
  expect(w.redraws).toHaveLength(0)
  await ui.unmount()
})

// ---------- 3: an agent finishes ----------

function finishB1(w: World): void {
  const t = timeline(w)
  w.stored.set('timeline', { ...t, agents: { ...t.agents, b1: { ...t.agents.b1!, status: 'done', endedAt: w.clock.now() } }, steps: t.steps.filter(s => s.agent !== 'b1') })
}

test('motion 3: a finish nods and fades (2 x 150 ms), rests 700 ms in grey on its card, then one redraw folds it into the finished count', async ($, on) => {
  const w = world(on, busy())
  const ui = await $.ui.mount(PANE())
  expect(screen(await ui.drawn()).some(r => r.includes('31 finished earlier'))).toBe(true)
  finishB1(w)
  await ui.redraw()
  // Still a card, its critter nodding; the count not yet moved.
  expect(screen(await ui.drawn()).some(r => r.includes('31 finished earlier'))).toBe(true)
  await playsMove(w, ui, 'agent-b1-who', 'general', 'settle', 'done', 0)
  expect(w.redraws).toEqual([1000])
  await ui.redraw()
  const rows = screen(await ui.drawn())
  expect(rows.some(r => r.includes('32 finished earlier'))).toBe(true)
  expect(await cellsOf(ui, 'agent-b1-who')).toBeUndefined()
  await w.clock.advance(5000)
  expect(w.redraws).toHaveLength(1)
  await ui.unmount()
})

test('motion 3, motion off: the card folds at once, with no blit and no redraw', { options: { motion: 'off' } }, async ($, on) => {
  const w = world(on, busy())
  const ui = await $.ui.mount(PANE())
  finishB1(w)
  await ui.redraw()
  expect(screen(await ui.drawn()).some(r => r.includes('32 finished earlier'))).toBe(true)
  await w.clock.advance(2000)
  expect(w.blits).toHaveLength(0)
  expect(w.redraws).toHaveLength(0)
  await ui.unmount()
})

test('motion 3, text look: the card folds at once (the end state)', { options: { look: 'text' } }, async ($, on) => {
  const w = world(on, busy())
  const ui = await $.ui.mount(PANE())
  finishB1(w)
  await ui.redraw()
  expect(screen(await ui.drawn()).some(r => r.includes('32 finished earlier'))).toBe(true)
  await w.clock.advance(2000)
  expect(w.redraws).toHaveLength(0)
  await ui.unmount()
})

test('motion 3: the agent-finished toast waits about 1.5 s after the finish, so finishes that land together go up as one', { timeoutMs: 30_000 }, async ($, on) => {
  const t = busy()
  const w = world(on, { ...t, agents: { ...t.agents, e1: { ...t.agents.e1!, status: 'done', endedAt: NOW }, b1: { ...t.agents.b1!, status: 'done', endedAt: NOW + 400 } } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await w.clock.advance(1000)
  expect(w.toasts.filter(x => x.includes('finished'))).toEqual([])
  await w.clock.advance(1000)
  expect(w.toasts.filter(x => x.includes('finished'))).toEqual(['2 agents finished'])
  await w.clock.advance(10_000)
  expect(w.toasts.filter(x => x.includes('finished'))).toHaveLength(1)
})

// ---------- 4: Needs you arrives ----------

function freshAsk(): Timeline {
  const t = asked()
  return { ...t, steps: t.steps.map(s => (s.id === 's-b1' ? { ...s, asking: NOW - 100 } : s)) }
}

const textProps = async (ui: Mounted, text: string): Promise<Record<string, unknown> | undefined> =>
  (await ui.findAll({ type: 'Text' })).find(f => f.text === text)?.props as Record<string, unknown> | undefined

test('motion 4: the block comes in at half strength, full amber one frame later (one redraw at 140 ms); the asker glances and hops (2 x 140 ms), then all holds still', async ($, on) => {
  const w = world(on, freshAsk())
  const ui = await $.ui.mount(PANE({ covered: true }))
  expect(await textProps(ui, 'Needs you')).toMatchObject({ color: 'warning', dimColor: true })
  await playsMove(w, ui, 'asker', 'general', 'ask', 'waiting', 0)
  expect(w.redraws).toEqual([140])
  await ui.redraw()
  const head = await textProps(ui, 'Needs you')
  expect(head).toMatchObject({ color: 'warning' })
  expect(head?.dimColor).toBeUndefined()
  // Never again: no pulse, no repeat, however long it waits.
  const n = blitsOf(w, 'asker').length
  await w.clock.advance(30_000)
  await ui.redraw()
  expect((await textProps(ui, 'Needs you'))?.dimColor).toBeUndefined()
  expect(blitsOf(w, 'asker')).toHaveLength(n)
  expect(w.redraws).toHaveLength(1)
  await ui.unmount()
})

test('motion 4, text look: one dim-amber frame, then amber (the sketch\'s text cue); no Raster', { options: { look: 'text' } }, async ($, on) => {
  const w = world(on, freshAsk())
  const ui = await $.ui.mount(PANE({ covered: true }))
  expect(await textProps(ui, 'Needs you')).toMatchObject({ color: 'warning', dimColor: true })
  expect(await cellsOf(ui, 'asker')).toBeUndefined()
  await w.clock.advance(140)
  expect(w.redraws).toEqual([140])
  await ui.redraw()
  expect((await textProps(ui, 'Needs you'))?.dimColor).toBeUndefined()
  await ui.unmount()
})

test('motion 4, motion off: full amber at once, the asker waiting with its badge, no blit, no redraw', { options: { motion: 'off' } }, async ($, on) => {
  const w = world(on, freshAsk())
  const ui = await $.ui.mount(PANE({ covered: true }))
  expect((await textProps(ui, 'Needs you'))?.dimColor).toBeUndefined()
  const cells = await cellsOf(ui, 'asker')
  expect(GROUNDS.some(g => encode(critterBox('general', 'waiting', 'small', { ground: g })) === cells)).toBe(true)
  await w.clock.advance(2000)
  expect(w.blits).toHaveLength(0)
  expect(w.redraws).toHaveLength(0)
  await ui.unmount()
})

test('motion 4: an ask already old when the pane first draws it is shown full at once (no soft frame, no hop)', async ($, on) => {
  const w = world(on, asked())
  const ui = await $.ui.mount(PANE({ covered: true }))
  expect((await textProps(ui, 'Needs you'))?.dimColor).toBeUndefined()
  await w.clock.advance(2000)
  expect(blitsOf(w, 'asker')).toHaveLength(0)
  expect(w.redraws).toHaveLength(0)
  await ui.unmount()
})

// ---------- 1: a to-do lands ----------

function landTask(w: World): void {
  const t = timeline(w)
  const tasks = tasksOf(10).map(x => (x.id === '10' ? { ...x, updatedAt: w.clock.now() } : x))
  w.stored.set('timeline', { ...t, tasks })
}

test('motion 1: the landed segment flashes, settles and the next lights (3 x 160 ms blits of the bar); no redraw', async ($, on) => {
  const w = world(on, busy())
  const ui = await $.ui.mount(PANE())
  const before = await cellsOf(ui, 'todo-bar')
  expect(before).toBeDefined()
  landTask(w)
  await ui.redraw()
  const flash = await cellsOf(ui, 'todo-bar')
  expect(flash).not.toBe(before)
  for (const at of [160, 320, 480]) {
    await w.clock.advance(159)
    const n = blitsOf(w, 'todo-bar').length
    await w.clock.advance(1)
    expect(blitsOf(w, 'todo-bar').length).toBe(n + 1)
    expect(blitsOf(w, 'todo-bar').at(-1)!.at).toBe(at)
  }
  // The last blit is the end state: what a fresh draw mounts.
  const end = blitsOf(w, 'todo-bar').at(-1)!.cells
  await ui.redraw()
  expect(await cellsOf(ui, 'todo-bar')).toBe(end)
  await w.clock.advance(5000)
  expect(blitsOf(w, 'todo-bar')).toHaveLength(3)
  expect(w.redraws).toHaveLength(0)
  await ui.unmount()
})

test('motion 1, motion off: the bar jumps to the new state', { options: { motion: 'off' } }, async ($, on) => {
  const w = world(on, busy())
  const ui = await $.ui.mount(PANE())
  landTask(w)
  await ui.redraw()
  await w.clock.advance(1000)
  expect(w.blits).toHaveLength(0)
  await ui.unmount()
})

const countRun = async (ui: Mounted, n: string): Promise<Record<string, unknown> | undefined> => textProps(ui, n)

for (const look of ['rich', 'text'] as const) {
  test(`motion 1: in the band the new count is in the accent for one 1 s beat, then one redraw (${look} look)`, { options: { look } }, async ($, on) => {
    const w = world(on, busy())
    landTask(w)
    const ui = await $.ui.mount(BAND)
    expect(await countRun(ui, '10')).toMatchObject({ color: 'suggestion', bold: true })
    await w.clock.advance(999)
    expect(w.redraws).toHaveLength(0)
    await w.clock.advance(1)
    expect(w.redraws).toEqual([1000])
    await ui.redraw()
    expect((await countRun(ui, '10'))?.color).toBeUndefined()
    await w.clock.advance(5000)
    await ui.redraw()
    expect((await countRun(ui, '10'))?.color).toBeUndefined()
    expect(w.redraws).toHaveLength(1)
    // R24: the band's critter never moves.
    expect(w.blits).toHaveLength(0)
    await ui.unmount()
  })
}

test('motion 1, motion off: the band count stays ink, no redraw', { options: { motion: 'off' } }, async ($, on) => {
  const w = world(on, busy())
  landTask(w)
  const ui = await $.ui.mount(BAND)
  expect((await countRun(ui, '10'))?.color).toBeUndefined()
  await w.clock.advance(2000)
  expect(w.redraws).toHaveLength(0)
  await ui.unmount()
})

// ---------- 5: a step lands ----------

/** The Steps tab with the main turn open, so its rows show. */
const STEPS_UI: UiState = { ...initialUi, tab: 'timeline', openTurns: ['t1'] }

function addStep(w: World): void {
  const t = timeline(w)
  const s: Step = step('s-new', 200, 'main', 'Bash', 'Bash npm run lint', 'running', w.clock.now(), { turnId: 't1' })
  w.stored.set('timeline', { ...t, steps: [...t.steps, s] })
}

/** Whether the new step's row starts with the accent mark. */
const markOf = async (ui: Mounted): Promise<boolean> => {
  const rows = screen(await ui.drawn())
  const row = rows.find(r => r.includes('npm run lint'))
  return row?.startsWith('▍') === true
}

test('motion 5: the new Steps row carries an accent mark for one beat, and its map column grows in (2 x 120 ms blits)', async ($, on) => {
  const w = world(on, busy(), STEPS_UI)
  const ui = await $.ui.mount(PANE())
  expect(await markOf(ui)).toBe(false)
  const before = await cellsOf(ui, 'map')
  addStep(w)
  await ui.redraw()
  expect(await markOf(ui)).toBe(true)
  expect(await cellsOf(ui, 'map')).not.toBe(before)
  for (const at of [120, 240]) {
    await w.clock.advance(119)
    const n = blitsOf(w, 'map').length
    await w.clock.advance(1)
    expect(blitsOf(w, 'map').length).toBe(n + 1)
    expect(blitsOf(w, 'map').at(-1)!.at).toBe(at)
  }
  expect(w.redraws).toHaveLength(0)
  // The mark rides the 1 s redraw: the next draw past the beat has none.
  await w.clock.advance(800)
  await ui.redraw()
  expect(await markOf(ui)).toBe(false)
  expect(blitsOf(w, 'map')).toHaveLength(2)
  await ui.unmount()
})

test('motion 5, text look: the mark only', { options: { look: 'text' } }, async ($, on) => {
  const w = world(on, busy(), STEPS_UI)
  const ui = await $.ui.mount(PANE())
  addStep(w)
  await ui.redraw()
  expect(await markOf(ui)).toBe(true)
  await w.clock.advance(1000)
  expect(w.blits).toHaveLength(0)
  await ui.unmount()
})

test('motion 5, motion off: no mark, the column at full height', { options: { motion: 'off' } }, async ($, on) => {
  const w = world(on, busy(), STEPS_UI)
  const ui = await $.ui.mount(PANE())
  addStep(w)
  await ui.redraw()
  expect(await markOf(ui)).toBe(false)
  await w.clock.advance(1000)
  expect(w.blits).toHaveLength(0)
  await ui.unmount()
})

// ---------- 6: gauges fill on open ----------

/** The middle row's letters of a gauge pair's cells (the figures). */
function figures(cells: string): string {
  const raw = atob(cells)
  const out: string[] = []
  for (let i = 0; i < raw.length; i += 12) {
    const cp = raw.charCodeAt(i) | (raw.charCodeAt(i + 1) << 8)
    out.push(String.fromCharCode(cp))
  }
  return out.slice(20 * 2, 20 * 3).join('')
}

test('motion 6: the pane opening on Now fills the arcs from empty (5 x 80 ms blits); the figures are true from the first frame', { options: { header: 'full' } }, async ($, on) => {
  const w = world(on, busy())
  const ui = await $.ui.mount(PANE())
  const first = await cellsOf(ui, 'now-gauges')
  expect(first).toBeDefined()
  expect(figures(first!)).toContain('62%')
  for (let i = 1; i <= GAUGE_FILL.length; i++) {
    await w.clock.advance(GAUGE_FILL_MS - 1)
    const n = blitsOf(w, 'now-gauges').length
    await w.clock.advance(1)
    expect(blitsOf(w, 'now-gauges').length).toBe(n + 1)
    expect(blitsOf(w, 'now-gauges').at(-1)!.at).toBe(i * GAUGE_FILL_MS)
    expect(figures(blitsOf(w, 'now-gauges').at(-1)!.cells)).toContain('62%')
  }
  await w.clock.advance(5000)
  expect(blitsOf(w, 'now-gauges')).toHaveLength(GAUGE_FILL.length)
  // A second draw of the open pane does not fill again.
  await ui.redraw()
  await w.clock.advance(1000)
  expect(blitsOf(w, 'now-gauges')).toHaveLength(GAUGE_FILL.length)
  expect(w.redraws).toHaveLength(0)
  await ui.unmount()
})

test('motion 6: a gauge that jumps 10 points or more travels; a smaller move does not', { options: { header: 'full' } }, async ($, on) => {
  const w = world(on, busy())
  const ui = await $.ui.mount(PANE())
  await w.clock.advance(1000)
  const n = blitsOf(w, 'now-gauges').length
  const t = timeline(w)
  w.stored.set('timeline', { ...t, budget: { ...t.budget!, contextPct: 66, contextTokens: 660_000 } })
  await ui.redraw()
  await w.clock.advance(1000)
  expect(blitsOf(w, 'now-gauges')).toHaveLength(n)
  w.stored.set('timeline', { ...t, budget: { ...t.budget!, contextPct: 20, contextTokens: 200_000 } })
  await ui.redraw()
  const travel = await cellsOf(ui, 'now-gauges')
  await w.clock.advance(1000)
  // The travel blits on the fill's frames (a frame whose cells are the ones shown is not sent again), within 5 x 80 ms, ending on the value.
  const sent = blitsOf(w, 'now-gauges').slice(n)
  expect(sent.length).toBeGreaterThan(0)
  expect(sent.length).toBeLessThanOrEqual(GAUGE_FILL.length)
  expect(sent.every(b => b.at % GAUGE_FILL_MS === 0 && b.at <= 1000 + 2000 + GAUGE_FILL.length * GAUGE_FILL_MS)).toBe(true)
  await ui.redraw()
  const end = await cellsOf(ui, 'now-gauges')
  expect(sent.at(-1)!.cells).toBe(end)
  expect(travel).not.toBe(end)
  await ui.unmount()
})

test('motion 6, motion off: the arcs are drawn at their value at once', { options: { motion: 'off' } }, async ($, on) => {
  const w = world(on, busy())
  const ui = await $.ui.mount(PANE())
  await w.clock.advance(1000)
  expect(w.blits).toHaveLength(0)
  await ui.unmount()
})

// ---------- 9: failed (8, stalled, is the same path: motion.test.ts) ----------

test('motion 9: a card on Now whose agent fails flinches and dims (2 x 130 ms), then wears the red badge; once', async ($, on) => {
  const w = world(on, busy())
  const ui = await $.ui.mount(PANE())
  const t = timeline(w)
  w.stored.set('timeline', { ...t, agents: { ...t.agents, e1: { ...t.agents.e1!, status: 'error', endedAt: w.clock.now(), result: 'not found' } } })
  await ui.redraw()
  await playsMove(w, ui, 'agent-e1-who', 'scout', 'fail', 'failed', 0)
  await w.clock.advance(5000)
  expect(blitsOf(w, 'agent-e1-who')).toHaveLength(2)
  expect(w.redraws).toHaveLength(0)
  await ui.unmount()
})

// ---------- 10: all done ----------

test('motion 10: the lead squashes, hops and greys on the finish sweep\'s frames, riding its redraws (no blit, no timer of its own)', { timeoutMs: 30_000 }, async ($, on) => {
  const t = idle()
  const w = world(on, { ...t, turns: [{ id: 't1', agent: 'main', prompt: 'go', startedAt: NOW - 80 * 60_000, endedAt: NOW - 2000 }] }, { ...initialUi, paneOpen: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE())
  const seen: string[] = []
  const draw = async (): Promise<void> => {
    await ui.redraw()
    const c = await cellsOf(ui, 'now-who')
    if (c !== undefined && seen.at(-1) !== c) seen.push(c)
  }
  await draw()
  // The sweep starts on the next tick; sample in the middle of each of its frames.
  await w.clock.advance(1000 + SWEEP_STEP_MS / 2)
  await draw()
  for (let i = 1; i < SWEEP_FRAMES; i++) {
    await w.clock.advance(SWEEP_STEP_MS)
    await draw()
  }
  await w.clock.advance(SWEEP_STEP_MS)
  await draw()
  const g = groundOf(seen[0], x => encode(critterBox('lead', 'done', 'small', { ground: x })))
  const want = [critterBox('lead', 'done', 'small', { ground: g }), ...[0, 1, 2, 3, 4].map(f => critterPoseBox('lead', 'small', sweepPose(f), g)), critterBox('lead', 'done', 'small', { ground: g })].map(encode)
  // Consecutive equal frames collapse (frame 4 is the grey end state).
  expect(seen).toEqual(want.filter((c, i) => i === 0 || want[i - 1] !== c))
  expect(blitsOf(w, 'now-who')).toHaveLength(0)
  await ui.unmount()
})

// ---------- fix round 1: B-M1, B-M2, B-M5 ----------

/** The pane at a given body height (the cards that fit shrink with it). */
const PANE_AT = (rows: number, surface: 'terminal' | 'desktop' = 'terminal') =>
  ({
    plugin: 'binnacle', component: 'Pane', requestId: 'binnacle', surface,
    props: { title: 'Binnacle', isFocused: true, bodyColumns: 62, placement: 'dock', scroll: { offset: 0, bodyRows: rows }, view: {} },
  }) as const

const AGENTS_UI: UiState = { ...initialUi, tab: 'agents' }

test('B-M1: the Agents tab counts Working over the running agents only, while a finished card is held for its nod', async ($, on) => {
  const w = world(on, busy(), AGENTS_UI)
  const ui = await $.ui.mount(PANE())
  const head = async (): Promise<string> => screen(await ui.drawn()).find(r => /^\s*Working\b/.test(r)) ?? ''
  expect(await head()).toMatch(/\s2\s*$/)
  finishB1(w)
  await ui.redraw()
  // The finished card is still drawn (its nod), but it is not working.
  expect(await cellsOf(ui, 'agent-b1-who')).toBeDefined()
  expect(await head()).toMatch(/\s1\s*$/)
  await ui.unmount()
})

test('B-M1: on Now "+ k more working" counts running agents only, and a held card that is not drawn counts as finished', async ($, on) => {
  const w = world(on, busy())
  const ui = await $.ui.mount(PANE_AT(30))
  const t = timeline(w)
  const extra: Record<string, ReturnType<typeof agent>> = {}
  for (const id of ['r1', 'r2', 'r3', 'r4']) extra[id] = agent(id, 'Explore', `look at ${id}`, NOW - 400_000)
  w.stored.set('timeline', { ...t, agents: { ...t.agents, ...extra, b1: { ...t.agents.b1!, status: 'done', endedAt: w.clock.now() } } })
  await ui.redraw()
  const rows = screen(await ui.drawn())
  const drawn = (await ui.findAll({ type: 'Raster' })).map(r => r.key ?? '').filter(k => /^agent-.*-who$/.test(k))
  expect(drawn.length).toBeGreaterThan(0)
  expect(drawn.length).toBeLessThan(5)
  // Running agents: e1, r1..r4 (b1 has finished). Those not drawn are the "more".
  const runningDrawn = drawn.filter(k => k !== 'agent-b1-who').length
  const more = rows.map(r => /\+ (\d+) more working/.exec(r)).find(m => m !== null)
  expect(Number(more?.[1])).toBe(5 - runningDrawn)
  // b1 either is drawn (held, so not counted finished) or is not drawn and counts as finished at once.
  const b1Drawn = drawn.includes('agent-b1-who')
  expect(rows.some(r => r.includes(`${b1Drawn ? 31 : 32} finished earlier`))).toBe(true)
  await ui.unmount()
})

// B-M2: the hidden draw behind a tab switch is dry.
test('B-M2: a tab press mid-burst leaves the running burst alone', async ($, on) => {
  const w = world(on, busy())
  const ui = await $.ui.mount(PANE())
  finishB1(w)
  await ui.redraw()
  await w.clock.advance(100)
  await ui.press({ key: 'tab-overview' })
  // The nod still plays on its own times, and the fold still comes.
  await w.clock.advance(60)
  expect(blitsOf(w, 'agent-b1-who').map(b => b.at)).toEqual([150])
  await w.clock.advance(5000)
  expect(blitsOf(w, 'agent-b1-who').map(b => b.at)).toEqual([150, 300])
  expect(w.redraws).toEqual([1000])
  await ui.unmount()
})

test('B-M2: a change that landed before a tab press still plays when the pane is drawn again', async ($, on) => {
  const w = world(on, busy())
  const ui = await $.ui.mount(PANE())
  finishB1(w)
  await ui.press({ key: 'tab-overview' })
  await ui.redraw()
  await playsMove(w, ui, 'agent-b1-who', 'general', 'settle', 'done', 0)
  await ui.unmount()
})

// The case B-M2 actually broke: a tagged instrument (the to-do bar) whose new tag the hidden draw used to record.
test('B-M2: a to-do that landed before a tab press still flashes the bar when the pane is drawn again', async ($, on) => {
  const w = world(on, busy())
  const ui = await $.ui.mount(PANE())
  const before = await cellsOf(ui, 'todo-bar')
  landTask(w)
  await ui.press({ key: 'tab-overview' })
  await ui.redraw()
  expect(await cellsOf(ui, 'todo-bar')).not.toBe(before)
  await w.clock.advance(5000)
  expect(blitsOf(w, 'todo-bar').map(b => b.at)).toEqual([160, 320, 480])
  await ui.unmount()
})

// B-M7: when the lead asks, the Needs-you asker glances and hops; the header's lead holds still.
function leadAsks(w: World): void {
  const t = timeline(w)
  const s = step('s-main-ask', 102, 'main', 'Bash', 'Bash npm run deploy', 'running', w.clock.now() - 100, {
    turnId: 't1', asking: w.clock.now() - 100, pending: { command: 'npm run deploy' },
  })
  w.stored.set('timeline', { ...t, steps: [...t.steps, s] })
}

test('B-M7: the lead asking moves the asker only; the header lead does not play the ask', async ($, on) => {
  const w = world(on, busy())
  const ui = await $.ui.mount(PANE({ covered: true }))
  leadAsks(w)
  await ui.redraw()
  expect(screen(await ui.drawn()).some(r => r.includes('Needs you'))).toBe(true)
  await w.clock.advance(3000)
  expect(blitsOf(w, 'asker').length).toBeGreaterThan(0)
  expect(blitsOf(w, 'now-who')).toHaveLength(0)
  await ui.unmount()
})

// ---------- 8: stalled, through a real view ----------

/** b1 has no step running and has been quiet longer than the limit: the Now card dozes. */
function quietB1(w: World): void {
  const t = timeline(w)
  w.stored.set('timeline', {
    ...t,
    agents: { ...t.agents, b1: { ...t.agents.b1!, startedAt: NOW - 700_000 } },
    steps: t.steps.filter(s => s.agent !== 'b1'),
  })
}

test('motion 8: a card whose agent goes quiet shuts its eyes, sinks and dims (2 x 300 ms), then sits dim with its z; once', async ($, on) => {
  const w = world(on, busy())
  const ui = await $.ui.mount(PANE())
  quietB1(w)
  await ui.redraw()
  await playsMove(w, ui, 'agent-b1-who', 'general', 'stall', 'stalled', 0)
  await w.clock.advance(5000)
  expect(blitsOf(w, 'agent-b1-who')).toHaveLength(2)
  expect(w.redraws).toHaveLength(0)
  await ui.unmount()
})

test('motion 8, motion off: the stalled card is drawn dim with its z at once, nothing blitted', { options: { motion: 'off' } }, async ($, on) => {
  const w = world(on, busy())
  const ui = await $.ui.mount(PANE())
  quietB1(w)
  await ui.redraw()
  const cells = await cellsOf(ui, 'agent-b1-who')
  expect(GROUNDS.some(g => encode(critterBox('general', 'stalled', 'small', { ground: g })) === cells)).toBe(true)
  await w.clock.advance(2000)
  expect(w.blits).toHaveLength(0)
  await ui.unmount()
})

test('motion 8, text look: no Raster, no blit', { options: { look: 'text' } }, async ($, on) => {
  const w = world(on, busy())
  const ui = await $.ui.mount(PANE())
  quietB1(w)
  await ui.redraw()
  expect(await cellsOf(ui, 'agent-b1-who')).toBeUndefined()
  await w.clock.advance(2000)
  expect(w.blits).toHaveLength(0)
  await ui.unmount()
})

// ---------- 9, 6, 10: motion off and the text look show the end state ----------

function failE1(w: World): void {
  const t = timeline(w)
  w.stored.set('timeline', { ...t, agents: { ...t.agents, e1: { ...t.agents.e1!, status: 'error', endedAt: w.clock.now(), result: 'not found' } } })
}

test('motion 9, motion off: the failed card is drawn failed at once, nothing blitted', { options: { motion: 'off' } }, async ($, on) => {
  const w = world(on, busy())
  const ui = await $.ui.mount(PANE())
  failE1(w)
  await ui.redraw()
  const cells = await cellsOf(ui, 'agent-e1-who')
  expect(GROUNDS.some(g => encode(critterBox('scout', 'failed', 'small', { ground: g })) === cells)).toBe(true)
  await w.clock.advance(2000)
  expect(w.blits).toHaveLength(0)
  await ui.unmount()
})

test('motion 9, text look: no Raster, no blit', { options: { look: 'text' } }, async ($, on) => {
  const w = world(on, busy())
  const ui = await $.ui.mount(PANE())
  failE1(w)
  await ui.redraw()
  expect(await cellsOf(ui, 'agent-e1-who')).toBeUndefined()
  await w.clock.advance(2000)
  expect(w.blits).toHaveLength(0)
  await ui.unmount()
})

test('motion 6, text look: no gauge Raster, nothing blitted', { options: { look: 'text' } }, async ($, on) => {
  const w = world(on, busy())
  const ui = await $.ui.mount(PANE())
  expect(await cellsOf(ui, 'now-gauges')).toBeUndefined()
  await w.clock.advance(2000)
  expect(w.blits).toHaveLength(0)
  await ui.unmount()
})

/** A finished turn that ended 2 s ago, the pane open (the finish sweep starts on the next tick). */
function sweepWorld(on: On, t: Timeline): World {
  return world(on, { ...t, turns: [{ id: 't1', agent: 'main', prompt: 'go', startedAt: NOW - 80 * 60_000, endedAt: NOW - 2000 }] }, { ...initialUi, paneOpen: true })
}

/** The cells of the lead over the sweep window: each distinct one, in order. */
async function leadOverSweep(w: World, ui: Mounted): Promise<string[]> {
  const seen: string[] = []
  const draw = async (): Promise<void> => {
    await ui.redraw()
    const c = await cellsOf(ui, 'now-who')
    if (c !== undefined && seen.at(-1) !== c) seen.push(c)
  }
  await draw()
  await w.clock.advance(1000 + SWEEP_STEP_MS / 2)
  await draw()
  for (let i = 1; i < SWEEP_FRAMES; i++) {
    await w.clock.advance(SWEEP_STEP_MS)
    await draw()
  }
  await w.clock.advance(SWEEP_STEP_MS)
  await draw()
  return seen
}

test('motion 10, motion off: the lead is at rest, grey, at once and never moves', { options: { motion: 'off' }, timeoutMs: 30_000 }, async ($, on) => {
  const w = sweepWorld(on, idle())
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE())
  const seen = await leadOverSweep(w, ui)
  expect(seen).toHaveLength(1)
  expect(GROUNDS.some(g => encode(critterBox('lead', 'done', 'small', { ground: g })) === seen[0])).toBe(true)
  await ui.unmount()
})

test('motion 10, text look: no Raster for the lead, nothing blitted', { options: { look: 'text' }, timeoutMs: 30_000 }, async ($, on) => {
  const w = sweepWorld(on, idle())
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE())
  const seen = await leadOverSweep(w, ui)
  expect(seen).toHaveLength(0)
  expect(w.blits).toHaveLength(0)
  await ui.unmount()
})

test('motion 10: while Needs you has rows the lead stays still: the sweep does not play', { timeoutMs: 30_000 }, async ($, on) => {
  // Every to-do done and the turn just ended (so the sweep would start), with a subagent asking to run a command.
  const a = asked()
  const i = idle()
  const w = sweepWorld(on, { ...i, agents: { ...i.agents, b1: a.agents.b1! }, steps: [...i.steps, a.steps[2]!] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE({ covered: true }))
  expect(screen(await ui.drawn()).some(r => r.includes('Needs you'))).toBe(true)
  const seen = await leadOverSweep(w, ui)
  // The lead never takes a sweep pose: no squash, hop or half-grey frame.
  const sweep = GROUNDS.flatMap(g => [0, 1, 3].map(k => encode(critterPoseBox('lead', 'small', sweepPose(k), g))))
  expect(seen.length).toBeGreaterThan(0)
  for (const c of seen) expect(sweep).not.toContain(c)
  await ui.unmount()
})

// ---------- the desktop app: still, end states only ----------

test('the desktop Svg plays no move: a finish folds at once, a stall and a failure blit nothing', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on, busy())
  const ui = await $.ui.mount(PANE_AT(46, 'desktop'))
  expect(screen(await ui.drawn()).some(r => r.includes('31 finished earlier'))).toBe(true)
  finishB1(w)
  await ui.redraw()
  expect(screen(await ui.drawn()).some(r => r.includes('32 finished earlier'))).toBe(true)
  quietB1(w)
  await ui.redraw()
  failE1(w)
  await ui.redraw()
  await w.clock.advance(3000)
  expect(w.blits).toHaveLength(0)
  expect(w.redraws).toHaveLength(0)
  await ui.unmount()
})
