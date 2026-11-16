import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, UiFocusInput, UiFocusResult } from 'claude-code'

import type { AgentRow, Step, TaskItem, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { stops } from './screen.testkit'

// The navigation pass: the ring starts in the content, a person's move onto a
// tab stays in the content, a tab's hotkey moves the ring to the new tab's
// first row, and every view draws its focusables in reading order.

const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }
const PANE_ID = 'mission-control'
// The tab bar's Buttons: the five tabs and Options (`0`), all reached by hotkey rather than by the ring.
const TAB_KEYS = ['tab-overview', 'tab-tasks', 'tab-agents', 'tab-timeline', 'tab-artifacts', 'tab-options']

type World = { stored: Map<string, unknown>; landed: (string | undefined)[]; logs: string[] }

/**
 * The engine beneath the mod: state from memory, the debug log kept, and the
 * bottom of `ui.focus`, which lands the ring on what it is handed (`{}`) and
 * records it; `deny`, when set, refuses instead.
 */
function world(on: On, t: Timeline, u: UiState, deny?: string): World {
  const stored = new Map<string, unknown>([['timeline', t], ['ui', u]])
  const landed: (string | undefined)[] = []
  const logs: string[] = []
  mock.clock(on, { now: NOW })
  on('ui.log', (_, e) => {
    logs.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined }
  })
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
  on('ui.focus', (_, e) => {
    landed.push((e as { element?: string }).element)
    return (deny !== undefined ? { deny } : {}) as never
  })
  return { stored, landed, logs }
}

const step = (id: string, seq: number, label: string, status: Step['status'], extra: Partial<Step> = {}): Step => ({
  id, seq, agent: 'main', tool: 'Edit', label, status, startedAt: NOW - 5000, ...extra,
})
const task = (id: string, subject: string, status: TaskItem['status']): TaskItem => ({ id, subject, status, owner: 'main', updatedAt: NOW - 1000 })
const agent = (id: string, status: AgentRow['status'], extra: Partial<AgentRow> = {}): AgentRow => ({
  id, parent: 'main', type: 'Explore', description: `agent ${id}`, status, startedAt: NOW - 60_000, doing: 'reading', stepCount: 1, ...extra,
})

// Something on every tab: an ask waiting 30 s (NEEDS YOU), agents, a run, tasks, steps, an artifact.
const RICH: Timeline = {
  ...empty,
  steps: [
    step('s1', 1, 'Edit a.ts', 'done', { endedAt: NOW - 4000, pin: 'kept it' }),
    step('s2', 2, 'Bash npm test', 'error', { tool: 'Bash', endedAt: NOW - 1000 }),
    step('s3', 3, 'Bash ls', 'running', { tool: 'Bash', asking: NOW - 30_000 }),
  ],
  agents: {
    ...empty.agents,
    a1: agent('a1', 'running'),
    a2: agent('a2', 'done', { endedAt: NOW - 1000 }),
    w1: agent('w1', 'running', { runId: 'r1', agentIndex: 0 }),
  },
  runs: { r1: { runId: 'r1', name: 'review run', parent: 'main', startedAt: NOW - 30_000 } },
  tasks: [task('1', 'First', 'in_progress'), task('2', 'Second', 'pending'), task('3', 'Third', 'completed')],
  now: { focus: 'Doing things', next: 'More', at: NOW - 1000 },
  notes: [{ text: 'a note', agent: 'main', at: NOW - 1000 }],
  artifacts: [{ id: 'r1', kind: 'result', title: 'Result one', agent: 'main', count: 1, updatedAt: NOW - 1000 }],
  changed: ['src/a.ts'],
}
// The same session with nothing waiting on the person.
const CALM: Timeline = { ...RICH, steps: RICH.steps.map(s => (s.id === 's3' ? { ...s, asking: undefined } : s)) }

const PANE = (columns: number) =>
  ({
    plugin: PANE_ID,
    component: 'Pane',
    requestId: PANE_ID,
    props: { title: 'Mission Control', isFocused: true, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
  }) as const

const TABS = ['overview', 'tasks', 'agents', 'timeline', 'artifacts'] as const

async function mount($: Engine, columns = 62) {
  return $.ui.mount({ ...PANE(columns), surface: 'terminal' })
}
type Mounted = Awaited<ReturnType<typeof mount>>

/** The focusable keys in document order, and the first one marked `autoFocus`. */
async function ring(ui: Mounted): Promise<{ order: string[]; buttons: string[]; start: string | undefined }> {
  const all = (await ui.findAll({})).filter(f => f.type === 'Button' || f.type === 'Input' || f.type === 'Select')
  return {
    order: all.map(f => f.key ?? '?'),
    buttons: all.filter(f => f.type === 'Button').map(f => f.key ?? '?'),
    start: all.find(f => f.props.autoFocus === true)?.key,
  }
}

/** A move of the ring as the engine raises it: the person's, or this plugin's (its autoFocus, its `$.ui.focus`). */
function move($: Engine, element: string | undefined, by: 'person' | 'plugin' = 'person'): Promise<UiFocusResult> {
  const e: UiFocusInput = {
    component: 'Pane',
    requestId: PANE_ID,
    ...(element !== undefined ? { element } : {}),
    origin: by === 'person' ? { kind: 'person' } : { kind: 'plugin', name: PANE_ID },
  }
  // The engine's $ types `ui.focus` by the plugin's arguments; the event's own input is what a surface raises.
  return ($.ui.focus as unknown as (e: UiFocusInput) => Promise<UiFocusResult>)(e)
}

const contentOf = (order: string[]): string[] => order.filter(k => !TAB_KEYS.includes(k))

// ---------- the ring starts in the content ----------

const STARTS: [string, Timeline, UiState['tab'], string][] = [
  ['Now, something waiting: the first NEEDS YOU item', RICH, 'overview', 'open-asking:s3'],
  ['Now, nothing waiting: the headline, the first content row', CALM, 'overview', 'now-title'],
  ['Tasks: the first task row', RICH, 'tasks', 'task-main:1'],
  ['Agents: the first row under the deck', RICH, 'agents', 'mode-list'],
  ['Steps: the find hotkey, never the find field', RICH, 'timeline', 'find-f'],
  ['Artifacts: the HANDOFF row', RICH, 'artifacts', 'handoff-export'],
]

for (const [name, t, tab, want] of STARTS) {
  test(`opening the pane starts the ring in the content: ${name}`, async ($, on) => {
    world(on, t, { ...initialUi, tab })
    const ui = await mount($)
    const r = await ring(ui)
    expect(r.start).toBe(want)
    expect(contentOf(r.order)[0] === want || r.order.indexOf(want) > r.order.indexOf('tab-artifacts')).toBe(true)
    // Exactly one element of the drawing is marked: no tab, no Input.
    const marked = (await ui.findAll({})).filter(f => f.props.autoFocus === true)
    expect(marked.map(f => f.key)).toEqual([want])
    await ui.unmount()
  })
}

test('an empty session still starts the ring in the content, on every tab', async ($, on) => {
  const w = world(on, empty, initialUi)
  for (const tab of TABS) {
    w.stored.set('ui', { ...initialUi, tab })
    const ui = await mount($)
    const r = await ring(ui)
    expect(r.start).toBe(contentOf(r.buttons)[0])
    expect(r.start === undefined || !TAB_KEYS.includes(r.start)).toBe(true)
    await ui.unmount()
  }
})

test('on Now the NEEDS YOU item wins over the deck at every width with a tab bar', async ($, on) => {
  world(on, RICH, initialUi)
  for (const cols of [62, 50, 40, 32]) {
    const ui = await mount($, cols)
    expect((await ring(ui)).start).toBe('open-asking:s3')
    await ui.unmount()
  }
})

// ---------- a person's move onto a tab stays in the content ----------

test('Up off the first content row onto a tab stays on that row', async ($, on) => {
  const w = world(on, RICH, initialUi)
  const ui = await mount($)
  await move($, 'open-asking:s3', 'plugin')
  w.landed.length = 0
  const got = await move($, 'tab-artifacts')
  expect(got).toEqual({})
  expect(w.landed).toEqual(['open-asking:s3'])
  await ui.unmount()
})

test('Down off the last content row (wrapping to the first tab) stays on the last row', async ($, on) => {
  const w = world(on, CALM, { ...initialUi, tab: 'tasks' })
  const ui = await mount($)
  const last = contentOf((await ring(ui)).order).at(-1)!
  await move($, last, 'plugin')
  w.landed.length = 0
  await move($, 'tab-overview')
  expect(w.landed).toEqual([last])
  await ui.unmount()
})

test("Down off the last content row onto one of the engine's own stops stays on the last row", async ($, on) => {
  const w = world(on, CALM, { ...initialUi, tab: 'tasks' })
  const ui = await mount($)
  const last = contentOf((await ring(ui)).order).at(-1)!
  await move($, last, 'plugin')
  w.landed.length = 0
  // The engine refuses an element in place of its own stop: the hook keeps the ring, answering {} without next.
  expect(await move($, undefined)).toEqual({})
  expect(w.landed).toEqual([])
  // The ring is still on the last row: a move onto a tab now stays there too.
  await move($, 'tab-overview')
  expect(w.landed).toEqual([last])
  await ui.unmount()
})

test('a move from a tab (after a click) onto the next tab goes to the first content row instead', async ($, on) => {
  const w = world(on, CALM, { ...initialUi, tab: 'agents' })
  const ui = await mount($)
  // The ring sits on a tab: only a plugin's own move puts it there now.
  await move($, 'tab-agents', 'plugin')
  w.landed.length = 0
  await move($, 'tab-timeline')
  expect(w.landed).toEqual(['mode-list'])
  await ui.unmount()
})

test('a move onto a tab before anything is known about the ring goes to the first content row', async ($, on) => {
  const w = world(on, RICH, initialUi)
  const ui = await mount($)
  await move($, undefined, 'plugin')
  w.landed.length = 0
  await move($, 'tab-overview')
  expect(w.landed).toEqual(['open-asking:s3'])
  await ui.unmount()
})

test('a move between content rows lands where the engine sends it, unchanged', async ($, on) => {
  const w = world(on, RICH, { ...initialUi, tab: 'timeline' })
  const ui = await mount($)
  const content = contentOf((await ring(ui)).order)
  w.landed.length = 0
  for (const k of content) await move($, k)
  expect(w.landed).toEqual(content)
  await ui.unmount()
})

test("this plugin's own move onto a tab is not redirected", async ($, on) => {
  const w = world(on, RICH, initialUi)
  const ui = await mount($)
  w.landed.length = 0
  await move($, 'tab-tasks', 'plugin')
  expect(w.landed).toEqual(['tab-tasks'])
  await ui.unmount()
})

test('the hook answers what the chain beneath answered: a deny comes back as it was', async ($, on) => {
  const w = world(on, RICH, initialUi, 'held elsewhere')
  const ui = await mount($)
  expect(await move($, 'tab-overview')).toEqual({ deny: 'held elsewhere' })
  expect(await move($, 'deck-crew')).toEqual({ deny: 'held elsewhere' })
  // A refused move did not put the ring on the row: the next move onto a tab still goes to the start.
  w.landed.length = 0
  await move($, 'tab-tasks')
  expect(w.landed).toEqual(['open-asking:s3'])
  await ui.unmount()
})

test('the hook never throws: odd inputs and a pane never drawn pass through', async ($, on) => {
  world(on, RICH, initialUi)
  // The plugin's arguments form, as the kit raises `$.ui.focus` (no origin, no element).
  const r = await ($.ui.focus as unknown as (a: unknown) => Promise<unknown>)({ requestId: PANE_ID, key: 'deck-crew' })
  expect(r).toEqual({})
  // Another pane's ring is not this hook's.
  const other = await ($.ui.focus as unknown as (e: UiFocusInput) => Promise<UiFocusResult>)({
    component: 'Pane', requestId: 'other', element: 'tab-overview', origin: { kind: 'person' },
  })
  expect(other).toEqual({})
})

// ---------- tabs stay reachable ----------

test('hotkey 3 switches to Agents and moves the ring to its first row', async ($, on) => {
  const w = world(on, RICH, { ...initialUi, tab: 'overview' })
  const ui = await mount($)
  const tab = await ui.find({ type: 'Button', key: 'tab-agents' })
  expect(tab?.props.hotkey).toBe('3')
  await ui.press({ key: 'tab-agents' })
  expect((w.stored.get('ui') as UiState).tab).toBe('agents')
  await ui.redraw()
  expect((await ring(ui)).start).toBe('mode-list')
  // The kit has no ring, so `$.ui.focus` from a handler cannot land there; the
  // debug line names the element the press asked the ring onto.
  expect(w.logs.some(l => l.includes('tab agents: focus mode-list'))).toBe(true)
  await ui.unmount()
})

for (const [i, tab] of TABS.entries()) {
  test(`a press on tab ${i + 1} still switches to ${tab}`, async ($, on) => {
    const w = world(on, RICH, { ...initialUi, tab: tab === 'overview' ? 'artifacts' : 'overview' })
    const ui = await mount($)
    await ui.press({ key: `tab-${tab}` })
    expect((w.stored.get('ui') as UiState).tab).toBe(tab)
    await ui.unmount()
  })
}

// ---------- slim: no tab bar, nothing is redirected ----------

test('slim has no tab bar: the ring starts on its first item and no move is redirected', async ($, on) => {
  const w = world(on, RICH, initialUi)
  const ui = await mount($, 28)
  const r = await ring(ui)
  expect(r.order.some(k => TAB_KEYS.includes(k))).toBe(false)
  expect(r.start).toBe('open-asking:s3')
  await move($, r.order.at(-1)!, 'plugin')
  w.landed.length = 0
  for (const k of [...r.order, 'tab-overview']) await move($, k)
  await move($, undefined)
  expect(w.landed).toEqual([...r.order, 'tab-overview', undefined])
  await ui.unmount()
})

// ---------- every view draws its focusables in reading order ----------

type Case = { name: string; t: Timeline; u: UiState; cols: number; before?: (ui: Mounted) => Promise<void>; after?: (ui: Mounted) => Promise<void> }

const CASES: Case[] = []
for (const cols of [62, 50, 40, 32, 28]) {
  for (const tab of TABS) {
    CASES.push({ name: `${tab} at ${cols}`, t: RICH, u: { ...initialUi, tab }, cols })
    CASES.push({ name: `${tab} at ${cols}, nothing waiting`, t: CALM, u: { ...initialUi, tab }, cols })
  }
  CASES.push({ name: `agents tree at ${cols}`, t: RICH, u: { ...initialUi, tab: 'agents', agentsMode: 'tree' }, cols })
  CASES.push({ name: `agents run board at ${cols}`, t: RICH, u: { ...initialUi, tab: 'agents', run: 'r1' }, cols })
  CASES.push({ name: `agents with a row open at ${cols}`, t: RICH, u: { ...initialUi, tab: 'agents', agentOpen: 'a1' }, cols })
  CASES.push({ name: `step detail at ${cols}`, t: RICH, u: { ...initialUi, tab: 'timeline', detail: { stepId: 's2' } }, cols })
  CASES.push({ name: `step open in place at ${cols}`, t: RICH, u: { ...initialUi, tab: 'timeline', stepOpen: 's2' }, cols })
  CASES.push({ name: `task open at ${cols}`, t: RICH, u: { ...initialUi, tab: 'tasks', taskOpen: 'main:1' }, cols })
  CASES.push({
    name: `budget view at ${cols}`,
    t: CALM,
    u: initialUi,
    cols,
    before: async ui => {
      if (await ui.find({ key: 'hint-budget' })) await ui.press({ key: 'hint-budget' })
    },
    // The budget view is the module's own flag: close it so the next case draws Now.
    after: async ui => {
      if (await ui.find({ key: 'hint-back' })) await ui.press({ key: 'hint-back' })
    },
  })
}

for (const c of CASES) {
  test(`reading order: ${c.name}`, async ($, on) => {
    world(on, c.t, c.u)
    const ui = await mount($, c.cols)
    if (c.before) await c.before(ui)
    const doc = (await ring(ui)).order
    const laid = stops(await ui.drawn()).map(s => s.key)
    expect(laid).toEqual(doc)
    if (c.after) await c.after(ui)
    await ui.unmount()
  })
}

test('reading order in the inline strip: the left column top to bottom, then the right', async ($, on) => {
  world(on, RICH, initialUi)
  const ui = await mount($, 100)
  const doc = (await ring(ui)).order
  const at = stops(await ui.drawn())
  const tabs = at.filter(s => TAB_KEYS.includes(s.key)).map(s => s.key)
  const left = at.filter(s => !TAB_KEYS.includes(s.key) && s.col < 50).sort((a, b) => a.row - b.row || a.col - b.col)
  const right = at.filter(s => !TAB_KEYS.includes(s.key) && s.col >= 50).sort((a, b) => a.row - b.row || a.col - b.col)
  const footerRow = Math.max(...at.map(s => s.row))
  const body = (xs: typeof left) => xs.filter(s => s.row !== footerRow).map(s => s.key)
  const foot = at.filter(s => s.row === footerRow).map(s => s.key)
  expect(doc).toEqual([...tabs, ...body(left), ...body(right), ...foot])
  await ui.unmount()
})
