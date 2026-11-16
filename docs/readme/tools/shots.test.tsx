// README shots: draws the real views with the tests' own fixtures and prints each drawn tree as one
// `SHOT <name> <json>` line, with the rows the test kit lays it out as. Not part of the mod: make.mjs copies
// it into a scratch copy of mod/ (as hooks/views/zz_shots.test.tsx) and runs it there with `claude plugin test`.
import { mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Timeline, UiState } from '../../types'
import { initialUi } from '../state'
import { flaggedSession, listSession, mapSession } from './agents.fixtures.testkit'
import { asked, busy, endedOpen, idle, NOW, stopped, watching } from './now.fixtures.testkit'
import { critterBox, encode, CRITTER_ROLES, STATES } from './raster'
import { screen } from './screen.testkit'
import { artifactsTimeline, stepsTimeline, stepsUi, tasksTimeline } from './tabs.fixtures.testkit'

const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }
// The one-shot moves (motion sketches) play on a view's first draw (the gauges fill when the pane opens): the
// clock starts SETTLE_MS early, and a shot is the redraw at NOW, after every move has ended.
const SETTLE_MS = 2000
let clock: MockClock | undefined
async function settle(ui: { redraw: () => Promise<void> }): Promise<void> {
  await clock?.advance(SETTLE_MS)
  await ui.redraw()
}
function world(on: On, t: Timeline, u: UiState = initialUi): void {
  const stored = new Map<string, unknown>([['timeline', t], ['ui', u]])
  const versions = new Map<string, number>()
  clock = mock.clock(on, { now: NOW - SETTLE_MS })
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
}
type PO = { focused?: boolean; covered?: boolean; surface?: 'terminal' | 'desktop' | 'vscode' | 'mobile' }
const PANE = (columns: number, rows: number, o: PO = {}) =>
  ({
    plugin: 'binnacle', component: 'Pane', requestId: 'binnacle',
    props: { title: 'Binnacle', isFocused: o.focused ?? true, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: rows }, view: {}, ...(o.covered === true ? { isPromptCovered: true as const } : {}) },
  }) as const
const BAND = (columns: number, extra: Record<string, unknown> = {}) =>
  ({
    plugin: 'binnacle', component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: columns, scroll: { offset: 0, bodyRows: 10 }, view: {}, ...extra },
  }) as const
const out = (name: string, tree: unknown): void => console.log('SHOT ' + name + ' ' + JSON.stringify({ tree, rows: screen(tree) }))

async function pane($: Engine, name: string, cols: number, rows: number, o: PO = {}): Promise<void> {
  const ui = await $.ui.mount({ ...PANE(cols, rows, o), surface: o.surface ?? 'terminal' })
  await settle(ui)
  out(name, await ui.drawn())
  await ui.unmount()
}
async function band($: Engine, name: string, cols: number, surface: 'terminal' | 'desktop' = 'terminal', extra: Record<string, unknown> = {}): Promise<void> {
  const ui = await $.ui.mount({ ...BAND(cols, extra), surface })
  await settle(ui)
  out(name, await ui.drawn())
  await ui.unmount()
}
const DAY = { options: { ground: 'day' } } as const
const TEXT = { options: { look: 'text' } } as const

test('now-busy', async ($, on) => { world(on, busy()); await pane($, 'now-busy', 62, 46) })
test('now-busy-unfocused', async ($, on) => { world(on, busy()); await pane($, 'now-busy-unfocused', 62, 46, { focused: false }) })
test('now-busy-day', DAY, async ($, on) => { world(on, busy()); await pane($, 'now-busy-day', 62, 46) })
test('now-busy-text', TEXT, async ($, on) => { world(on, busy()); await pane($, 'now-busy-text', 62, 46) })
test('now-needs', async ($, on) => { world(on, asked()); await pane($, 'now-needs', 62, 46, { focused: false, covered: true }) })
test('now-needs-focused', async ($, on) => { world(on, asked()); await pane($, 'now-needs-focused', 62, 46, { focused: true, covered: true }) })
test('now-watch', async ($, on) => { world(on, watching()); await pane($, 'now-watch', 62, 46) })
test('now-idle', async ($, on) => { world(on, idle()); await pane($, 'now-idle', 62, 46) })
test('now-ended-open', async ($, on) => { world(on, endedOpen()); await pane($, 'now-ended-open', 62, 46) })
test('hero-pane', async ($, on) => { world(on, busy(), { ...initialUi, paneOpen: true }); await pane($, 'hero-pane', 62, 40, { focused: false }) })
test('hero-pane-day', DAY, async ($, on) => { world(on, busy(), { ...initialUi, paneOpen: true }); await pane($, 'hero-pane-day', 62, 40, { focused: false }) })
test('hero-band', async ($, on) => { world(on, busy(), { ...initialUi, paneOpen: true }); await band($, 'hero-band', 74) })
test('hero-band-day', DAY, async ($, on) => { world(on, busy(), { ...initialUi, paneOpen: true }); await band($, 'hero-band-day', 74) })
test('now-stopped', async ($, on) => { world(on, stopped()); await pane($, 'now-stopped', 62, 46) })
for (const a of ['sky', 'slate'] as const) test('now-' + a, { options: { accent: a } }, async ($, on) => { world(on, busy()); await pane($, 'now-' + a, 62, 46) })

test('tasks', async ($, on) => { world(on, tasksTimeline(), { ...initialUi, tab: 'tasks' }); await pane($, 'tasks', 62, 46) })
test('agents-list', async ($, on) => { world(on, listSession(), { ...initialUi, tab: 'agents' }); await pane($, 'agents-list', 62, 46) })
test('agents-map', async ($, on) => { world(on, mapSession(), { ...initialUi, tab: 'agents', agentsMode: 'tree' }); await pane($, 'agents-map', 62, 46) })
test('agents-map-open', async ($, on) => { world(on, mapSession(), { ...initialUi, tab: 'agents', agentsMode: 'tree', folded: ['open:task:11'] }); await pane($, 'agents-map-open', 62, 46) })
test('agents-map-flagged', async ($, on) => { world(on, flaggedSession(), { ...initialUi, tab: 'agents', agentsMode: 'tree' }); await pane($, 'agents-map-flagged', 62, 46, { covered: true }) })
test('agents-list-flagged', async ($, on) => { world(on, flaggedSession(), { ...initialUi, tab: 'agents' }); await pane($, 'agents-list-flagged', 62, 46, { covered: true }) })
test('steps', async ($, on) => {
  const { t, ids } = stepsTimeline()
  const open = { ...stepsUi({ stepOpen: ids.failed }), tab: 'timeline', stepBody: { stepId: ids.failed, body: { input: {}, text: 'exit 1 · 2 of 14 tests failed\nexpected 429, received 200', cut: 0, isError: true } } } as UiState
  world(on, t, open)
  const marks = []
  for (const id of ids.view) marks.push(await $.ui.mount({ plugin: 'binnacle', surface: 'terminal', component: 'ToolUse', requestId: id, props: { tool_use_id: id, tool: 'Edit', input: {}, isRunning: false, isErrored: false, isInterrupted: false, onScreen: { first: 0, last: 2, of: 3 } } } as never))
  await pane($, 'steps', 62, 46)
  for (const m of marks) await m.unmount()
})
test('artifacts', async ($, on) => { world(on, artifactsTimeline(), { ...initialUi, tab: 'artifacts' }); await pane($, 'artifacts', 62, 46) })
test('slim-busy', async ($, on) => { world(on, busy()); await pane($, 'slim-busy', 28, 46) })
test('slim-needs', async ($, on) => { world(on, asked()); await pane($, 'slim-needs', 28, 46, { focused: false, covered: true }) })
test('slim-idle', async ($, on) => { world(on, idle()); await pane($, 'slim-idle', 28, 46) })
test('strip', async ($, on) => { world(on, busy()); await pane($, 'strip', 110, 18, { focused: false }) })
test('strip-needs', async ($, on) => { world(on, asked()); await pane($, 'strip-needs', 110, 18, { focused: false, covered: true }) })
test('narrow-48', async ($, on) => { world(on, busy()); await pane($, 'narrow-48', 48, 30) })
test('narrow-40', async ($, on) => { world(on, busy()); await pane($, 'narrow-40', 40, 30) })

test('band-busy', async ($, on) => { world(on, busy()); await band($, 'band-busy', 104) })
test('band-asked', async ($, on) => { world(on, asked()); await band($, 'band-asked', 104) })
test('band-watch', async ($, on) => { world(on, { ...watching(), budget: busy().budget }); await band($, 'band-watch', 104) })
test('band-idle', async ($, on) => { world(on, idle()); await band($, 'band-idle', 104) })
test('band-stopped', async ($, on) => { world(on, stopped()); await band($, 'band-stopped', 104) })
test('band-64', async ($, on) => { world(on, busy()); await band($, 'band-64', 64) })
test('band-40', async ($, on) => { world(on, busy()); await band($, 'band-40', 40) })
test('band-strip', async ($, on) => { world(on, busy(), { ...initialUi, strip: true }); await band($, 'band-strip', 110, 'terminal', { maxRows: 20, scroll: { offset: 0, bodyRows: 20 } }) })

test('desktop-now', async ($, on) => { world(on, busy()); await pane($, 'desktop-now', 62, 46, { surface: 'desktop' }) })
test('desktop-now-needs', async ($, on) => { world(on, asked()); await pane($, 'desktop-now-needs', 62, 46, { surface: 'desktop', covered: true, focused: false }) })
test('desktop-now-day', DAY, async ($, on) => { world(on, busy()); await pane($, 'desktop-now-day', 62, 46, { surface: 'desktop' }) })
test('desktop-band', async ($, on) => { world(on, busy()); await band($, 'desktop-band', 104, 'desktop') })
test('desktop-band-asked', async ($, on) => { world(on, asked()); await band($, 'desktop-band-asked', 104, 'desktop') })

test('options', async ($, on) => {
  world(on, busy())
  const ui = await $.ui.mount({ ...PANE(62, 46), surface: 'terminal' })
  await ui.press({ key: 'tab-options' })
  await ui.unmount()
  const again = await $.ui.mount({ ...PANE(62, 46), surface: 'terminal' })
  await settle(again)
  out('options', await again.drawn())
  await again.press({ key: 'tab-options' })
  await again.unmount()
})
test('budget', async ($, on) => {
  const HOUR = 3_600_000
  const t = busy()
  world(on, { ...t, budget: { ...t.budget!, windows: [{ name: 'five_hour', pct: 71, resetsAt: NOW + 2 * HOUR }, { name: 'seven_day', pct: 34, resetsAt: NOW + 70 * HOUR }] } } as Timeline)
  const ui = await $.ui.mount({ ...PANE(62, 46), surface: 'terminal' })
  await ui.press({ key: 'now-budget' })
  await ui.unmount()
  const again = await $.ui.mount({ ...PANE(62, 46), surface: 'terminal' })
  await settle(again)
  out('budget', await again.drawn())
  await again.press({ key: 'budget-back' })
  await again.unmount()
})

test('critters', () => {
  for (const ground of ['night', 'day'] as const) for (const size of ['small', 'micro'] as const) {
    const sheet: unknown[] = []
    for (const role of CRITTER_ROLES) for (const state of STATES) {
      const g = critterBox(role, state, size, { ground })
      sheet.push({ role, state, columns: g.columns, rows: g.rows, cells: encode(g) })
    }
    console.log(`SHOT critters-${size}-${ground} ` + JSON.stringify({ sheet }))
  }
})
