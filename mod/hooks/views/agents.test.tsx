import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Run, Step, TaskItem, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-2', ui: 'ui-2' }

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

const task = (id: string, subject: string, status: TaskItem['status'], extra: Partial<TaskItem> = {}): TaskItem => ({
  id,
  subject,
  status,
  owner: 'main',
  updatedAt: NOW - 120_000,
  ...extra,
})
const step = (id: string, seq: number, label: string, status: Step['status'], extra: Partial<Step> = {}): Step => ({
  id,
  seq,
  agent: 'main',
  tool: 'Edit',
  label,
  status,
  startedAt: NOW - 5000,
  ...extra,
})
const agent = (
  id: string,
  type: string,
  description: string,
  doing: string,
  status: AgentRow['status'] = 'running',
): AgentRow => ({
  id,
  parent: 'main',
  type,
  description,
  status,
  startedAt: NOW - 60_000,
  doing,
  stepCount: 1,
})

const main: AgentRow = { ...empty.agents.main! }

async function mount($: Engine, surface: (typeof SURFACES)[number], columns = 62) {
  return $.ui.mount({ ...PANE(columns), surface })
}

const texts = async (ui: Awaited<ReturnType<typeof mount>>): Promise<string[]> => {
  const found = await ui.findAll({ type: 'Text' })
  return found.map(f => f.text ?? '')
}

const AGENTS_UI: UiState = { tab: 'agents', filter: { kind: 'all' }, agentsMode: 'list', folded: [], openTurns: [] }
const run: Run = { runId: 'r1', name: 'review-changes', parent: 'main', startedAt: NOW - 90_000 }
const wf = (id: string, index: number, description: string, doing: string, status: AgentRow['status']): AgentRow => ({
  ...agent(id, 'workflow-subagent', description, doing, status),
  runId: 'r1',
  agentIndex: index,
})
const withMainWork: AgentRow = { ...main, stepCount: 14, doing: 'Edit src/index.ts' }
const busy = (t: Partial<Timeline>): Timeline => ({
  ...empty,
  steps: [step('s1', 1, 'Edit a.ts', 'done', { startedAt: NOW - 360_000 })],
  ...t,
})

// Replaces what the world holds, for the next surface.
function put(stored: Stored, t: Timeline, u: UiState): void {
  stored.clear()
  stored.set('timeline', t)
  stored.set('ui', u)
}

test('lists main, a running subagent and a finished one with glyphs', async ($, on) => {
  seed(
    on,
    busy({
      agents: {
        main: withMainWork,
        a1: agent('a1', 'Explore', 'find callers', 'Grep upload'),
        a2: {
          ...agent('a2', 'Explore', 'map the path', 'upload() is reached from 3 routes', 'done'),
          endedAt: NOW - 8000,
          stepCount: 11,
        },
      },
    }),
    AGENTS_UI,
  )
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const mainText = (await ui.find({ key: 'agent-main' }))?.text ?? ''
    expect(mainText).toContain('main · this conversation')
    expect(mainText).not.toContain('▶')
    expect(mainText).toContain('Edit src/index.ts')
    const running = (await ui.find({ key: 'agent-a1' }))?.text ?? ''
    expect(running).toContain('▶ Explore · find callers')
    expect(running).toContain('1m · 1 steps')
    expect(running).toContain('Grep upload')
    const done = (await ui.find({ key: 'agent-a2' }))?.text ?? ''
    expect(done).toContain('✔ Explore · map the path')
    expect(done).toContain('52s · 11 steps')
    await ui.unmount()
  }
})

test('main is listed first and an error agent shows its glyph', async ($, on) => {
  seed(on, busy({ agents: { main, a1: agent('a1', 'Explore', 'x', 'y', 'error') } }), AGENTS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key)
    expect(keys.indexOf('agent-main') < keys.indexOf('agent-a1')).toBe(true)
    expect((await ui.find({ key: 'agent-a1' }))?.text ?? '').toContain('✖ Explore')
    await ui.unmount()
  }
})

test('groups two workflow agents under their run with 1/2 done', async ($, on) => {
  seed(
    on,
    busy({
      runs: { r1: run },
      agents: {
        main,
        w1: wf('w1', 0, 'read:agent-1', 'Read a.ts', 'done'),
        w2: wf('w2', 1, 'read:agent-2', 'Read b.ts', 'running'),
      },
    }),
    AGENTS_UI,
  )
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = (await texts(ui)).join('\n')
    expect(all).toContain('⚙ review-changes')
    expect(all).toContain('workflow · 1/2 done')
    expect((await ui.find({ key: 'agent-w1' }))?.text).toContain('read:agent-1')
    expect((await ui.find({ key: 'agent-w2' }))?.text).toContain('Read b.ts')
    await ui.unmount()
  }
})

test('pressing an agent opens the timeline filtered to it', async ($, on) => {
  const stored = seed(on, empty, AGENTS_UI)
  for (const surface of SURFACES) {
    put(stored, busy({ agents: { main, a1: agent('a1', 'Explore', 'x', 'y') } }), AGENTS_UI)
    const ui = await mount($, surface)
    await ui.press({ key: 'agent-a1' })
    const u = stored.get('ui') as UiState
    expect(u.tab).toBe('timeline')
    expect(u.filter).toEqual({ kind: 'agent', id: 'a1' })
    await ui.unmount()
  }
})

test('two agents with the same description keep distinct keys', async ($, on) => {
  seed(
    on,
    busy({ agents: { main, a1: agent('a1', 'Explore', 'same', 'x'), a2: agent('a2', 'Explore', 'same', 'x') } }),
    AGENTS_UI,
  )
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await ui.find({ key: 'agent-a1' })).toBeDefined()
    expect(await ui.find({ key: 'agent-a2' })).toBeDefined()
    await ui.unmount()
  }
})

test('pressing Tree writes ui.agentsMode = tree', async ($, on) => {
  const stored = seed(on, empty, AGENTS_UI)
  for (const surface of SURFACES) {
    put(stored, empty, AGENTS_UI)
    const ui = await mount($, surface)
    await ui.press({ key: 'mode-tree' })
    expect((stored.get('ui') as UiState).agentsMode).toBe('tree')
    await ui.unmount()
  }
})


test('the mode buttons are labelled without their hotkeys', async ($, on) => {
  seed(on, empty, AGENTS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect((await ui.find({ key: 'mode-list' }))?.text).toContain('List')
    expect((await ui.find({ key: 'mode-tree' }))?.text).toContain('Tree')
    await ui.unmount()
  }
})

test('narrow: no Text longer than 24', async ($, on) => {
  seed(
    on,
    busy({
      runs: { r1: run },
      agents: {
        main: { ...withMainWork, doing: 'Edit src/server/middleware/index.ts' },
        a1: agent('a1', 'general-purpose', 'write limiter tests for the endpoint', 'Edit test/rateLimit.test.ts now'),
        w1: wf('w1', 0, 'review: bugs and more bugs here', 'Read a very long path/to/file.ts', 'done'),
      },
    }),
    AGENTS_UI,
  )
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 24)
    const found = await ui.findAll({ type: 'Text' })
    expect(found.length > 8).toBe(true)
    // A Text may hold two lines; each line is what must fit.
    for (const f of found) {
      for (const line of (f.text ?? '').split('\n')) expect(line.length <= 24).toBe(true)
    }
    await ui.unmount()
  }
})

test('empty state', async ($, on) => {
  seed(on, empty, AGENTS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect((await texts(ui)).join('\n')).toContain(
      'No agents yet. Subagents and workflow agents appear here while they run.',
    )
    await ui.unmount()
  }
})

type Mounted = Awaited<ReturnType<typeof mount>>
type Found = Awaited<ReturnType<Mounted['findAll']>>[number]
const propsOf = (f: Found | undefined): { color?: string; dimColor?: boolean; bold?: boolean } =>
  (f?.props ?? {}) as { color?: string; dimColor?: boolean; bold?: boolean }

const MIXED_AGENTS = busy({
  runs: { r1: run },
  agents: {
    main: withMainWork,
    a1: agent('a1', 'Explore', 'find callers', 'Grep upload'),
    a2: { ...agent('a2', 'Explore', 'map the path', 'done it', 'done'), endedAt: NOW - 8000, stepCount: 11 },
    a3: agent('a3', 'Explore', 'broke', 'oops', 'error'),
    w1: wf('w1', 0, 'read:agent-1', 'Read a.ts', 'done'),
  },
})

test('agent glyphs carry status colours and main gets a dim bullet', async ($, on) => {
  seed(on, MIXED_AGENTS, AGENTS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const found = await ui.findAll({ type: 'Text' })
    expect(found.filter(f => f.text === '▶').map(f => propsOf(f).color)).toContain('warning')
    expect(found.filter(f => f.text === '✔').map(f => propsOf(f).color)).toContain('success')
    expect(found.filter(f => f.text === '✖').map(f => propsOf(f).color)).toContain('error')
    expect(propsOf(found.find(f => f.text === '•')).dimColor).toBe(true)
    await ui.unmount()
  }
})

test('a row is one Button: meta flush right, the doing line second, dim and prefixed with └', async ($, on) => {
  seed(on, MIXED_AGENTS, AGENTS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 62)
    const row = (await ui.find({ key: 'agent-a1' }))?.text ?? ''
    const [first, second] = row.split('\n')
    expect(first?.length).toBe(62)
    expect(first?.endsWith('1m · 1 steps')).toBe(true)
    expect(second).toBe('└ Grep upload')
    const found = await ui.findAll({ type: 'Text' })
    expect(propsOf(found.find(f => f.text === '\n└ Grep upload')).dimColor).toBe(true)
    await ui.unmount()
  }
})

test('the AGENTS and run headers are section headers that sum to the columns', async ($, on) => {
  seed(on, MIXED_AGENTS, AGENTS_UI)
  for (const surface of SURFACES) {
    for (const columns of [62, 24]) {
      const ui = await mount($, surface, columns)
      const found = await ui.findAll({ type: 'Text' })
      const heads = found.filter(f => (f.text ?? '').startsWith('AGENTS') && (f.text ?? '').length === columns)
      expect(heads.length).toBe(1)
      const run = found.filter(f => (f.text ?? '').startsWith('⚙ review-changes') && (f.text ?? '').length === columns)
      expect(run.length).toBe(1)
      expect(propsOf(found.find(f => f.text === 'AGENTS')).color).toBe('suggestion')
      await ui.unmount()
    }
  }
})
