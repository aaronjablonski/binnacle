import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Step, TaskItem, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { resetCover } from './needs'
import { screen } from './screen.testkit'
import { GLYPHS } from './style'

// One waiting agent, one rule: the same `?` on every view that draws the
// agent, and none once the ask is dismissed.
//
// C-1 (meaning changed): the ask came in auto mode, so it waits on the person
// only while its dialog covers the prompt (the pane's `isPromptCovered`; the
// band reads what the pane saw). Uncovered it is only "Checking a
// permission", at any age: the 20 s promotion is gone.

const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }

/** Whether the dialog covers the prompt in the drawings a test makes. */
let cover = true

function seed(on: On, t: Timeline, u: UiState, covered = true): void {
  resetCover()
  cover = covered
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
// a1 asked 30 s ago, in auto mode: waiting on the person while its dialog covers the prompt.
const asking: Step = { id: 's1', seq: 1, agent: 'a1', tool: 'Bash', label: 'Bash rm -rf build', status: 'running', startedAt: NOW - 40_000, asking: NOW - 30_000 }
const T: Timeline = {
  ...empty,
  autoAsk: true,
  seq: 1,
  steps: [asking],
  tasks: [task],
  agents: { main: { ...empty.agents.main! }, a1: worker },
  now: { focus: 'Fixing the parser', at: NOW - 60_000 },
}

const PANE = (columns: number) =>
  ({
    plugin: 'binnacle',
    component: 'Pane',
    requestId: 'binnacle',
    props: { title: 'Binnacle', isFocused: false, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {}, ...(cover ? { isPromptCovered: true as const } : {}) },
  }) as const
const BAND = (columns: number) =>
  ({
    plugin: 'binnacle',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: columns, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  }) as const

const uiOf = (tab: UiState['tab'], dismissed: string[]): UiState => ({ ...initialUi, tab, dismissed })

// Every hull of every role and state, from the one table the views draw with.
const HULLS: string[] = Object.values(GLYPHS.hull).flatMap(h => [...h])
/**
 * A signal as a view draws it, and only there: in a row's gutter cell (column
 * 0, then a space) or as a pod's suffix (right after a hull). A `?` inside a
 * description is neither.
 */
const marked = (rows: string[], mark: '?' | '!' | 'z'): boolean =>
  rows.some(r => r.startsWith(`${mark} `) || HULLS.some(h => r.includes(`${h}${mark}`)) || CRITTER_MARK[mark].test(r))
/** The cockpit critter's text form (R22): its state glyph, then the badge in the box's last column (`●    ?`). */
const CRITTER_MARK: Record<'?' | '!' | 'z', RegExp> = { '?': /● {3,4}\?/, '!': /× {3,4}!/, z: /● {3,4}z/ }
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
  // The band has no isPromptCovered: it reads what the pane's last drawing saw.
  const pane = await $.ui.mount({ ...PANE(62), surface: 'terminal' })
  await pane.drawn()
  await pane.unmount()
  const ui = await $.ui.mount({ ...BAND(columns), surface: 'terminal' })
  const rows = screen(await ui.drawn())
  await ui.unmount()
  return rows
}

// BEHAVIOUR CHANGE (C6): the band is the cockpit's. Two rows (110 columns) show the ask as the asker's critter, waiting (its `?` badge); one row (62) shows it as the amber `▲`. Like Now's, its needs take no dismissal (R1: no `x` on a permission), so a dismissed ask still shows.
const VIEWS: { name: string; tab: UiState['tab']; rows: ($: Engine) => Promise<string[]>; shows?: (rows: string[]) => boolean }[] = [
  { name: 'Agents', tab: 'agents', rows: $ => paneRows($) },
  { name: 'Now', tab: 'overview', rows: $ => paneRows($) },
  { name: 'Tasks', tab: 'tasks', rows: $ => paneRows($) },
  { name: 'band (two rows)', tab: 'overview', rows: $ => bandRows($, 110) },
  { name: 'band (one row)', tab: 'overview', rows: $ => bandRows($, 62), shows: rows => rows.some(r => r.includes('▲')) },
]

// LOOK TEST (edited for Rich, and for the cockpit Tasks: its tethered micro critters are Rasters on the terminal, so Tasks is read in the text form too): the ? is a glyph of the text form (a hull's suffix or a gutter flag); on Now, Agents and the three-row band the rich form draws it in a character, so those are read in the text form here (the rich band is tested in band.test.tsx, the rich Now in rich2.test.tsx).
const LOOK = (view: { name: string }) => (view.name === 'Now' || view.name === 'band (two rows)' || view.name === 'Agents' || view.name === 'Tasks' ? { options: { look: 'text' } } : {})

for (const view of VIEWS) {
  test(`a waiting agent shows ? on ${view.name}`, LOOK(view), async ($, on) => {
    seed(on, T, uiOf(view.tab, []))
    expect((view.shows ?? signalled)(await view.rows($))).toBe(true)
  })
  // Needs take no dismissal (owner ruling 4: no `x` on a permission), and every view reads Now's needs (I-2, meaning
  // changed for Agents and Tasks, which read the legacy list that a dismissal hid): a dismissed ask still shows everywhere.
  test(`a dismissed ask shows its mark still on ${view.name}`, LOOK(view), async ($, on) => {
    seed(on, T, uiOf(view.tab, ['asking:s1']))
    expect((view.shows ?? anyMark)(await view.rows($))).toBe(true)
  })
  test(`an auto-mode ask with no dialog over the prompt shows no ? on ${view.name}, even 30 s old`, LOOK(view), async ($, on) => {
    seed(on, T, uiOf(view.tab, []), false)
    expect((view.shows ?? anyMark)(await view.rows($))).toBe(false)
  })
}

for (const mode of ['list', 'tree'] as const) {
  test(`an ask 5 s old marks nothing in the Agents ${mode}: no !, ? or z`, { options: { look: 'text' } }, async ($, on) => {
    seed(on, { ...T, steps: [{ ...asking, asking: NOW - 5_000 }] }, { ...uiOf('agents', []), agentsMode: mode }, false)
    const rows = await paneRows($)
    expect(rows.some(r => r.includes('find callers'))).toBe(true)
    expect(gutterFlag(rows)).toBe(undefined)
    expect(marked(rows, '!')).toBe(false)
    expect(marked(rows, '?')).toBe(false)
    expect(marked(rows, 'z')).toBe(false)
  })
  // R26: the ? and ! stand in column 0 on the map only; the list shows the ask on the critter (its badge).
  test(`an ask 30 s old is ? ${mode === 'tree' ? 'in the Agents tree gutter' : 'on the Agents list critter, and no gutter flag'}, and no !`, { options: { look: 'text' } }, async ($, on) => {
    seed(on, T, { ...uiOf('agents', []), agentsMode: mode })
    const rows = await paneRows($)
    const flagged = rows.filter(r => /^[!?z] /.test(r))
    if (mode === 'tree') {
      expect(flagged.length > 0).toBe(true)
      expect(flagged.every(r => r.startsWith('? '))).toBe(true)
      expect(flagged.some(r => r.includes('find callers'))).toBe(true)
    } else {
      expect(flagged).toEqual([])
      expect(marked(rows, '?')).toBe(true)
    }
    expect(marked(rows, '!')).toBe(false)
  })
}

test('the ? matcher reads the gutter and pods only: a ? in a description is no mark', async ($, on) => {
  const quiet: AgentRow = { ...worker, description: 'why does it fail?' }
  seed(on, { ...T, steps: [], agents: { ...T.agents, a1: quiet } }, uiOf('agents', []))
  const rows = await paneRows($)
  expect(rows.some(r => r.includes('fail?'))).toBe(true)
  expect(anyMark(rows)).toBe(false)
})
