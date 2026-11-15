import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Run, Step, TaskItem, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-2', ui: 'ui-1' }

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

const TREE_UI: UiState = { tab: 'agents', filter: { kind: 'all' }, agentsMode: 'tree', folded: [] }
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

const at = (a: AgentRow, ago: number, extra: Partial<AgentRow> = {}): AgentRow => ({ ...a, startedAt: NOW - ago, ...extra })
const allText = async (ui: Awaited<ReturnType<typeof mount>>): Promise<string> => (await texts(ui)).join('\n')

const family = (): Timeline =>
  busy({
    agents: {
      main: withMainWork,
      a1: at(agent('a1', 'Explore', 'map the upload path', 'Read up.ts', 'done'), 60_000),
      a2: at(agent('a2', 'general-purpose', 'limiter tests', 'Edit limiter.test.ts'), 30_000),
      g1: at(agent('g1', 'Explore', 'find test helpers', 'Grep helpers', 'done'), 20_000, { parent: 'a1' }),
    },
  })

test('draws main, two children and a grandchild with ├─ │ └─ prefixes', async ($, on) => {
  seed(on, family(), TREE_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const out = await allText(ui)
    expect(out).toContain('├─')
    expect(out).toContain('│  └─')
    expect(out).toContain('└─')
    expect(out).toContain('3 agents · 1 running')
    expect((await ui.find({ key: 'node-main' }))?.text).toContain('main')
    expect((await ui.find({ key: 'node-main' }))?.text).not.toContain('▶')
    const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key)
    expect(keys.indexOf('node-a1') < keys.indexOf('node-g1')).toBe(true)
    expect(keys.indexOf('node-g1') < keys.indexOf('node-a2')).toBe(true)
    const a2 = (await ui.find({ key: 'node-a2' }))?.text ?? ''
    expect(a2).toContain('▶ general-purpose · limiter tests')
    expect(a2).toContain('Edit limiter.test.ts')
    expect((await ui.find({ key: 'node-a1' }))?.text).not.toContain('Read up.ts')
    await ui.unmount()
  }
})

test('a workflow run is a node holding its agents with n/m done', async ($, on) => {
  seed(
    on,
    busy({
      runs: { r1: run },
      agents: {
        main,
        w1: at(wf('w1', 0, 'review: bugs', 'Read a.ts', 'done'), 80_000),
        w2: at(wf('w2', 1, 'review: perf', 'Read b.ts', 'running'), 70_000),
      },
    }),
    TREE_UI,
  )
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect((await ui.find({ key: 'node-run:r1' }))?.text).toContain('⚙ review-changes · workflow · 1/2 done')
    expect(await ui.find({ key: 'node-w1' })).toBeDefined()
    expect(await ui.find({ key: 'node-w2' })).toBeDefined()
    expect(await ui.find({ key: 'fold-run:r1' })).toBeDefined()
    await ui.unmount()
  }
})

test('folding a node hides its descendants and shows ▸', async ($, on) => {
  const stored = seed(on, family(), TREE_UI)
  for (const surface of SURFACES) {
    put(stored, family(), TREE_UI)
    let ui = await mount($, surface)
    expect((await ui.find({ key: 'fold-a1' }))?.text).toContain('▾')
    await ui.press({ key: 'fold-a1' })
    expect((stored.get('ui') as UiState).folded).toEqual(['a1'])
    expect((stored.get('ui') as UiState).tab).toBe('agents')
    await ui.unmount()
    put(stored, family(), { ...TREE_UI, folded: ['a1'] })
    ui = await mount($, surface)
    expect(await ui.find({ key: 'node-g1' })).toBeUndefined()
    expect((await ui.find({ key: 'fold-a1' }))?.text).toContain('▸')
    expect(await ui.find({ key: 'node-a1' })).toBeDefined()
    await ui.press({ key: 'fold-a1' })
    expect((stored.get('ui') as UiState).folded).toEqual([])
    await ui.unmount()
  }
})

test('pressing an agent row filters the timeline to it', async ($, on) => {
  const stored = seed(on, family(), TREE_UI)
  for (const surface of SURFACES) {
    put(stored, family(), TREE_UI)
    const ui = await mount($, surface)
    await ui.press({ key: 'node-g1' })
    const u = stored.get('ui') as UiState
    expect(u.tab).toBe('timeline')
    expect(u.filter).toEqual({ kind: 'agent', id: 'g1' })
    await ui.unmount()
  }
})

test('pressing a run row folds it', async ($, on) => {
  const t = busy({ runs: { r1: run }, agents: { main, w1: at(wf('w1', 0, 'review: bugs', 'x', 'done'), 80_000) } })
  const stored = seed(on, t, TREE_UI)
  for (const surface of SURFACES) {
    put(stored, t, TREE_UI)
    const ui = await mount($, surface)
    await ui.press({ key: 'node-run:r1' })
    const u = stored.get('ui') as UiState
    expect(u.folded).toEqual(['run:r1'])
    expect(u.tab).toBe('agents')
    await ui.unmount()
  }
})

test('an agent whose parent never spawned sits under main', async ($, on) => {
  seed(
    on,
    busy({ agents: { main, a1: at(agent('a1', 'Explore', 'orphan', 'x'), 10_000, { parent: 'ghost' }) } }),
    TREE_UI,
  )
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await ui.find({ key: 'node-a1' })).toBeDefined()
    expect(await allText(ui)).toContain('└─')
    await ui.unmount()
  }
})

test('depth 8 at bodyColumns 24 keeps every Text within 24', async ($, on) => {
  const agents: Record<string, AgentRow> = { main: withMainWork }
  for (let i = 1; i <= 8; i++) {
    agents[`c${i}`] = at(
      agent(`c${i}`, 'general-purpose', 'write limiter tests for the endpoint', 'Edit test/rateLimit.test.ts now'),
      60_000 - i * 1000,
      { parent: i === 1 ? 'main' : `c${i - 1}` },
    )
  }
  seed(on, busy({ agents }), TREE_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 24)
    const found = await ui.findAll({ type: 'Text' })
    expect(found.length > 16).toBe(true)
    for (const f of found) {
      for (const line of (f.text ?? '').split('\n')) expect(line.length <= 24).toBe(true)
    }
    expect(await allText(ui)).toContain('8›')
    expect(await ui.find({ key: 'node-c8' })).toBeDefined()
    await ui.unmount()
  }
})

test('only main: one row and the empty-state line', async ($, on) => {
  seed(on, empty, TREE_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await ui.find({ key: 'node-main' })).toBeDefined()
    expect((await ui.findAll({ type: 'Button' })).filter(b => (b.key ?? '').startsWith('node-')).length).toBe(1)
    expect(await allText(ui)).toContain('No agents yet. Subagents and workflow agents appear here while they run.')
    expect(await allText(ui)).toContain('0 agents · 0 running')
    await ui.unmount()
  }
})
