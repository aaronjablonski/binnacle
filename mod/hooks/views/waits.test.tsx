import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Step, TaskItem, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { screen } from './screen.testkit'
import { HULL } from './style'

// One waiting agent, one rule: the same `?` on every view that draws the
// agent, and none once the ask is dismissed.

const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }

function seed(on: On, t: Timeline, u: UiState): void {
  mock.clock(on, { now: NOW })
  on('ui.log', () => ({ value: undefined }))
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    const v = key === 'timeline' ? t : key === 'ui' ? u : undefined
    return { value: { value: v === undefined ? undefined : { shape: SHAPES[key], value: v }, version: 0 } }
  })
}

const task: TaskItem = { id: 't1', subject: 'Fix the parser', status: 'in_progress', owner: 'main', updatedAt: NOW - 60_000 }
const worker: AgentRow = {
  id: 'a1', parent: 'main', type: 'Explore', description: 'find callers', status: 'running',
  startedAt: NOW - 60_000, lastStepAt: NOW - 5_000, doing: 'Bash rm -rf build', stepCount: 1, taskId: 't1',
}
// a1 asked 30 s ago: past the 20 s threshold, so it is waiting on the person.
const asking: Step = { id: 's1', seq: 1, agent: 'a1', tool: 'Bash', label: 'Bash rm -rf build', status: 'running', startedAt: NOW - 40_000, asking: NOW - 30_000 }
const T: Timeline = {
  ...empty,
  seq: 1,
  steps: [asking],
  tasks: [task],
  agents: { main: { ...empty.agents.main! }, a1: worker },
  now: { focus: 'Fixing the parser', at: NOW - 60_000 },
}

const PANE = (columns: number) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    props: { title: 'Mission Control', isFocused: false, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  }) as const
const BAND = (columns: number) =>
  ({
    plugin: 'mission-control',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: columns, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  }) as const

const uiOf = (tab: UiState['tab'], dismissed: string[]): UiState => ({ ...initialUi, tab, dismissed })

// Every hull of every role and state, from the one table the views draw with.
const HULLS: string[] = Object.values(HULL).flatMap(h => [...h])
/**
 * A signal as a view draws it, and only there: in a row's gutter cell (column
 * 0, then a space) or as a pod's suffix (right after a hull). A `?` inside a
 * description is neither.
 */
const marked = (rows: string[], mark: '?' | '!' | 'z'): boolean =>
  rows.some(r => r.startsWith(`${mark} `) || HULLS.some(h => r.includes(`${h}${mark}`)))
const signalled = (rows: string[]): boolean => marked(rows, '?')
const anyMark = (rows: string[]): boolean => marked(rows, '?')
/** Any gutter flag on a row: `!`, `?` or `z` at column 0. */
const gutterFlag = (rows: string[]): string | undefined => rows.find(r => /^[!?z] /.test(r))

async function paneRows($: Engine, columns = 62): Promise<string[]> {
  const ui = await $.ui.mount({ ...PANE(columns), surface: 'terminal' })
  const rows = screen(await ui.drawn())
  await ui.unmount()
  return rows
}
async function bandRows($: Engine, columns: number): Promise<string[]> {
  const ui = await $.ui.mount({ ...BAND(columns), surface: 'terminal' })
  const rows = screen(await ui.drawn())
  await ui.unmount()
  return rows
}

const VIEWS: { name: string; tab: UiState['tab']; rows: ($: Engine) => Promise<string[]> }[] = [
  { name: 'Agents', tab: 'agents', rows: $ => paneRows($) },
  { name: 'Now', tab: 'overview', rows: $ => paneRows($) },
  { name: 'Tasks', tab: 'tasks', rows: $ => paneRows($) },
  { name: 'band (three rows)', tab: 'overview', rows: $ => bandRows($, 110) },
  { name: 'band (one row)', tab: 'overview', rows: $ => bandRows($, 80) },
]

for (const view of VIEWS) {
  test(`a waiting agent shows ? on ${view.name}`, async ($, on) => {
    seed(on, T, uiOf(view.tab, []))
    expect(signalled(await view.rows($))).toBe(true)
  })
  test(`a dismissed ask shows no ? on ${view.name}`, async ($, on) => {
    seed(on, T, uiOf(view.tab, ['asking:s1']))
    expect(anyMark(await view.rows($))).toBe(false)
  })
  test(`an ask younger than 20 s shows no ? on ${view.name}`, async ($, on) => {
    seed(on, { ...T, steps: [{ ...asking, asking: NOW - 5_000 }] }, uiOf(view.tab, []))
    expect(anyMark(await view.rows($))).toBe(false)
  })
}

for (const mode of ['list', 'tree'] as const) {
  test(`an ask 5 s old marks nothing in the Agents ${mode}: no !, ? or z`, async ($, on) => {
    seed(on, { ...T, steps: [{ ...asking, asking: NOW - 5_000 }] }, { ...uiOf('agents', []), agentsMode: mode })
    const rows = await paneRows($)
    expect(rows.some(r => r.includes('find callers'))).toBe(true)
    expect(gutterFlag(rows)).toBe(undefined)
    expect(marked(rows, '!')).toBe(false)
    expect(marked(rows, '?')).toBe(false)
    expect(marked(rows, 'z')).toBe(false)
  })
  test(`an ask 30 s old is ? in the Agents ${mode} gutter, and no !`, async ($, on) => {
    seed(on, T, { ...uiOf('agents', []), agentsMode: mode })
    const rows = await paneRows($)
    const flagged = rows.filter(r => /^[!?z] /.test(r))
    expect(flagged.length > 0).toBe(true)
    expect(flagged.every(r => r.startsWith('? '))).toBe(true)
    expect(flagged.some(r => r.includes('find callers'))).toBe(true)
  })
}

test('the ? matcher reads the gutter and pods only: a ? in a description is no mark', async ($, on) => {
  const quiet: AgentRow = { ...worker, description: 'why does it fail?' }
  seed(on, { ...T, steps: [], agents: { ...T.agents, a1: quiet } }, uiOf('agents', []))
  const rows = await paneRows($)
  expect(rows.some(r => r.includes('fail?'))).toBe(true)
  expect(anyMark(rows)).toBe(false)
})
