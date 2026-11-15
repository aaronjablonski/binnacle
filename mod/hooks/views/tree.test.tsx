import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Run, Step, TaskItem, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-3', ui: 'ui-3' }

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

const TREE_UI: UiState = {
  tab: 'agents', filter: { kind: 'all' }, agentsMode: 'tree', folded: [], openTurns: [],
  dismissed: [], query: '', runningOnly: false, notified: [], toasted: [],
}
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
    const runText = (await ui.find({ key: 'node-run:r1' }))?.text ?? ''
    expect(runText).toContain('⚙ review-changes')
    expect(runText).toContain('workflow · 1/2 done')
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

type Found2 = Awaited<ReturnType<Awaited<ReturnType<typeof mount>>['findAll']>>[number]
const props2 = (f: Found2 | undefined): { color?: string; dimColor?: boolean } => (f?.props ?? {}) as { color?: string; dimColor?: boolean }

test('tree glyphs carry status colours, folds are accent, and the header sums to the columns', async ($, on) => {
  seed(on, family(), TREE_UI)
  for (const surface of SURFACES) {
    for (const columns of [62, 24]) {
      const ui = await mount($, surface, columns)
      const found = await ui.findAll({ type: 'Text' })
      expect(found.filter(f => f.text === '▶').map(f => props2(f).color)).toContain('warning')
      expect(found.filter(f => f.text === '✔').map(f => props2(f).color)).toContain('success')
      expect(props2(found.find(f => f.text === '▾')).color).toBe('suggestion')
      const header = found.filter(f => (f.text ?? '').startsWith('AGENTS') && (f.text ?? '').length === columns)
      expect(header.length).toBe(1)
      await ui.unmount()
    }
  }
})

test('a tree row has its meta flush right and the running agent doing line is dim under a └', async ($, on) => {
  seed(on, family(), TREE_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 62)
    const row = (await ui.find({ key: 'node-a2' }))?.text ?? ''
    const [first, second] = row.split('\n')
    expect(first?.endsWith('  30s · 1')).toBe(true)
    // The button spans the row less its tree prefix and the fold column.
    expect(first?.length).toBe(62 - 3 - 2)
    expect(second).toBe('└ Edit limiter.test.ts')
    const found = await ui.findAll({ type: 'Text' })
    expect(props2(found.find(f => f.text === '\n└ Edit limiter.test.ts')).dimColor).toBe(true)
    await ui.unmount()
  }
})

// ---- F7: agent tree upgrade ----

const stalledFamily = (): Timeline =>
  busy({
    agents: {
      main: withMainWork,
      a1: at(agent('a1', 'Explore', 'map the upload path', 'Read up.ts', 'done'), 400_000),
      g1: at(agent('g1', 'Explore', 'find test helpers', 'Grep helpers'), 300_000, { parent: 'a1' }),
      a2: at(agent('a2', 'general-purpose', 'limiter tests', 'Edit limiter.test.ts', 'done'), 30_000),
    },
  })

test('a node with a problem shows ! in the error colour, and so does its folded ancestor', async ($, on) => {
  const stored = seed(on, stalledFamily(), TREE_UI)
  for (const surface of SURFACES) {
    put(stored, stalledFamily(), TREE_UI)
    let ui = await mount($, surface)
    let bangs = (await ui.findAll({ type: 'Text' })).filter(f => f.text === '!')
    expect(bangs.length).toBe(1)
    expect(props2(bangs[0]).color).toBe('error')
    expect((await ui.find({ key: 'node-g1' }))?.text).toContain('!')
    expect((await ui.find({ key: 'node-a1' }))?.text).not.toContain('!')
    await ui.unmount()
    put(stored, stalledFamily(), { ...TREE_UI, folded: ['a1'] })
    ui = await mount($, surface)
    expect(await ui.find({ key: 'node-g1' })).toBeUndefined()
    expect((await ui.find({ key: 'node-a1' }))?.text).toContain('!')
    expect((await ui.find({ key: 'node-a2' }))?.text).not.toContain('!')
    bangs = (await ui.findAll({ type: 'Text' })).filter(f => f.text === '!')
    expect(bangs.map(b => props2(b).color)).toEqual(['error'])
    await ui.unmount()
  }
})

test('a dismissed problem leaves no !', async ($, on) => {
  seed(on, stalledFamily(), { ...TREE_UI, dismissed: ['stalled:g1'] })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect((await ui.findAll({ type: 'Text' })).filter(f => f.text === '!').length).toBe(0)
    await ui.unmount()
  }
})

test('a folded branch shows its agent count and running count, never counting main', async ($, on) => {
  seed(on, stalledFamily(), { ...TREE_UI, folded: ['a1'] })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const text = (await ui.find({ key: 'node-a1' }))?.text ?? ''
    expect(text).toContain('1 agents · 1 running')
    await ui.unmount()
  }
})

test('a folded main counts every agent and only the running ones', async ($, on) => {
  seed(on, stalledFamily(), { ...TREE_UI, folded: ['main'] })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const text = (await ui.find({ key: 'node-main' }))?.text ?? ''
    expect(text).toContain('3 agents · 1 running')
    await ui.unmount()
  }
})

test('an expanded node does not show the branch count', async ($, on) => {
  seed(on, family(), TREE_UI)
  const ui = await mount($, 'terminal')
  expect((await ui.find({ key: 'node-a1' }))?.text).not.toContain('agents ·')
  await ui.unmount()
})

test('node meta carries model and tokens', async ($, on) => {
  const t = busy({
    agents: {
      main,
      a1: at(agent('a1', 'Explore', 'map', 'x', 'done'), 60_000, { model: 'claude-sonnet-5', tokensIn: 40_000, tokensOut: 1_000, endedAt: NOW - 1000 }),
    },
  })
  seed(on, t, TREE_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 62)
    const first = ((await ui.find({ key: 'node-a1' }))?.text ?? '').split('\n')[0] ?? ''
    expect(first).toMatch(/sonnet 41k/)
    await ui.unmount()
  }
})

test('every non-main agent row has a View button that acts only on press', async ($, on) => {
  const calls: unknown[] = []
  on('ui.view', (_, e) => {
    calls.push(e)
    return { value: {} }
  })
  seed(on, family(), TREE_UI)
  for (const surface of SURFACES) {
    calls.length = 0
    const ui = await mount($, surface)
    for (const id of ['a1', 'a2', 'g1']) expect(await ui.find({ key: `view-${id}` })).toBeDefined()
    expect(await ui.find({ key: 'view-main' })).toBeUndefined()
    expect(calls.length).toBe(0)
    await ui.press({ key: 'view-g1' })
    expect(JSON.stringify(calls)).toContain('g1')
    await ui.unmount()
  }
})

test('a refused View is toasted', async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: string }).text))
    return { value: undefined }
  })
  on('ui.view', () => ({ value: { deny: 'no such agent' } }))
  seed(on, family(), TREE_UI)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'view-a2' })
  expect(toasts.join('|')).toContain('no such agent')
  await ui.unmount()
})

test('the running only toggle writes ui.runningOnly', async ($, on) => {
  const stored = seed(on, family(), TREE_UI)
  for (const surface of SURFACES) {
    put(stored, family(), TREE_UI)
    const ui = await mount($, surface)
    expect(await ui.find({ key: 'running-only' })).toBeDefined()
    await ui.press({ key: 'running-only' })
    expect((stored.get('ui') as UiState).runningOnly).toBe(true)
    await ui.unmount()
    put(stored, family(), { ...TREE_UI, runningOnly: true })
    const again = await mount($, surface)
    await again.press({ key: 'running-only' })
    expect((stored.get('ui') as UiState).runningOnly).toBe(false)
    await again.unmount()
  }
})

test('running only hides finished branches but keeps the ancestors of running nodes', async ($, on) => {
  seed(on, stalledFamily(), { ...TREE_UI, runningOnly: true })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await ui.find({ key: 'node-main' })).toBeDefined()
    // a1 is done but its child g1 is running: a1 stays.
    expect(await ui.find({ key: 'node-a1' })).toBeDefined()
    expect(await ui.find({ key: 'node-g1' })).toBeDefined()
    expect(await ui.find({ key: 'node-a2' })).toBeUndefined()
    await ui.unmount()
  }
})

test('running only drops a finished branch with nothing running under it', async ($, on) => {
  seed(on, family(), { ...TREE_UI, runningOnly: true })
  const ui = await mount($, 'terminal')
  expect(await ui.find({ key: 'node-a1' })).toBeUndefined()
  expect(await ui.find({ key: 'node-g1' })).toBeUndefined()
  expect(await ui.find({ key: 'node-a2' })).toBeDefined()
  await ui.unmount()
})

const fits = async (ui: Awaited<ReturnType<typeof mount>>, columns: number): Promise<void> => {
  for (const type of ['Text', 'Button'] as const) {
    for (const f of await ui.findAll({ type })) {
      for (const line of (f.text ?? '').split('\n')) expect(line.length <= columns).toBe(true)
    }
  }
}

test('at 24 columns the meta goes before the description, and every line fits', async ($, on) => {
  const t = busy({
    agents: {
      main: withMainWork,
      a1: at(agent('a1', 'Explore', 'map it', 'Read up.ts'), 60_000),
      a2: at(agent('a2', 'general-purpose', 'write the limiter tests now', 'Edit x'), 50_000, {
        model: 'claude-sonnet-5',
        tokensIn: 5000,
      }),
      a3: at(agent('a3', 'Explore', 'x'.repeat(60), 'y'), 40_000, { parent: 'a1' }),
    },
  })
  seed(on, t, TREE_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 24)
    const a1 = ((await ui.find({ key: 'node-a1' }))?.text ?? '').split('\n')[0] ?? ''
    expect(a1).toContain('map it')
    expect(a1).not.toContain('1m')
    await fits(ui, 24)
    await ui.unmount()
  }
})

test('a bang and a folded count still fit at 24 columns', async ($, on) => {
  seed(on, stalledFamily(), { ...TREE_UI, folded: ['a1'] })
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 24)
    await fits(ui, 24)
    expect((await ui.find({ key: 'node-a1' }))?.text).toContain('!')
    await ui.unmount()
  }
})
