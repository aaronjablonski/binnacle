import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Run, Step, TaskItem, Timeline, UiState } from '../../types'
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


const PANE = (columns: number, focused = false) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    props: {
      title: 'Mission Control',
      isFocused: focused,
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

async function mount($: Engine, surface: (typeof SURFACES)[number], columns = 62, focused = false) {
  return $.ui.mount({ ...PANE(columns, focused), surface })
}

const texts = async (ui: Awaited<ReturnType<typeof mount>>): Promise<string[]> => {
  const found = await ui.findAll({ type: 'Text' })
  return found.map(f => f.text ?? '')
}

const TREE_UI: UiState = {
  tab: 'agents', filter: { kind: 'all' }, agentsMode: 'tree', folded: [], openTurns: [],
  dismissed: [], query: '', runningOnly: false, notified: [], toasted: [], slim: false,
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

type Mounted = Awaited<ReturnType<typeof mount>>
type Found = Awaited<ReturnType<Mounted['findAll']>>[number]
const propsOf = (f: Found | undefined): { color?: string; dimColor?: boolean; bold?: boolean } =>
  (f?.props ?? {}) as { color?: string; dimColor?: boolean; bold?: boolean }

const rows = async (ui: Mounted): Promise<string[]> => screen(await ui.drawn())
const rowWith = (all: string[], text: string): string => all.find(r => r.includes(text)) ?? ''
const idxWith = (all: string[], text: string): number => all.findIndex(r => r.includes(text))

const tok = (n: number, extra: Partial<AgentRow> = {}): Partial<AgentRow> => ({ tokensIn: n, tokensOut: 0, ...extra })

// main
// ├ find callers (live)
// ├ write tests (live)
// │ ├ review hooks (live)
// │ ├ review views (failed)
// │ └ + 2 done (two finished helpers)
// └ + 1 done
const branchy = (): Timeline =>
  busy({
    agents: {
      main: { ...withMainWork, ...tok(993_000) },
      a1: { ...at(agent('a1', 'Explore', 'find callers', 'Grep'), 60_000), ...tok(72_000) },
      a2: { ...at(agent('a2', 'general-purpose', 'write tests', 'Edit'), 40_000), ...tok(88_000) },
      g1: { ...at(agent('g1', 'Explore', 'review hooks', 'Read', 'running'), 30_000, { parent: 'a2' }), ...tok(64_000) },
      g2: { ...at(agent('g2', 'Explore', 'review views', 'oops', 'error'), 25_000, { parent: 'a2', endedAt: NOW - 1000 }), ...tok(81_000) },
      g3: at(agent('g3', 'Explore', 'helper one', 'x', 'done'), 20_000, { parent: 'a2', endedAt: NOW - 2000 }),
      g4: at(agent('g4', 'Explore', 'helper two', 'x', 'done'), 19_000, { parent: 'a2', endedAt: NOW - 2000 }),
      d1: at(agent('d1', 'Explore', 'old job', 'x', 'done'), 80_000, { endedAt: NOW - 30_000 }),
    },
  })

test('guides at 2 and 4, glyphs at 4 and 6, names at 6 and 8, tokens at 38 and time at 50', async ($, on) => {
  seed(on, branchy(), TREE_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 62)
    const all = await rows(ui)
    const head = rowWith(all, '┌ AGENTS')
    expect([colOf(head, '┌'), colOf(head, 'AGENTS'), colOf(head, 'tokens'), colOf(head, 'time')]).toEqual([0, 2, 38, 50])
    const mainRow = rowWith(all, '◆')
    expect([colOf(mainRow, '◆'), colOf(mainRow, 'main'), colOf(mainRow, '993k')]).toEqual([2, 4, 38])
    const a1 = rowWith(all, 'find callers')
    expect([colOf(a1, '├'), colOf(a1, '▸'), colOf(a1, 'find callers'), colOf(a1, '72k'), colOf(a1, '1m')]).toEqual([2, 4, 6, 38, 50])
    const g1 = rowWith(all, 'review hooks')
    expect([colOf(g1, '│'), colOf(g1, '├'), colOf(g1, '▸'), colOf(g1, 'review hooks'), colOf(g1, '64k')]).toEqual([2, 4, 6, 8, 38])
    const g2 = rowWith(all, 'review views')
    expect([colOf(g2, '├'), colOf(g2, '✖'), colOf(g2, 'review views')]).toEqual([4, 6, 8])
    await ui.unmount()
  }
})

test('guides are subtle, glyphs carry status, and the old ├─ prefixes are gone', async ($, on) => {
  seed(on, branchy(), TREE_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const found = await ui.findAll({ type: 'Text' })
    const guides = found.filter(f => /^[│├└ ]+$/.test(f.text ?? '') && (f.text ?? '').trim() !== '')
    expect(guides.length > 0).toBe(true)
    for (const g of guides) expect(propsOf(g).color).toBe('subtle')
    expect(found.filter(f => f.text === '▸').map(f => propsOf(f).color)).toContain('suggestion')
    expect(found.filter(f => f.text === '✖').map(f => propsOf(f).color)).toContain('error')
    expect((await rows(ui)).join('\n')).not.toContain('├─')
    await ui.unmount()
  }
})

test('finished branches fold to + n done at the child depth, with a guide', async ($, on) => {
  seed(on, branchy(), TREE_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = await rows(ui)
    // helper one and two, under write tests (depth 2)
    const inner = all.find(r => r.includes('2 done')) ?? ''
    expect([colOf(inner, '│'), colOf(inner, '└'), colOf(inner, '+'), colOf(inner, '2 done')]).toEqual([2, 4, 6, 8])
    // old job, under main (depth 1)
    const outer = all.find(r => r.includes('1 done')) ?? ''
    expect([colOf(outer, '└'), colOf(outer, '+'), colOf(outer, '1 done')]).toEqual([2, 4, 6])
    expect(all.join('\n')).not.toContain('helper one')
    expect(all.join('\n')).not.toContain('old job')
    expect(await ui.find({ key: 'node-g3' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a done agent with a running child stays, and a done branch holding the opened row stays', async ($, on) => {
  const t = busy({
    agents: {
      main,
      a1: at(agent('a1', 'Explore', 'map the path', 'x', 'done'), 400_000, { endedAt: NOW - 10_000 }),
      g1: at(agent('g1', 'Explore', 'find helpers', 'Grep'), 300_000, { parent: 'a1' }),
      a2: at(agent('a2', 'Explore', 'limiter tests', 'x', 'done'), 30_000, { endedAt: NOW - 5000 }),
    },
  })
  const stored = seed(on, t, TREE_UI)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ key: 'node-a1' })).toBeDefined()
  expect(await ui.find({ key: 'node-g1' })).toBeDefined()
  expect(await ui.find({ key: 'node-a2' })).toBeUndefined()
  await ui.unmount()
  put(stored, t, { ...TREE_UI, agentOpen: 'a2' })
  const open = await mount($, 'terminal')
  expect(await open.find({ key: 'node-a2' })).toBeDefined()
  await open.unmount()
})

test('a workflow run is a ≡ node holding its running agents; its tokens are the sum of theirs', async ($, on) => {
  seed(
    on,
    busy({
      runs: { r1: run },
      agents: {
        main,
        w1: { ...at(wf('w1', 0, 'review: bugs', 'Read a.ts', 'running'), 80_000), ...tok(10_000) },
        w2: { ...at(wf('w2', 1, 'review: perf', 'Read b.ts', 'running'), 70_000), ...tok(20_000) },
      },
    }),
    TREE_UI,
  )
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = await rows(ui)
    const r = rowWith(all, 'review-changes')
    expect([colOf(r, '└'), colOf(r, '≡'), colOf(r, 'review-changes'), colOf(r, '30k'), colOf(r, '1m')]).toEqual([2, 4, 6, 38, 50])
    expect(colOf(rowWith(all, 'review: bugs'), '▸')).toBe(6)
    expect(await ui.find({ key: 'node-w1' })).toBeDefined()
    expect(await ui.find({ key: 'node-w2' })).toBeDefined()
    await ui.unmount()
  }
})

test('pressing a run row folds it and shows its agent count; pressing again unfolds', async ($, on) => {
  const t = busy({
    runs: { r1: run },
    agents: { main, w1: at(wf('w1', 0, 'review: bugs', 'x', 'running'), 80_000), w2: at(wf('w2', 1, 'review: perf', 'x', 'running'), 70_000) },
  })
  const stored = seed(on, t, TREE_UI)
  for (const surface of SURFACES) {
    put(stored, t, TREE_UI)
    let ui = await mount($, surface)
    await ui.press({ key: 'node-run:r1' })
    const u = stored.get('ui') as UiState
    expect(u.folded).toEqual(['run:r1'])
    expect(u.tab).toBe('agents')
    await ui.unmount()
    put(stored, t, { ...TREE_UI, folded: ['run:r1'] })
    ui = await mount($, surface)
    expect(await ui.find({ key: 'node-w1' })).toBeUndefined()
    expect(rowWith(await rows(ui), 'review-changes')).toContain('review-changes · 2 agents')
    await ui.press({ key: 'node-run:r1' })
    expect((stored.get('ui') as UiState).folded).toEqual([])
    await ui.unmount()
  }
})

test('a stored fold of an agent key is ignored: only runs fold', async ($, on) => {
  seed(on, branchy(), { ...TREE_UI, folded: ['a2'] })
  const ui = await mount($, 'terminal')
  expect(await ui.find({ key: 'node-g1' })).toBeDefined()
  await ui.unmount()
})

test('pressing an agent row opens it in place; pressing it again closes it', async ($, on) => {
  const stored = seed(on, branchy(), TREE_UI)
  for (const surface of SURFACES) {
    put(stored, branchy(), TREE_UI)
    const ui = await mount($, surface)
    await ui.press({ key: 'node-g1' })
    const u = stored.get('ui') as UiState
    expect(u.agentOpen).toBe('g1')
    expect(u.tab).toBe('agents')
    await ui.press({ key: 'node-g1' })
    expect((stored.get('ui') as UiState).agentOpen).toBeUndefined()
    await ui.unmount()
  }
})

test('an opened node: details at 6/14, the action line at 6, blanks around, no View line', async ($, on) => {
  seed(on, branchy(), { ...TREE_UI, agentOpen: 'g1' })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = await rows(ui)
    const at = idxWith(all, 'review hooks')
    expect(all[at - 1]?.trim()).toBe('')
    expect(colOf(all[at + 1], 'doing')).toBe(6)
    expect(colOf(all[at + 1], 'Read')).toBe(14)
    expect(colOf(all[at + 2], 'agent')).toBe(6)
    expect(all[at + 3]).toBe('      s: steps   v: transcript   g: chat')
    expect(all[at + 4]?.trim()).toBe('')
    expect(all.join('\n')).not.toContain('View')
    const found = await ui.findAll({ type: 'Text' })
    expect(propsOf(found.find(f => f.text === 'review hooks')).bold).toBe(true)
    await ui.unmount()
  }
})

test('the s and v actions of an opened node filter Steps and view the transcript', async ($, on) => {
  const calls: unknown[] = []
  on('ui.view', (_, e) => {
    calls.push(e)
    return { value: {} }
  })
  const stored = seed(on, branchy(), { ...TREE_UI, agentOpen: 'g1' })
  const ui = await mount($, 'terminal')
  expect(calls.length).toBe(0)
  await ui.press({ key: 'agent-view-g1' })
  expect(JSON.stringify(calls)).toContain('g1')
  await ui.press({ key: 'agent-steps-g1' })
  const u = stored.get('ui') as UiState
  expect(u.tab).toBe('timeline')
  expect(u.filter).toEqual({ kind: 'agent', id: 'g1' })
  await ui.unmount()
})

test('an agent whose parent never spawned sits under main', async ($, on) => {
  seed(on, busy({ agents: { main, a1: at(agent('a1', 'Explore', 'orphan', 'x'), 10_000, { parent: 'ghost' }) } }), TREE_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const r = rowWith(await rows(ui), 'orphan')
    expect([colOf(r, '└'), colOf(r, '▸'), colOf(r, 'orphan')]).toEqual([2, 4, 6])
    await ui.unmount()
  }
})

test('only main: one row, the empty-state note, and nothing running when r is on', async ($, on) => {
  const stored = seed(on, empty, TREE_UI)
  for (const surface of SURFACES) {
    put(stored, empty, TREE_UI)
    const ui = await mount($, surface)
    expect((await ui.findAll({ type: 'Button' })).filter(b => (b.key ?? '').startsWith('node-')).length).toBe(1)
    const joined = (await rows(ui)).map(r => r.trim()).join(' ')
    expect(joined).toContain('No agents yet. Subagents and workflow agents appear here while they run.')
    await ui.unmount()
  }
  put(stored, busy({ agents: { main, a1: at(agent('a1', 'Explore', 'x', 'y', 'done'), 10_000, { endedAt: NOW - 1000 }) } }), { ...TREE_UI, runningOnly: true })
  const idle = await mount($, 'terminal')
  expect((await rows(idle)).join('\n')).toContain('Nothing is running.')
  await idle.unmount()
})

const stalledFamily = (): Timeline =>
  busy({
    runs: { r1: run },
    agents: {
      main: withMainWork,
      a1: at(agent('a1', 'Explore', 'find callers', 'Grep'), 400_000, { lastStepAt: NOW - 300_000 }),
      a2: at(agent('a2', 'general-purpose', 'limiter tests', 'Edit'), 30_000),
      w1: at(wf('w1', 0, 'review: bugs', 'x', 'running'), 400_000, { lastStepAt: NOW - 300_000 }),
      w2: at(wf('w2', 1, 'review: perf', 'x', 'running'), 30_000),
    },
  })

test('a problem node carries ! in the gutter in error; a folded run that holds one carries it too', async ($, on) => {
  const stored = seed(on, stalledFamily(), TREE_UI)
  for (const surface of SURFACES) {
    put(stored, stalledFamily(), TREE_UI)
    let ui = await mount($, surface)
    let all = await rows(ui)
    expect(colOf(rowWith(all, 'find callers'), '!')).toBe(0)
    expect(colOf(rowWith(all, 'review: bugs'), '!')).toBe(0)
    expect(rowWith(all, 'limiter tests').startsWith('!')).toBe(false)
    expect(rowWith(all, 'review: perf').startsWith('!')).toBe(false)
    expect(rowWith(all, 'review-changes').startsWith('!')).toBe(false)
    const bangs = (await ui.findAll({ type: 'Text' })).filter(f => (f.text ?? '').startsWith('!'))
    expect(bangs.map(b => propsOf(b).color)).toEqual(['error', 'error'])
    await ui.unmount()
    put(stored, stalledFamily(), { ...TREE_UI, folded: ['run:r1'] })
    ui = await mount($, surface)
    all = await rows(ui)
    expect(await ui.find({ key: 'node-w1' })).toBeUndefined()
    expect(colOf(rowWith(all, 'review-changes'), '!')).toBe(0)
    await ui.unmount()
  }
})

test('a folded run with no problem has no !, and a dismissed problem leaves no !', async ($, on) => {
  const stored = seed(on, stalledFamily(), { ...TREE_UI, dismissed: ['stalled:a1', 'stalled:w1'], folded: ['run:r1'] })
  const ui = await mount($, 'terminal')
  expect((await rows(ui)).filter(r => r.startsWith('!')).length).toBe(0)
  await ui.unmount()
  put(stored, stalledFamily(), { ...TREE_UI, dismissed: ['stalled:w1'], folded: ['run:r1'] })
  const again = await mount($, 'terminal')
  const all = await rows(again)
  expect(rowWith(all, 'review-changes').startsWith('!')).toBe(false)
  expect(colOf(rowWith(all, 'find callers'), '!')).toBe(0)
  await again.unmount()
})

test('n and p visit the ! rows: agents open, a folded run becomes the cursor', async ($, on) => {
  const stored = seed(on, stalledFamily(), { ...TREE_UI, folded: ['run:r1'] })
  const ui = await mount($, 'terminal', 62, true)
  const foot = rowWith(await rows(ui), '↵ open')
  expect(foot.trim()).toBe('↵ open   n: next !   p: prev')
  await ui.press({ key: 'hint-next' })
  expect((stored.get('ui') as UiState).agentOpen).toBe('a1')
  await ui.press({ key: 'hint-next' })
  expect((stored.get('ui') as UiState).agentOpen).toBe('run:r1')
  await ui.press({ key: 'hint-prev' })
  expect((stored.get('ui') as UiState).agentOpen).toBe('a1')
  await ui.unmount()
})

test('the running toggle writes ui.runningOnly from the tree', async ($, on) => {
  const stored = seed(on, branchy(), TREE_UI)
  for (const surface of SURFACES) {
    put(stored, branchy(), TREE_UI)
    const ui = await mount($, surface)
    expect(rowWith(await rows(ui), 'r: Running')).toContain('t: Tree')
    await ui.press({ key: 'mode-running' })
    expect((stored.get('ui') as UiState).runningOnly).toBe(true)
    await ui.unmount()
    put(stored, branchy(), { ...TREE_UI, runningOnly: true })
    const again = await mount($, surface)
    await again.press({ key: 'mode-running' })
    expect((stored.get('ui') as UiState).runningOnly).toBe(false)
    await again.unmount()
  }
})

test('r hides everything but running branches, and keeps the ancestors of running nodes', async ($, on) => {
  const t = busy({
    agents: {
      main,
      a1: at(agent('a1', 'Explore', 'map the path', 'x', 'done'), 400_000, { endedAt: NOW - 10_000 }),
      g1: at(agent('g1', 'Explore', 'find helpers', 'Grep'), 300_000, { parent: 'a1' }),
      a2: at(agent('a2', 'general-purpose', 'limiter tests', 'x', 'done'), 30_000, { endedAt: NOW - 5000 }),
      a3: at(agent('a3', 'Explore', 'broke', 'x', 'error'), 20_000, { endedAt: NOW - 5000 }),
    },
  })
  seed(on, t, { ...TREE_UI, runningOnly: true })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await ui.find({ key: 'node-main' })).toBeDefined()
    expect(await ui.find({ key: 'node-a1' })).toBeDefined()
    expect(await ui.find({ key: 'node-g1' })).toBeDefined()
    expect(await ui.find({ key: 'node-a2' })).toBeUndefined()
    expect(await ui.find({ key: 'node-a3' })).toBeUndefined()
    expect((await rows(ui)).join('\n')).not.toContain('done')
    await ui.unmount()
  }
})

test('depth 8 draws at most two levels in, and every row fits 32', async ($, on) => {
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
    const ui = await mount($, surface, 32)
    const all = await rows(ui)
    for (const r of all) expect(r.length).toBeLessThanOrEqual(32)
    expect(await ui.find({ key: 'node-c8' })).toBeDefined()
    for (const r of all.filter(x => x.includes('▸'))) expect(colOf(r, '▸')).toBeLessThanOrEqual(6)
    await ui.unmount()
  }
})

test('narrow tiers: tokens and time follow the table columns, and nothing is wider than the pane', async ($, on) => {
  const t = branchy()
  const long = { ...t.agents.a1!, description: 'find every caller of the stepRow function in the views' }
  seed(on, { ...t, agents: { ...t.agents, a1: long } }, TREE_UI)
  const expected: [number, number | undefined, number | undefined][] = [
    [62, 38, 50],
    [55, undefined, 38],
    [40, undefined, 26],
    [32, undefined, undefined],
  ]
  for (const [columns, metric, time] of expected) {
    const ui = await mount($, 'terminal', columns)
    const all = await rows(ui)
    for (const r of all) expect(r.length).toBeLessThanOrEqual(columns)
    const a1 = rowWith(all, 'find every')
    if (metric !== undefined) expect(colOf(a1, '72k')).toBe(metric)
    else expect(a1).not.toContain('72k')
    if (time !== undefined) expect(colOf(a1, '1m')).toBe(time)
    else expect(a1).not.toContain('1m')
    const name = a1.slice(6).split(/ {2,}/)[0] ?? ''
    if (name.endsWith('…')) {
      const kept = name.slice(0, -1)
      expect(long.description.startsWith(kept)).toBe(true)
      expect(long.description[kept.length]).toBe(' ')
    }
    await ui.unmount()
  }
})
