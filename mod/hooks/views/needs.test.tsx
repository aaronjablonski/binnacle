import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Step, Timeline, TurnRow, UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { resetCover } from './needs'
import { screen } from './screen.testkit'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const BAND_SURFACES = ['terminal', 'desktop', 'mobile'] as const
const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }

type Stored = Map<string, unknown>
/** How often the plugin read the Timeline: the clock's tick reads it every period, so a stopped clock reads nothing (M10). */
let timelineReads = 0

function world(on: On, t: Timeline, u?: UiState): { stored: Stored; clock: MockClock } {
  // M12: what the pane saw of the prompt is module state; each world starts with none.
  resetCover()
  const stored: Stored = new Map()
  stored.set('timeline', t)
  if (u) stored.set('ui', u)
  const versions = new Map<string, number>()
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, {})
  on('ui.log', () => ({ value: undefined }))
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    if (key === 'timeline') timelineReads += 1
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
    plugin: 'binnacle',
    component: 'Pane',
    requestId: 'binnacle',
    props: {
      title: 'Binnacle',
      isFocused: false,
      bodyColumns: columns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

const BAND = (columns: number) =>
  ({
    plugin: 'binnacle',
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

// LOOK TEST (rewritten for the cockpit band, C6): the band has no pill and no "n need you" count in a row of its own; at 80 columns it is two rows led by the amber "Needs you", narrower one row led by "▲ n needs you"; it still fits 24 columns.
// C-1 (meaning changed): asked outside auto mode, where an ask shows at once; an uncovered auto ask is only checked.
test('the band leads with "Needs you" in bold warning and the ask, and still fits at 24 columns', async ($, on) => {
  const { autoAsk: _auto, ...manual } = asked(30)
  world(on, {
    ...manual,
    tasks: [{ id: '1', subject: 'x', status: 'in_progress', owner: 'main', updatedAt: NOW }],
    agents: { main, a1: sub('a1') },
  })
  // The desktop draws the band as an Svg, which has no Text rows.
  for (const surface of BAND_SURFACES.filter(x => x !== 'desktop')) {
    const ui = await $.ui.mount({ ...BAND(80), surface })
    const found = await ui.findAll({ type: 'Text' })
    expect(found.find(f => f.text === 'Needs you')?.props).toMatchObject({ bold: true, color: 'warning' })
    expect(found.some(f => (f.text ?? '').includes('WAITING'))).toBe(false)
    await ui.unmount()
    const narrow = await $.ui.mount({ ...BAND(24), surface })
    const small = (await narrow.findAll({ type: 'Text' })).map(f => f.text ?? '').find(t => t.includes('▲')) ?? ''
    expect(small.length <= 24).toBe(true)
    expect(small).toContain('▲')
    await narrow.unmount()
  }
})

// A clock-driven world: the session has started, the ticker runs.
async function ticking($: Engine, on: On, t: Timeline, u?: UiState, onInvalidate?: () => void): Promise<{ stored: Stored; clock: MockClock; notes: string[]; toasts: string[] }> {
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
  on('ui.invalidate', () => {
    onInvalidate?.()
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: false as const, reason: 'narrow' } }))
  on('command.register', () => ({ value: { command: 'binnacle' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  return { stored, clock, notes, toasts }
}

/** What `follow` needs of a mounted pane. */
type Redrawable = { redraw(): Promise<void> }
/** The terminal pane with or without a dialog over the prompt. */
const TERMINAL_PANE = (covered: boolean) => ({
  ...PANE(62),
  props: { ...PANE(62).props, ...(covered ? { isPromptCovered: true as const } : {}) },
  surface: 'terminal' as const,
})
/** Runs the clock `ms` on, the pane drawn again every 4 s (inside the 5 s it counts as watching; the engine draws it on each tick's invalidate, which this world answers itself). */
async function follow(ui: Redrawable, clock: MockClock, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 4000) {
    await clock.advance(Math.min(4000, left))
    await ui.redraw()
  }
}

// Ruled (I1): a Bash ask is a row from 20 s but notifies only from 60 s,
// as Claude Code raises its own notification for a real dialog.
// F C1: a permission notifies only while the pane watches the prompt (here it
// still shows the dialog over it); with no pane, the next test.
test('a Bash wait the pane still sees notifies once at 60 s, not at 20 s, and records the step id', async ($, on) => {
  const { stored, clock, notes } = await ticking($, on, asked(5))
  const ui = await $.ui.mount(TERMINAL_PANE(true))
  await ui.drawn()
  await follow(ui, clock, 20_000)
  expect(notes).toEqual([])
  await follow(ui, clock, 30_000)
  expect(notes).toEqual([])
  await follow(ui, clock, 10_000)
  expect(notes).toEqual(['Waiting on you: Bash rm -rf build'])
  await follow(ui, clock, 30_000)
  expect(notes.length).toBe(1)
  expect((stored.get('ui') as UiState).notified).toEqual(['s1'])
  await ui.unmount()
})

test('F C1: with no pane, a Bash ask never notifies (nothing can tell it was answered)', async ($, on) => {
  const { clock, notes } = await ticking($, on, asked(5))
  await clock.advance(120_000)
  expect(notes).toEqual([])
})

// F C1: the person answers the dialog and the command runs on for minutes.
test('F C1: an ask the pane saw covered and then uncovered is answered: the step runs on, Needs you and the band clear, no notification', async ($, on) => {
  const deploy: Timeline = {
    ...empty,
    seq: 1,
    turns: [{ id: 't1', agent: 'main', prompt: 'deploy', startedAt: NOW - 10_000 } as TurnRow],
    steps: [step('s1', 'Bash npm run deploy -- --env staging', { startedAt: NOW - 3000, asking: NOW - 2000 })],
    agents: { main },
  }
  const { stored, clock, notes } = await ticking($, on, deploy)
  const ui = await $.ui.mount(TERMINAL_PANE(true))
  expect((await texts(ui)).join('\n')).toContain('Needs you')
  await follow(ui, clock, 2000)
  expect((stored.get('timeline') as Timeline).steps[0]!.asking).toBe(NOW - 2000)
  // The person presses Yes: the dialog closes and the engine draws the pane with its next props.
  await ui.redraw(TERMINAL_PANE(false).props)
  await follow(ui, clock, 2000)
  const s1 = (stored.get('timeline') as Timeline).steps[0]!
  expect([s1.status, s1.asking]).toEqual(['running', undefined])
  const shown = (await texts(ui)).join('\n')
  expect(shown).not.toContain('Needs you')
  expect(shown).not.toContain('WAITING FOR YOU')
  const band = await $.ui.mount({ ...BAND(104), surface: 'terminal' })
  const words = (await texts(band)).join('\n')
  expect(words).not.toContain('Needs you')
  expect(words).not.toContain('answer below')
  await band.unmount()
  // The command runs on for three minutes: nothing is raised.
  await follow(ui, clock, 180_000)
  expect(notes).toEqual([])
  expect((stored.get('timeline') as Timeline).steps[0]!.status).toBe('running')
  await ui.unmount()
})

test('F C1: an ask answered while the Tasks tab is open clears too: every tab notes what the pane saw', async ($, on) => {
  const deploy: Timeline = {
    ...empty,
    seq: 1,
    turns: [{ id: 't1', agent: 'main', prompt: 'deploy', startedAt: NOW - 10_000 } as TurnRow],
    steps: [step('s1', 'Bash npm run deploy -- --env staging', { startedAt: NOW - 3000, asking: NOW - 2000 })],
    agents: { main },
  }
  const { stored, clock, notes } = await ticking($, on, deploy, { ...initialUi, tab: 'tasks' })
  const ui = await $.ui.mount(TERMINAL_PANE(true))
  await follow(ui, clock, 2000)
  expect((stored.get('timeline') as Timeline).steps[0]!.asking).toBe(NOW - 2000)
  await ui.redraw(TERMINAL_PANE(false).props)
  await follow(ui, clock, 2000)
  const s1 = (stored.get('timeline') as Timeline).steps[0]!
  expect([s1.status, s1.asking]).toEqual(['running', undefined])
  await follow(ui, clock, 180_000)
  expect(notes).toEqual([])
  await ui.unmount()
})

test('F C1: a pane that never saw the dialog clears nothing', async ($, on) => {
  const { stored, clock } = await ticking($, on, asked(30))
  const ui = await $.ui.mount(TERMINAL_PANE(false))
  await follow(ui, clock, 3000)
  expect((stored.get('timeline') as Timeline).steps[0]!.asking).toBe(NOW - 30_000)
  await ui.unmount()
})

test('F C1: another surface drawing the pane with no dialog prop does not read as the dialog closing', async ($, on) => {
  const { stored, clock } = await ticking($, on, asked(30))
  const ui = await $.ui.mount(TERMINAL_PANE(true))
  await follow(ui, clock, 2000)
  const desk = await $.ui.mount({ ...PANE(62), surface: 'desktop' })
  await desk.drawn()
  await follow(ui, clock, 2000)
  expect((stored.get('timeline') as Timeline).steps[0]!.asking).toBe(NOW - 30_000)
  await desk.unmount()
  await ui.unmount()
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
  // M4 (R23): the toast names the agent's type in friendly case.
  expect(toasts).toEqual(['Explorer finished: Grep upload'])
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
  expect(toasts).toEqual(['Workflow subagent finished: verdict: ok · files: 3'])
})


// ---------- F I2: no green tick under a stopped turn or a request left open ----------

test('F I2: under STOPPED the needs slot draws no tick and a plain "Stopped. Send a prompt to carry on"; ended with tasks open, a dim "2 to do still open"', async ($, on) => {
  const failed: Timeline = {
    ...empty,
    turns: [{ id: 't1', agent: 'main', prompt: 'build it', startedAt: NOW - 60_000, endedAt: NOW - 30_000, failed: true } as TurnRow],
    failure: { turnId: 't1', reason: 'The API was overloaded (529)' },
    agents: { main },
  }
  const { stored } = world(on, failed)
  const ui = await $.ui.mount({ ...PANE(62), surface: 'terminal' })
  const rows = (await texts(ui)).join('\n')
  expect(rows).toContain('STOPPED')
  expect(rows).toContain('Stopped. Send a prompt to carry on')
  expect(rows).not.toContain('✓')
  expect(rows).not.toContain('Nothing needs you')
  await ui.unmount()

  const tasks = [
    { id: '1', subject: 'one', status: 'completed' as const, owner: 'main', updatedAt: NOW - 50_000 },
    { id: '2', subject: 'two', status: 'pending' as const, owner: 'main', updatedAt: NOW - 50_000 },
    { id: '3', subject: 'three', status: 'pending' as const, owner: 'main', updatedAt: NOW - 50_000 },
  ]
  stored.set('timeline', { ...empty, turns: [{ id: 't2', agent: 'main', prompt: 'go', startedAt: NOW - 60_000, endedAt: NOW - 30_000 } as TurnRow], tasks, agents: { main } })
  const open = await $.ui.mount({ ...PANE(62), surface: 'terminal' })
  const found = await open.findAll({ type: 'Text' })
  const line = found.find(f => (f.text ?? '').includes('2 to do still open'))
  expect(line).toBeDefined()
  expect((await texts(open)).join('\n')).not.toContain('✓ Nothing needs you')
  await open.unmount()
})

// ---------- F I1: in auto mode's checking gap the band agrees with the pane ----------

test('F I1: an auto-mode ask 5 s old: the band says "Checking a permission", never "nothing needs you"', async ($, on) => {
  const t: Timeline = { ...asked(5), turns: [{ id: 't1', agent: 'main', prompt: 'go', startedAt: NOW - 90_000 } as TurnRow] }
  world(on, t)
  const band = await $.ui.mount({ ...BAND(104), surface: 'terminal' })
  const words = (await texts(band)).join('\n')
  expect(words).toContain('Checking a permission')
  expect(words).not.toContain('nothing needs you')
  expect(words).not.toContain('Needs you')
  await band.unmount()
})

// FX3 M-3: the band has no isPromptCovered of its own; it reads what the pane's last drawing saw. An ask the pane shows as Needs you at once (a dialog holds the prompt, R2) is never "Checking a permission" in the band.
test('M-3: with a dialog holding the prompt the pane shows Needs you and the band agrees, not "Checking a permission"', async ($, on) => {
  const t: Timeline = { ...asked(5), turns: [{ id: 't1', agent: 'main', prompt: 'go', startedAt: NOW - 90_000 } as TurnRow] }
  world(on, t)
  // the pane draws covered: its ask shows at once
  const pane = await $.ui.mount({ ...PANE(62), props: { ...PANE(62).props, isPromptCovered: true as const }, surface: 'terminal' })
  expect((await texts(pane)).join(String.fromCharCode(10))).toContain('Needs you')
  const band = await $.ui.mount({ ...BAND(104), surface: 'terminal' })
  const words = (await texts(band)).join(String.fromCharCode(10))
  expect(words).toContain('Needs you')
  expect(words).not.toContain('Checking a permission')
  await band.unmount()
  // the dialog closes: the pane draws uncovered, and the band is back to the classifier's gap
  await pane.unmount()
  const open = await $.ui.mount({ ...PANE(62), surface: 'terminal' })
  await open.unmount()
  const again = await $.ui.mount({ ...BAND(104), surface: 'terminal' })
  expect((await texts(again)).join(String.fromCharCode(10))).toContain('Checking a permission')
  await again.unmount()
})

// ---------- O I-3: the band's cache words stay true with the pane closed ----------

test('O I-3: idle with the pane closed, the clock redraws when the warm cache words change their minute', async ($, on) => {
  const idleT: Timeline = {
    ...empty,
    turns: [{ id: 't1', agent: 'main', prompt: 'go', startedAt: NOW - 90_000, endedAt: NOW - 30_000 } as TurnRow],
    agents: { main },
    cache: { at: NOW - 30_000 },
  }
  let redraws = 0
  const { stored, clock } = await ticking($, on, idleT, undefined, () => {
    redraws += 1
  })
  expect((stored.get('ui') as UiState | undefined)?.paneOpen ?? false).toBe(false)
  // Warm for 270 s: the words read "4 min" until 240 s are left, 30 s from now.
  await clock.advance(1000)
  const first = redraws
  for (let s = 2; s <= 29; s++) await clock.advance(1000)
  const within = redraws - first
  for (let s = 30; s <= 32; s++) await clock.advance(1000)
  expect(within).toBe(0)
  expect(redraws - first).toBe(1)
})

// ---------- F I10 / R41: a long step with nothing to measure against ----------

test('R41: a 6-minute npm run build with no earlier run is a Long step on Watch, not Stalled', async ($, on) => {
  const t: Timeline = {
    ...empty,
    seq: 2,
    turns: [{ id: 't1', agent: 'main', prompt: 'build', startedAt: NOW - 7 * 60_000 } as TurnRow],
    steps: [
      step('s1', 'Bash ls', { status: 'done', startedAt: NOW - 7 * 60_000, endedAt: NOW - 7 * 60_000 + 500 }),
      step('s2', 'Bash npm run build', { startedAt: NOW - 6 * 60_000 }),
    ],
    agents: { main },
  }
  world(on, t)
  const ui = await $.ui.mount({ ...PANE(62), surface: 'terminal' })
  const rows = (await texts(ui)).join('\n')
  expect(rows).toContain('Long step')
  expect(rows).toContain('npm run build has run 6 min')
  expect(rows).not.toContain('Stalled')
  await ui.unmount()
})

// ---------- Now's agent card and header (F I1, F M11 / R30, F M12a) ----------

const askedSub = (seconds: number, auto: boolean): Timeline => ({
  ...empty,
  ...(auto ? { autoAsk: true } : {}),
  seq: 1,
  turns: [{ id: 't1', agent: 'main', prompt: 'go', startedAt: NOW - 5 * 60_000 } as TurnRow],
  steps: [step('s1', 'Bash npm run deploy', { agent: 'a1', startedAt: NOW - 90_000, asking: NOW - seconds * 1000 })],
  agents: { main, a1: sub('a1', { type: 'general-purpose', description: 'deploy to staging', startedAt: NOW - 120_000 }) },
})

test('F I1: in the checking gap the card says "Checking a permission", as the needs slot does; never "Waiting for your answer"', async ($, on) => {
  world(on, askedSub(5, true))
  const ui = await $.ui.mount({ ...PANE(62), surface: 'terminal' })
  const rows = (await texts(ui)).join('\n')
  expect(rows).toContain('Checking a permission')
  expect(rows).not.toContain('Waiting for your answer')
  expect(rows).not.toContain('Needs you')
  await ui.unmount()
})

test('F M11 / R30: the wait shows in the pill and the block, not on the card, which keeps the agent\'s own time', async ($, on) => {
  world(on, askedSub(40, false))
  const ui = await $.ui.mount({ ...PANE(62), surface: 'terminal' })
  const found = await ui.findAll({ type: 'Text' })
  const all = found.map(f => f.text ?? '')
  expect(all.some(x => x.includes('asked 40s ago'))).toBe(true)
  expect(all.some(x => x.includes('Waiting for your answer'))).toBe(true)
  // The pill's meta and the block say 40s; the card says 2 min, its agent's own time.
  expect(all.filter(x => x.trim() === '40s').length).toBe(1)
  expect(all.some(x => x.trim() === '2 min')).toBe(true)
  await ui.unmount()
})

test('F M12a: a request that ended with tasks open says "stopped 2 min ago" in the header, not "finished"', async ($, on) => {
  const tasks = [
    { id: '1', subject: 'one', status: 'completed' as const, owner: 'main', updatedAt: NOW - 200_000 },
    { id: '2', subject: 'two', status: 'pending' as const, owner: 'main', updatedAt: NOW - 200_000 },
  ]
  world(on, { ...empty, turns: [{ id: 't1', agent: 'main', prompt: 'go', startedAt: NOW - 300_000, endedAt: NOW - 120_000 } as TurnRow], tasks, agents: { main } })
  const ui = await $.ui.mount({ ...PANE(62), surface: 'terminal' })
  const rows = (await texts(ui)).join('\n')
  expect(rows).toContain('stopped 2 min ago')
  expect(rows).not.toContain('finished 2 min ago')
  expect(rows).toContain('Stopped with 1 to do open')
  await ui.unmount()
})

// ---------- C-1 / I-1: an ask nothing waits on never reads as "Needs you" ----------

const running = (asking: number, auto: boolean, label = 'Bash npm test'): Timeline => ({
  ...empty,
  ...(auto ? { autoAsk: true as const } : {}),
  seq: 1,
  turns: [{ id: 't1', agent: 'main', prompt: 'test it', startedAt: NOW - 10_000 } as TurnRow],
  steps: [step('s1', label, { startedAt: NOW - 3000, asking })],
  agents: { main },
})

test('C-1: auto mode, the classifier allowed the call: the pane watched 25 s uncovered, the step still runs; no need, no notification, the band is not amber', async ($, on) => {
  const { stored, clock, notes } = await ticking($, on, running(NOW - 2000, true))
  const ui = await $.ui.mount(TERMINAL_PANE(false))
  expect((await texts(ui)).join('\n')).toContain('Checking a permission')
  await follow(ui, clock, 25_000)
  const s1 = (stored.get('timeline') as Timeline).steps[0]!
  expect([s1.status, s1.asking]).toEqual(['running', undefined])
  const shown = (await texts(ui)).join('\n')
  expect(shown).not.toContain('Needs you')
  expect(shown).not.toContain('WAITING FOR YOU')
  expect(shown).not.toContain('Checking a permission')
  const band = await $.ui.mount({ ...BAND(104), surface: 'terminal' })
  const drawn = await band.drawn()
  expect(JSON.stringify(drawn)).not.toContain('"warning"')
  expect((await texts(band)).join('\n')).not.toContain('Needs you')
  await band.unmount()
  await follow(ui, clock, 60_000)
  expect(notes).toEqual([])
  await ui.unmount()
})

test('C-1: auto mode with no pane: the ask is only "Checking a permission", never amber, never notified', async ($, on) => {
  const { clock, notes } = await ticking($, on, running(NOW - 2000, true))
  await clock.advance(30_000)
  const band = await $.ui.mount({ ...BAND(104), surface: 'terminal' })
  const words = (await texts(band)).join('\n')
  expect(words).not.toContain('Needs you')
  expect(JSON.stringify(await band.drawn())).not.toContain('"warning"')
  await band.unmount()
  await clock.advance(120_000)
  expect(notes).toEqual([])
})

test('I-1: pane closed, the person answered the ask: after its first minute the band clears to a dim "asked to run a command · running"', async ($, on) => {
  const { clock } = await ticking($, on, running(NOW - 5000, false, 'Bash cargo build'))
  const early = await $.ui.mount({ ...BAND(104), surface: 'terminal' })
  expect((await texts(early)).join('\n')).toContain('Needs you')
  await early.unmount()
  await clock.advance(60_000)
  const band = await $.ui.mount({ ...BAND(104), surface: 'terminal' })
  const words = (await texts(band)).join('\n')
  expect(words).not.toContain('Needs you')
  expect(words).not.toContain('waiting')
  expect(words).toContain('asked to run a command · running')
  expect(JSON.stringify(await band.drawn())).not.toContain('"warning"')
  await band.unmount()
})

test('C-1: a real dialog in auto mode still shows at once on the pane and in the band, and notifies at a minute', async ($, on) => {
  const { clock, notes } = await ticking($, on, running(NOW - 1000, true))
  const ui = await $.ui.mount(TERMINAL_PANE(true))
  expect((await texts(ui)).join('\n')).toContain('Needs you')
  const band = await $.ui.mount({ ...BAND(104), surface: 'terminal' })
  expect((await texts(band)).join('\n')).toContain('Needs you')
  await band.unmount()
  await follow(ui, clock, 58_000)
  expect(notes).toEqual([])
  await follow(ui, clock, 4000)
  expect(notes).toEqual(['Waiting on you: Bash npm test'])
  await ui.unmount()
})

test('M2: a cover open before the ask (a search) is not its dialog: closing it clears nothing; the real dialog that follows is still a need', async ($, on) => {
  const { stored, clock } = await ticking($, on, running(NOW - 30_000, false))
  // The search opened before the ask came: the covered run began before `asking`.
  const t0 = { ...running(NOW - 30_000, false), steps: [] }
  stored.set('timeline', t0)
  const ui = await $.ui.mount(TERMINAL_PANE(true))
  await ui.drawn()
  await clock.advance(1000)
  stored.set('timeline', running(NOW + 1000, false))
  await ui.redraw()
  await ui.redraw(TERMINAL_PANE(false).props)
  await clock.advance(1000)
  expect((stored.get('timeline') as Timeline).steps[0]!.asking).toBe(NOW + 1000)
  // The dialog now covers the prompt: it is a need at once.
  await ui.redraw(TERMINAL_PANE(true).props)
  expect((await texts(ui)).join('\n')).toContain('Needs you')
  await ui.unmount()
})

// ---------- M10: the one clock stops when nothing is live ----------

test('M10: the 1 s clock stops once nothing runs, nothing is fresh and the cache is cold; a new step starts it again', async ($, on) => {
  const idle: Timeline = {
    ...empty,
    turns: [{ id: 't1', agent: 'main', prompt: 'go', startedAt: NOW - 90_000, endedAt: NOW - 60_000 } as TurnRow],
    agents: { main },
  }
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  const { stored, clock } = await ticking($, on, idle)
  await clock.advance(3000)
  // Stopped: five more seconds read nothing.
  let before = timelineReads
  await clock.advance(5000)
  expect(timelineReads).toBe(before)
  // A step's call: the capture hook writes it, which starts the clock; its ticks read the Timeline again.
  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'toolu_w' } as never)
  expect((stored.get('timeline') as Timeline).steps.some(x => x.id === 'toolu_w')).toBe(true)
  before = timelineReads
  await clock.advance(3000)
  expect(timelineReads).toBeGreaterThan(before)
  // Nothing live again: it stops.
  await clock.advance(25_000)
  before = timelineReads
  await clock.advance(5000)
  expect(timelineReads).toBe(before)
})


// ---------- R3-A ----------

// I1: the desktop and VS Code panes are not the watcher (the type file speaks of `isPromptCovered` in
// terms of the terminal's keys): with no terminal pane they follow the band's no-pane rule.
for (const surface of ['desktop', 'vscode'] as const) {
  test(`I1: a ${surface} pane shows a permission as Needs you for its first minute, then a dim "asked to run a command · running", never the tick`, async ($, on) => {
    const { clock } = await ticking($, on, running(NOW - 5000, false, 'Bash npm run deploy'))
    const pane = { ...PANE(62), surface }
    const early = await $.ui.mount(pane)
    expect((await texts(early)).join('\n')).toContain('Needs you')
    await early.unmount()
    await clock.advance(60_000)
    const later = await $.ui.mount(pane)
    const words = (await texts(later)).join('\n')
    expect(words).not.toContain('Needs you')
    expect(words).not.toContain('Nothing needs you')
    expect(words).toContain('asked to run a command · running')
    await later.unmount()
  })
}

test('I1: the terminal pane is still the watcher: an uncovered permission past a minute stays Needs you until the clock sees it settled', async ($, on) => {
  await ticking($, on, running(NOW - 70_000, false, 'Bash npm run deploy'))
  const ui = await $.ui.mount(TERMINAL_PANE(false))
  expect((await texts(ui)).join('\n')).toContain('Needs you')
  await ui.unmount()
})

// I5: the ask's command keeps its words from 32 to 47 columns: it wraps to a second row before any cut.
for (const cols of [32, 36, 40, 44, 47]) {
  test(`I5: at ${cols} columns the permission command is drawn whole over two rows, with no "…"`, async ($, on) => {
    const { autoAsk: _a, ...t } = asked(30)
    world(on, { ...t, steps: [step('s1', 'Bash npm run deploy -- --env staging', { asking: NOW - 30_000, pending: { command: 'npm run deploy -- --env staging' } })] })
    const ui = await $.ui.mount({ ...PANE(cols), surface: 'terminal' })
    const all = screen(await ui.drawn())
    const first = all.findIndex(x => x.includes('Bash') && x.includes('npm'))
    expect(first >= 0).toBe(true)
    const rows = all.slice(first, first + 2).map(x => x.replace(/^[\s▍]+/, '')).join(' ')
    expect(rows.replace(/\s+/g, ' ')).toContain('Bash npm run deploy -- --env staging')
    for (const x of all.slice(first, first + 2)) expect(x.includes('…')).toBe(false)
    for (const x of all) expect(x.length <= cols).toBe(true)
    await ui.unmount()
  })
}

// I5 in the band: the ask keeps its words in the one-row form at 32 to 47 columns.
for (const cols of [32, 40, 47]) {
  test(`I5: the band at ${cols} columns says the ask in whole words`, async ($, on) => {
    const { autoAsk: _a, ...t } = asked(30)
    world(on, t)
    const band = await $.ui.mount({ ...BAND(cols), surface: 'terminal' })
    const words = (await texts(band)).join('\n')
    expect(words).toContain('needs you')
    expect(words).toContain('Bash')
    expect(words.includes('…')).toBe(false)
    await band.unmount()
  })
}

// M9: at 80 columns the band's goal never ends on "the", and the ask's command is whole.
test('M9: the band at 80 columns cuts the goal at a word that is not "the", and moves a long command whole to row 2', async ($, on) => {
  const goal: Timeline = {
    ...empty,
    now: { focus: 'Wiring the limiter into the middleware chain of the upload route', at: NOW - 1000 },
    turns: [{ id: 't1', agent: 'main', prompt: 'go', startedAt: NOW - 60_000 } as TurnRow],
    steps: [step('s1', 'Bash ls', {})],
    agents: { main },
    budget: { contextPct: 62, windows: [{ name: 'seven_day', pct: 34 }], at: NOW },
  }
  const { stored } = world(on, goal)
  const band = await $.ui.mount({ ...BAND(80), surface: 'terminal' })
  const row1 = (await texts(band)).find(x => x.includes('Working on')) ?? ''
  expect(row1).toContain('Wiring the limiter')
  expect(/\bthe\s*(context|$)/.test(row1.replace(/\s+/g, ' ').trim())).toBe(false)
  expect(row1.includes('…')).toBe(false)
  await band.unmount()

  const { autoAsk: _a, ...t } = asked(30)
  stored.set('timeline', { ...t, steps: [step('s1', 'Bash npm run deploy -- --env staging', { asking: NOW - 30_000, pending: { command: 'npm run deploy -- --env staging' } })] })
  const askBand = await $.ui.mount({ ...BAND(80), surface: 'terminal' })
  const words = await texts(askBand)
  expect(words.join('\n')).toContain('npm run deploy -- --env staging')
  expect(words.join('\n').includes('npm run…')).toBe(false)
  for (const x of words) for (const line of x.split('\n')) expect(line.length <= 80).toBe(true)
  await askBand.unmount()
})

// M13: agent-finished toasts fold over 30 s and never come more than once a minute; folded, no answer text.
test('M13: finishes fold over 30 s into one toast with no answer text, and the next toast waits out the minute', async ($, on) => {
  // The lead still works (its turn is open), so the clock keeps ticking while a toast is held.
  const t: Timeline = {
    ...empty,
    turns: [{ id: 't1', agent: 'main', prompt: 'go', startedAt: NOW - 60_000 } as TurnRow],
    agents: {
      main,
      r1: sub('r1'),
      x1: sub('x1', { status: 'done', endedAt: NOW, doing: 'answer one' }),
    },
  }
  const { stored, clock, toasts } = await ticking($, on, t)
  await clock.advance(10_000)
  expect(toasts).toEqual([])
  // A second finish 10 s later folds into the first.
  const t2 = stored.get('timeline') as Timeline
  stored.set('timeline', { ...t2, agents: { ...t2.agents, x2: sub('x2', { status: 'done', endedAt: NOW + 10_000, doing: 'answer two' }) } })
  await clock.advance(22_000)
  expect(toasts).toEqual(['2 agents finished'])
  // Another finish soon after: held until a minute has passed since the last toast.
  const t3 = stored.get('timeline') as Timeline
  stored.set('timeline', { ...t3, agents: { ...t3.agents, r1: sub('r1', { status: 'done', endedAt: NOW + 33_000, doing: 'last one' }) } })
  await clock.advance(10_000)
  expect(toasts).toHaveLength(1)
  await clock.advance(55_000)
  expect(toasts).toEqual(['2 agents finished', 'Explorer finished: last one'])
})

// B-I1: the finish settle hold is capped by the fold limit, so a steady stream of finishes cannot starve the toast.
test('B-I1: 50 finishes 1 s apart give one toast by about 30 s, and its count covers every finish that had arrived', async ($, on) => {
  const t: Timeline = {
    ...empty,
    turns: [{ id: 't1', agent: 'main', prompt: 'go', startedAt: NOW - 60_000 } as TurnRow],
    agents: { main, x0: sub('x0', { status: 'done', endedAt: NOW, doing: 'w0' }) },
  }
  const { stored, clock, toasts } = await ticking($, on, t)
  // Finish k lands at NOW + k s, after the k-th advance. The toast that appears during advance k saw finishes x0..x(k-1): k of them.
  let at = 0
  for (let k = 1; k <= 50 && toasts.length === 0; k++) {
    await clock.advance(1000)
    at = k
    if (toasts.length > 0) break
    const cur = stored.get('timeline') as Timeline
    stored.set('timeline', { ...cur, agents: { ...cur.agents, ['x' + k]: sub('x' + k, { status: 'done', endedAt: NOW + k * 1000, doing: 'w' + k }) } })
  }
  expect(toasts).toHaveLength(1)
  expect(at).toBeGreaterThanOrEqual(30)
  expect(at).toBeLessThanOrEqual(36)
  // None dropped: the count is exactly the finishes that had arrived, the oldest included.
  expect(toasts[0]).toBe(`${at} agents finished`)
})

// Controller ruling on concern 4: a held agent-finished toast is never dropped; when the clock is about to stop it goes up at once.
test('M13: a toast held by the once-a-minute limit goes up when the clock is about to stop, never dropped', async ($, on) => {
  const t: Timeline = { ...empty, agents: { main, x1: sub('x1', { status: 'done', endedAt: NOW, doing: 'first' }) } }
  const { stored, clock, toasts } = await ticking($, on, t)
  await clock.advance(2000)
  expect(toasts).toEqual(['Explorer finished: first'])
  const t2 = stored.get('timeline') as Timeline
  stored.set('timeline', { ...t2, agents: { ...t2.agents, x2: sub('x2', { status: 'done', endedAt: NOW + 3000, doing: 'second' }) } })
  await clock.advance(10_000)
  // Still inside the minute and the clock still live: held.
  expect(toasts).toHaveLength(1)
  // Nothing live 20 s after the last finish: the clock stops, and the held toast goes up first.
  await clock.advance(20_000)
  expect(toasts).toEqual(['Explorer finished: first', 'Explorer finished: second'])
  await clock.advance(60_000)
  expect(toasts).toHaveLength(2)
})
