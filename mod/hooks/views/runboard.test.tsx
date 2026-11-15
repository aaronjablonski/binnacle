import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Run, Step, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { colOf, screen } from './screen.testkit'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }

type Stored = Map<string, unknown>

// The engine's $.state beneath the mod: seeded with a timeline, remembering
// every write so a press can be read back.
function world(on: On, t: Timeline, u?: UiState): { stored: Stored; clock: MockClock } {
  const stored: Stored = new Map()
  stored.set('timeline', t)
  if (u) stored.set('ui', u)
  const versions = new Map<string, number>()
  const clock = mock.clock(on, { now: NOW })
  on('ui.log', () => ({ value: undefined }))
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
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

const seed = (on: On, t: Timeline, u?: UiState): Stored => world(on, t, u).stored


const PANE = (columns: number) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    props: {
      title: 'Mission Control',
      isFocused: false,
      bodyColumns: columns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const


const step = (id: string, seq: number, agent: string, status: Step['status']): Step => ({
  id, seq, agent, tool: 'Read', label: `Read ${id}`, status, startedAt: NOW - 50_000 + seq * 100,
})
const wf = (id: string, index: number, description: string, status: AgentRow['status'], extra: Partial<AgentRow> = {}): AgentRow => ({
  id, parent: 'main', type: 'workflow-subagent', description, status,
  startedAt: NOW - 60_000 + index * 1000, doing: '', stepCount: 0, runId: 'r1', agentIndex: index,
  ...(status !== 'running' ? { endedAt: NOW - 20_000 } : {}),
  ...extra,
})
const UI: UiState = {
  tab: 'agents', filter: { kind: 'all' }, agentsMode: 'list', folded: [], openTurns: [],
  dismissed: [], query: '', runningOnly: false, notified: [], toasted: [], slim: false, run: 'r1',
}
const run: Run = { runId: 'r1', name: 'review-changes', parent: 'main', startedAt: NOW - 90_000 }
const main: AgentRow = { ...empty.agents.main! }
const board = (n = 3): Timeline => ({
  ...empty,
  runs: { r1: run },
  agents: {
    main,
    w0: wf('w0', 0, 'read agent one', 'done', { result: 'found 3 bugs' }),
    w1: wf('w1', 1, 'read agent two', 'error'),
    w2: wf('w2', 2, 'read agent three', 'running'),
  },
  steps: [
    step('a1', 1, 'w0', 'done'), step('a2', 2, 'w0', 'done'),
    step('b1', 3, 'w1', 'error'),
    ...Array.from({ length: n }, (_, i) => step(`c${i}`, 10 + i, 'w2', i === n - 1 ? 'running' : 'done')),
  ],
})
async function mount($: Engine, surface: (typeof SURFACES)[number], columns = 62) {
  return $.ui.mount({ ...PANE(columns), surface })
}
type Mounted = Awaited<ReturnType<typeof mount>>
type Found = Awaited<ReturnType<Mounted['findAll']>>[number]
const propsOf = (f: Found | undefined): { color?: string; dimColor?: boolean } =>
  (f?.props ?? {}) as { color?: string; dimColor?: boolean }
const texts = async (ui: Mounted): Promise<string[]> => (await ui.findAll({ type: 'Text' })).map(f => f.text ?? '')

test('the Agents list run header opens the board', async ($, on) => {
  const stored = seed(on, board(), { ...UI, run: undefined })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    await ui.press({ key: 'run-open-r1' })
    expect((stored.get('ui') as UiState).run).toBe('r1')
    stored.set('ui', { ...UI, run: undefined })
    await ui.unmount()
  }
})

const rows = async (ui: Mounted): Promise<string[]> => screen(await ui.drawn())
const rowWith = (all: string[], text: string): string => all.find(r => r.includes(text)) ?? ''

test('LOOK: the board: hulls at 2, head on the grid, rows in spawn order on the table columns, no main', async ($, on) => {
  seed(on, board(), UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = await rows(ui)
    const back = rowWith(all, 'b: Back')
    expect(colOf(back, 'b: Back')).toBe(2)
    const head = rowWith(all, '┌ review-changes')
    expect([colOf(head, '┌'), colOf(head, 'review-changes'), colOf(head, 'tokens'), colOf(head, 'time')]).toEqual([0, 2, 38, 50])
    expect(colOf(rowWith(all, 'done ·'), '1/3 done · 1 failed · 1m')).toBe(2)
    const text = all.join('\n')
    expect(text.indexOf('read agent one') < text.indexOf('read agent two')).toBe(true)
    expect(text.indexOf('read agent two') < text.indexOf('read agent three')).toBe(true)
    const one = rowWith(all, 'read agent one')
    expect([colOf(one, '■'), colOf(one, 'read agent one'), colOf(one, '–'), colOf(one, '40s')]).toEqual([2, 4, 38, 50])
    expect(colOf(rowWith(all, 'read agent three'), '▣')).toBe(2)
    expect(colOf(rowWith(all, 'read agent two'), '□')).toBe(2)
    expect(colOf(rowWith(all, 'read agent two'), '!')).toBe(0)
    expect(text).not.toContain('main')
    expect(text).not.toContain('└')
    expect(await ui.find({ key: 'agent-main' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a press on an agent row opens it: result and agent lines, then s: steps  v: transcript  g: chat', async ($, on) => {
  const stored = seed(on, board(), UI)
  for (const surface of SURFACES) {
    stored.set('ui', UI)
    let ui = await mount($, surface)
    expect((await rows(ui)).join('\n')).not.toContain('found 3 bugs')
    await ui.press({ key: 'run-agent-w0' })
    expect((stored.get('ui') as UiState).agentOpen).toBe('w0')
    await ui.unmount()
    stored.set('ui', { ...UI, agentOpen: 'w0' })
    ui = await mount($, surface)
    const all = await rows(ui)
    const at = all.findIndex(r => r.includes('read agent one'))
    // the strip of blocks sits under the row, then the detail
    const detail = all.slice(at + 1)
    const result = detail.find(r => r.includes('result')) ?? ''
    expect([colOf(result, 'result'), colOf(result, 'found 3 bugs')]).toEqual([6, 14])
    const agent = detail.find(r => r.includes('workflow-subagent')) ?? ''
    expect(colOf(agent, 'agent')).toBe(6)
    expect(detail).toContain('      s: steps   v: transcript   g: chat')
    await ui.press({ key: 'run-agent-w0' })
    expect((stored.get('ui') as UiState).agentOpen).toBeUndefined()
    await ui.unmount()
  }
})

test('step blocks are coloured by status (live in the accent, done dim), one Button each', async ($, on) => {
  seed(on, board(), UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect((await ui.find({ key: 'block-a1' }))?.text).toBe('■')
    expect((await ui.find({ key: 'block-b1' }))?.text).toBe('■')
    expect(await ui.find({ key: 'block-c2' })).toBeDefined()
    const found = await ui.findAll({ type: 'Text' })
    const blocks = found.filter(f => f.text === '■')
    expect(blocks.map(f => propsOf(f).color)).toContain('suggestion')
    expect(blocks.map(f => propsOf(f).color)).toContain('error')
    // a finished step is dim, with no colour of its own
    const dim = blocks.filter(f => propsOf(f).color === undefined)
    expect(dim.length > 0).toBe(true)
    for (const d of dim) expect(propsOf(d).dimColor).toBe(true)
    await ui.unmount()
  }
})

test('pressing a block opens that step', async ($, on) => {
  const stored = seed(on, board(), UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    await ui.press({ key: 'block-b1' })
    const u = stored.get('ui') as UiState
    expect(u.tab).toBe('timeline')
    expect(u.stepOpen).toBe('b1')
    expect(u.detail).toBeUndefined()
    stored.set('ui', UI)
    await ui.unmount()
  }
})

test('more than 20 steps: the newest 20 with +n before them', async ($, on) => {
  seed(on, board(25), UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 62)
    expect(await ui.find({ key: 'block-c4' })).toBeUndefined()
    expect(await ui.find({ key: 'block-c5' })).toBeDefined()
    expect(await ui.find({ key: 'block-c24' })).toBeDefined()
    expect((await texts(ui)).some(t => t.includes('+5'))).toBe(true)
    await ui.unmount()
  }
})

test('Back clears ui.run (b: Back)', async ($, on) => {
  const stored = seed(on, board(), UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    await ui.press({ key: 'run-back' })
    expect((stored.get('ui') as UiState).run).toBeUndefined()
    stored.set('ui', UI)
    await ui.unmount()
  }
})

test('a run the timeline lacks shows a note and Back', async ($, on) => {
  seed(on, empty, UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect((await texts(ui)).join('\n')).toContain('This run is gone.')
    expect(await ui.find({ key: 'run-back' })).toBeDefined()
    await ui.unmount()
  }
})

test('a huge run falls back to one Button per agent opening its newest step', async ($, on) => {
  const agents: Record<string, AgentRow> = { main }
  const steps: Step[] = []
  for (let i = 0; i < 10; i++) {
    agents[`h${i}`] = wf(`h${i}`, i, `agent ${i}`, 'done')
    for (let j = 0; j < 25; j++) steps.push(step(`h${i}s${j}`, i * 100 + j, `h${i}`, 'done'))
  }
  const stored = seed(on, { ...empty, runs: { r1: run }, agents, steps }, UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await ui.find({ key: 'block-h3s24' })).toBeUndefined()
    expect((await ui.findAll({ type: 'Button' })).length < 30).toBe(true)
    await ui.press({ key: 'strip-h3' })
    const opened = stored.get('ui') as UiState
    expect(opened.tab).toBe('timeline')
    expect(opened.stepOpen).toBe('h3s24')
    expect(opened.detail).toBeUndefined()
    stored.set('ui', UI)
    await ui.unmount()
  }
})

test('narrow: every row fits 32, and the strip keeps its blocks and its marker', async ($, on) => {
  seed(on, board(25), UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 32)
    const all = await rows(ui)
    expect(all.length > 8).toBe(true)
    for (const r of all) expect(r.length).toBeLessThanOrEqual(32)
    const found = await ui.findAll({ type: 'Text' })
    const blocks = found.filter(f => f.text === '■').length
    const marker = found.filter(f => /^\+\d+ ?$/.test(f.text ?? '')).length
    expect(blocks > 0 && marker > 0).toBe(true)
    await ui.unmount()
  }
})

test('at 40 and 50 columns the time follows the table columns', async ($, on) => {
  seed(on, board(), UI)
  for (const [columns, time] of [[50, 38], [40, 26]] as const) {
    const ui = await mount($, 'terminal', columns)
    const all = await rows(ui)
    for (const r of all) expect(r.length).toBeLessThanOrEqual(columns)
    expect(colOf(rowWith(all, 'read agent one'), '40s')).toBe(time)
    await ui.unmount()
  }
})
